import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { SqlResult } from '../core/sql';
import { errorMessage, logError, showLog } from '../core/log';
import { isDestructiveSql, statementAtOffset, toCsv } from '../core/util';
import { escapeHtml, nonce } from './webviewUtil';

const HISTORY_KEY = 'silverlake.sqlHistory';
const CL_HISTORY_KEY = 'silverlake.clHistory';

class ResultsPanel {
  private static panel?: vscode.WebviewPanel;
  private static last?: SqlResult;

  static show(sql: string, result: SqlResult): void {
    ResultsPanel.last = result;
    if (!ResultsPanel.panel) {
      ResultsPanel.panel = vscode.window.createWebviewPanel('silverlake.sqlResults', 'SQL Results',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true });
      ResultsPanel.panel.onDidDispose(() => { ResultsPanel.panel = undefined; });
      ResultsPanel.panel.webview.onDidReceiveMessage(async m => {
        const r = ResultsPanel.last;
        if (!r) { return; }
        if (m.type === 'exportCsv') {
          const target = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, saveLabel: 'Export' });
          if (target) {
            await vscode.workspace.fs.writeFile(target, Buffer.from('﻿' + toCsv(r.columns, r.rows), 'utf8'));
            vscode.window.showInformationMessage(`Exported ${r.rows.length} rows to ${target.fsPath}`);
          }
        }
        if (m.type === 'copyCsv') {
          await vscode.env.clipboard.writeText(toCsv(r.columns, r.rows));
          vscode.window.setStatusBarMessage('$(clippy) Results copied as CSV', 3000);
        }
      });
    } else {
      ResultsPanel.panel.reveal(undefined, true);
    }
    ResultsPanel.panel.title = `SQL Results (${result.rows.length})`;
    ResultsPanel.panel.webview.html = ResultsPanel.html(sql, result);
  }

  private static html(sql: string, r: SqlResult): string {
    const n = nonce();
    // Embed data safely inside <script>: escape "<" so "</script>" in data cannot break out.
    const payload = JSON.stringify({ columns: r.columns, rows: r.rows.map(row => r.columns.map(c => row[c] ?? null)) })
      .replace(/</g, '\\u003c');
    const info = r.columns.length
      ? `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}${r.truncated ? ' (limit reached — raise silverlake.sql.maxRows for more)' : ''}`
      : (r.updateCount >= 0 ? `${r.updateCount} row(s) affected` : 'Statement completed');
    return /* html */ `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 8px; margin: 0; }
  header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 8px 0; z-index: 2; }
  .sql { font-family: var(--vscode-editor-font-family); font-size: 0.9em; color: var(--vscode-descriptionForeground);
    white-space: pre-wrap; max-height: 4.5em; overflow: auto; margin-bottom: 6px; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-right: auto; }
  input { padding: 4px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; min-width: 200px; }
  button { padding: 4px 12px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { border: 1px solid var(--vscode-editorWidget-border, #8883); padding: 3px 8px; text-align: left; white-space: pre; }
  th { position: sticky; top: var(--hdr, 80px); background: var(--vscode-editorWidget-background); cursor: pointer; user-select: none; }
  th .t { color: var(--vscode-descriptionForeground); font-weight: normal; }
  tr:nth-child(even) td { background: var(--vscode-list-hoverBackground); }
  td.num { text-align: right; } td.null { color: var(--vscode-disabledForeground); font-style: italic; }
  .wrap { overflow: auto; }
</style></head><body>
<header id="hdr">
  <div class="sql">${escapeHtml(sql)}</div>
  <div class="bar">
    <span class="meta">${escapeHtml(info)} · ${r.elapsedMs} ms · ${escapeHtml(r.engine)}</span>
    ${r.columns.length ? `<input id="filter" placeholder="Filter rows…">
    <button id="copy">Copy CSV</button><button id="export">Export CSV…</button>` : ''}
  </div>
</header>
<div class="wrap"><table id="grid"></table></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const data = ${payload};
  let rows = data.rows.slice(); let sortCol = -1; let asc = true;
  const grid = document.getElementById('grid');
  const isNum = v => typeof v === 'number' || (typeof v === 'string' && /^-?\\d+(\\.\\d+)?$/.test(v.trim()));
  function render() {
    if (!data.columns.length) { grid.innerHTML = ''; return; }
    const f = (document.getElementById('filter')?.value || '').toLowerCase();
    const shown = f ? rows.filter(r => r.some(v => v !== null && String(v).toLowerCase().includes(f))) : rows;
    const head = '<tr>' + data.columns.map((c, i) => '<th data-i="' + i + '">' + esc(c) +
      (i === sortCol ? (asc ? ' ▲' : ' ▼') : '') + '</th>').join('') + '</tr>';
    const body = shown.slice(0, 5000).map(r => '<tr>' + r.map(v => v === null
      ? '<td class="null">null</td>'
      : '<td' + (isNum(v) ? ' class="num"' : '') + '>' + esc(String(v)) + '</td>').join('') + '</tr>').join('');
    grid.innerHTML = head + body;
    grid.querySelectorAll('th').forEach(th => th.addEventListener('click', () => sort(Number(th.dataset.i))));
  }
  function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  function sort(i) {
    asc = sortCol === i ? !asc : true; sortCol = i;
    rows.sort((a, b) => {
      const x = a[i], y = b[i];
      if (x === y) return 0; if (x === null) return 1; if (y === null) return -1;
      const r = isNum(x) && isNum(y) ? Number(x) - Number(y) : String(x).localeCompare(String(y));
      return asc ? r : -r;
    });
    render();
  }
  document.getElementById('filter')?.addEventListener('input', render);
  document.getElementById('export')?.addEventListener('click', () => vscode.postMessage({ type: 'exportCsv' }));
  document.getElementById('copy')?.addEventListener('click', () => vscode.postMessage({ type: 'copyCsv' }));
  const setHdr = () => document.body.style.setProperty('--hdr', document.getElementById('hdr').offsetHeight + 'px');
  window.addEventListener('resize', setHdr); setHdr();
  render();
</script></body></html>`;
  }
}

export async function runSqlAndShow(manager: ConnectionManager, state: vscode.Memento, sql: string): Promise<void> {
  const conn = manager.require();
  const cfg = vscode.workspace.getConfiguration('silverlake');
  if (cfg.get<boolean>('sql.confirmDestructive', true) && isDestructiveSql(sql)) {
    const ok = await vscode.window.showWarningMessage(
      'This statement can change or remove a lot of data. Run it?', { modal: true }, 'Run');
    if (ok !== 'Run') { return; }
  }
  const maxRows = cfg.get<number>('sql.maxRows', 500);
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Running SQL…' },
      () => conn.sql(sql, maxRows));
    ResultsPanel.show(sql, result);
    const history = state.get<string[]>(HISTORY_KEY, []).filter(s => s !== sql);
    await state.update(HISTORY_KEY, [sql, ...history].slice(0, 50));
  } catch (e) {
    logError(e);
    const choice = await vscode.window.showErrorMessage(`SQL error: ${errorMessage(e)}`, 'Show Log');
    if (choice) { showLog(); }
  }
}

export function registerSql(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const state = context.globalState;
  context.subscriptions.push(
    vscode.commands.registerCommand('silverlake.runSql', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        let sql: string | undefined;
        if (editor && editor.document.languageId === 'sql') {
          sql = editor.selection.isEmpty
            ? statementAtOffset(editor.document.getText(), editor.document.offsetAt(editor.selection.active))
            : editor.document.getText(editor.selection);
        } else {
          const history = state.get<string[]>(HISTORY_KEY, []);
          const pick = await vscode.window.showQuickPick(
            [{ label: '$(edit) Type a new statement…', sql: '' }, ...history.map(h => ({ label: h.replace(/\s+/g, ' '), sql: h }))],
            { title: 'Run SQL', placeHolder: 'Pick a recent statement or type a new one' });
          if (!pick) { return; }
          sql = pick.sql || await vscode.window.showInputBox({ title: 'Run SQL', prompt: 'SQL statement', ignoreFocusOut: true });
        }
        sql = sql?.trim().replace(/;\s*$/, '');
        if (!sql) { return; }
        await runSqlAndShow(manager, state, sql);
      } catch (e) {
        vscode.window.showErrorMessage(errorMessage(e));
      }
    }),

    vscode.commands.registerCommand('silverlake.newSqlScratchpad', async () => {
      const lib = manager.connection?.profile.currentLibrary || manager.connection?.profile.libraries[0] || 'QSYS2';
      const doc = await vscode.workspace.openTextDocument({
        language: 'sql',
        content:
          `-- Silverlake SQL scratchpad. Put the cursor in a statement and press Ctrl+Enter.\n` +
          `-- Statements are separated by semicolons. Results open in a grid you can filter and export.\n\n` +
          `SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS('${lib}', '*ALL')) ORDER BY OBJTYPE, OBJNAME;\n\n` +
          `SELECT JOB_NAME, JOB_STATUS, FUNCTION, ELAPSED_CPU_PERCENTAGE\n  FROM TABLE(QSYS2.ACTIVE_JOB_INFO(CURRENT_USER_LIST_FILTER => CURRENT USER));\n\n` +
          `SELECT * FROM TABLE(QSYS2.JOBLOG_INFO('*')) ORDER BY ORDINAL_POSITION DESC;\n`,
      });
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('silverlake.runCl', async (preset?: string) => {
      try {
        const conn = manager.require();
        let cmd = typeof preset === 'string' ? preset : undefined;
        if (!cmd) {
          const history = state.get<string[]>(CL_HISTORY_KEY, []);
          const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
          qp.title = 'Run CL command';
          qp.placeholder = 'Type a CL command (e.g. WRKACTJOB is interactive – use batch-friendly commands like DSPLIBL OUTPUT(*PRINT))';
          const recent = history.map(h => ({ label: h, description: 'recent' }));
          qp.items = recent;
          qp.onDidChangeValue(v => {
            qp.items = v.trim() && !history.includes(v.trim())
              ? [{ label: v.trim(), description: 'run this command', alwaysShow: true }, ...recent]
              : recent;
          });
          cmd = await new Promise<string | undefined>(resolve => {
            qp.onDidAccept(() => { resolve(qp.selectedItems[0]?.label ?? qp.value); qp.hide(); });
            qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
            qp.show();
          });
        }
        cmd = cmd?.trim();
        if (!cmd) { return; }
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Running ${cmd.split(/\s|\(/)[0]}…` },
          () => conn.runCL(cmd!));
        const history = state.get<string[]>(CL_HISTORY_KEY, []).filter(h => h !== cmd);
        await state.update(CL_HISTORY_KEY, [cmd, ...history].slice(0, 50));
        const output = (r.stdout + '\n' + r.stderr).trim();
        const firstLine = output.split('\n').filter(Boolean).slice(-1)[0] ?? '';
        if (r.ok) {
          const c = await vscode.window.showInformationMessage(`✔ ${cmd}${firstLine ? ` — ${firstLine}` : ''}`, 'Show Output');
          if (c) { showLog(); }
        } else {
          const c = await vscode.window.showErrorMessage(`✖ ${cmd} — ${firstLine || 'failed'}`, 'Show Output');
          if (c) { showLog(); }
        }
      } catch (e) {
        vscode.window.showErrorMessage(errorMessage(e));
      }
    }),
  );
}
