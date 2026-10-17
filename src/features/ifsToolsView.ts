// IFS tools: search, permissions, CCSID and Create IFS Folder or File.
import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import {
  checkIfsPath, checkMode, chgautCommand, chgownCommand, COMMON_CCSIDS, convertCcsidCommand, DATA_AUTHORITIES, ifsGrepCommand, parseGrep,
  tagCcsidCommand,
} from '../core/ifsTools';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { formatBytes } from '../core/storage';
import { shSingleQuote, sqlString } from '../core/util';
import { ifsUri } from './fileSystems';
import { reportProgress, showReport } from './reportPanel';

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vscode.open', 'vanthrex.searchIfs', 'vanthrex.ifsPermissions', 'vanthrex.ifsPermissions.row', 'vanthrex.ifsCcsid',
  'vanthrex.ifsCcsid.change',
]);

const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function searchIfs(manager: ConnectionManager, n?: { path?: string; isDirectory?: boolean }): Promise<void> {
  const conn = manager.require();
  const folder = n?.path && n.isDirectory ? n.path : (await vscode.window.showInputBox({ title: vscode.l10n.t('Search text in IFS files'), prompt: vscode.l10n.t('Folder'), value: conn.profile.ifsHome ?? '/home', ignoreFocusOut: true }))?.trim();
  if (!folder) { return; }
  const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Find in {0}', folder), ignoreFocusOut: true });
  if (!text) { return; }
  const include = await vscode.window.showInputBox({ title: vscode.l10n.t('Only files named (optional)'), placeHolder: vscode.l10n.t('*.rpgle'), ignoreFocusOut: true });
  if (include === undefined) { return; }
  const r = await reportProgress('ifsSearch', vscode.l10n.t('Searching {0}…', folder), () => conn.exec(ifsGrepCommand(folder, text, { include, max: 2000 })));
  const hits = parseGrep(r.stdout);
  showReport('ifsSearch', {
    title: `"${text}" in ${folder}`, subtitle: vscode.l10n.t('{0} match(es) in {1} file(s){2}. Click one to open it at that line.', hits.length, new Set(hits.map(h => h.file)).size, hits.length >= 2000 ? ' (first 2000)' : ''),
    tables: [{ title: vscode.l10n.t('Matches'), filter: true, columns: ['File', 'Line', 'Text'], rows: hits.map(h => [h.file, h.line, h.text.trim().slice(0, 200)]),
      rowActions: hits.map(h => ({ label: vscode.l10n.t('Open'), command: 'vscode.open', args: [ifsUri(h.file), { selection: new vscode.Range(h.line - 1, 0, h.line - 1, 0) }] })), empty: vscode.l10n.t('No match.') }],
  }, ALLOWED);
}

type Row = Record<string, unknown>;

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

const pick = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { if (r && r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') { return String(r[k]).trim(); } } return ''; };

async function run(conn: IbmiConnection, cmd: string, warn = ''): Promise<boolean> {
  const p = await vscode.window.showWarningMessage(cmd, { modal: true, detail: warn || undefined }, vscode.l10n.t('Run'));
  if (p !== vscode.l10n.t('Run')) { return false; }
  const r = await progress(cmd.split(' ')[0], () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  return true;
}

async function ifsPermissions(manager: ConnectionManager, n?: { path?: string; isDirectory?: boolean }): Promise<void> {
  const conn = manager.require();
  const path = n?.path ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('IFS permissions'), prompt: vscode.l10n.t('Path'), value: conn.profile.ifsHome ?? '/home', ignoreFocusOut: true }))?.trim();
  if (!path) { return; }
  const rows = await reportProgress('ifsPerm', vscode.l10n.t('Reading from the IBM i…'), () => conn.rows<Row>(`SELECT * FROM TABLE(QSYS2.IFS_OBJECT_PRIVILEGES(PATH_NAME => ${sqlString(path)})) X`, 500));
  const owner = await reportProgress('ifsPerm', vscode.l10n.t('Reading from the IBM i…'), () => conn.rows<Row>(`SELECT * FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => ${sqlString(path)}, SUBTREE_DIRECTORIES => 'NO')) X WHERE PATH_NAME = ${sqlString(path)}`, 1).catch(() => []));
  const isDir = n?.isDirectory ?? /DIR/i.test(pick(owner[0], 'OBJECT_TYPE'));
  showReport('ifsPerm', {
    title: vscode.l10n.t('Permissions — {0}', path), subtitle: `Owner ${pick(owner[0], 'OBJECT_OWNER') || '?'}${pick(owner[0], 'PRIMARY_GROUP') ? `, primary group ${pick(owner[0], 'PRIMARY_GROUP')}` : ''}. Click a line to change it.`,
    actions: [{ label: vscode.l10n.t('Give someone access…'), command: 'vanthrex.ifsPermissions.row', args: [path, '', isDir] }, { label: vscode.l10n.t('Change owner…'), command: 'vanthrex.ifsPermissions.row', args: [path, '*OWNER', isDir] },
      { label: vscode.l10n.t('Refresh'), command: 'vanthrex.ifsPermissions', args: [{ path, isDirectory: isDir }] }],
    tables: [{ title: vscode.l10n.t('Who has access'), columns: ['User / group', 'Data authority', 'Object authorities'],
      rows: rows.map(r => [pick(r, 'AUTHORIZATION_NAME', 'AUTHORIZATION_USER'), pick(r, 'DATA_AUTHORITY'),
        ['OBJECT_EXISTENCE', 'OBJECT_MANAGEMENT', 'OBJECT_ALTER', 'OBJECT_REFERENCE'].filter(k => s(r, k) === 'YES').map(k => k.replace('OBJECT_', '').toLowerCase()).join(', ')]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Change…'), command: 'vanthrex.ifsPermissions.row', args: [path, pick(r, 'AUTHORIZATION_NAME', 'AUTHORIZATION_USER'), isDir] })) }],
    note: vscode.l10n.t('*RWX = read, write, execute (for a folder: list, create, enter). On a folder, Vanthrex can apply the change to everything below it too (SUBTREE(*ALL)).'),
  }, ALLOWED);
}

async function ifsPermissionRow(manager: ConnectionManager, path: string, user: string, isDir: boolean): Promise<void> {
  const conn = manager.require();
  const sub = async () => (isDir ? (await vscode.window.showQuickPick([{ label: vscode.l10n.t('Only this folder'), v: false }, { label: vscode.l10n.t('This folder and everything below it'), v: true }], { title: vscode.l10n.t('Apply to') }))?.v : false);
  if (user === '*OWNER') {
    const o = (await vscode.window.showInputBox({ title: vscode.l10n.t('New owner of {0}', path), ignoreFocusOut: true }))?.trim().toUpperCase();
    if (!o) { return; }
    const st = await sub(); if (st === undefined) { return; }
    if (await run(conn, chgownCommand(path, o, st))) { await ifsPermissions(manager, { path, isDirectory: isDir }); }
    return;
  }
  const u = user || (await vscode.window.showInputBox({ title: vscode.l10n.t('User, group or *PUBLIC'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!u) { return; }
  const a = await vscode.window.showQuickPick(DATA_AUTHORITIES, { title: vscode.l10n.t('Data authority of {0} on {1}', u, path) });
  if (!a) { return; }
  const st = await sub(); if (st === undefined) { return; }
  if (await run(conn, chgautCommand(path, u, a, st))) { await ifsPermissions(manager, { path, isDirectory: isDir }); }
}

async function ifsCcsid(manager: ConnectionManager, n?: { path?: string; isDirectory?: boolean }): Promise<void> {
  const conn = manager.require();
  const path = n?.path ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('IFS file or folder'), value: conn.profile.ifsHome ?? '/home', ignoreFocusOut: true }))?.trim();
  if (!path) { return; }
  const rows = await reportProgress('ifsCcsid', vscode.l10n.t('Reading CCSIDs…'), () => conn.rows<Row>(
    `SELECT PATH_NAME AS P, OBJECT_TYPE AS T, COALESCE(CCSID, 0) AS C, COALESCE(DATA_SIZE, 0) AS SZ FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => ${sqlString(path)}, SUBTREE_DIRECTORIES => 'NO', OBJECT_TYPE_LIST => '*ALLSTMF')) X ORDER BY PATH_NAME FETCH FIRST 2000 ROWS ONLY`, 2000));
  const byC = new Map<number, number>(); rows.forEach(r => byC.set(Number(r.C), (byC.get(Number(r.C)) ?? 0) + 1));
  showReport('ifsCcsid', {
    title: vscode.l10n.t('Character sets — {0}', path), subtitle: vscode.l10n.t('{0} stream file(s). Files tagged with the wrong CCSID show garbled text in VS Code, ACS and programs. Click a file to change it.', rows.length),
    facts: [...byC.entries()].map(([c, k]) => [`${c} ${COMMON_CCSIDS[c] ?? ''}`.trim(), k] as [string, number]),
    actions: [{ label: n?.isDirectory !== false ? 'Tag every file in this folder…' : 'Change…', command: 'vanthrex.ifsCcsid.change', args: [path, true] }],
    tables: [{ title: vscode.l10n.t('Files'), filter: true, columns: ['File', 'CCSID', 'Character set', 'Size'], rows: rows.map(r => [s(r, 'P'), s(r, 'C'), COMMON_CCSIDS[Number(r.C)] ?? '', formatBytes(Number(r.SZ))]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Change…'), command: 'vanthrex.ifsCcsid.change', args: [s(r, 'P'), false] })),
      rowClass: rows.map(r => (Number(r.C) === 65535 ? 'bad' : undefined)) }],
    note: vscode.l10n.t('"Tag" only changes the label (when the content is already in that character set); "Convert" rewrites the content into the new character set.'),
  }, ALLOWED);
}

async function changeCcsid(manager: ConnectionManager, path: string, many: boolean): Promise<void> {
  const conn = manager.require();
  const how = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(tag) Tag only (the content already is in that character set)'), v: 'tag' },
    ...(many ? [] : [{ label: vscode.l10n.t('$(sync) Convert the content to another character set'), v: 'convert' }]),
  ], { title: path });
  if (!how) { return; }
  const c = await vscode.window.showQuickPick([...Object.entries(COMMON_CCSIDS).map(([k, v]) => ({ label: k, description: v })), { label: vscode.l10n.t('Other…'), description: '' }], { title: vscode.l10n.t('CCSID') });
  if (!c) { return; }
  const ccsid = Number(c.description ? c.label : await vscode.window.showInputBox({ title: vscode.l10n.t('CCSID'), validateInput: x => (/^\d+$/.test(x) ? undefined : vscode.l10n.t('A number')) }));
  if (!ccsid) { return; }
  const cmd = how.v === 'tag' ? tagCcsidCommand(path, ccsid, many) : convertCcsidCommand(path, ccsid);
  const ok = await vscode.window.showWarningMessage(cmd, { modal: true, detail: how.v === 'convert' ? vscode.l10n.t('The file is rewritten in the new character set.') : undefined }, vscode.l10n.t('Run'));
  if (ok !== vscode.l10n.t('Run')) { return; }
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
}

async function createIfs(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  const node = a as { path?: string; isDirectory?: boolean } | undefined;
  const base = node?.path ? (node.isDirectory === false ? node.path.replace(/\/[^/]*$/, '') || '/' : node.path) : `/home/${conn.user.toLowerCase()}`;
  const kind = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(new-folder) Folder'), k: 'dir', detail: vscode.l10n.t('Creates the missing parent folders too') },
    { label: vscode.l10n.t('$(new-file) File (UTF-8)'), k: 'file', detail: vscode.l10n.t('Empty file tagged CCSID 1208, opened in the editor') },
  ], { title: vscode.l10n.t('Create in the IFS') });
  if (!kind) { return; }
  const raw = await vscode.window.showInputBox({ title: kind.k === 'dir' ? vscode.l10n.t('New folder (full path)') : vscode.l10n.t('New file (full path)'), value: `${base.replace(/\/$/, '')}/`, ignoreFocusOut: true,
    validateInput: v => { try { checkIfsPath(v); return undefined; } catch (e) { return errorMessage(e); } } });
  if (!raw) { return; }
  const path = checkIfsPath(raw);
  const exists = await conn.stat(path).then(() => true, () => false);
  if (exists) { throw new Error(vscode.l10n.t('{0} already exists.', path)); }
  const mode = await vscode.window.showInputBox({ title: vscode.l10n.t('Permissions (optional)'), prompt: vscode.l10n.t('Octal, e.g. 755 for a folder or 644 for a file; empty keeps the default'), ignoreFocusOut: true,
    validateInput: v => { if (!v.trim()) { return undefined; } try { checkMode(v); return undefined; } catch (e) { return errorMessage(e); } } });
  if (mode === undefined) { return; }
  if (kind.k === 'dir') {
    await conn.mkdir(path);
  } else {
    const parent = path.replace(/\/[^/]*$/, '') || '/';
    if (!(await conn.stat(parent).then(() => true, () => false))) { await conn.mkdir(parent); }
    await conn.writeStreamFile(path, new Uint8Array());
    await conn.runCL(tagCcsidCommand(path, 1208, false)).catch(e => logError(e));
  }
  if (mode.trim()) {
    const r = await conn.exec(`chmod ${checkMode(mode)} '${path.replace(/'/g, `'\\''`)}'`);
    if (r.code !== 0) { vscode.window.showWarningMessage(vscode.l10n.t('Created, but the permissions could not be set: {0}', (r.stderr || r.stdout).trim())); }
  }
  void vscode.commands.executeCommand('vanthrex.refreshIfs');
  if (kind.k === 'file') { await vscode.window.showTextDocument(ifsUri(path), { preview: false }); }
  else { vscode.window.setStatusBarMessage(vscode.l10n.t('Folder {0} created', path), 4000); }
}

const TAIL = 'vanthrex-tail';

class TailProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly manager: ConnectionManager) {
    this.timer = setInterval(() => {
      for (const ed of vscode.window.visibleTextEditors) { if (ed.document.uri.scheme === TAIL) { this.emitter.fire(ed.document.uri); } }
    }, 2000);
  }
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const conn = this.manager.connection;
    if (!conn) { return vscode.l10n.t('Not connected.'); }
    const lines = Number(vscode.workspace.getConfiguration('vanthrex.ifs').get<number>('followLines', 500));
    const r = await conn.exec(`tail -n ${Math.max(10, Math.min(20000, lines))} ${shSingleQuote(uri.path)} 2>&1`);
    return r.stdout;
  }
  dispose(): void { if (this.timer) { clearInterval(this.timer); } this.emitter.dispose(); }
}

// ================================================================ registration

export function registerIfsTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const tail = new TailProvider(manager);
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.searchIfs', guard((n?: { path?: string; isDirectory?: boolean }) => searchIfs(manager, n))),
    vscode.commands.registerCommand('vanthrex.ifsPermissions', guard((n?: { path?: string; isDirectory?: boolean }) => ifsPermissions(manager, n))),
    vscode.commands.registerCommand('vanthrex.ifsPermissions.row', guard((p: string, u: string, d: boolean) => ifsPermissionRow(manager, p, u, !!d))),
    vscode.commands.registerCommand('vanthrex.ifsCcsid', guard((n?: { path?: string; isDirectory?: boolean }) => ifsCcsid(manager, n))),
    vscode.commands.registerCommand('vanthrex.ifsCcsid.change', guard((p: string, many: boolean) => changeCcsid(manager, p, !!many))),
    vscode.commands.registerCommand('vanthrex.createIfs', guard((a?: unknown) => createIfs(manager, a))),
    tail,
    vscode.workspace.registerTextDocumentContentProvider(TAIL, tail),
    vscode.commands.registerCommand('vanthrex.followIfsFile', guard(async (n?: { path?: string; isDirectory?: boolean }) => {
      const path = n?.path && !n.isDirectory ? n.path : (await vscode.window.showInputBox({ title: vscode.l10n.t('Follow an IFS file'), prompt: vscode.l10n.t('Path of the file'), placeHolder: vscode.l10n.t('/home/user/app.log'), ignoreFocusOut: true }))?.trim();
      if (!path) { return; }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: TAIL, path }));
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      const toEnd = () => ed.revealRange(new vscode.Range(doc.lineCount, 0, doc.lineCount, 0));
      toEnd();
      const sub = vscode.workspace.onDidChangeTextDocument(e => { if (e.document === doc && vscode.window.activeTextEditor?.document === doc) { toEnd(); } });
      const close = vscode.workspace.onDidCloseTextDocument(d => { if (d === doc) { sub.dispose(); close.dispose(); } });
    })),
  );
}
