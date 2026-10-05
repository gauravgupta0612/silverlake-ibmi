import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { ConnectionProfile } from '../core/profiles';

export class ConnectionTreeProvider implements vscode.TreeDataProvider<ConnectionProfile> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly manager: ConnectionManager) {
    manager.profiles.onDidChange(() => this.emitter.fire());
    manager.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(p: ConnectionProfile): vscode.TreeItem {
    const active = this.manager.connection?.profile.id === p.id;
    const background = !active && this.manager.isOpen(p.id);
    const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.None);
    item.description = `${p.user.toUpperCase()}@${p.host}${active ? ' • active' : background ? ' • connected' : ''}`;
    item.iconPath = new vscode.ThemeIcon(active ? 'vm-running' : background ? 'vm-active' : 'vm',
      active ? new vscode.ThemeColor('testing.iconPassed') : background ? new vscode.ThemeColor('testing.iconQueued') : undefined);
    item.tooltip = new vscode.MarkdownString(
      `**${p.name}**  \n${p.user.toUpperCase()}@${p.host}:${p.port}  \n` +
      `Libraries: ${p.libraries.join(', ') || '—'}  \nCurrent library: ${p.currentLibrary || '—'}\n\n` +
      (active ? '_Connected — the views show this system_' : background ? '_Connected in the background — click to switch to it_' : '_Click to connect_'));
    item.contextValue = active ? 'connection.active' : background ? 'connection.background' : 'connection';
    if (!active) {
      item.command = { command: 'vanthrex.connect', title: background ? 'Switch' : 'Connect', arguments: [p] };
    }
    return item;
  }

  getChildren(p?: ConnectionProfile): ConnectionProfile[] {
    return p ? [] : this.manager.profiles.list();
  }
}
