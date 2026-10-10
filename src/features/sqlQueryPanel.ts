// "Run SQL Query…": an SQL editor panel with ready-made queries for what was clicked
// (library, source file, member or object) and the results right underneath.

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, logError } from '../core/log';
import { isDestructiveSql, statementAtOffset, toCsv } from '../core/util';
import { SqlTarget, SqlTemplate, sqlTemplatesFor, targetLabel } from '../core/sqlTemplates';
import { escapeHtml, nonce } from './webviewUtil';

const HISTORY_KEY = 'vanthrex.sqlHistory';
const MAX_SHOWN = 5000;

/** Accepts a Libraries-view node, a call graph / report object ({ library, name, type }) or nothing. */
export function toSqlTarget(arg: unknown, fallbackLibrary?: string): SqlTarget | undefined {
  const a = (arg ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
  const library = s('library') ?? fallbackLibrary;
  if (!library) { return undefined; }
  if (s('member')) { return { library, file: s('file'), member: s('member') }; }
  if (a.kind === 'srcfile') { return { library, file: s('file') }; }
  if (a.kind === 'library' || !s('name')) { return { library }; }
  return { library, name: s('name'), type: s('type') };
}

class SqlQueryPanel {
  private static current?: SqlQueryPanel;
  private readonly panel: vscode.WebviewPanel;
  private last?: { columns: string[]; rows: Record<string, unknown>[] };

  static show(manager: ConnectionManager, state: vscode.Memento, target: SqlTarget | undefined): void {
    if (!SqlQueryPanel.current) { SqlQueryPanel.current = new SqlQueryPanel(manager, state); }
    SqlQueryPanel.current.load(target);
  }

  private constructor(private readonly manager: ConnectionManager, private readonly state: vscode.Memento) {
    this.panel = vscode.window.createWebviewPanel('vanthrex.sqlQuery', 'SQL', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.onDidDispose(() => { SqlQueryPanel.current = undefined; });
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => {
      logError(e); this.post({ type: 'error', message: errorMessage(e) });
    }));
  }

  private post(m: unknown): void { void this.panel.webview.postMessage(m); }

  private load(target: SqlTarget | undefined): void {
    const templates: SqlTemplate[] = target ? sqlTemplatesFor(target) : [];
    const label = target ? targetLabel(target) : (this.manager.connection?.profile.name ?? 'IBM i');
    const first = templates[0]?.sql ?? 'SELECT *\n  FROM ';
    this.panel.title = `SQL: ${label}`;
    this.panel.webview.html = this.html(label, templates, first);
    this.panel.reveal();
  }

  private async onMessage(m: { type: string; text?: string; offset?: number; selection?: string }): Promise<void> {
    if (m.type === 'run') {
      const raw = (m.selection?.trim() ? m.selection : statementAtOffset(m.text ?? '', m.offset ?? 0)) ?? m.text ?? '';
      const sql = raw.trim().replace(/;\s*$/, '');
      if (!sql) { this.post({ type: 'error', message: 'Type a statement first.' }); return; }
      await this.run(sql);
    } else if (m.type === 'scratchpad') {
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `${(m.text ?? '').trim().replace(/;?\s*$/, ';')}\n` });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } else if (m.type === 'csv' && this.last) {
      await vscode.env.clipboard.writeText(toCsv(this.last.columns, this.last.rows));
      vscode.window.showInformationMessage(`${this.last.rows.length} row(s) copied as CSV — paste them into Excel or a file.`);
    }
  }

  private async run(sql: string): Promise<void> {
    const conn = this.manager.require();
    const cfg = vscode.workspace.getConfiguration('vanthrex');
    if (cfg.get<boolean>('sql.confirmDestructive', true) && isDestructiveSql(sql)) {
      const ok = await vscode.window.showWarningMessage('This statement can change or remove a lot of data. Run it?', { modal: true }, 'Run');
      if (ok !== 'Run') { this.post({ type: 'error', message: 'Not run.' }); return; }
    }
    this.post({ type: 'running' });
    const maxRows = cfg.get<number>('sql.maxRows', 500);
    const r = await conn.sql(sql, maxRows);
    this.last = { columns: r.columns, rows: r.rows };
    const history = this.state.get<string[]>(HISTORY_KEY, []).filter(s => s !== sql);
    await this.state.update(HISTORY_KEY, [sql, ...history].slice(0, 50));
    const cell = (v: unknown) => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    this.post({
      type: 'result', columns: r.columns,
      rows: r.rows.slice(0, MAX_SHOWN).map(row => r.columns.map(c => cell(row[c]))),
      info: r.columns.length
        ? `${r.rows.length} row(s)${r.truncated ? ` — stopped at ${maxRows} (setting vanthrex.sql.maxRows)` : ''} · ${r.elapsedMs} ms · ${conn.profile.name}`
        : `Done: ${r.updateCount >= 0 ? r.updateCount + ' row(s) affected' : 'statement ran'} · ${r.elapsedMs} ms · ${conn.profile.name}`,
    });
  }

  private html(label: string, templates: SqlTemplate[], sql: string): string {
    const n = nonce();
    const options = templates.map((t, i) => `<option value="${i}">${escapeHtml(t.label)}</option>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px 14px; margin: 0; }
  h1 { font-size: 1.15em; margin: 0 0 8px; } .dim { color: var(--vscode-descriptionForeground); }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
  select, input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #8884); padding: 3px 6px; }
  button { padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  textarea { width: 100%; box-sizing: border-box; height: 150px; resize: vertical; font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
    border: 1px solid var(--vscode-input-border, #8884); padding: 8px; tab-size: 2; }
  #status { margin: 6px 0; } .err { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  .grid { overflow: auto; max-height: calc(100vh - 330px); border: 1px solid var(--vscode-editorWidget-border, #8883); }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  th, td { padding: 3px 8px; border-bottom: 1px solid var(--vscode-editorWidget-border, #8882); text-align: left; white-space: pre; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); cursor: pointer; }
  tr:hover td { background: var(--vscode-list-hoverBackground); } td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
</style></head><body>
<h1>SQL — ${escapeHtml(label)}</h1>
<div class="bar">
  ${templates.length ? `<label>Ready-made query <select id="tpl">${options}</select></label>` : ''}
  <button class="primary" id="run" title="Run the selected text, or the statement under the cursor (Ctrl+Enter)">▶ Run</button>
  <button id="pad" title="Open this query in an SQL scratchpad editor">Open in scratchpad</button>
  <span class="dim">Edit the query freely · Ctrl+Enter runs it</span>
</div>
<textarea id="sql" spellcheck="false">${escapeHtml(sql)}</textarea>
<div class="bar"><span id="status" class="dim">Press Run to see the data.</span>
  <input id="filter" placeholder="Filter rows…" style="display:none">
  <button id="csv" style="display:none">Copy as CSV</button></div>
<div class="grid" id="grid"></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const templates = ${JSON.stringify(templates.map(t => t.sql)).replace(/</g, '\\u003c')};
  const ta = document.getElementById('sql'), status = document.getElementById('status'), grid = document.getElementById('grid');
  const filter = document.getElementById('filter'), csv = document.getElementById('csv');
  let data = { columns: [], rows: [] }, sortCol = -1, sortDir = 1;
  const tpl = document.getElementById('tpl');
  if (tpl) tpl.addEventListener('change', () => { ta.value = templates[tpl.value]; ta.focus(); });
  const run = () => {
    const sel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
    vscode.postMessage({ type: 'run', text: ta.value, offset: ta.selectionStart, selection: sel });
  };
  document.getElementById('run').addEventListener('click', run);
  document.getElementById('pad').addEventListener('click', () => vscode.postMessage({ type: 'scratchpad', text: ta.value }));
  csv.addEventListener('click', () => vscode.postMessage({ type: 'csv' }));
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
    else if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
  });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const draw = () => {
    const f = filter.value.toLowerCase();
    let rows = f ? data.rows.filter(r => r.some(v => v !== null && v.toLowerCase().includes(f))) : data.rows.slice();
    if (sortCol >= 0) rows.sort((a, b) => {
      const x = a[sortCol], y = b[sortCol];
      if (x === y) return 0; if (x === null) return 1; if (y === null) return -1;
      const nx = Number(x), ny = Number(y);
      return (!isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y)) * sortDir;
    });
    grid.innerHTML = data.columns.length ? '<table><thead><tr>' +
      data.columns.map((c, i) => '<th data-i="' + i + '">' + esc(c) + (i === sortCol ? (sortDir > 0 ? ' ▲' : ' ▼') : '') + '</th>').join('') +
      '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(v => v === null ? '<td class="null">null</td>' : '<td>' + esc(v) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table>' : '';
  };
  grid.addEventListener('click', e => {
    const th = e.target.closest('th'); if (!th) return;
    const i = Number(th.dataset.i); sortDir = sortCol === i ? -sortDir : 1; sortCol = i; draw();
  });
  filter.addEventListener('input', draw);
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'running') { status.className = 'dim'; status.textContent = 'Running…'; }
    else if (m.type === 'error') { status.className = 'err'; status.textContent = m.message; }
    else if (m.type === 'result') {
      data = { columns: m.columns, rows: m.rows }; sortCol = -1; filter.value = '';
      status.className = 'dim'; status.textContent = m.info;
      filter.style.display = csv.style.display = m.columns.length ? '' : 'none';
      draw();
    }
  });
  ta.focus();
</script></body></html>`;
  }
}

export function registerSqlQueryPanel(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.sqlQuery', (arg?: unknown) => {
      try {
        const conn = manager.require();
        SqlQueryPanel.show(manager, context.globalState, toSqlTarget(arg, conn.profile.currentLibrary || undefined));
      } catch (e) { vscode.window.showErrorMessage(errorMessage(e)); }
    }),
  );
}
