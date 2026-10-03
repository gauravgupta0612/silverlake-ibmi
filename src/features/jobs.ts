import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, logError } from '../core/log';
import { clString, sqlString } from '../core/util';

// ------------------------------------------------------------------ Jobs view

export interface JobNode {
  kind: 'job';
  job: string;
  subsystem: string;
  type: string;
  status: string;
  user: string;
  function: string;
  cpu: number;
  tempStorage: number;
}
type InfoNode = { kind: 'info'; text: string; error?: boolean };

export type JobFilter =
  | { mode: 'mine' }
  | { mode: 'user'; user: string }
  | { mode: 'subsystem'; subsystem: string }
  | { mode: 'all' };

export class JobsTreeProvider implements vscode.TreeDataProvider<JobNode | InfoNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  filter: JobFilter = { mode: 'mine' };
  view?: vscode.TreeView<JobNode | InfoNode>;

  constructor(private readonly manager: ConnectionManager) {
    manager.onDidChange(() => this.refresh());
  }

  refresh(): void { this.emitter.fire(); }

  describeFilter(): string {
    const f = this.filter;
    return f.mode === 'mine' ? 'my jobs' : f.mode === 'user' ? `user ${f.user}` : f.mode === 'subsystem' ? `subsystem ${f.subsystem}` : 'all active jobs';
  }

  getTreeItem(n: JobNode | InfoNode): vscode.TreeItem {
    if (n.kind === 'info') {
      const item = new vscode.TreeItem(n.text);
      item.iconPath = new vscode.ThemeIcon(n.error ? 'error' : 'info');
      return item;
    }
    const [num, user, name] = n.job.split('/');
    const item = new vscode.TreeItem(name ?? n.job);
    item.description = `${n.status} · ${n.subsystem || n.type}${n.function ? ' · ' + n.function : ''}${n.cpu ? ` · ${n.cpu}% CPU` : ''}`;
    item.tooltip = new vscode.MarkdownString(
      `**${n.job}**  \nUser: ${n.user || user}  \nNumber: ${num}  \nSubsystem: ${n.subsystem || '—'}  \nType: ${n.type}  \n` +
      `Status: ${n.status}  \nFunction: ${n.function || '—'}  \nCPU (elapsed): ${n.cpu}%  \nTemporary storage: ${n.tempStorage} MB`);
    item.iconPath = new vscode.ThemeIcon(
      n.status === 'MSGW' ? 'warning' : n.status === 'HLD' ? 'debug-pause' : n.status === 'RUN' ? 'play-circle' : 'circle-outline',
      n.status === 'MSGW' ? new vscode.ThemeColor('editorWarning.foreground') : undefined);
    item.contextValue = n.status === 'HLD' ? 'job.held' : 'job';
    item.command = { command: 'silverlake.jobLog', title: 'Job log', arguments: [n] };
    return item;
  }

  async getChildren(n?: JobNode | InfoNode): Promise<(JobNode | InfoNode)[]> {
    const conn = this.manager.connection;
    if (!conn || n) { return []; }
    if (this.view) { this.view.description = this.describeFilter(); }
    const f = this.filter;
    const args = ["DETAILED_INFO => 'NONE'"];
    if (f.mode === 'mine') { args.push(`CURRENT_USER_LIST_FILTER => ${sqlString(conn.user)}`); }
    if (f.mode === 'user') { args.push(`CURRENT_USER_LIST_FILTER => ${sqlString(f.user)}`); }
    if (f.mode === 'subsystem') { args.push(`SUBSYSTEM_LIST_FILTER => ${sqlString(f.subsystem)}`); }
    try {
      const rows = await conn.rows<Record<string, unknown>>(
        `SELECT JOB_NAME, COALESCE(SUBSYSTEM, '') AS SUBSYSTEM, JOB_TYPE, JOB_STATUS, AUTHORIZATION_NAME, ` +
        `COALESCE(FUNCTION, '') AS FUNCTION, COALESCE(ELAPSED_CPU_PERCENTAGE, 0) AS CPU, COALESCE(TEMPORARY_STORAGE, 0) AS TMP ` +
        `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(${args.join(', ')})) ` +
        `ORDER BY CASE JOB_STATUS WHEN 'MSGW' THEN 0 ELSE 1 END, ELAPSED_CPU_PERCENTAGE DESC, JOB_NAME ` +
        `FETCH FIRST 500 ROWS ONLY`, 500);
      if (!rows.length) { return [{ kind: 'info', text: `No active jobs (${this.describeFilter()})` }]; }
      return rows.map(r => ({
        kind: 'job',
        job: String(r.JOB_NAME).trim(),
        subsystem: String(r.SUBSYSTEM ?? '').trim(),
        type: String(r.JOB_TYPE ?? '').trim(),
        status: String(r.JOB_STATUS ?? '').trim(),
        user: String(r.AUTHORIZATION_NAME ?? '').trim(),
        function: String(r.FUNCTION ?? '').trim(),
        cpu: Number(r.CPU ?? 0),
        tempStorage: Number(r.TMP ?? 0),
      }));
    } catch (e) {
      logError(e);
      return [{ kind: 'info', text: errorMessage(e).split('\n')[0], error: true }];
    }
  }
}

// ------------------------------------------------------------------ Messages view

export interface MessageNode {
  kind: 'message';
  queueLib: string;
  queue: string;
  key: string;
  id: string;
  type: string;
  severity: number;
  text: string;
  help: string;
  time: string;
  fromUser: string;
  fromJob: string;
  needsReply: boolean;
}
type QueueNode = { kind: 'queue'; lib: string; name: string; label: string };

export class MessagesTreeProvider implements vscode.TreeDataProvider<QueueNode | MessageNode | InfoNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  view?: vscode.TreeView<QueueNode | MessageNode | InfoNode>;

  constructor(private readonly manager: ConnectionManager) {
    manager.onDidChange(() => this.refresh());
  }

  refresh(): void { this.emitter.fire(); }

  getTreeItem(n: QueueNode | MessageNode | InfoNode): vscode.TreeItem {
    if (n.kind === 'info') {
      const item = new vscode.TreeItem(n.text);
      item.iconPath = new vscode.ThemeIcon(n.error ? 'error' : 'info');
      return item;
    }
    if (n.kind === 'queue') {
      const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('inbox');
      item.description = `${n.lib}/${n.name}`;
      item.contextValue = 'msgq';
      return item;
    }
    const item = new vscode.TreeItem(n.text.length > 90 ? n.text.substring(0, 87) + '…' : n.text);
    item.description = `${n.id || n.type} · ${n.time}`;
    item.tooltip = new vscode.MarkdownString(
      `**${n.id || n.type}** (severity ${n.severity}) — ${n.time}\n\n${n.text}\n\n` +
      (n.help ? `---\n\n${n.help.replace(/&N |&B |&P /g, '\n\n')}\n\n` : '') +
      `From ${n.fromUser || '—'}${n.fromJob ? ` · job \`${n.fromJob}\`` : ''}` +
      (n.needsReply ? '\n\n**Waiting for a reply** — right-click → Reply' : ''));
    item.iconPath = new vscode.ThemeIcon(n.needsReply ? 'question' : n.severity >= 40 ? 'error' : n.severity >= 20 ? 'warning' : 'info',
      n.needsReply ? new vscode.ThemeColor('editorWarning.foreground') : undefined);
    item.contextValue = n.needsReply ? 'message.inquiry' : 'message';
    return item;
  }

  async getChildren(n?: QueueNode | MessageNode | InfoNode): Promise<(QueueNode | MessageNode | InfoNode)[]> {
    const conn = this.manager.connection;
    if (!conn) { return []; }
    if (!n) {
      return [
        { kind: 'queue', lib: 'QSYS', name: 'QSYSOPR', label: 'System operator (QSYSOPR)' },
        { kind: 'queue', lib: 'QUSRSYS', name: conn.user, label: 'My messages' },
      ];
    }
    if (n.kind !== 'queue') { return []; }
    try {
      const rows = await conn.rows<Record<string, unknown>>(
        `SELECT HEX(M.MESSAGE_KEY) AS MSGKEY, COALESCE(M.MESSAGE_ID, '') AS MSGID, M.MESSAGE_TYPE, COALESCE(M.SEVERITY, 0) AS SEV, ` +
        `COALESCE(M.MESSAGE_TEXT, '') AS TEXT, COALESCE(M.MESSAGE_SECOND_LEVEL_TEXT, '') AS HELP, ` +
        `VARCHAR_FORMAT(M.MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TIME, COALESCE(M.FROM_USER, '') AS FROMUSER, ` +
        `COALESCE(M.FROM_JOB, '') AS FROMJOB, ` +
        `CASE WHEN M.MESSAGE_TYPE = 'INQUIRY' AND NOT EXISTS (SELECT 1 FROM QSYS2.MESSAGE_QUEUE_INFO R ` +
        `WHERE R.MESSAGE_QUEUE_LIBRARY = M.MESSAGE_QUEUE_LIBRARY AND R.MESSAGE_QUEUE_NAME = M.MESSAGE_QUEUE_NAME ` +
        `AND R.MESSAGE_TYPE = 'REPLY' AND R.ASSOCIATED_MESSAGE_KEY = M.MESSAGE_KEY) THEN 'Y' ELSE 'N' END AS NEEDSREPLY ` +
        `FROM QSYS2.MESSAGE_QUEUE_INFO M WHERE M.MESSAGE_QUEUE_LIBRARY = ${sqlString(n.lib)} ` +
        `AND M.MESSAGE_QUEUE_NAME = ${sqlString(n.name)} AND M.MESSAGE_TYPE <> 'REPLY' ` +
        `ORDER BY NEEDSREPLY DESC, M.MESSAGE_TIMESTAMP DESC FETCH FIRST 150 ROWS ONLY`, 150);
      if (!rows.length) { return [{ kind: 'info', text: 'No messages' }]; }
      return rows.map(r => ({
        kind: 'message', queueLib: n.lib, queue: n.name,
        key: String(r.MSGKEY).trim(), id: String(r.MSGID ?? '').trim(), type: String(r.MESSAGE_TYPE ?? '').trim(),
        severity: Number(r.SEV ?? 0), text: String(r.TEXT ?? '').trim(), help: String(r.HELP ?? '').trim(),
        time: String(r.TIME ?? ''), fromUser: String(r.FROMUSER ?? '').trim(), fromJob: String(r.FROMJOB ?? '').trim(),
        needsReply: r.NEEDSREPLY === 'Y',
      }));
    } catch (e) {
      logError(e);
      return [{ kind: 'info', text: errorMessage(e).split('\n')[0], error: true }];
    }
  }
}

// ------------------------------------------------------------------ Job log documents

export const JOBLOG_SCHEME = 'silverlake-joblog';

class JobLogProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly manager: ConnectionManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const job = new URLSearchParams(uri.query).get('job') ?? '*';
    const rows = await this.manager.require().rows<Record<string, unknown>>(
      `SELECT VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TIME, COALESCE(MESSAGE_ID, '') AS MSGID, ` +
      `MESSAGE_TYPE, COALESCE(SEVERITY, 0) AS SEV, COALESCE(MESSAGE_TEXT, '') AS TEXT, ` +
      `COALESCE(MESSAGE_SECOND_LEVEL_TEXT, '') AS HELP, COALESCE(FROM_PROGRAM, '') AS PGM ` +
      `FROM TABLE(QSYS2.JOBLOG_INFO(${sqlString(job)})) ORDER BY ORDINAL_POSITION`, 20000);
    const out = [`Job log of ${job} — ${rows.length} message(s)`, '='.repeat(80), ''];
    for (const r of rows) {
      out.push(`${r.TIME}  ${String(r.MSGID).padEnd(7)}  ${String(r.MESSAGE_TYPE ?? '').padEnd(12)} sev ${String(r.SEV).padStart(2)}  ${r.PGM}`);
      out.push(`    ${r.TEXT}`);
      const help = String(r.HELP ?? '').trim();
      if (help && /ESCAPE|DIAGNOSTIC|INQUIRY/.test(String(r.MESSAGE_TYPE))) {
        out.push(...help.replace(/&N |&B |&P /g, '\n').split('\n').map(l => `      ${l.trim()}`).filter(l => l.trim()));
      }
      out.push('');
    }
    return out.join('\n');
  }
}

// ------------------------------------------------------------------ Commands

export function registerJobs(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const jobs = new JobsTreeProvider(manager);
  const messages = new MessagesTreeProvider(manager);
  jobs.view = vscode.window.createTreeView('silverlake.jobs', { treeDataProvider: jobs });
  messages.view = vscode.window.createTreeView('silverlake.messages', { treeDataProvider: messages });

  const guard = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const cl = async (cmd: string, success: string) => {
    const r = await manager.require().runCL(cmd);
    if (!r.ok) { throw new Error(`${cmd.split(' ')[0]} failed: ${(r.stderr || r.stdout).trim()}`); }
    vscode.window.setStatusBarMessage(`$(check) ${success}`, 4000);
  };

  context.subscriptions.push(
    jobs.view, messages.view,
    vscode.workspace.registerTextDocumentContentProvider(JOBLOG_SCHEME, new JobLogProvider(manager)),
    vscode.commands.registerCommand('silverlake.refreshJobs', () => jobs.refresh()),
    vscode.commands.registerCommand('silverlake.refreshMessages', () => messages.refresh()),
    vscode.commands.registerCommand('silverlake.filterJobs', guard(async () => {
      const pick = await vscode.window.showQuickPick([
        { label: '$(person) My jobs', mode: 'mine' as const },
        { label: '$(account) Jobs of a user…', mode: 'user' as const },
        { label: '$(server-process) Jobs in a subsystem…', mode: 'subsystem' as const },
        { label: '$(list-flat) All active jobs (first 500)', mode: 'all' as const },
      ], { title: 'Show which jobs?' });
      if (!pick) { return; }
      if (pick.mode === 'user' || pick.mode === 'subsystem') {
        const v = await vscode.window.showInputBox({
          title: pick.mode === 'user' ? 'User profile' : 'Subsystem', value: pick.mode === 'subsystem' ? 'QBATCH' : '',
        });
        if (!v?.trim()) { return; }
        jobs.filter = pick.mode === 'user' ? { mode: 'user', user: v.trim().toUpperCase() } : { mode: 'subsystem', subsystem: v.trim().toUpperCase() };
      } else {
        jobs.filter = { mode: pick.mode };
      }
      jobs.refresh();
    })),
    vscode.commands.registerCommand('silverlake.jobLog', guard(async (n?: JobNode) => {
      let job = n?.job;
      if (!job) {
        job = await vscode.window.showInputBox({ title: 'Job log', prompt: 'Qualified job name (number/user/name)', placeHolder: '123456/QUSER/QZDASOINIT' });
        if (!job?.trim()) { return; }
      }
      const uri = vscode.Uri.from({ scheme: JOBLOG_SCHEME, path: `/${job.replace(/\//g, '_')}.joblog`, query: new URLSearchParams({ job: job.trim() }).toString() });
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    })),
    vscode.commands.registerCommand('silverlake.endJob', guard(async (n: JobNode) => {
      const how = await vscode.window.showQuickPick([
        { label: 'Controlled (*CNTRLD)', detail: 'Let the job finish its cleanup (30 s delay)', opt: '*CNTRLD) DELAY(30' },
        { label: 'Immediately (*IMMED)', detail: 'End now — work in progress may be lost', opt: '*IMMED' },
      ], { title: `End job ${n.job}?` });
      if (!how) { return; }
      const ok = await vscode.window.showWarningMessage(`End job ${n.job} ${how.label.toLowerCase()}?`, { modal: true }, 'End job');
      if (ok !== 'End job') { return; }
      await cl(`ENDJOB JOB(${n.job}) OPTION(${how.opt})`, `Ending ${n.job}`);
      setTimeout(() => jobs.refresh(), 1500);
    })),
    vscode.commands.registerCommand('silverlake.holdJob', guard(async (n: JobNode) => {
      await cl(`HLDJOB JOB(${n.job})`, `Held ${n.job}`); jobs.refresh();
    })),
    vscode.commands.registerCommand('silverlake.releaseJob', guard(async (n: JobNode) => {
      await cl(`RLSJOB JOB(${n.job})`, `Released ${n.job}`); jobs.refresh();
    })),
    vscode.commands.registerCommand('silverlake.replyMessage', guard(async (n: MessageNode) => {
      const hints = (n.text.match(/\(([A-Z0-9 ]+(?:\s+[A-Z0-9]+)*)\)\s*$/)?.[1] ?? 'C D I R G').split(/\s+/).filter(Boolean);
      const qp = vscode.window.createQuickPick();
      qp.title = `Reply to ${n.id}: ${n.text}`;
      qp.placeholder = 'Pick or type a reply';
      qp.items = hints.map(h => ({ label: h, description: replyMeaning(h) }));
      const reply = await new Promise<string | undefined>(resolve => {
        qp.onDidAccept(() => { resolve((qp.selectedItems[0]?.label ?? qp.value).trim()); qp.hide(); });
        qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
        qp.show();
      });
      if (!reply) { return; }
      await cl(`SNDRPY MSGKEY(X'${n.key}') MSGQ(${n.queueLib}/${n.queue}) RPY(${clString(reply)}) RMV(*NO)`, `Replied ${reply} to ${n.id}`);
      messages.refresh();
    })),
    vscode.commands.registerCommand('silverlake.removeMessage', guard(async (n: MessageNode) => {
      await cl(`RMVMSG MSGQ(${n.queueLib}/${n.queue}) MSGKEY(X'${n.key}')`, 'Message removed'); messages.refresh();
    })),
    vscode.commands.registerCommand('silverlake.sendMessage', guard(async () => {
      const user = await vscode.window.showInputBox({ title: 'Send message', prompt: 'To user profile (or *SYSOPR)', value: '*SYSOPR' });
      if (!user?.trim()) { return; }
      const text = await vscode.window.showInputBox({ title: `Message to ${user}` });
      if (!text?.trim()) { return; }
      const to = user.trim().toUpperCase();
      await cl(to === '*SYSOPR' ? `SNDMSG MSG(${clString(text)}) TOMSGQ(*SYSOPR)` : `SNDMSG MSG(${clString(text)}) TOUSR(${to})`, 'Message sent');
      messages.refresh();
    })),
  );
}

function replyMeaning(r: string): string {
  return ({ C: 'Cancel', D: 'Dump and cancel', I: 'Ignore', R: 'Retry', G: 'Go / continue', F: 'Full dump', S: 'System dump' } as Record<string, string>)[r] ?? '';
}
