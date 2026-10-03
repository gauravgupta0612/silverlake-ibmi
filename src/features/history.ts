import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, logError } from '../core/log';
import { parseMemberPath } from '../core/util';
import { FsTransfer, IFS_SCHEME, MEMBER_SCHEME, fsEvents, memberUri } from './fileSystems';

const SERVER_SCHEME = 'vanthrex-server';

interface Version { uri: vscode.Uri; time: Date; kind: string; size: number; }

/** Keeps a local copy of every member / IFS file you open and save, so nothing is ever lost. */
export class LocalHistory {
  constructor(private readonly root: vscode.Uri, private readonly manager: ConnectionManager) {}

  private maxVersions(): number {
    return Math.max(1, vscode.workspace.getConfiguration('vanthrex').get<number>('history.maxVersions', 50));
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('vanthrex').get<boolean>('history.enabled', true);
  }

  folderFor(uri: vscode.Uri): vscode.Uri | undefined {
    const host = this.manager.connection?.profile.host;
    if (!host) { return undefined; }
    const safe = (s: string) => s.replace(/[^\w.$#@-]/g, '_');
    const parts = uri.path.split('/').filter(Boolean).map(safe);
    return vscode.Uri.joinPath(this.root, safe(host), uri.scheme === MEMBER_SCHEME ? 'members' : 'ifs', ...parts);
  }

  async versions(uri: vscode.Uri): Promise<Version[]> {
    const folder = this.folderFor(uri);
    if (!folder) { return []; }
    try {
      const entries = await vscode.workspace.fs.readDirectory(folder);
      const list: Version[] = [];
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) { continue; }
        const m = name.match(/^(\d{8}T\d{6}\d{3})_(\w+)\.txt$/);
        if (!m) { continue; }
        const s = m[1];
        const time = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15), +s.slice(15, 18)));
        const fileUri = vscode.Uri.joinPath(folder, name);
        const stat = await vscode.workspace.fs.stat(fileUri);
        list.push({ uri: fileUri, time, kind: m[2], size: stat.size });
      }
      return list.sort((a, b) => b.time.getTime() - a.time.getTime());
    } catch {
      return [];
    }
  }

  async record(t: FsTransfer): Promise<void> {
    if (!this.enabled()) { return; }
    const folder = this.folderFor(t.uri);
    if (!folder) { return; }
    const existing = await this.versions(t.uri);
    // On open, only keep a copy when it differs from the last one we have (e.g. someone else changed it).
    if (existing.length) {
      const last = await vscode.workspace.fs.readFile(existing[0].uri);
      if (Buffer.compare(Buffer.from(last), Buffer.from(t.content)) === 0) { return; }
    }
    await vscode.workspace.fs.createDirectory(folder);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '').replace('Z', '');
    const kind = t.kind === 'write' ? 'saved' : existing.length ? 'server' : 'original';
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, `${stamp}_${kind}.txt`), t.content);
    for (const old of existing.slice(this.maxVersions() - 1)) {
      await vscode.workspace.fs.delete(old.uri).then(undefined, () => undefined);
    }
  }
}

/** Read-only view of the copy currently on the IBM i: vanthrex-server:/<scheme>/<path> */
class ServerCopyProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly manager: ConnectionManager) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const conn = this.manager.require();
    const [, scheme, ...rest] = uri.path.split('/');
    const path = '/' + rest.join('/');
    if (scheme === MEMBER_SCHEME) {
      const m = parseMemberPath(path);
      return conn.readMember(m.library, m.file, m.member);
    }
    return (await conn.readStreamFile(path)).toString('utf8');
  }
}

function label(uri: vscode.Uri): string {
  if (uri.scheme === MEMBER_SCHEME) {
    const m = parseMemberPath(uri.path);
    return `${m.library}/${m.file}(${m.member})`;
  }
  return uri.path.split('/').pop() ?? uri.path;
}

type TreeArg = vscode.Uri | { kind?: string; library?: string; file?: string; member?: string; type?: string; path?: string; isDirectory?: boolean };

/** The member / IFS file a command applies to: a tree node, a URI, or the active editor. */
function activeRemoteUri(arg?: TreeArg): vscode.Uri | undefined {
  let uri: vscode.Uri | undefined;
  if (arg instanceof vscode.Uri) { uri = arg; }
  else if (arg && arg.kind === 'member' && arg.library && arg.file && arg.member) { uri = memberUri(arg.library, arg.file, arg.member, arg.type || 'mbr'); }
  else if (arg && typeof arg.path === 'string' && arg.isDirectory === false) { uri = vscode.Uri.from({ scheme: IFS_SCHEME, path: arg.path }); }
  else { uri = vscode.window.activeTextEditor?.document.uri; }
  return uri && (uri.scheme === MEMBER_SCHEME || uri.scheme === IFS_SCHEME) ? uri : undefined;
}

export function registerHistory(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const history = new LocalHistory(vscode.Uri.joinPath(context.globalStorageUri, 'history'), manager);
  let selectedForCompare: vscode.Uri | undefined;

  const guard = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };

  context.subscriptions.push(
    fsEvents.event(t => { history.record(t).catch(logError); }),
    vscode.workspace.registerTextDocumentContentProvider(SERVER_SCHEME, new ServerCopyProvider(manager)),

    vscode.commands.registerCommand('vanthrex.showHistory', guard(async (arg?: TreeArg) => {
      const uri = activeRemoteUri(arg);
      if (!uri) { vscode.window.showInformationMessage('Open a member or IFS file from Vanthrex to see its local history.'); return; }
      const versions = await history.versions(uri);
      if (!versions.length) { vscode.window.showInformationMessage(`No local history yet for ${label(uri)}.`); return; }
      const pick = await vscode.window.showQuickPick(versions.map((v, i) => ({
        label: `$(history) ${v.time.toLocaleString()}`,
        description: `${v.kind === 'saved' ? 'saved by you' : v.kind === 'original' ? 'first opened' : 'changed on server'} · ${v.size} bytes${i === 0 ? ' · latest' : ''}`,
        v,
      })), { title: `Local history of ${label(uri)}`, placeHolder: 'Pick a version to compare with the current file' });
      if (!pick) { return; }
      const action = await vscode.window.showQuickPick(['$(diff) Compare with current', '$(discard) Restore this version into the editor'], { title: pick.label });
      if (!action) { return; }
      if (action.includes('Compare')) {
        await vscode.commands.executeCommand('vscode.diff', pick.v.uri, uri, `${label(uri)}: ${pick.v.time.toLocaleString()} ↔ current`);
      } else {
        const editor = await vscode.window.showTextDocument(uri);
        const text = Buffer.from(await vscode.workspace.fs.readFile(pick.v.uri)).toString('utf8');
        const all = new vscode.Range(0, 0, editor.document.lineCount, 0);
        await editor.edit(e => e.replace(all, text));
        vscode.window.showInformationMessage('Version restored in the editor. Save (Ctrl+S) to write it to the IBM i.');
      }
    })),

    vscode.commands.registerCommand('vanthrex.compareWithServer', guard(async (arg?: TreeArg) => {
      const uri = activeRemoteUri(arg);
      if (!uri) { vscode.window.showInformationMessage('Open a member or IFS file from Vanthrex first.'); return; }
      const server = vscode.Uri.from({ scheme: SERVER_SCHEME, path: `/${uri.scheme}${uri.path}`, query: String(Date.now()) });
      await vscode.commands.executeCommand('vscode.diff', server, uri, `${label(uri)}: on IBM i ↔ your editor`);
    })),

    vscode.commands.registerCommand('vanthrex.compareMembers', guard(async (arg?: TreeArg) => {
      const left = activeRemoteUri(arg);
      const input = await vscode.window.showInputBox({
        title: `Compare ${left ? label(left) : ''} with…`, prompt: 'Other member as LIBRARY/FILE(MEMBER), or an IFS path',
        placeHolder: 'PRODLIB/QRPGLESRC(ORDENTRY)', ignoreFocusOut: true,
      });
      if (!input?.trim()) { return; }
      const v = input.trim();
      let right: vscode.Uri;
      const m = v.toUpperCase().match(/^([^/\s]+)\/([^(\s]+)\(([^)\s]+)\)$/);
      if (m) {
        const ext = left?.scheme === MEMBER_SCHEME ? parseMemberPath(left.path).extension : 'mbr';
        right = memberUri(m[1], m[2], m[3], ext || 'mbr');
      } else if (v.startsWith('/')) {
        right = vscode.Uri.from({ scheme: IFS_SCHEME, path: v });
      } else {
        throw new Error('Use LIBRARY/FILE(MEMBER) or an IFS path starting with /');
      }
      if (!left) {
        const other = await vscode.window.showInputBox({ title: 'Compare with', prompt: 'First member as LIBRARY/FILE(MEMBER)' });
        const mm = other?.trim().toUpperCase().match(/^([^/\s]+)\/([^(\s]+)\(([^)\s]+)\)$/);
        if (!mm) { return; }
        await vscode.commands.executeCommand('vscode.diff', memberUri(mm[1], mm[2], mm[3], 'mbr'), right, `${mm[1]}/${mm[2]}(${mm[3]}) ↔ ${v}`);
        return;
      }
      await vscode.commands.executeCommand('vscode.diff', right, left, `${v} ↔ ${label(left)}`);
    })),

    vscode.commands.registerCommand('vanthrex.selectForCompare', (n?: TreeArg) => {
      selectedForCompare = activeRemoteUri(n);
      if (selectedForCompare) {
        vscode.commands.executeCommand('setContext', 'vanthrex.hasCompareSelection', true);
        vscode.window.setStatusBarMessage(`$(diff) ${label(selectedForCompare)} selected — right-click another member → Compare with Selected`, 6000);
      }
    }),
    vscode.commands.registerCommand('vanthrex.compareWithSelected', guard(async (n?: TreeArg) => {
      const right = activeRemoteUri(n);
      if (!selectedForCompare || !right) { return; }
      await vscode.commands.executeCommand('vscode.diff', selectedForCompare, right, `${label(selectedForCompare)} ↔ ${label(right)}`);
    })),
    vscode.commands.registerCommand('vanthrex.openHistoryFolder', () =>
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.joinPath(context.globalStorageUri, 'history'))),
  );
}
