// Move whole folders between this PC and the IFS: upload files or a folder into an IFS folder (also by dragging them
// from the Explorer or the desktop onto the IFS view), and download an IFS file or folder to this PC.
import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { matchesIgnore } from '../core/localDev';
import { baseName, formatBytes, joinIfs, planTransfer, TransferEntry } from '../core/ifsTransfer';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { shSingleQuote } from '../core/util';
import { IfsNode, IfsTreeProvider } from '../views/ifsTree';

const S_IFMT = 0o170000; const S_IFDIR = 0o040000; const S_IFREG = 0o100000;
/** Folder uploads skip only version-control folders (.git, .svn) and OS clutter. */
const ignoreFn = () => (rel: string) => matchesIgnore(rel, []);

async function localEntries(root: vscode.Uri): Promise<TransferEntry[]> {
  const out: TransferEntry[] = [];
  const walk = async (dir: vscode.Uri, rel: string, depth: number): Promise<void> => {
    if (depth > 40 || out.length > 100000) { return; }
    for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
      const r = rel ? `${rel}/${name}` : name; const u = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.SymbolicLink) { continue; }
      if (type & vscode.FileType.Directory) { out.push({ rel: r, isDirectory: true, size: 0 }); await walk(u, r, depth + 1); }
      else if (type & vscode.FileType.File) { out.push({ rel: r, isDirectory: false, size: (await vscode.workspace.fs.stat(u)).size }); }
    }
  };
  await walk(root, '', 0);
  return out;
}

async function remoteEntries(conn: IbmiConnection, root: string): Promise<TransferEntry[]> {
  const out: TransferEntry[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 40 || out.length > 100000) { return; }
    for (const e of await conn.readDirectory(dir)) {
      if (e.filename === '.' || e.filename === '..') { continue; }
      const r = rel ? `${rel}/${e.filename}` : e.filename; const type = e.attrs.mode & S_IFMT;
      if (type === S_IFDIR) { out.push({ rel: r, isDirectory: true, size: 0 }); await walk(`${dir}/${e.filename}`, r, depth + 1); }
      else if (type === S_IFREG) { out.push({ rel: r, isDirectory: false, size: e.attrs.size }); }
    }
  };
  await walk(root.replace(/\/+$/, ''), '', 0);
  return out;
}

/** Upload local files and folders (URIs) into an IFS folder. */
async function upload(manager: ConnectionManager, ifs: IfsTreeProvider, sources: vscode.Uri[], target: string, node?: IfsNode): Promise<void> {
  const conn = manager.require();
  type Item = { local: vscode.Uri; remote: string; size: number };
  const files: Item[] = []; const folders: string[] = []; let skipped = 0;
  const ignore = ignoreFn();
  for (const src of sources) {
    const st = await vscode.workspace.fs.stat(src);
    const name = baseName(src.path);
    if (st.type & vscode.FileType.Directory) {
      const top = joinIfs(target, name);
      folders.push(top);
      const plan = planTransfer(await localEntries(src), ignore);
      folders.push(...plan.folders.map(f => joinIfs(top, f)));
      files.push(...plan.files.map(f => ({ local: vscode.Uri.joinPath(src, ...f.rel.split('/')), remote: joinIfs(top, f.rel), size: f.size })));
      skipped += plan.skipped.length;
    } else { files.push({ local: src, remote: joinIfs(target, name), size: st.size }); }
  }
  if (!files.length && !folders.length) { return; }
  const bytes = files.reduce((a, f) => a + f.size, 0);
  // Overwriting: ask once when any of the top-level names already exists.
  const existing = new Set((await conn.readDirectory(target).catch(() => [])).map(e => e.filename));
  const clash = sources.map(s => baseName(s.path)).filter(n => existing.has(n));
  if (clash.length) {
    const replace = vscode.l10n.t('Replace');
    const ok = await vscode.window.showWarningMessage(vscode.l10n.t('{0} already exist(s) in {1}. Replace the files with the same names?', clash.slice(0, 5).join(', '), target), { modal: true }, replace);
    if (ok !== replace) { return; }
  }
  await conn.withChangesAllowed(vscode.l10n.t('Upload {0} file(s) ({1}) to {2}', files.length, formatBytes(bytes), target), async () =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Uploading to {0}', target), cancellable: true }, async (progress, token) => {
      for (let i = 0; i < folders.length; i += 100) {
        const r = await conn.exec(`mkdir -p ${folders.slice(i, i + 100).map(shSingleQuote).join(' ')}`);
        if (r.code !== 0) { throw new Error(r.stderr || 'mkdir failed'); }
      }
      let done = 0;
      for (const f of files) {
        if (token.isCancellationRequested) { break; }
        await conn.writeStreamFile(f.remote, await vscode.workspace.fs.readFile(f.local));
        done++;
        progress.report({ message: `${done}/${files.length} ${baseName(f.remote)}`, increment: bytes ? (f.size / bytes) * 100 : 100 / files.length });
      }
      vscode.window.showInformationMessage(vscode.l10n.t('Uploaded {0} of {1} file(s) ({2}) to {3}.', done, files.length, formatBytes(bytes), target) +
        (skipped ? ' ' + vscode.l10n.t('{0} skipped (.git, ignored or too big).', skipped) : ''));
    }));
  ifs.refresh(node);
}

async function download(manager: ConnectionManager, node: IfsNode): Promise<void> {
  const conn = manager.require();
  const dest = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: vscode.l10n.t('Download here'), title: vscode.l10n.t('Download {0} to…', node.path) });
  if (!dest?.length) { return; }
  const target = vscode.Uri.joinPath(dest[0], baseName(node.path));
  try { await vscode.workspace.fs.stat(target);
    const replace = vscode.l10n.t('Replace');
    if (await vscode.window.showWarningMessage(vscode.l10n.t('{0} already exists in that folder. Replace it?', baseName(node.path)), { modal: true }, replace) !== replace) { return; }
  } catch { /* does not exist */ }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Downloading {0}', node.path), cancellable: true }, async (progress, token) => {
    if (!node.isDirectory) {
      await vscode.workspace.fs.writeFile(target, await conn.readStreamFile(node.path));
      return;
    }
    const plan = planTransfer(await remoteEntries(conn, node.path), () => false);
    await vscode.workspace.fs.createDirectory(target);
    for (const f of plan.folders) { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ...f.split('/'))); }
    let done = 0;
    for (const f of plan.files) {
      if (token.isCancellationRequested) { break; }
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(target, ...f.rel.split('/')), await conn.readStreamFile(joinIfs(node.path, f.rel)));
      done++;
      progress.report({ message: `${done}/${plan.files.length} ${f.rel}`, increment: plan.bytes ? (f.size / plan.bytes) * 100 : 100 / Math.max(1, plan.files.length) });
    }
  });
  const reveal = vscode.l10n.t('Show in Folder');
  void vscode.window.showInformationMessage(vscode.l10n.t('Downloaded {0} to {1}.', node.path, target.fsPath), reveal).then(c => { if (c) { void vscode.commands.executeCommand('revealFileInOS', target); } });
}

/** Drop local files or folders on an IFS folder (or file: its folder) to upload them. */
export function ifsDropController(manager: ConnectionManager, ifs: IfsTreeProvider): vscode.TreeDragAndDropController<IfsNode> {
  return {
    dropMimeTypes: ['text/uri-list', 'files'],
    dragMimeTypes: [],
    handleDrop: async (target, data) => {
      try {
        const list = await data.get('text/uri-list')?.asString();
        const uris = (list ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => vscode.Uri.parse(l)).filter(u => u.scheme === 'file');
        if (!uris.length || !manager.connection) { return; }
        const dir = target ? (target.isDirectory ? target.path : target.path.replace(/\/[^/]*$/, '') || '/') : (ifs.rootPath ?? manager.connection.homeDirectory);
        await upload(manager, ifs, uris, dir, target?.isDirectory ? target : undefined);
      } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
    },
  };
}

export function registerIfsTransfer(context: vscode.ExtensionContext, manager: ConnectionManager, ifs: IfsTreeProvider): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.ifsUpload', wrap(async (node?: IfsNode) => {
      manager.require();
      const dir = node?.isDirectory ? node.path : (ifs.rootPath ?? manager.require().homeDirectory);
      const kind = await vscode.window.showQuickPick([{ label: vscode.l10n.t('$(files) Files…'), id: 'files' }, { label: vscode.l10n.t('$(folder) A whole folder…'), id: 'folder' }],
        { title: vscode.l10n.t('Upload to {0}', dir) });
      if (!kind) { return; }
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: kind.id === 'files', canSelectFolders: kind.id === 'folder', canSelectMany: true, openLabel: vscode.l10n.t('Upload') });
      if (picked?.length) { await upload(manager, ifs, picked, dir, node); }
    })),
    vscode.commands.registerCommand('vanthrex.ifsDownload', wrap(async (node?: IfsNode) => {
      if (!node?.path) { vscode.window.showInformationMessage(vscode.l10n.t('Right-click a file or folder in the IFS view.')); return; }
      await download(manager, node);
    })),
  );
}
