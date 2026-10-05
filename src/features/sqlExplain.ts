import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, log, logError, showLog } from '../core/log';
import { sqlString, statementAtOffset } from '../core/util';
import { isReadOnlySql, limitRows } from '../core/sqlSafety';
import { createIndexSql, summarizeMonitor } from '../core/explainSummary';
import { showReport } from './reportPanel';

const ALLOWED = new Set(['vanthrex.explain.createIndexSql', 'vanthrex.objectInfo']);
const MONITOR = 'QTEMP/SLKDBMON';

/**
 * "Visual Explain" summary: runs the statement under a database monitor in the SQL job, then reads
 * the monitor records (table scans, indexes used, temporary indexes, sorts, advised indexes).
 */
export async function explainSql(manager: ConnectionManager, statement: string): Promise<void> {
  const conn = manager.require();
  if (!isReadOnlySql(statement)) {
    throw new Error('Explain runs the statement to watch the optimizer, so it only accepts queries (SELECT, WITH or VALUES).');
  }
  await conn.sql('VALUES 1', 1);
  if (!conn.sqlKeepsJob) {
    throw new Error('Explain needs the Mapepire SQL engine (the database monitor runs in the SQL job). Change the SQL engine in the connection settings.');
  }
  const cmd = (c: string) => conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(c)})`, 1);

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Explaining the query (running it under a database monitor)…' },
    async () => {
      await cmd(`DLTF FILE(${MONITOR})`).catch(() => undefined);
      await cmd(`STRDBMON OUTFILE(${MONITOR}) JOB(*) TYPE(*DETAIL)`);
      let elapsed = 0; let rows = 0; let error = '';
      try {
        const start = Date.now();
        const r = await conn.sql(limitRows(statement, 100), 100);
        elapsed = Date.now() - start;
        rows = r.rows.length;
      } catch (e) { error = errorMessage(e); }
      finally { await cmd('ENDDBMON JOB(*)').catch(e => log(`ENDDBMON: ${errorMessage(e)}`)); }
      const records = await conn.rows<Record<string, unknown>>(
        `SELECT * FROM ${MONITOR} A WHERE QQRID IN (1000, 3000, 3001, 3002, 3003, 3004, 3006, 3007) ORDER BY RRN(A)`, 2000)
        .catch(e => { logError(e); return []; });
      return { elapsed, rows, error, records };
    });

  if (result.error) { throw new Error(`The query failed: ${result.error}`); }
  const s = summarizeMonitor(result.records);

  // The index advisor knows more about the tables that were scanned.
  const advisorRows: (string | number | null)[][] = [];
  const advisorActions: ({ label: string; command: string; args: unknown[] } | undefined)[] = [];
  for (const t of [...s.tableScans, ...s.temporaryIndexes].map(x => x.table).filter((v, i, a) => a.indexOf(v) === i)) {
    const [lib, file] = t.split('/');
    if (!file) { continue; }
    try {
      const adv = await conn.rows<Record<string, unknown>>(
        `SELECT KEY_COLUMNS_ADVISED AS K, INDEX_TYPE AS T, TIMES_ADVISED AS N, VARCHAR(LAST_ADVISED) AS L FROM QSYS2.SYSIXADV ` +
        `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(file)} ORDER BY TIMES_ADVISED DESC FETCH FIRST 5 ROWS ONLY`, 5);
      for (const a of adv) {
        const keys = String(a.K ?? '').trim();
        advisorRows.push([t, keys, String(a.T ?? '').trim(), Number(a.N ?? 0), String(a.L ?? '').replace(/\.\d+$/, '')]);
        advisorActions.push({ label: 'Write the CREATE INDEX statement', command: 'vanthrex.explain.createIndexSql', args: [t, keys] });
      }
    } catch (e) { log(`Index advisor: ${errorMessage(e)}`); }
  }

  const verdict = s.tableScans.length || s.temporaryIndexes.length ? '⚠ Could be faster' : s.indexesUsed.length ? '✔ Uses indexes' : 'ℹ Simple plan';
  showReport('explain', {
    title: `Explain: ${verdict}`,
    subtitle: statement.replace(/\s+/g, ' ').substring(0, 300),
    facts: [
      ['Run time (first 100 rows)', `${result.elapsed} ms`],
      ['Rows returned', result.rows],
      ['Estimated processing time', s.estimatedMs !== undefined ? `${Math.round(s.estimatedMs)} ms` : undefined],
      ['Table scans', s.tableScans.length],
      ['Indexes used', s.indexesUsed.length],
      ['Temporary indexes built', s.temporaryIndexes.length],
      ['Sorts', s.sorts],
      ['Temporary results', s.temporaryResults],
      ['Access plan rebuilt (reason)', s.planRebuilt.join(', ') || undefined],
    ],
    tables: [
      { title: 'Advice', columns: ['Tip'], rows: s.tips.map(t => [t]), empty: 'No advice — nothing stood out.' },
      { title: 'Table scans', columns: ['Table', 'Rows', 'Why'], rows: s.tableScans.map(t => [t.table, t.rows, t.reason]), empty: 'No table scans.' },
      { title: 'Indexes used', columns: ['Table', 'Index'], rows: s.indexesUsed.map(t => [t.table, t.index]), empty: 'No indexes were used.' },
      {
        title: 'Indexes advised for this query', columns: ['Table', 'Key columns'],
        rows: s.advised.map(a => [a.table, a.keys]),
        rowActions: s.advised.map(a => ({ label: 'Write the CREATE INDEX statement', command: 'vanthrex.explain.createIndexSql', args: [a.table, a.keys] })),
        empty: 'The optimizer did not advise an index for this query.',
      },
      {
        title: 'Index advisor history for these tables', columns: ['Table', 'Key columns', 'Type', 'Times advised', 'Last advised'],
        rows: advisorRows, rowActions: advisorActions, empty: 'No earlier advice recorded.',
      },
    ],
    note: 'Collected with a database monitor (STRDBMON) on your SQL job while the query ran. Click an advised index to get a CREATE INDEX statement you can review and run.',
  }, ALLOWED);
}

export function registerSqlExplain(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.explainSql', async (sql?: string) => {
      try {
        let statement = typeof sql === 'string' ? sql : undefined;
        if (statement) {
          // Called with a statement from elsewhere (e.g. an AI answer): show it and ask before running it.
          const ok = await vscode.window.showInformationMessage('Explain runs this query on the IBM i to watch the optimizer:',
            { modal: true, detail: statement.length > 1500 ? statement.substring(0, 1500) + '…' : statement }, 'Run and Explain');
          if (ok !== 'Run and Explain') { return; }
        }
        const editor = vscode.window.activeTextEditor;
        if (!statement && editor) {
          statement = editor.selection.isEmpty
            ? statementAtOffset(editor.document.getText(), editor.document.offsetAt(editor.selection.active))
            : editor.document.getText(editor.selection);
        }
        if (!statement?.trim()) {
          statement = await vscode.window.showInputBox({ title: 'Explain a query', prompt: 'SELECT statement', ignoreFocusOut: true });
        }
        if (statement?.trim()) { await explainSql(manager, statement.trim()); }
      } catch (e) {
        logError(e);
        const c = await vscode.window.showErrorMessage(errorMessage(e), 'Show Log');
        if (c) { showLog(); }
      }
    }),
    vscode.commands.registerCommand('vanthrex.explain.createIndexSql', async (table: string, keys: string) => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: `-- Index advised by the Db2 for i optimizer for ${table}. Review the name and columns, then run it with Ctrl+Enter.\n${createIndexSql(table, keys)}\n`,
      });
      await vscode.window.showTextDocument(doc);
    }),
  );
}
