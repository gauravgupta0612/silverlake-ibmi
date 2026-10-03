import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, logError } from '../core/log';
import { ifsUri } from '../features/fileSystems';

export interface IfsNode {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
  error?: string;
}

export class IfsTreeProvider implements vscode.TreeDataProvider<IfsNode> {
  private readonly emitter = new vscode.EventEmitter<IfsNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private root?: string;

  constructor(private readonly manager: ConnectionManager) {
    manager.onDidChange(c => {
      this.root = c ? (c.profile.ifsHome || c.homeDirectory) : undefined;
      this.refresh();
    });
  }

  get rootPath(): string | undefined { return this.root; }

  setRoot(path: string): void {
    this.root = path.replace(/\/+$/, '') || '/';
    this.refresh();
  }

  refresh(node?: IfsNode): void { this.emitter.fire(node); }

  getTreeItem(n: IfsNode): vscode.TreeItem {
    if (n.error) {
      const item = new vscode.TreeItem(n.error);
      item.iconPath = new vscode.ThemeIcon('error');
      return item;
    }
    const item = new vscode.TreeItem(n.name,
      n.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.resourceUri = ifsUri(n.path);
    item.contextValue = n.isDirectory ? 'ifs.dir' : 'ifs.file';
    item.tooltip = n.path + (n.size !== undefined && !n.isDirectory ? `\n${formatSize(n.size)}` : '') +
      (n.mtime ? `\nModified ${new Date(n.mtime * 1000).toLocaleString()}` : '');
    if (!n.isDirectory) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
      item.description = n.size !== undefined ? formatSize(n.size) : undefined;
    }
    return item;
  }

  async getChildren(n?: IfsNode): Promise<IfsNode[]> {
    const conn = this.manager.connection;
    if (!conn) { return []; }
    if (!n) {
      const root = this.root ?? conn.homeDirectory;
      return [{ path: root, name: root, isDirectory: true }];
    }
    try {
      const list = await conn.readDirectory(n.path);
      return list
        .filter(e => e.filename !== '.' && e.filename !== '..')
        .map(e => ({
          path: `${n.path === '/' ? '' : n.path}/${e.filename}`,
          name: e.filename,
          isDirectory: e.longname.startsWith('d'),
          size: e.attrs.size,
          mtime: e.attrs.mtime,
        }))
        .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    } catch (e) {
      logError(e);
      return [{ path: n.path, name: '', isDirectory: false, error: errorMessage(e) }];
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
