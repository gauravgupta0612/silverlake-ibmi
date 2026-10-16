import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { assertSystemName, sqlString, toCsv } from '../core/util';
import {
  MESSAGE_ID, analyzeJobLog, changedColumns, dataCompareSql, indexName, indexStatement,
  messageFileFor, messageHint,
} from '../core/insights';
import { pickScope } from './search';
import { runSqlAndShow } from './sqlRunner';
import { Report, showReport } from './reportPanel';

type ObjArg = { library: string; name: string; type?: string };
const s = (r: Record<string, unknown>, k: string) => String(r[k] ?? '').trim();

const ALLOWED = new Set([
  'vanthrex.createAdvisedIndex', 'vanthrex.indexAdvisor', 'vanthrex.activeQueries', 'vanthrex.objectInfo',
  'vanthrex.openProgramSource', 'vanthrex.compareData', 'vanthrex.exportDataCompare',
  'vanthrex.jobLog', 'vanthrex.analyzeJobLog', 'vanthrex.explainMessage', 'vanthrex.ai.jobLog',
]);

function requireSystemNaming(conn: IbmiConnection): void {
  if (!conn.sqlKeepsJob) {
    throw new Error(vscode.l10n.t('This feature needs the Mapepire SQL engine (it uses QTEMP and system naming). Change the SQL engine in the connection settings.'));
  }
}

// ================================================================ 1. Index advisor

async function indexAdvisor(manager: ConnectionManager, lib?: string): Promise<void> {
  const conn = manager.require();
  await conn.sql('VALUES 1', 1);
  const scope = lib ? [lib] : await pickScope(conn, 'Index advice for which libraries?');
  if (!scope) { return; }
  const where = scope[0] === '*ALLUSR'
    ? `SYSTEM_TABLE_SCHEMA NOT LIKE 'Q%' AND SYSTEM_TABLE_SCHEMA NOT LIKE 'SYS%'`
    : `SYSTEM_TABLE_SCHEMA IN (${scope.map(sqlString).join(', ')})`;
  const rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading the index advisor…') },
    () => conn.rows<Record<string, unknown>>(
      `SELECT * FROM QSYS2.SYSIXADV WHERE ${where} ORDER BY TIMES_ADVISED DESC, MOST_EXPENSIVE_QUERY DESC FETCH FIRST 200 ROWS ONLY`, 200));
  const report: Report = {
    title: vscode.l10n.t('Index advice — {0}', scope.join(', ')),
    subtitle: rows.length
      ? `Db2 for i recorded ${rows.length} index suggestion(s) while running queries. The most requested come first. Click a row to create the index.`
      : 'No index advice recorded for these libraries. Db2 adds advice here while queries run, so check again after the application has been used.',
    actions: [
      { label: vscode.l10n.t('Refresh'), command: 'vanthrex.indexAdvisor', args: [lib] },
      { label: vscode.l10n.t('Queries running now'), command: 'vanthrex.activeQueries' },
    ],
    tables: [{
      title: vscode.l10n.t('Suggested indexes'), filter: true,
      columns: ['Table', 'Key columns', 'Type', 'Times advised', 'Last advised', 'Most expensive query (s)', 'Est. build (s)', 'Reason'],
      rows: rows.map(r => [
        `${s(r, 'SYSTEM_TABLE_SCHEMA')}/${s(r, 'SYSTEM_TABLE_NAME')}`, s(r, 'KEY_COLUMNS_ADVISED'), s(r, 'INDEX_TYPE'),
        s(r, 'TIMES_ADVISED'), s(r, 'LAST_ADVISED').replace(/\.\d+$/, ''), s(r, 'MOST_EXPENSIVE_QUERY'),
        s(r, 'ESTIMATED_CREATION_TIME'), s(r, 'REASON_ADVISED')]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Create this index…'), command: 'vanthrex.createAdvisedIndex',
        args: [s(r, 'SYSTEM_TABLE_SCHEMA'), s(r, 'SYSTEM_TABLE_NAME'), s(r, 'KEY_COLUMNS_ADVISED'), s(r, 'INDEX_TYPE')] })),
      empty: vscode.l10n.t('No advice.'),
    }],
    note: vscode.l10n.t('Advice is cumulative since it was last cleared. Indexes speed up reads but cost a little on every insert/update — create the ones advised often, for expensive queries.'),
  };
  showReport('indexAdvisor', report, ALLOWED);
}

async function createAdvisedIndex(manager: ConnectionManager, schema: string, table: string, keys: string, type: string): Promise<void> {
  const conn = manager.require();
  let n = 1;
  const existing = await conn.rows<{ N: string }>(
    `SELECT SYSTEM_INDEX_NAME AS N FROM QSYS2.SYSINDEXES WHERE SYSTEM_INDEX_SCHEMA = ${sqlString(schema)}`, 5000).catch(() => []);
  const taken = new Set(existing.map(r => String(r.N).trim()));
  while (taken.has(indexName(table, n)) && n < 99) { n++; }
  const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Create advised index'), prompt: vscode.l10n.t('Index name'), value: indexName(table, n),
    validateInput: v => /^[A-Za-z$#@][\w$#@]{0,9}$/.test(v.trim()) ? undefined : '1–10 characters, a valid system name' });
  if (!name) { return; }
  const stmt = indexStatement(schema, table, keys, type, name.trim().toUpperCase());
  const ok = await vscode.window.showInformationMessage(stmt, { modal: true, detail: vscode.l10n.t('Building an index on a large table can take a while and locks the table briefly.') }, vscode.l10n.t('Create Index'), vscode.l10n.t('Copy SQL'));
  if (ok === vscode.l10n.t('Copy SQL')) { await vscode.env.clipboard.writeText(stmt + ';'); return; }
  if (ok !== vscode.l10n.t('Create Index')) { return; }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating {0}…', name) }, () => conn.sql(stmt, 1));
  vscode.window.showInformationMessage(vscode.l10n.t('Index {0}/{1} created.', schema, name.toUpperCase()));
}

// ================================================================ 3. Data compare

let lastCompare: { title: string; columns: string[]; rows: Record<string, unknown>[] } | undefined;

async function compareData(manager: ConnectionManager, o?: ObjArg): Promise<void> {
  const conn = manager.require();
  await conn.sql('VALUES 1', 1);
  requireSystemNaming(conn);
  let libA = o?.library; let table = o?.name;
  if (!libA || !table) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Compare table data'), prompt: vscode.l10n.t('First copy: LIBRARY/TABLE'), placeHolder: 'DEVLIB/CUSTMAST', ignoreFocusOut: true });
    if (!v?.includes('/')) { return; }
    [libA, table] = v.trim().toUpperCase().split('/');
  }
  libA = assertSystemName(libA, 'library'); table = assertSystemName(table, 'table');
  const libs = [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(l => l && l !== libA) as string[])];
  const libB = (await vscode.window.showQuickPick([...libs, '$(edit) Other library…'], { title: vscode.l10n.t('Compare {0}/{1} with the same table in…', libA, table) }));
  if (!libB) { return; }
  const other = libB.startsWith('$(') ? (await vscode.window.showInputBox({ title: vscode.l10n.t('Library'), prompt: vscode.l10n.t('Library with the other copy (e.g. PROD)') }))?.trim().toUpperCase() : libB;
  if (!other) { return; }
  assertSystemName(other, 'library');

  const cols = await conn.rows<Record<string, unknown>>(
    `SELECT COLUMN_NAME, DATA_TYPE FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(libA)} AND SYSTEM_TABLE_NAME = ${sqlString(table)} ORDER BY ORDINAL_POSITION`, 2000);
  if (!cols.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', libA, table)); }
  const comparable = cols.filter(c => !/LOB|XML|DATALINK/i.test(s(c, 'DATA_TYPE'))).map(c => s(c, 'COLUMN_NAME'));
  const pk = await conn.rows<{ C: string }>(
    `SELECT K.COLUMN_NAME AS C FROM QSYS2.SYSCST C JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
    `WHERE C.SYSTEM_TABLE_SCHEMA = ${sqlString(libA)} AND C.SYSTEM_TABLE_NAME = ${sqlString(table)} AND C.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE') ` +
    `ORDER BY CASE C.CONSTRAINT_TYPE WHEN 'PRIMARY KEY' THEN 0 ELSE 1 END, K.ORDINAL_POSITION`, 50).catch(() => []);
  const firstKeyConstraint = [...new Set(pk.map(r => String(r.C).trim()))];
  const picked = await vscode.window.showQuickPick(comparable.map(c => ({ label: c, picked: firstKeyConstraint.includes(c) })), {
    title: vscode.l10n.t('Key columns that identify a row of {0}{1}', table, firstKeyConstraint.length ? ' (primary key pre-selected)' : ''), canPickMany: true, ignoreFocusOut: true });
  if (!picked?.length) { return; }
  const spec = { libA, libB: other, table, keys: picked.map(p => p.label), columns: comparable };

  const [count, onlyA, onlyB, changed] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Comparing {0}/{1} with {2}/{3}…', libA, table, other, table) },
    () => Promise.all([
      conn.rows<Record<string, unknown>>(dataCompareSql(spec, 'count'), 1),
      conn.rows<Record<string, unknown>>(dataCompareSql(spec, 'onlyA', 200), 200),
      conn.rows<Record<string, unknown>>(dataCompareSql(spec, 'onlyB', 200), 200),
      conn.rows<Record<string, unknown>>(dataCompareSql(spec, 'changed', 500), 500),
    ]));
  const c = count[0] ?? {};
  const keyOf = (r: Record<string, unknown>, prefix = '') => spec.keys.map(k => s(r, prefix + k) || s(r, k)).join(' · ');
  const changedRows = changed.map(r => {
    const diff = changedColumns(r, spec.columns, spec.keys);
    return [keyOf(r), diff.map(col => `${col}: ${s(r, `A_${col}`) || '∅'} → ${s(r, `B_${col}`) || '∅'}`).join('\n')];
  });
  lastCompare = {
    title: `${libA} vs ${other} ${table}`,
    columns: ['Status', 'Key', 'Details'],
    rows: [
      ...onlyA.map(r => ({ Status: `only in ${libA}`, Key: keyOf(r), Details: '' })),
      ...onlyB.map(r => ({ Status: `only in ${other}`, Key: keyOf(r), Details: '' })),
      ...changedRows.map(([k, d]) => ({ Status: 'changed', Key: k, Details: d })),
    ],
  };
  const showCols = spec.columns.filter(col => !spec.keys.includes(col)).slice(0, 4);
  showReport('dataCompare', {
    title: `${table}: ${libA} ↔ ${other}`,
    subtitle: vscode.l10n.t('{0} rows in {1}, {2} in {3}. Keys: {4}.', s(c, 'ROWS_A'), libA, s(c, 'ROWS_B'), other, spec.keys.join(', ')),
    facts: [[`Only in ${libA}`, s(c, 'ONLY_A')], [`Only in ${other}`, s(c, 'ONLY_B')], ['Changed', s(c, 'CHANGED')]],
    actions: [{ label: vscode.l10n.t('Export differences (CSV)…'), command: 'vanthrex.exportDataCompare' }, { label: vscode.l10n.t('Compare another table'), command: 'vanthrex.compareData' }],
    tables: [
      { title: vscode.l10n.t('Changed rows (field by field)'), columns: ['Key', 'Changed fields'], rows: changedRows, filter: true, rowClass: changedRows.map(() => 'different'), empty: vscode.l10n.t('No changed rows.') },
      { title: vscode.l10n.t('Only in {0}', libA), columns: ['Key', ...showCols], rows: onlyA.map(r => [keyOf(r), ...showCols.map(col => s(r, col))]), rowClass: onlyA.map(() => 'onlyA'), filter: true, empty: vscode.l10n.t('None.') },
      { title: vscode.l10n.t('Only in {0}', other), columns: ['Key', ...showCols], rows: onlyB.map(r => [keyOf(r), ...showCols.map(col => s(r, col))]), rowClass: onlyB.map(() => 'onlyB'), filter: true, empty: vscode.l10n.t('None.') },
    ],
    note: vscode.l10n.t('Lists show at most 200 rows per side and 500 changed rows; the counts above are exact. Large objects (LOB/XML) are not compared. Trailing blanks are ignored.'),
  }, ALLOWED);
}

// ================================================================ 4. Message help & job log analyzer

const messageCache = new Map<string, { text: string; help: string; sev: string } | null>();

async function messageText(conn: IbmiConnection, id: string): Promise<{ text: string; help: string; sev: string } | null> {
  const key = id.toUpperCase();
  if (messageCache.has(key)) { return messageCache.get(key)!; }
  const file = messageFileFor(key) ?? { library: 'QSYS', file: 'QCPFMSG' };
  let found: { text: string; help: string; sev: string } | null = null;
  try {
    const r = await conn.rows<Record<string, unknown>>(
      `SELECT MESSAGE_TEXT, COALESCE(MESSAGE_SECOND_LEVEL_TEXT, '') AS HELP, SEVERITY FROM QSYS2.MESSAGE_FILE_DATA ` +
      `WHERE MESSAGE_FILE_LIBRARY = ${sqlString(file.library)} AND MESSAGE_FILE = ${sqlString(file.file)} AND MESSAGE_ID = ${sqlString(key)}`, 1);
    if (r[0]) { found = { text: s(r[0], 'MESSAGE_TEXT'), help: s(r[0], 'HELP'), sev: s(r[0], 'SEVERITY') }; }
  } catch (e) { log(`Message ${key}: ${errorMessage(e)}`); }
  messageCache.set(key, found);
  return found;
}

/** Second-level text uses &N / &P / &B formatting codes; turn them into readable paragraphs. */
function formatHelp(t: string): string {
  return t.replace(/&N\s*/g, '\n\n').replace(/&P\s*/g, '\n\n  ').replace(/&B\s*/g, '\n\n- ').trim();
}

async function explainMessage(manager: ConnectionManager, id?: string): Promise<void> {
  const conn = manager.require();
  const msg = id ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Explain message'), prompt: vscode.l10n.t('Message ID (CPF9801, MCH1211, RNQ0102, SQL0204…)'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!msg) { return; }
  const m = await messageText(conn, msg);
  const hint = messageHint(msg);
  if (!m && !hint) { throw new Error(vscode.l10n.t('{0} was not found in the IBM message files.', msg)); }
  showReport('message', {
    title: msg,
    subtitle: m?.text ?? '',
    facts: [['Severity', m?.sev ?? ''], ['What to do', hint ?? '']],
    tables: m?.help ? [{ title: vscode.l10n.t('IBM help text'), columns: ['Text'], rows: formatHelp(m.help).split(/\n\n/).map(p => [p.trim()]).filter(r => r[0]) }] : [],
  }, ALLOWED);
}

async function analyzeJobLogCmd(manager: ConnectionManager, job?: string): Promise<void> {
  const conn = manager.require();
  const j = job ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Analyze job log'), prompt: vscode.l10n.t('Qualified job name (number/user/name), or * for this job'), placeHolder: '123456/QUSER/ORDENTRY', ignoreFocusOut: true }))?.trim();
  if (!j) { return; }
  const rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading the job log of {0}…', j) },
    () => conn.rows<Record<string, unknown>>(
      `SELECT VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TIME, COALESCE(MESSAGE_ID, '') AS MSGID, MESSAGE_TYPE, ` +
      `COALESCE(SEVERITY, 0) AS SEV, COALESCE(MESSAGE_TEXT, '') AS TEXT, COALESCE(MESSAGE_SECOND_LEVEL_TEXT, '') AS HELP, COALESCE(FROM_PROGRAM, '') AS PGM ` +
      `FROM TABLE(QSYS2.JOBLOG_INFO(${sqlString(j)})) ORDER BY ORDINAL_POSITION`, 20000));
  const { findings, rootCause } = analyzeJobLog(rows.map(r => ({
    id: s(r, 'MSGID'), type: s(r, 'MESSAGE_TYPE'), severity: Number(r.SEV ?? 0), text: s(r, 'TEXT'), help: s(r, 'HELP'), program: s(r, 'PGM'), time: s(r, 'TIME'),
  })));
  showReport('joblogAnalysis', {
    title: vscode.l10n.t('Job log analysis — {0}', j),
    subtitle: findings.length ? `${rows.length} message(s), ${findings.length} distinct problem(s).` : `${rows.length} message(s) — no errors found.`,
    facts: rootCause ? [
      ['Most likely cause', `${rootCause.id} — ${rootCause.text}`],
      ['Sent by', rootCause.program ?? ''],
      ['What to do', rootCause.hint ?? formatHelp(rootCause.help ?? '').split('\n\n').find(p => /recovery/i.test(p)) ?? 'Read the IBM help text below.'],
    ] : [],
    actions: [{ label: vscode.l10n.t('Open the full job log'), command: 'vanthrex.jobLog', args: [{ job: j }] },
      ...(/^\d{6}\//.test(j) && vscode.workspace.getConfiguration('vanthrex').get<boolean>('ai.enabled', true) ? [{ label: vscode.l10n.t('Ask AI why it failed and how to fix it'), command: 'vanthrex.ai.jobLog', args: [j] }] : [])],
    tables: [{
      title: vscode.l10n.t('Problems (worst first)'), columns: ['Message', 'Times', 'Sev', 'Text', 'Program', 'What to do'], filter: true,
      rows: findings.map(f => [f.id, f.count, f.severity, f.text, f.program ?? '', f.hint ?? '']),
      rowActions: findings.map(f => (f.id ? { label: vscode.l10n.t('Explain this message'), command: 'vanthrex.explainMessage', args: [f.id] } : undefined)),
      rowClass: findings.map(f => (f === rootCause ? 'bad' : undefined)),
      empty: vscode.l10n.t('No diagnostic or escape messages.'),
    }],
    note: vscode.l10n.t('The first escape message that is not a generic function check (CPF9999) is usually the real cause. Click a message for IBM\'s full help text.'),
  }, ALLOWED);
}

// ================================================================ registration

export function registerInsights(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.indexAdvisor', guard(async (n?: { library?: string; kind?: string }) =>
      indexAdvisor(manager, typeof n === 'string' ? n : n?.library))),
    vscode.commands.registerCommand('vanthrex.createAdvisedIndex', guard((schema: string, table: string, keys: string, type: string) =>
      createAdvisedIndex(manager, schema, table, keys, type))),
    vscode.commands.registerCommand('vanthrex.activeQueries', guard(() => runSqlAndShow(manager, context.globalState,
      'SELECT * FROM TABLE(QSYS2.ACTIVE_QUERY_INFO()) A'))),
    vscode.commands.registerCommand('vanthrex.compareData', guard(async (n?: ObjArg) => compareData(manager, n?.library ? n : undefined))),
    vscode.commands.registerCommand('vanthrex.exportDataCompare', guard(async () => {
      if (!lastCompare) { throw new Error(vscode.l10n.t('Run a data compare first.')); }
      const target = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, saveLabel: 'Export',
        defaultUri: vscode.Uri.file(`${lastCompare.title.replace(/\W+/g, '_')}.csv`) });
      if (!target) { return; }
      await vscode.workspace.fs.writeFile(target, Buffer.from('﻿' + toCsv(lastCompare.columns, lastCompare.rows), 'utf8'));
      vscode.window.showInformationMessage(vscode.l10n.t('Exported {0} difference(s) to {1}', lastCompare.rows.length, target.fsPath));
    })),
    vscode.commands.registerCommand('vanthrex.explainMessage', guard((id?: string) => explainMessage(manager, typeof id === 'string' ? id : undefined))),
    vscode.commands.registerCommand('vanthrex.analyzeJobLog', guard((n?: { job?: string } | string) =>
      analyzeJobLogCmd(manager, typeof n === 'string' ? n : n?.job))),

    // Hover any message ID in any editor (job logs, compile listings, source comments, SQL…).
    vscode.languages.registerHoverProvider({ scheme: '*' }, {
      async provideHover(doc, pos) {
        const conn = manager.connection;
        if (!conn) { return undefined; }
        const range = doc.getWordRangeAtPosition(pos, /[A-Z]{3}[0-9A-F]{4}/);
        if (!range) { return undefined; }
        const id = doc.getText(range);
        if (!MESSAGE_ID.test(id)) { return undefined; }
        const m = await messageText(conn, id);
        const hint = messageHint(id);
        if (!m && !hint) { return undefined; }
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**${id}**${m?.sev ? ` · severity ${m.sev}` : ''}  \n`);
        if (m?.text) { md.appendText(m.text); md.appendMarkdown('\n\n'); }
        if (hint) { md.appendMarkdown(`💡 ${hint.replace(/[*_`]/g, '')}\n\n`); }
        if (m?.help) { md.appendText(formatHelp(m.help).slice(0, 1200)); }
        return new vscode.Hover(md, range);
      },
    }),
  );
}
