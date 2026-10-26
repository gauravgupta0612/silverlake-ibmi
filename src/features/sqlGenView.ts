// SQL generators: a CREATE TABLE for a CSV or Excel file (column types guessed from the data, then the rows imported),
// a JSON_TABLE query for a JSON sample, and a text search across recent spooled files.
import * as vscode from 'vscode';
import { createTableSql, guessColumns, jsonTableSql, spooledFilesSql, spoolSearchSql } from '../core/sqlGen';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { assertSystemName } from '../core/util';
import { readFileRows } from './dataTransferView';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const ALLOWED = new Set(['vanthrex.searchSpooledFiles', 'vanthrex.spoolOpen']);

async function csvToTable(manager: ConnectionManager, uri?: vscode.Uri): Promise<void> {
  const file = uri ?? (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'CSV or Excel': ['csv', 'txt', 'xlsx'] }, openLabel: vscode.l10n.t('Create table') }))?.[0];
  if (!file) { return; }
  const all = await readFileRows(file);
  if (all.length < 2) { throw new Error(vscode.l10n.t('The file needs a header row and at least one data row.')); }
  const [header, ...rows] = all;
  const cols = guessColumns(header, rows);
  const base = (file.path.split('/').pop() ?? 'DATA').replace(/\.[^.]*$/, '');
  const conn = manager.connection;
  const lib = await vscode.window.showInputBox({ title: vscode.l10n.t('Create the table in which library?'), value: conn?.profile.currentLibrary ?? '', ignoreFocusOut: true });
  if (!lib?.trim()) { return; }
  const table = await vscode.window.showInputBox({ title: vscode.l10n.t('Table name'), value: base.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^[^A-Z]+/, '').slice(0, 10) || 'DATA', ignoreFocusOut: true,
    validateInput: v => (/^[A-Za-z$#@][A-Za-z0-9$#@_]{0,9}$/.test(v.trim()) ? undefined : vscode.l10n.t('1 to 10 characters, starting with a letter.')) });
  if (!table) { return; }
  const schema = assertSystemName(lib.trim(), 'library'); const name = table.trim().toUpperCase();
  const sql = createTableSql(schema, name, cols, base);
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `-- ${vscode.l10n.t('From {0}: {1} row(s). Types guessed from the data: check them before running.', file.path.split('/').pop() ?? '', rows.length)}\n${sql}` });
  await vscode.window.showTextDocument(doc, { preview: false });
  if (!conn) { return; }
  const create = vscode.l10n.t('Create and Import'); const only = vscode.l10n.t('Create Only');
  const c = await vscode.window.showInformationMessage(vscode.l10n.t('Create {0}.{1} with {2} column(s)?', schema, name, cols.length), create, only);
  if (!c) { return; }
  // Run the statements from the editor, so the edits the user made to the types are used.
  for (const stmt of doc.getText().split(/;\s*$/m).map(x => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) { await conn.sql(stmt); }
  vscode.window.setStatusBarMessage(vscode.l10n.t('{0}.{1} created.', schema, name), 5000);
  if (c === create) { await vscode.commands.executeCommand('vanthrex.importData', { library: schema, name, file }); }
}

async function jsonTable(uri?: vscode.Uri): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  let text = uri ? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) : ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : ed?.document.languageId === 'json' ? ed.document.getText() : '';
  if (!text.trim()) {
    const f = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json', 'txt'] }, title: vscode.l10n.t('A JSON sample (or select JSON text in an editor first)') }))?.[0];
    if (!f) { return; }
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(f));
  }
  const kind = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(file) A file in the IFS'), id: 'ifs' as const },
    { label: vscode.l10n.t('$(table) A column of a table'), id: 'column' as const },
    { label: vscode.l10n.t('$(symbol-variable) A host variable (embedded SQL)'), id: 'variable' as const },
  ], { title: vscode.l10n.t('Where is the JSON read from?') });
  if (!kind) { return; }
  let sql: string;
  if (kind.id === 'ifs') {
    const p = await vscode.window.showInputBox({ title: vscode.l10n.t('IFS path of the JSON file'), placeHolder: '/home/me/orders.json', ignoreFocusOut: true });
    if (!p?.trim()) { return; }
    sql = jsonTableSql(text, { kind: 'ifs', path: p.trim() });
  } else if (kind.id === 'column') {
    const t = await vscode.window.showInputBox({ title: vscode.l10n.t('Table and column'), placeHolder: 'APPLIB.MESSAGES.BODY', prompt: 'SCHEMA.TABLE.COLUMN', ignoreFocusOut: true,
      validateInput: v => (/^[A-Za-z$#@_][\w$#@]*\.[A-Za-z$#@_][\w$#@]*\.[A-Za-z$#@_][\w$#@]*$/.test(v.trim()) ? undefined : 'SCHEMA.TABLE.COLUMN') });
    if (!t) { return; }
    const parts = t.trim().toUpperCase().split('.');
    sql = jsonTableSql(text, { kind: 'column', table: `${parts[0]}.${parts[1]}`, column: parts[2] });
  } else { sql = jsonTableSql(text, { kind: 'variable' }); }
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

async function searchSpooled(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const text = (await vscode.window.showInputBox({ title: vscode.l10n.t('Find a text in spooled files'), value: state.get<string>('vanthrex.spoolSearch.last', ''), prompt: vscode.l10n.t('An order number, a customer name, an error text…') }))?.trim();
  if (!text) { return; }
  const who = (await vscode.window.showInputBox({ title: vscode.l10n.t('Whose spooled files?'), value: conn.user, prompt: vscode.l10n.t('User profile, or *ALL (slower)') }))?.trim();
  if (!who) { return; }
  await state.update('vanthrex.spoolSearch.last', text);
  const days = vscode.workspace.getConfiguration('vanthrex').get<number>('spoolSearchDays', 7);
  const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Searching spooled files…'), cancellable: true }, async (progress, token) => {
    const files = await conn.rows<Row>(spooledFilesSql(who, days, 200), 200);
    const hits: { f: Row; line: number; data: string }[] = [];
    for (const [i, f] of files.entries()) {
      if (token.isCancellationRequested) { break; }
      progress.report({ message: `${i + 1}/${files.length} ${String(f.F).trim()}`, increment: 100 / files.length });
      const rows = await conn.rows<Row>(spoolSearchSql(String(f.J).trim(), String(f.F).trim(), Number(f.N), text), 20).catch(() => [] as Row[]);
      rows.forEach(r => hits.push({ f, line: Number(r.L), data: String(r.D ?? '').trim() }));
    }
    return { files: files.length, hits };
  });
  const node = (f: Row) => ({ job: String(f.J).trim(), name: String(f.F).trim(), number: Number(f.N) });
  showReport('spoolSearch', {
    title: vscode.l10n.t('"{0}" in spooled files', text),
    subtitle: vscode.l10n.t('{0} line(s) in {1} of the {2} spooled file(s) of {3} from the last {4} days.', found.hits.length, new Set(found.hits.map(h => `${h.f.J}${h.f.F}${h.f.N}`)).size, found.files, who, days),
    actions: [{ label: vscode.l10n.t('Search again…'), command: 'vanthrex.searchSpooledFiles' }],
    tables: [{ title: vscode.l10n.t('Lines found'), filter: true, columns: ['Spooled file', 'Job', 'Created', 'Line', 'Text'],
      rows: found.hits.map(h => [`${String(h.f.F).trim()} #${h.f.N}`, String(h.f.J).trim(), String(h.f.C ?? ''), h.line, h.data]),
      rowActions: found.hits.map(h => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.spoolOpen', args: [node(h.f)] })), empty: vscode.l10n.t('Not found.') }],
    note: vscode.l10n.t('Searched with SYSTOOLS.SPOOLED_FILE_DATA, at most 20 lines per spooled file.'),
  }, ALLOWED);
}

export function registerSqlGen(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.csvToTable', wrap((uri?: vscode.Uri) => csvToTable(manager, uri instanceof vscode.Uri ? uri : undefined))),
    vscode.commands.registerCommand('vanthrex.jsonTable', wrap((uri?: vscode.Uri) => jsonTable(uri instanceof vscode.Uri ? uri : undefined))),
    vscode.commands.registerCommand('vanthrex.searchSpooledFiles', wrap(() => searchSpooled(manager, context.globalState))),
  );
}
