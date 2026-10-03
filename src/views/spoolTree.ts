import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, logError } from '../core/log';
import { sqlString } from '../core/util';

export interface SpoolNode {
  name: string;
  job: string;
  number: number;
  userData: string;
  status: string;
  pages: number;
  created: string;
  outq: string;
  error?: string;
}

export class SpoolTreeProvider implements vscode.TreeDataProvider<SpoolNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly manager: ConnectionManager) {
    manager.onDidChange(() => this.refresh());
  }

  refresh(): void { this.emitter.fire(); }

  getTreeItem(n: SpoolNode): vscode.TreeItem {
    if (n.error) {
      const item = new vscode.TreeItem(n.error);
      item.iconPath = new vscode.ThemeIcon('error');
      return item;
    }
    const item = new vscode.TreeItem(n.name);
    item.description = `${n.userData ? n.userData + ' · ' : ''}${n.pages}p · ${n.created}`;
    item.tooltip = new vscode.MarkdownString(
      `**${n.name}** (#${n.number})  \nJob: \`${n.job}\`  \nStatus: ${n.status}  \nPages: ${n.pages}  \n` +
      `Output queue: ${n.outq}  \nCreated: ${n.created}`);
    item.iconPath = new vscode.ThemeIcon(n.status === 'HELD' ? 'debug-pause' : 'file-text');
    item.contextValue = 'spool';
    item.command = { command: 'silverlake.spoolOpen', title: 'Open', arguments: [n] };
    return item;
  }

  async getChildren(n?: SpoolNode): Promise<SpoolNode[]> {
    const conn = this.manager.connection;
    if (!conn || n) { return []; }
    const max = vscode.workspace.getConfiguration('silverlake').get<number>('spool.maxEntries', 200);
    try {
      const rows = await conn.rows<Record<string, unknown>>(
        `SELECT SPOOLED_FILE_NAME, JOB_NAME, FILE_NUMBER, COALESCE(USER_DATA, '') AS USER_DATA, STATUS, ` +
        `TOTAL_PAGES, VARCHAR_FORMAT(CREATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS CREATED, ` +
        `OUTPUT_QUEUE_LIBRARY_NAME CONCAT '/' CONCAT OUTPUT_QUEUE_NAME AS OUTQ ` +
        `FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE USER_NAME = ${sqlString(conn.user)} ` +
        `ORDER BY CREATE_TIMESTAMP DESC FETCH FIRST ${Math.max(1, Math.floor(max))} ROWS ONLY`, max);
      return rows.map(r => ({
        name: String(r.SPOOLED_FILE_NAME).trim(),
        job: String(r.JOB_NAME).trim(),
        number: Number(r.FILE_NUMBER),
        userData: String(r.USER_DATA ?? '').trim(),
        status: String(r.STATUS ?? '').trim(),
        pages: Number(r.TOTAL_PAGES ?? 0),
        created: String(r.CREATED ?? ''),
        outq: String(r.OUTQ ?? '').trim(),
      }));
    } catch (e) {
      logError(e);
      return [{ name: '', job: '', number: 0, userData: '', status: '', pages: 0, created: '', outq: '', error: errorMessage(e).split('\n')[0] }];
    }
  }
}
