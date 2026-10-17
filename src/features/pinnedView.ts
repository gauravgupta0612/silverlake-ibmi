// The Pinned view.
import * as vscode from 'vscode';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { movePin, Pin, pinDescription, pinKey, pinLabel, togglePin } from '../core/pins';
import { ifsUri, memberUri } from './fileSystems';
import { memberOf } from './memberToolsView';

class PinnedTree implements vscode.TreeDataProvider<Pin> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly manager: ConnectionManager, private readonly state: vscode.Memento) {}

  private key(): string { return `vanthrex.pins.${this.manager.connection?.profile.name ?? ''}`; }
  get list(): Pin[] { return this.state.get<Pin[]>(this.key(), []); }
  async save(list: Pin[]): Promise<void> { await this.state.update(this.key(), list); this.refresh(); }
  refresh(): void { this.emitter.fire(); }

  getTreeItem(p: Pin): vscode.TreeItem {
    const item = new vscode.TreeItem(pinLabel(p), vscode.TreeItemCollapsibleState.None);
    item.description = pinDescription(p);
    item.contextValue = `pin.${p.kind}`;
    const icons: Record<string, string> = { member: 'file-code', srcfile: 'list-selection', library: 'library', object: 'package', ifs: 'file' };
    item.iconPath = new vscode.ThemeIcon(icons[p.kind] ?? 'pin');
    item.command = { command: 'vanthrex.pin.open', title: vscode.l10n.t('Open'), arguments: [p] };
    if (p.kind === 'member') { item.resourceUri = memberUri(p.library!, p.file!, p.name!, p.type ?? ''); }
    item.tooltip = `${pinLabel(p)}\n${pinDescription(p)}`;
    return item;
  }

  getChildren(p?: Pin): Pin[] {
    if (p || !this.manager.connection) { return []; }
    return this.list;
  }
}

/** Turn whatever was right-clicked (library tree node, IFS node, PDM row, editor) into a pin. */
function toPin(a?: unknown): Pin | undefined {
  const n = a as { kind?: string; library?: string; file?: string; member?: string; name?: string; type?: string; text?: string; path?: string; isDirectory?: boolean } | undefined;
  if (n?.kind === 'member') { return { kind: 'member', library: n.library, file: n.file, name: n.member, type: n.type, text: n.text }; }
  if (n?.kind === 'srcfile') { return { kind: 'srcfile', library: n.library, file: n.file, text: n.text }; }
  if (n?.kind === 'library') { return { kind: 'library', library: n.library }; }
  if (n?.kind === 'object') { return { kind: 'object', library: n.library, name: n.name, type: n.type, text: n.text }; }
  if (n?.path && typeof n.isDirectory === 'boolean') { return { kind: 'ifs', path: n.path, type: n.isDirectory ? 'dir' : 'file' }; }
  const m = memberOf(a instanceof vscode.Uri ? a : undefined);
  if (m) { return { kind: 'member', library: m.library, file: m.file, name: m.member, type: m.type }; }
  return undefined;
}

async function openPin(p: Pin): Promise<void> {
  switch (p.kind) {
    case 'member': await vscode.window.showTextDocument(memberUri(p.library!, p.file!, p.name!, p.type ?? ''), { preview: false }); break;
    case 'srcfile': await vscode.commands.executeCommand('vanthrex.pdm', { level: 'members', library: p.library, file: p.file }); break;
    case 'library': await vscode.commands.executeCommand('vanthrex.pdm', { level: 'objects', library: p.library }); break;
    case 'object': await vscode.commands.executeCommand('vanthrex.objectInfo', { library: p.library, name: p.name, type: p.type }); break;
    case 'ifs':
      if (p.type === 'dir') { await vscode.commands.executeCommand('vanthrex.pin.ifsDir', p.path); } else { await vscode.window.showTextDocument(ifsUri(p.path!), { preview: false }); }
      break;
  }
}

// ================================================================ registration

export function registerPinned(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const state = context.globalState;
  const pins = new PinnedTree(manager, state);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('vanthrex.pinned', pins),
    vscode.commands.registerCommand('vanthrex.pin', guard(async (a?: unknown) => {
      manager.require();
      const p = toPin(a);
      if (!p) { throw new Error(vscode.l10n.t('Right-click a member, source file, library, object or IFS file to pin it.')); }
      const r = togglePin(pins.list, p);
      await pins.save(r.list);
      vscode.window.setStatusBarMessage(r.pinned ? vscode.l10n.t('📌 {0} pinned', pinLabel(p)) : vscode.l10n.t('{0} unpinned', pinLabel(p)), 3000);
    })),
    vscode.commands.registerCommand('vanthrex.unpin', guard(async (p: Pin) => { await pins.save(pins.list.filter(x => pinKey(x) !== pinKey(p))); })),
    vscode.commands.registerCommand('vanthrex.pin.open', guard((p: Pin) => openPin(p))),
    vscode.commands.registerCommand('vanthrex.pin.moveUp', guard(async (p: Pin) => { await pins.save(movePin(pins.list, pinKey(p), -1)); })),
    vscode.commands.registerCommand('vanthrex.pin.moveDown', guard(async (p: Pin) => { await pins.save(movePin(pins.list, pinKey(p), 1)); })),
    vscode.commands.registerCommand('vanthrex.pin.ifsDir', guard(async (path: string) => {
      await vscode.commands.executeCommand('workbench.view.extension.vanthrex');
      await vscode.commands.executeCommand('vanthrex.ifsChangeRoot', path);
    })),
    manager.onDidChange(() => pins.refresh()),
  );
}
