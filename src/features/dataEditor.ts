import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, log, logError } from '../core/log';
import { assertSystemName, sqlString } from '../core/util';
import { ColumnInfo, deleteStatement, insertStatement, isEditableType, tableName, updateStatement } from '../core/sqlLiteral';
import { nonce, escapeHtml } from './webviewUtil';

interface Change {
  op: 'update' | 'insert' | 'delete';
  rrn?: number;
  values?: Record<string, string | null>;
  tempId?: number;
}

/** Spreadsheet-like editor for a physical file / table, keyed by relative record number. */
export class DataEditor {
  private static readonly open = new Map<string, DataEditor>();
  private readonly panel: vscode.WebviewPanel;
  private columns: ColumnInfo[] = [];
  private page = 0;
  private where = '';
  /** Shown with the next data refresh (e.g. failed saves), so the reload doesn't hide it. */
  private pendingError?: string;

  static show(manager: ConnectionManager, library: string, file: string): void {
    const key = `${library}/${file}`;
    const existing = DataEditor.open.get(key);
    if (existing) { existing.panel.reveal(); return; }
    DataEditor.open.set(key, new DataEditor(manager, assertSystemName(library, 'library'), assertSystemName(file, 'file')));
  }

  private constructor(private readonly manager: ConnectionManager, private readonly library: string, private readonly file: string) {
    this.panel = vscode.window.createWebviewPanel('vanthrex.dataEditor', `${library}/${file} (data)`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.onDidDispose(() => DataEditor.open.delete(`${library}/${file}`));
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => {
      logError(e);
      this.post({ type: 'error', text: errorMessage(e) });
    }));
    this.panel.webview.html = this.html();
  }

  private get pageSize(): number {
    return Math.max(10, vscode.workspace.getConfiguration('vanthrex').get<number>('dataEditor.pageSize', 100));
  }

  private post(m: object): void { this.panel.webview.postMessage(m); }

  private async loadColumns(): Promise<void> {
    const rows = await this.manager.require().rows<Record<string, unknown>>(
      `SELECT COLUMN_NAME, DATA_TYPE, LENGTH, COALESCE(NUMERIC_SCALE, 0) AS SCALE, IS_NULLABLE, COALESCE(COLUMN_TEXT, '') AS TEXT ` +
      `FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(this.library)} AND SYSTEM_TABLE_NAME = ${sqlString(this.file)} ` +
      `ORDER BY ORDINAL_POSITION`, 2000);
    if (!rows.length) { throw new Error(`${this.library}/${this.file} was not found or has no columns.`); }
    this.columns = rows.map(r => ({
      name: String(r.COLUMN_NAME).trim(), type: String(r.DATA_TYPE).trim(), length: Number(r.LENGTH ?? 0),
      scale: Number(r.SCALE ?? 0), nullable: String(r.IS_NULLABLE).trim() === 'Y', text: String(r.TEXT ?? '').trim(),
    }));
  }

  private async load(): Promise<void> {
    if (!this.columns.length) { await this.loadColumns(); }
    const conn = this.manager.require();
    const where = this.where.trim() ? ` WHERE ${this.where}` : '';
    const sql = `SELECT RRN(T) AS "__RRN", T.* FROM ${tableName(this.library, this.file)} T${where} ` +
      `ORDER BY RRN(T) LIMIT ${this.pageSize + 1} OFFSET ${this.page * this.pageSize}`;
    const result = await conn.sql(sql, this.pageSize + 1);
    const more = result.rows.length > this.pageSize;
    const rows = result.rows.slice(0, this.pageSize).map(r => ({
      rrn: Number(r.__RRN),
      values: Object.fromEntries(this.columns.map(c => [c.name, r[c.name] === undefined || r[c.name] === null ? null : String(r[c.name])])),
    }));
    let total: number | undefined;
    try {
      const t = await conn.rows<{ N: number }>(`SELECT COUNT(*) AS N FROM ${tableName(this.library, this.file)} T${where}`, 1);
      total = Number(t[0]?.N);
    } catch { total = undefined; }
    this.post({
      type: 'data', page: this.page, pageSize: this.pageSize, more, total, where: this.where,
      columns: this.columns.map(c => ({ ...c, editable: isEditableType(c.type) })), rows,
      error: this.pendingError,
    });
    this.pendingError = undefined;
  }

  private async onMessage(m: { type: string; page?: number; where?: string; changes?: Change[] }): Promise<void> {
    switch (m.type) {
      case 'ready': case 'reload': await this.load(); break;
      case 'page': this.page = Math.max(0, m.page ?? 0); await this.load(); break;
      case 'filter': this.where = (m.where ?? '').trim(); this.page = 0; await this.load(); break;
      case 'save': await this.save(m.changes ?? []); break;
    }
  }

  private async save(changes: Change[]): Promise<void> {
    if (!changes.length) { return; }
    const table = tableName(this.library, this.file);
    // Build every statement first so validation errors stop the save before anything is written.
    const statements: { sql: string; change: Change }[] = [];
    const problems: string[] = [];
    for (const c of changes) {
      try {
        const sql = c.op === 'update' ? updateStatement(table, c.rrn!, c.values ?? {}, this.columns)
          : c.op === 'insert' ? insertStatement(table, c.values ?? {}, this.columns)
          : deleteStatement(table, c.rrn!);
        statements.push({ sql, change: c });
      } catch (e) {
        problems.push(`${c.op} ${c.rrn ? `row ${c.rrn}` : 'new row'}: ${errorMessage(e)}`);
      }
    }
    if (problems.length) { this.post({ type: 'error', text: problems.join('\n') }); return; }

    const counts = { update: 0, insert: 0, delete: 0 };
    for (const s of statements) { counts[s.change.op]++; }
    const summary = [counts.update && `${counts.update} update(s)`, counts.insert && `${counts.insert} insert(s)`, counts.delete && `${counts.delete} delete(s)`]
      .filter(Boolean).join(', ');
    const ok = await vscode.window.showWarningMessage(`Write ${summary} to ${table}?`, { modal: true, detail: 'Changes are written immediately (no commitment control).' }, 'Save changes');
    if (ok !== 'Save changes') { return; }

    const conn = this.manager.require();
    const failed: string[] = [];
    let done = 0;
    for (const s of statements) {
      try {
        log(`[data editor] ${s.sql}`);
        await conn.sql(s.sql, 1);
        done++;
      } catch (e) {
        failed.push(`${s.change.op} ${s.change.rrn ? `row ${s.change.rrn}` : 'new row'}: ${errorMessage(e).split('\n')[0]}`);
      }
    }
    if (failed.length) {
      this.pendingError = `${done} change(s) saved, ${failed.length} failed (not saved — please redo them):\n${failed.join('\n')}`;
      vscode.window.showErrorMessage(`${failed.length} change(s) to ${table} failed. See the editor for details.`);
    } else {
      vscode.window.setStatusBarMessage(`$(check) ${done} change(s) saved to ${table}`, 4000);
    }
    await this.load();
  }

  private html(): string {
    const n = nonce();
    return /* html */ `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 10px 20px; margin: 0; }
  header { position: sticky; top: 0; z-index: 3; background: var(--vscode-editor-background); padding: 8px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 1.1em; margin: 0 8px 0 0; }
  input.where { flex: 1; min-width: 220px; }
  input, button { font: inherit; }
  input { padding: 4px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; }
  button { padding: 4px 10px; border: none; border-radius: 3px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  .meta { color: var(--vscode-descriptionForeground); font-size: .9em; }
  #error { white-space: pre-wrap; background: var(--vscode-inputValidation-errorBackground, #be110033); padding: 6px 10px; border-radius: 4px; margin: 6px 0; display: none; }
  .wrap { overflow: auto; }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { border: 1px solid var(--vscode-editorWidget-border, #8883); padding: 0; white-space: pre; }
  th { position: sticky; top: var(--hdr, 44px); background: var(--vscode-editorWidget-background); padding: 3px 8px; text-align: left; font-weight: 600; z-index: 2; }
  th small { display: block; font-weight: normal; color: var(--vscode-descriptionForeground); }
  td { padding: 2px 8px; min-width: 40px; }
  td.rrn { color: var(--vscode-descriptionForeground); text-align: right; }
  td.num { text-align: right; }
  td[contenteditable="true"]:focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  td.ro { color: var(--vscode-disabledForeground); }
  td.null { color: var(--vscode-disabledForeground); font-style: italic; }
  td.dirty { background: var(--vscode-diffEditor-insertedTextBackground, #9bb95533); }
  tr.deleted td { text-decoration: line-through; opacity: .5; }
  tr.new td { background: var(--vscode-diffEditor-insertedLineBackground, #9bb95522); }
  tr.selected td.rrn { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
</style></head><body>
<header id="hdr">
  <h1>${escapeHtml(this.library)}/${escapeHtml(this.file)}</h1>
  <input class="where" id="where" placeholder="Filter: SQL WHERE condition, e.g. CUSTNO > 1000 AND STATUS = 'A'">
  <button id="apply">Filter</button>
  <button id="prev">◀</button><span class="meta" id="pageinfo"></span><button id="next">▶</button>
  <button id="add">+ Row</button><button id="del">Delete row</button><button id="null">Set NULL</button>
  <button id="revert">Revert</button><button id="reload">Reload</button>
  <button class="primary" id="save" disabled>Save</button>
</header>
<div id="error"></div>
<div class="wrap"><table id="grid"><tr><td class="meta">Loading…</td></tr></table></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let state = null;           // last data from the extension
  let edits = new Map();      // rrn -> {col: value}
  let deletes = new Set();    // rrn
  let inserts = [];           // [{tempId, values}]
  let selected = null;        // {key, col}
  let nextTemp = 1;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const numeric = t => /^(DECIMAL|NUMERIC|INTEGER|INT|SMALLINT|BIGINT|FLOAT|DOUBLE|REAL|DECFLOAT)$/i.test(t);
  function dirtyCount() { let n = deletes.size + inserts.length; edits.forEach(v => n += Object.keys(v).length ? 1 : 0); return n; }
  function updateButtons() {
    const n = dirtyCount();
    $('save').disabled = n === 0; $('save').textContent = n ? 'Save (' + n + ')' : 'Save';
    $('prev').disabled = !state || state.page === 0 || n > 0;
    $('next').disabled = !state || !state.more || n > 0;
  }
  function cell(key, col, value, isNew) {
    const editable = col.editable;
    const cls = [numeric(col.type) ? 'num' : '', editable ? '' : 'ro', value === null ? 'null' : ''];
    const changed = isNew ? false : edits.has(key) && col.name in edits.get(key);
    if (changed) cls.push('dirty');
    return '<td class="' + cls.join(' ') + '" data-key="' + key + '" data-col="' + esc(col.name) + '"' +
      (editable ? ' contenteditable="true" spellcheck="false"' : '') + '>' + (value === null ? 'null' : esc(value)) + '</td>';
  }
  function render() {
    if (!state) return;
    const cols = state.columns;
    const head = '<tr><th>RRN</th>' + cols.map(c => '<th title="' + esc(c.text || '') + '">' + esc(c.name) +
      '<small>' + esc(c.type) + (c.length ? '(' + c.length + (c.scale ? ',' + c.scale : '') + ')' : '') + (c.nullable ? ' null' : '') + '</small></th>').join('') + '</tr>';
    const body = state.rows.map(r => {
      const vals = Object.assign({}, r.values, edits.get(String(r.rrn)) || {});
      return '<tr class="' + (deletes.has(r.rrn) ? 'deleted' : '') + (selected && selected.key === String(r.rrn) ? ' selected' : '') + '" data-key="' + r.rrn + '">' +
        '<td class="rrn">' + r.rrn + '</td>' + cols.map(c => cell(String(r.rrn), c, vals[c.name], false)).join('') + '</tr>';
    }).join('');
    const news = inserts.map(ins => '<tr class="new" data-key="n' + ins.tempId + '"><td class="rrn">new</td>' +
      cols.map(c => cell('n' + ins.tempId, c, ins.values[c.name] ?? '', true)).join('') + '</tr>').join('');
    $('grid').innerHTML = head + body + news;
    const from = state.page * state.pageSize + 1;
    $('pageinfo').textContent = state.rows.length ? from + '–' + (from + state.rows.length - 1) + (state.total !== undefined ? ' of ' + state.total : '') : 'no rows';
    updateButtons();
  }
  function original(key, col) {
    const r = state.rows.find(x => String(x.rrn) === key); return r ? r.values[col] : undefined;
  }
  function setValue(key, col, value) {
    if (key.startsWith('n')) {
      const ins = inserts.find(i => 'n' + i.tempId === key); if (ins) ins.values[col] = value;
    } else {
      const e = edits.get(key) || {};
      if (value === original(key, col)) delete e[col]; else e[col] = value;
      edits.set(key, e);
    }
    updateButtons();
  }
  $('grid').addEventListener('focusin', e => {
    const td = e.target.closest('td[data-col]'); if (!td) return;
    selected = { key: td.dataset.key, col: td.dataset.col };
    document.querySelectorAll('tr.selected').forEach(tr => tr.classList.remove('selected'));
    td.parentElement.classList.add('selected');
    if (td.classList.contains('null')) { td.textContent = ''; }
  });
  $('grid').addEventListener('focusout', e => {
    const td = e.target.closest('td[data-col]'); if (!td || !td.isContentEditable) return;
    const value = td.textContent;
    const was = td.dataset.key.startsWith('n') ? null : original(td.dataset.key, td.dataset.col);
    if (was === null && value === '') {
      // Cleared back to empty: new rows get '' (column default), existing NULL cells stay NULL.
      setValue(td.dataset.key, td.dataset.col, td.dataset.key.startsWith('n') ? '' : null);
      if (!td.dataset.key.startsWith('n')) { td.textContent = 'null'; td.classList.add('null'); td.classList.remove('dirty'); }
      return;
    }
    td.classList.remove('null');
    setValue(td.dataset.key, td.dataset.col, value);
    td.classList.toggle('dirty', !td.dataset.key.startsWith('n') && value !== was);
  });
  $('grid').addEventListener('keydown', e => {
    const td = e.target.closest('td[data-col]'); if (!td) return;
    if (e.key === 'Enter') { e.preventDefault(); const row = td.parentElement.nextElementSibling; const idx = [...td.parentElement.children].indexOf(td);
      (row ? row.children[idx] : td).focus(); }
    if (e.key === 'Escape') {
      const isNew = td.dataset.key.startsWith('n');
      const o = isNew ? '' : original(td.dataset.key, td.dataset.col);
      td.textContent = o === null || o === undefined ? '' : o;
      setValue(td.dataset.key, td.dataset.col, o === undefined ? '' : o);
      td.blur();
    }
  });
  $('add').addEventListener('click', () => {
    const values = {}; state.columns.forEach(c => values[c.name] = '');
    inserts.push({ tempId: nextTemp++, values }); render();
    const last = $('grid').querySelector('tr.new:last-child td[contenteditable]'); if (last) last.focus();
  });
  $('del').addEventListener('click', () => {
    if (!selected) return;
    if (selected.key.startsWith('n')) { inserts = inserts.filter(i => 'n' + i.tempId !== selected.key); }
    else { const rrn = Number(selected.key); deletes.has(rrn) ? deletes.delete(rrn) : deletes.add(rrn); }
    render();
  });
  $('null').addEventListener('click', () => {
    if (!selected) return;
    const col = state.columns.find(c => c.name === selected.col);
    if (!col || !col.nullable) { showError(selected.col + ' does not allow NULL.'); return; }
    setValue(selected.key, selected.col, null); render();
  });
  $('revert').addEventListener('click', () => { edits.clear(); deletes.clear(); inserts = []; hideError(); render(); });
  $('reload').addEventListener('click', () => { edits.clear(); deletes.clear(); inserts = []; vscode.postMessage({ type: 'reload' }); });
  $('prev').addEventListener('click', () => vscode.postMessage({ type: 'page', page: state.page - 1 }));
  $('next').addEventListener('click', () => vscode.postMessage({ type: 'page', page: state.page + 1 }));
  const applyFilter = () => { if (dirtyCount()) { showError('Save or revert your changes before filtering.'); return; }
    vscode.postMessage({ type: 'filter', where: $('where').value }); };
  $('apply').addEventListener('click', applyFilter);
  $('where').addEventListener('keydown', e => { if (e.key === 'Enter') applyFilter(); });
  $('save').addEventListener('click', () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const changes = [];
    edits.forEach((v, k) => { if (Object.keys(v).length && !deletes.has(Number(k))) changes.push({ op: 'update', rrn: Number(k), values: v }); });
    deletes.forEach(rrn => changes.push({ op: 'delete', rrn }));
    inserts.forEach(i => changes.push({ op: 'insert', values: i.values, tempId: i.tempId }));
    hideError(); vscode.postMessage({ type: 'save', changes });
  });
  function showError(t) { const el = $('error'); el.textContent = t; el.style.display = 'block'; }
  function hideError() { $('error').style.display = 'none'; }
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'data') { state = m; edits.clear(); deletes.clear(); inserts = []; selected = null; $('where').value = m.where || ''; hideError(); render(); if (m.error) showError(m.error); }
    if (m.type === 'error') showError(m.text);
  });
  const setHdr = () => document.body.style.setProperty('--hdr', $('hdr').offsetHeight + 'px');
  window.addEventListener('resize', setHdr); setHdr();
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}

export function registerDataEditor(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  context.subscriptions.push(vscode.commands.registerCommand('vanthrex.editData', async (n?: { library: string; name: string }) => {
    try {
      let library = n?.library;
      let file = n?.name;
      if (!library || !file) {
        const v = await vscode.window.showInputBox({ title: 'Edit table data', prompt: 'LIBRARY/FILE', placeHolder: 'MYLIB/CUSTMAST', ignoreFocusOut: true });
        if (!v?.includes('/')) { return; }
        [library, file] = v.trim().toUpperCase().split('/');
      }
      DataEditor.show(manager, library, file);
    } catch (e) {
      vscode.window.showErrorMessage(errorMessage(e));
    }
  }));
}
