// IFS file work: compare a local folder with an IFS folder (what differs, which side is newer, diff, upload or download
// one file), pack and unpack archives on the IFS (.zip, .jar, .tar, .tar.gz), and copy or move IFS files and folders.
import * as vscode from 'vscode';
import { directoryFor, ignoreList, listFiles, pickFolder } from './localDevView';
import { ifsUri } from './fileSystems';
import { archiveKind, compareFolders, CompareRow, compressCommand, extractCommand, SideFile, Tools } from '../core/folderSync';
import { matchesIgnore } from '../core/localDev';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { shSingleQuote } from '../core/util';
import { reportProgress, showReport } from './reportPanel';

const ALLOWED = new Set(['vanthrex.compareWithIfs', 'vanthrex.ifsSync.row']);
const S_IFMT = 0o170000; const S_IFDIR = 0o040000; const S_IFREG = 0o100000;
type Node = { path: string; isDirectory?: boolean };

async function remoteFiles(conn: IbmiConnection, root: string, ignore: string[]): Promise<SideFile[]> {
  const out: SideFile[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 30 || out.length > 50000) { return; }
    let list;
    try { list = await conn.readDirectory(dir); } catch { return; }
    for (const e of list) {
      if (e.filename === '.' || e.filename === '..') { continue; }
      const r = rel ? `${rel}/${e.filename}` : e.filename; const type = e.attrs.mode & S_IFMT;
      if (type === S_IFDIR) { if (!matchesIgnore(r + '/', ignore)) { await walk(`${dir}/${e.filename}`, r, depth + 1); } }
      else if (type === S_IFREG && !matchesIgnore(r, ignore)) { out.push({ rel: r, size: e.attrs.size, mtimeMs: e.attrs.mtime * 1000 }); }
    }
  };
  await walk(root.replace(/\/+$/, ''), '', 0);
  return out;
}

const STATUS = (s: CompareRow['status']): string => ({
  onlyLocal: vscode.l10n.t('Only on this PC'), onlyIfs: vscode.l10n.t('Only in the IFS'), localNewer: vscode.l10n.t('Newer on this PC'),
  ifsNewer: vscode.l10n.t('Newer in the IFS'), different: vscode.l10n.t('Different'), same: vscode.l10n.t('Same'),
} as Record<string, string>)[s];

async function compare(manager: ConnectionManager, uri?: vscode.Uri, given?: { root: string; dir: string }): Promise<void> {
  const conn = manager.require();
  let root: vscode.Uri; let dir: string; let ignore: string[];
  if (given) { root = vscode.Uri.parse(given.root); dir = given.dir; ignore = ignoreList(vscode.workspace.getWorkspaceFolder(root) ?? { uri: root, name: '', index: 0 }); }
  else {
    const folder = await pickFolder(uri);
    if (!folder) { return; }
    root = folder.uri; ignore = ignoreList(folder);
    const d = await vscode.window.showInputBox({ title: vscode.l10n.t('Compare {0} with which IFS folder?', folder.name), value: directoryFor(conn, folder), validateInput: v => (v.startsWith('/') ? undefined : vscode.l10n.t('An absolute IFS path.')) });
    if (!d) { return; }
    dir = d.replace(/\/+$/, '');
  }
  const rows = await reportProgress('ifsCompare', vscode.l10n.t('Comparing with {0}…', dir), async () =>
    compareFolders(await listFiles(root, ignore), await remoteFiles(conn, dir, ignore)));
  const differ = rows.filter(r => r.status !== 'same');
  const kb = (n?: number) => (n === undefined ? '' : n < 1024 ? `${n} B` : `${Math.round(n / 102.4) / 10} KB`);
  const when = (f?: SideFile) => (f ? new Date(f.mtimeMs).toISOString().replace('T', ' ').slice(0, 19) : '');
  showReport('ifsCompare', {
    title: vscode.l10n.t('{0} ↔ {1}', root.fsPath, dir), subtitle: vscode.l10n.t('{0} file(s) differ, {1} are the same. Click a file to see the differences, upload or download it.', differ.length, rows.length - differ.length),
    facts: (['localNewer', 'ifsNewer', 'different', 'onlyLocal', 'onlyIfs'] as const).map(s => [STATUS(s), rows.filter(r => r.status === s).length] as [string, number]),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.compareWithIfs', args: [undefined, { root: root.toString(), dir }] }],
    tables: [{ title: vscode.l10n.t('Files'), filter: true, columns: ['File', 'Status', 'PC size', 'PC changed', 'IFS size', 'IFS changed'],
      rows: rows.map(r => [r.rel, STATUS(r.status), kb(r.local?.size), when(r.local), kb(r.ifs?.size), when(r.ifs)]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.ifsSync.row', args: [root.toString(), dir, r.rel, r.status] })),
      rowClass: rows.map(r => (r.status === 'same' ? undefined : r.status === 'different' ? 'bad' : 'different')) }],
  }, ALLOWED);
}

async function rowOptions(manager: ConnectionManager, rootText: string, dir: string, rel: string, status: CompareRow['status']): Promise<void> {
  const conn = manager.require();
  const local = vscode.Uri.joinPath(vscode.Uri.parse(rootText), ...rel.split('/'));
  const remote = `${dir}/${rel}`;
  const items: (vscode.QuickPickItem & { id: string })[] = [
    ...(status !== 'onlyLocal' && status !== 'onlyIfs' ? [{ label: vscode.l10n.t('$(diff) Show the differences'), id: 'diff' }] : []),
    ...(status !== 'onlyIfs' ? [{ label: vscode.l10n.t('$(cloud-upload) Upload this file to the IFS'), id: 'up' }] : []),
    ...(status !== 'onlyLocal' ? [{ label: vscode.l10n.t('$(cloud-download) Download this file to the PC'), id: 'down' }] : []),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: rel });
  if (!pick) { return; }
  if (pick.id === 'diff') { await vscode.commands.executeCommand('vscode.diff', local, ifsUri(remote), `${rel} (PC ↔ IFS)`); return; }
  if (pick.id === 'up') {
    await conn.withChangesAllowed(vscode.l10n.t('Upload {0}', remote), async () => {
      await conn.exec(`mkdir -p ${shSingleQuote(remote.replace(/\/[^/]*$/, ''))}`);
      await conn.writeStreamFile(remote, await vscode.workspace.fs.readFile(local));
    });
  }
  if (pick.id === 'down') {
    if (status !== 'onlyIfs') {
      const replace = vscode.l10n.t('Replace');
      if (await vscode.window.showWarningMessage(vscode.l10n.t('Replace {0} on this PC with the IFS version?', rel), { modal: true }, replace) !== replace) { return; }
    }
    await vscode.workspace.fs.writeFile(local, await conn.readStreamFile(remote));
  }
  vscode.window.setStatusBarMessage(vscode.l10n.t('{0}: done.', rel), 4000);
}

async function tools(conn: IbmiConnection): Promise<Tools> {
  const r = await conn.exec('export PATH=/QOpenSys/pkgs/bin:$PATH; for t in zip unzip jar; do command -v $t >/dev/null 2>&1 && echo $t; done');
  const have = new Set(r.stdout.split(/\s+/));
  return { zip: have.has('zip'), unzip: have.has('unzip'), jar: have.has('jar') };
}

async function runShell(conn: IbmiConnection, what: string, cmd: string): Promise<void> {
  const r = await conn.withChangesAllowed(what, async () => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: what },
    () => conn.exec(`export PATH=/QOpenSys/pkgs/bin:$PATH; ${cmd}`)));
  if (r.code !== 0) { throw new Error((r.stderr || r.stdout || `exit code ${r.code}`).trim().slice(0, 1000)); }
}

async function extract(manager: ConnectionManager, node?: Node): Promise<void> {
  const conn = manager.require();
  if (!node?.path || !archiveKind(node.path)) { vscode.window.showInformationMessage(vscode.l10n.t('Right-click a .zip, .jar, .tar, .tar.gz or .gz file in the IFS view.')); return; }
  const parent = node.path.replace(/\/[^/]*$/, '') || '/';
  const base = node.path.split('/').pop()!.replace(/\.(tar\.gz|tgz|zip|jar|war|ear|tar|gz)$/i, '');
  const dest = archiveKind(node.path) === 'gz' ? parent : await vscode.window.showInputBox({ title: vscode.l10n.t('Extract {0} into', node.path), value: `${parent}/${base}`, validateInput: v => (v.startsWith('/') ? undefined : vscode.l10n.t('An absolute IFS path.')) });
  if (!dest) { return; }
  await runShell(conn, vscode.l10n.t('Extracting {0}…', node.path), extractCommand(node.path, dest, await tools(conn)));
  await vscode.commands.executeCommand('vanthrex.refreshIfs');
  vscode.window.showInformationMessage(vscode.l10n.t('Extracted into {0}.', dest));
}

async function compress(manager: ConnectionManager, node?: Node, nodes?: Node[]): Promise<void> {
  const conn = manager.require();
  const list = (nodes?.length ? nodes : node ? [node] : []).map(n => n.path).filter(Boolean);
  if (!list.length) { vscode.window.showInformationMessage(vscode.l10n.t('Right-click a file or folder in the IFS view.')); return; }
  const parent = list[0].replace(/\/[^/]*$/, '') || '/';
  const name = list.length === 1 ? list[0].split('/').pop()! : 'archive';
  const archive = await vscode.window.showInputBox({ title: vscode.l10n.t('Compress {0} item(s) into', list.length), value: `${parent}/${name}.zip`, prompt: vscode.l10n.t('.zip, .tar or .tar.gz'),
    validateInput: v => (v.startsWith('/') && /\.(zip|jar|tar|tar\.gz|tgz)$/i.test(v) ? undefined : vscode.l10n.t('An absolute IFS path ending in .zip, .tar or .tar.gz.')) });
  if (!archive) { return; }
  await runShell(conn, vscode.l10n.t('Compressing into {0}…', archive), compressCommand(list, archive, await tools(conn)));
  await vscode.commands.executeCommand('vanthrex.refreshIfs');
  vscode.window.showInformationMessage(vscode.l10n.t('Created {0}.', archive));
}

async function copyOrMove(manager: ConnectionManager, node: Node | undefined, move: boolean): Promise<void> {
  const conn = manager.require();
  if (!node?.path) { vscode.window.showInformationMessage(vscode.l10n.t('Right-click a file or folder in the IFS view.')); return; }
  const to = await vscode.window.showInputBox({
    title: move ? vscode.l10n.t('Move or rename {0} to', node.path) : vscode.l10n.t('Copy {0} to', node.path), value: node.path, valueSelection: [node.path.lastIndexOf('/') + 1, node.path.length],
    prompt: vscode.l10n.t('A new name, or a path ending in / to keep the name in another folder.'),
    validateInput: v => (!v.startsWith('/') ? vscode.l10n.t('An absolute IFS path.') : v === node.path ? vscode.l10n.t('Give another name or folder.') : undefined),
  });
  if (!to) { return; }
  const target = to.endsWith('/') ? to + node.path.split('/').pop() : to;
  const exists = (await conn.exec(`test -e ${shSingleQuote(target)} && echo yes`)).stdout.includes('yes');
  if (exists) {
    const replace = vscode.l10n.t('Replace');
    if (await vscode.window.showWarningMessage(vscode.l10n.t('{0} already exists. Replace it?', target), { modal: true }, replace) !== replace) { return; }
  }
  const mk = `mkdir -p ${shSingleQuote(target.replace(/\/[^/]*$/, '') || '/')} && `;
  // cp -R keeps the CCSID tag of IFS files on IBM i; -p keeps the times and permissions.
  const cmd = move ? `${mk}mv -f ${shSingleQuote(node.path)} ${shSingleQuote(target)}` : `${mk}cp -R -p ${shSingleQuote(node.path)} ${shSingleQuote(target)}`;
  await runShell(conn, move ? vscode.l10n.t('Moving {0}…', node.path) : vscode.l10n.t('Copying {0}…', node.path), cmd);
  await vscode.commands.executeCommand('vanthrex.refreshIfs');
  vscode.window.setStatusBarMessage(vscode.l10n.t('{0} → {1}', node.path, target), 5000);
}

export function registerIfsSync(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.compareWithIfs', wrap((uri?: vscode.Uri, given?: { root: string; dir: string }) => compare(manager, uri instanceof vscode.Uri ? uri : undefined, given))),
    vscode.commands.registerCommand('vanthrex.ifsSync.row', wrap((root: string, dir: string, rel: string, status: CompareRow['status']) => rowOptions(manager, root, dir, rel, status))),
    vscode.commands.registerCommand('vanthrex.ifsExtract', wrap((n?: Node) => extract(manager, n))),
    vscode.commands.registerCommand('vanthrex.ifsCompress', wrap((n?: Node, all?: Node[]) => compress(manager, n, all))),
    vscode.commands.registerCommand('vanthrex.ifsCopyTo', wrap((n?: Node) => copyOrMove(manager, n, false))),
    vscode.commands.registerCommand('vanthrex.ifsMoveTo', wrap((n?: Node) => copyOrMove(manager, n, true))),
  );
}
