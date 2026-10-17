// Operations: storage and clean-up advisor, live alerts, message files and the field finder, and object promotion.
import * as vscode from 'vscode';
import { Alert, AlertMemory, isAbnormalEnd, replyCommand, validReplies } from '../core/alerts';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { addMessageCommand, changeMessageCommand, likePattern, nextMessageId, removeMessageCommand } from '../core/messageFiles';
import { carriesData, promoteStatus, promotionCommands, PromotionPlan, undoPromotionCommand } from '../core/promotion';
import { deleteCommand, formatBytes, receiverAdvice, reorgCandidates, reorgCommand } from '../core/storage';
import { assertSystemName, sqlString } from '../core/util';
import { showReport } from './reportPanel';
import { pickScope } from './search';

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vanthrex.storageAdvisor', 'vanthrex.ifsStorage', 'vanthrex.extras.row', 'vanthrex.alerts.show', 'vanthrex.alerts.toggle',
  'vanthrex.alerts.reply', 'vanthrex.messageFile', 'vanthrex.messageFile.add', 'vanthrex.fieldFinder', 'vanthrex.promoteObjects',
  'vanthrex.promote.run', 'vanthrex.promotionLog', 'vanthrex.promote.undo', 'vanthrex.objectInfo', 'vanthrex.whereUsed', 'vanthrex.jobLog',
  'vanthrex.editData', 'vanthrex.wrkOutputQueues',
]);

type Row = Record<string, unknown>;

type Obj = { library: string; name: string; type?: string };

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

const n = (r: Row | undefined, k: string) => Number(r?.[k] ?? 0) || 0;

const progress = <T>(title: string, fn: () => Promise<T>) =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function runCl(conn: IbmiConnection, cmd: string, warn?: string): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(cmd, { modal: true, detail: warn ?? vscode.l10n.t('Run this command on the IBM i?') }, 'Run', vscode.l10n.t('Copy Command'));
  if (pick === vscode.l10n.t('Copy Command')) { await vscode.env.clipboard.writeText(cmd); return false; }
  if (pick !== 'Run') { return false; }
  const r = await progress(cmd, () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  return true;
}

const row = (kind: string, data: Row) => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.extras.row', args: [kind, data] });

function libUnion(scope: string[], type = '*ALL'): string {
  return scope.map(l => `SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(l)}, ${sqlString(type)})) X`).join(' UNION ALL ');
}

async function storageAdvisor(manager: ConnectionManager, lib?: string): Promise<void> {
  const conn = manager.require();
  const scope = lib ? [lib] : await pickScope(conn, 'Storage & cleanup advisor: which libraries?');
  if (!scope) { return; }
  const daysPick = await vscode.window.showQuickPick(['90', '180', '365', '730'], { title: vscode.l10n.t('Objects not used for how many days count as unused?') });
  if (!daysPick) { return; }
  const days = Number(daysPick);
  const libsWhere = scope[0] === '*ALLUSR' ? `SYSTEM_TABLE_SCHEMA NOT LIKE 'Q%' AND SYSTEM_TABLE_SCHEMA NOT LIKE 'SYS%'` : `SYSTEM_TABLE_SCHEMA IN (${scope.map(sqlString).join(', ')})`;
  const objs = `(${libUnion(scope)})`;
  const [byLib, biggest, unused, tables, receivers, spool] = await progress('Analysing storage (this can take a minute on big systems)…', () => Promise.all([
    conn.rows<Row>(`SELECT OBJLIB AS LIB, COUNT(*) AS N, SUM(OBJSIZE) AS SZ FROM ${objs} O GROUP BY OBJLIB ORDER BY SZ DESC FETCH FIRST 50 ROWS ONLY`, 50),
    conn.rows<Row>(`SELECT OBJLIB AS LIB, OBJNAME AS NAME, OBJTYPE AS TYPE, COALESCE(OBJATTRIBUTE, '') AS ATTR, OBJSIZE AS SZ, VARCHAR_FORMAT(LAST_USED_TIMESTAMP, 'YYYY-MM-DD') AS USED, COALESCE(OBJTEXT, '') AS TXT ` +
      `FROM ${objs} O ORDER BY OBJSIZE DESC FETCH FIRST 100 ROWS ONLY`, 100),
    conn.rows<Row>(`SELECT OBJLIB AS LIB, OBJNAME AS NAME, OBJTYPE AS TYPE, COALESCE(OBJATTRIBUTE, '') AS ATTR, OBJSIZE AS SZ, VARCHAR_FORMAT(OBJCREATED, 'YYYY-MM-DD') AS CREATED, ` +
      `COALESCE(VARCHAR_FORMAT(LAST_USED_TIMESTAMP, 'YYYY-MM-DD'), 'never') AS USED, COALESCE(OBJTEXT, '') AS TXT FROM ${objs} O ` +
      `WHERE OBJTYPE IN ('*PGM', '*SRVPGM', '*FILE', '*MODULE', '*CMD', '*DTAARA', '*DTAQ', '*QRYDFN') AND OBJCREATED < CURRENT TIMESTAMP - ${days} DAYS ` +
      `AND (LAST_USED_TIMESTAMP IS NULL OR LAST_USED_TIMESTAMP < CURRENT TIMESTAMP - ${days} DAYS) ORDER BY OBJSIZE DESC FETCH FIRST 500 ROWS ONLY`, 500),
    conn.rows<Row>(`SELECT SYSTEM_TABLE_SCHEMA AS LIB, SYSTEM_TABLE_NAME AS NAME, COALESCE(NUMBER_ROWS, 0) AS ROWS, COALESCE(NUMBER_DELETED_ROWS, 0) AS DEL, COALESCE(DATA_SIZE, 0) AS SZ ` +
      `FROM QSYS2.SYSTABLESTAT WHERE ${libsWhere} AND NUMBER_DELETED_ROWS > 1000 ORDER BY NUMBER_DELETED_ROWS DESC FETCH FIRST 200 ROWS ONLY`, 200).catch(e => { log(errorMessage(e)); return []; }),
    conn.rows<Row>(`SELECT JOURNAL_RECEIVER_LIBRARY AS LIB, JOURNAL_RECEIVER_NAME AS NAME, STATUS, VARCHAR_FORMAT(DETACH_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS DET, COALESCE(SIZE, 0) AS SZ, ` +
      `JOURNAL_LIBRARY || '/' || JOURNAL_NAME AS JRN FROM QSYS2.JOURNAL_RECEIVER_INFO WHERE DETACH_TIMESTAMP < CURRENT TIMESTAMP - 30 DAYS` +
      `${scope[0] === '*ALLUSR' ? ` AND JOURNAL_RECEIVER_LIBRARY NOT LIKE 'Q%'` : ` AND JOURNAL_RECEIVER_LIBRARY IN (${scope.map(sqlString).join(', ')})`} ORDER BY SIZE DESC FETCH FIRST 300 ROWS ONLY`, 300).catch(e => { log(errorMessage(e)); return []; }),
    conn.rows<Row>(`SELECT COALESCE(USER_NAME, '') AS USR, COUNT(*) AS N, SUM(COALESCE(SIZE, 0)) AS SZ FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC ` +
      `WHERE CREATE_TIMESTAMP < CURRENT TIMESTAMP - 30 DAYS GROUP BY USER_NAME ORDER BY SZ DESC FETCH FIRST 50 ROWS ONLY`, 50).catch(e => { log(errorMessage(e)); return []; }),
  ]));
  const reorg = reorgCandidates(tables.map(t => ({ lib: s(t, 'LIB'), name: s(t, 'NAME'), rows: n(t, 'ROWS'), deleted: n(t, 'DEL'), size: n(t, 'SZ') })), 1000, 0.2);
  const rcv = receiverAdvice(receivers.map(r => ({ library: s(r, 'LIB'), name: s(r, 'NAME'), status: s(r, 'STATUS'), detached: s(r, 'DET'), size: n(r, 'SZ') * 1024 })), new Date(), 30);
  const unusedBytes = unused.reduce((a, r) => a + n(r, 'SZ'), 0);
  const reorgBytes = reorg.reduce((a, t) => a + t.size * t.share, 0);
  const rcvBytes = rcv.filter(r => r.advice === 'delete').reduce((a, r) => a + r.size, 0);
  const spoolBytes = spool.reduce((a, r) => a + n(r, 'SZ') * 1024, 0);
  showReport('storage', {
    title: vscode.l10n.t('Storage & cleanup — {0}', scope.join(', ')),
    subtitle: vscode.l10n.t('About {0} could be freed. Nothing is deleted without asking; click a row for its options.', formatBytes(unusedBytes + reorgBytes + rcvBytes + spoolBytes)),
    facts: [
      [`Objects unused for ${days}+ days`, `${unused.length} · ${formatBytes(unusedBytes)}`],
      ['Deleted rows to reclaim (RGZPFM)', `${reorg.length} file(s) · ~${formatBytes(reorgBytes)}`],
      ['Old journal receivers (saved, 30+ days)', `${rcv.filter(r => r.advice === 'delete').length} · ${formatBytes(rcvBytes)}`],
      ['Spooled files older than 30 days', `${spool.reduce((a, r) => a + n(r, 'N'), 0)} · ${formatBytes(spoolBytes)}`],
    ],
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.storageAdvisor', args: [lib] }, { label: vscode.l10n.t('IFS folders by size…'), command: 'vanthrex.ifsStorage' }, { label: vscode.l10n.t('Output queues'), command: 'vanthrex.wrkOutputQueues' }],
    tables: [
      { title: vscode.l10n.t('Libraries by size'), columns: ['Library', 'Objects', 'Size'], rows: byLib.map(r => [s(r, 'LIB'), n(r, 'N'), formatBytes(n(r, 'SZ'))]) },
      { title: vscode.l10n.t('Files with many deleted rows'), columns: ['File', 'Rows', 'Deleted rows', 'Deleted %', 'Data size'], filter: true,
        rows: reorg.map(t => [`${t.lib}/${t.name}`, t.rows, t.deleted, `${Math.round(t.share * 100)} %`, formatBytes(t.size)]),
        rowActions: reorg.map(t => row('reorg', { LIB: t.lib, NAME: t.name })), empty: vscode.l10n.t('None — nothing to reorganize.') },
      { title: vscode.l10n.t('Objects not used for {0} days or more (biggest first)', days), columns: ['Object', 'Type', 'Attribute', 'Size', 'Created', 'Last used', 'Description'], filter: true,
        rows: unused.map(r => [`${s(r, 'LIB')}/${s(r, 'NAME')}`, s(r, 'TYPE'), s(r, 'ATTR'), formatBytes(n(r, 'SZ')), s(r, 'CREATED'), s(r, 'USED'), s(r, 'TXT')]),
        rowActions: unused.map(r => row('obj', r)), empty: vscode.l10n.t('None.') },
      { title: vscode.l10n.t('Biggest objects'), columns: ['Object', 'Type', 'Attribute', 'Size', 'Last used', 'Description'], filter: true,
        rows: biggest.map(r => [`${s(r, 'LIB')}/${s(r, 'NAME')}`, s(r, 'TYPE'), s(r, 'ATTR'), formatBytes(n(r, 'SZ')), s(r, 'USED'), s(r, 'TXT')]),
        rowActions: biggest.map(r => row('obj', r)) },
      { title: vscode.l10n.t('Old journal receivers'), columns: ['Receiver', 'Journal', 'Status', 'Detached', 'Size', 'Advice'], filter: true,
        rows: rcv.map(r => [`${r.library}/${r.name}`, s(receivers.find(x => s(x, 'NAME') === r.name && s(x, 'LIB') === r.library), 'JRN'), r.status, r.detached ?? '', formatBytes(r.size), r.advice]),
        rowActions: rcv.map(r => (r.advice === 'delete' ? row('rcv', { LIB: r.library, NAME: r.name }) : undefined)),
        rowClass: rcv.map(r => (r.advice === 'delete' ? undefined : 'different')), empty: vscode.l10n.t('None.') },
      { title: vscode.l10n.t('Spooled files older than 30 days, by user'), columns: ['User', 'Files', 'Size'],
        rows: spool.map(r => [s(r, 'USR'), n(r, 'N'), formatBytes(n(r, 'SZ') * 1024)]), rowActions: spool.map(r => row('oldspool', r)), empty: vscode.l10n.t('None.') },
    ],
    note: vscode.l10n.t('"Last used" is kept by IBM i for most object types; objects that are only read by SQL or never opened since the last reset show as never used, so check before deleting. Receivers that are not saved yet should be saved first.'),
  }, ALLOWED);
}

async function ifsStorage(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const start = await vscode.window.showInputBox({ title: vscode.l10n.t('IFS folders by size'), prompt: vscode.l10n.t('Start folder'), value: '/home', ignoreFocusOut: true });
  if (!start) { return; }
  const rows = await progress(`Measuring ${start} (large trees take a while)…`, () => conn.rows<Row>(
    `SELECT CASE WHEN LOCATE('/', PATH_NAME, LENGTH(${sqlString(start.replace(/\/$/, ''))}) + 2) > 0 ` +
    `THEN SUBSTR(PATH_NAME, 1, LOCATE('/', PATH_NAME, LENGTH(${sqlString(start.replace(/\/$/, ''))}) + 2) - 1) ELSE PATH_NAME END AS DIR, ` +
    `COUNT(*) AS N, SUM(COALESCE(DATA_SIZE, 0)) AS SZ, VARCHAR_FORMAT(MAX(DATA_CHANGE_TIMESTAMP), 'YYYY-MM-DD') AS CHANGED ` +
    `FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => ${sqlString(start)}, SUBTREE_DIRECTORIES => 'YES', OBJECT_TYPE_LIST => '*ALLSTMF')) X ` +
    `GROUP BY 1 ORDER BY SZ DESC FETCH FIRST 200 ROWS ONLY`, 200));
  showReport('ifsstorage', {
    title: vscode.l10n.t('IFS storage — {0}', start), subtitle: vscode.l10n.t('{0} in {1} stream file(s), by first-level folder.', formatBytes(rows.reduce((a, r) => a + n(r, 'SZ'), 0)), rows.reduce((a, r) => a + n(r, 'N'), 0)),
    actions: [{ label: vscode.l10n.t('Another folder…'), command: 'vanthrex.ifsStorage' }],
    tables: [{ title: vscode.l10n.t('Folders by size'), filter: true, columns: ['Folder', 'Files', 'Size', 'Last change'], rows: rows.map(r => [s(r, 'DIR'), n(r, 'N'), formatBytes(n(r, 'SZ')), s(r, 'CHANGED')]) }],
  }, ALLOWED);
}

class Alerts implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly memory = new AlertMemory();
  private readonly history: Alert[] = [];
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private since = '';
  private busy = false;

  constructor(private readonly manager: ConnectionManager) {
    this.item.command = 'vanthrex.alerts.show';
    manager.onDidChange(() => this.restart());
  }

  get cfg() { return vscode.workspace.getConfiguration('vanthrex.alerts'); }

  restart(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (!this.cfg.get<boolean>('enabled', false) || !this.manager.connection) { this.item.hide(); return; }
    this.item.text = '$(bell) 0'; this.item.tooltip = vscode.l10n.t('Vanthrex live alerts — click to see them'); this.item.show();
    const secs = Math.max(30, this.cfg.get<number>('intervalSeconds', 60));
    this.since = '';
    void this.poll();
    this.timer = setInterval(() => void this.poll(), secs * 1000);
  }

  private async poll(): Promise<void> {
    const conn = this.manager.connection;
    if (!conn || this.busy) { return; }
    this.busy = true;
    try {
      const all = this.cfg.get<string>('scope', 'mine') === 'all';
      const me = sqlString(conn.user);
      const since = this.since || `CURRENT TIMESTAMP - 1 HOUR`;
      const found: Alert[] = [];
      const [msgw, inq, ends, disk, now] = await Promise.all([
        conn.rows<Row>(`SELECT JOB_NAME, COALESCE(FUNCTION, '') AS FN, COALESCE(SUBSYSTEM, '') AS SBS FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE'${all ? '' : `, CURRENT_USER_LIST_FILTER => ${me}`})) X WHERE JOB_STATUS = 'MSGW'`, 200).catch(() => []),
        conn.rows<Row>(`SELECT HEX(MESSAGE_KEY) AS K, COALESCE(MESSAGE_ID, '') AS ID, MESSAGE_TEXT AS T, VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, ` +
          `COALESCE(FROM_JOB, '') AS JOB FROM QSYS2.MESSAGE_QUEUE_INFO Q WHERE MESSAGE_QUEUE_LIBRARY = 'QSYS' AND MESSAGE_QUEUE_NAME = 'QSYSOPR' AND MESSAGE_TYPE = 'INQUIRY' ` +
          `AND MESSAGE_TIMESTAMP > CURRENT TIMESTAMP - 1 DAY${all ? '' : ` AND FROM_USER = ${me}`} AND NOT EXISTS (SELECT 1 FROM QSYS2.MESSAGE_QUEUE_INFO R WHERE R.MESSAGE_QUEUE_LIBRARY = 'QSYS' ` +
          `AND R.MESSAGE_QUEUE_NAME = 'QSYSOPR' AND R.MESSAGE_TYPE = 'REPLY' AND R.ASSOCIATED_MESSAGE_KEY = Q.MESSAGE_KEY)`, 100).catch(() => []),
        conn.rows<Row>(`SELECT FROM_JOB AS JOB, MESSAGE_TEXT AS T, VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS FROM TABLE(QSYS2.HISTORY_LOG_INFO(START_TIME => ${since})) X ` +
          `WHERE MESSAGE_ID = 'CPF1164'${all ? '' : ` AND FROM_USER = ${me}`}`, 500).catch(() => []),
        conn.rows<Row>(`SELECT SYSTEM_ASP_USED AS P FROM QSYS2.SYSTEM_STATUS_INFO`, 1).catch(() => []),
        conn.rows<Row>(`VALUES VARCHAR_FORMAT(CURRENT TIMESTAMP, 'YYYY-MM-DD-HH24.MI.SS')`, 1).catch(() => []),
      ]);
      const ts = now[0] ? String(Object.values(now[0])[0]) : '';
      if (ts) { this.since = `TIMESTAMP('${ts}')`; }
      for (const r of msgw) { found.push({ kind: 'msgw', key: `msgw:${s(r, 'JOB_NAME')}`, title: vscode.l10n.t('Job {0} is waiting for a reply (MSGW)', s(r, 'JOB_NAME')), detail: `${s(r, 'SBS')} ${s(r, 'FN')}`, job: s(r, 'JOB_NAME'), time: new Date().toISOString() }); }
      for (const r of inq) { found.push({ kind: 'inquiry', key: `inq:${s(r, 'K')}`, title: vscode.l10n.t('QSYSOPR inquiry {0}', s(r, 'ID')), detail: s(r, 'T'), job: s(r, 'JOB'), msgKey: s(r, 'K'), time: s(r, 'TS') }); }
      for (const r of ends) {
        if (isAbnormalEnd(s(r, 'T'))) { found.push({ kind: 'abend', key: `end:${s(r, 'JOB')}:${s(r, 'TS')}`, title: vscode.l10n.t('Job {0} ended abnormally', s(r, 'JOB')), detail: s(r, 'T'), job: s(r, 'JOB'), time: s(r, 'TS') }); }
      }
      const p = disk[0] ? Number(disk[0].P) : NaN; const limit = this.cfg.get<number>('diskPercent', 85);
      if (!isNaN(p) && p >= limit) { found.push({ kind: 'disk', key: `disk:${Math.floor(p)}`, title: vscode.l10n.t('System ASP is {0}% used', p.toFixed(1)), detail: vscode.l10n.t('Above the {0}% alert level.', limit), time: new Date().toISOString() }); }
      const fresh = this.memory.fresh(found);
      // A job that is no longer in MSGW can alert again later.
      for (const h of this.history.filter(a => a.kind === 'msgw')) { if (!found.some(f => f.key === h.key)) { this.memory.forget(h.key); } }
      this.history.unshift(...fresh); this.history.splice(300);
      const open = found.filter(a => a.kind === 'msgw' || a.kind === 'inquiry').length;
      this.item.text = `$(bell${open ? '-dot' : ''}) ${open}`;
      this.item.backgroundColor = open ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      for (const a of fresh.slice(0, 5)) { void this.notify(a); }
    } catch (e) { log(`Alerts: ${errorMessage(e)}`); } finally { this.busy = false; }
  }

  private async notify(a: Alert): Promise<void> {
    const buttons = [...(a.kind === 'inquiry' ? [vscode.l10n.t('Reply…')] : []), ...(a.job ? [vscode.l10n.t('Job Log')] : []), vscode.l10n.t('All Alerts')];
    const show = a.kind === 'disk' || a.kind === 'abend' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    const c = await show(`${a.title}: ${a.detail}`.slice(0, 300), ...buttons);
    if (c === vscode.l10n.t('Reply…')) { await vscode.commands.executeCommand('vanthrex.alerts.reply', a); }
    if (c === vscode.l10n.t('Job Log')) { await vscode.commands.executeCommand('vanthrex.jobLog', { job: a.job }); }
    if (c === vscode.l10n.t('All Alerts')) { this.show(); }
  }

  show(): void {
    showReport('alerts', {
      title: vscode.l10n.t('Live alerts'), subtitle: this.cfg.get<boolean>('enabled', false)
        ? `Checking every ${Math.max(30, this.cfg.get<number>('intervalSeconds', 60))} s for ${this.cfg.get<string>('scope', 'mine') === 'all' ? 'all users' : 'your own jobs'}. ${this.history.length} alert(s) this session.`
        : 'Live alerts are off. Turn them on to be told when a job waits for a reply, an inquiry arrives on QSYSOPR, a job ends abnormally or the disk fills up.',
      actions: [{ label: this.cfg.get<boolean>('enabled', false) ? 'Turn off' : 'Turn on', command: 'vanthrex.alerts.toggle' }],
      tables: [{ title: vscode.l10n.t('Alerts (newest first)'), filter: true, columns: ['Time', 'Kind', 'Alert', 'Details'],
        rows: this.history.map(a => [a.time.replace('T', ' ').slice(0, 19), a.kind, a.title, a.detail]),
        rowActions: this.history.map(a => (a.kind === 'inquiry' ? { label: vscode.l10n.t('Reply'), command: 'vanthrex.alerts.reply', args: [a] } : a.job ? { label: vscode.l10n.t('Job log'), command: 'vanthrex.jobLog', args: [{ job: a.job }] } : undefined)),
        rowClass: this.history.map(a => (a.kind === 'abend' || a.kind === 'disk' ? 'bad' : 'different')), empty: vscode.l10n.t('No alerts.') }],
      note: vscode.l10n.t('Settings: vanthrex.alerts.enabled, .intervalSeconds, .scope (mine / all), .diskPercent. Seeing other users\' jobs and QSYSOPR needs the matching authority.'),
    }, ALLOWED);
  }

  dispose(): void { if (this.timer) { clearInterval(this.timer); } this.item.dispose(); }
}

async function replyToInquiry(manager: ConnectionManager, a: Alert): Promise<void> {
  const conn = manager.require();
  if (!a?.msgKey) { return; }
  const options = validReplies(a.detail);
  const reply = options.length
    ? (await vscode.window.showQuickPick([...options, '$(edit) Other…'], { title: a.detail.slice(0, 120), placeHolder: vscode.l10n.t('Reply') }))
    : undefined;
  let text = reply && !reply.startsWith('$(') ? reply : await vscode.window.showInputBox({ title: a.detail.slice(0, 120), prompt: vscode.l10n.t('Reply'), ignoreFocusOut: true });
  if (!text) { return; }
  text = text.trim();
  await runCl(conn, replyCommand(a.msgKey, 'QSYS', 'QSYSOPR', text));
}

async function messageFile(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  let lib = o?.library; let f = o?.name;
  if (!lib || !f) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Work with message descriptions'), prompt: 'LIBRARY/MSGF', placeHolder: 'APPLIB/APPMSGF', ignoreFocusOut: true });
    if (!v?.includes('/')) { return; }
    [lib, f] = v.trim().toUpperCase().split('/');
  }
  lib = assertSystemName(lib, 'library'); f = assertSystemName(f, 'message file');
  const rows = await progress(`Reading ${lib}/${f}…`, () => conn.rows<Row>(
    `SELECT MESSAGE_ID AS ID, COALESCE(MESSAGE_TEXT, '') AS T, COALESCE(MESSAGE_SECOND_LEVEL_TEXT, '') AS H, COALESCE(SEVERITY, 0) AS SEV ` +
    `FROM QSYS2.MESSAGE_FILE_DATA WHERE MESSAGE_FILE_LIBRARY = ${sqlString(lib)} AND MESSAGE_FILE = ${sqlString(f)} ORDER BY MESSAGE_ID`, 20000));
  const target = { library: lib, name: f };
  showReport('msgf', {
    title: vscode.l10n.t('Message file {0}/{1}', lib, f), subtitle: vscode.l10n.t('{0} message description(s). Click one to change, copy or remove it.', rows.length),
    actions: [{ label: vscode.l10n.t('Add a message…'), command: 'vanthrex.messageFile.add', args: [target] }, { label: vscode.l10n.t('Refresh'), command: 'vanthrex.messageFile', args: [target] }],
    tables: [{ title: vscode.l10n.t('Messages'), filter: true, columns: ['ID', 'Severity', 'Text', 'Help'],
      rows: rows.map(r => [s(r, 'ID'), n(r, 'SEV'), s(r, 'T'), s(r, 'H').slice(0, 160)]),
      rowActions: rows.map(r => row('msgd', { ...r, LIB: lib, F: f })), empty: vscode.l10n.t('The message file is empty.') }],
    note: vscode.l10n.t('Help text may contain &N (new line), &P and &B formatting codes and &1, &2… for message data.'),
  }, ALLOWED);
}

async function editMessage(manager: ConnectionManager, lib: string, f: string, existing?: Row): Promise<void> {
  const conn = manager.require();
  let id = s(existing, 'ID');
  if (!id) {
    const ids = await conn.rows<{ ID: string }>(`SELECT MESSAGE_ID AS ID FROM QSYS2.MESSAGE_FILE_DATA WHERE MESSAGE_FILE_LIBRARY = ${sqlString(lib)} AND MESSAGE_FILE = ${sqlString(f)}`, 20000).catch(() => []);
    const prefixes = [...new Set(ids.map(x => String(x.ID).slice(0, 3)))];
    let suggested = '';
    try { suggested = nextMessageId(ids.map(x => String(x.ID)), prefixes[0] ?? f.slice(0, 3)); } catch { /* no suggestion */ }
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('New message in {0}/{1}', lib, f), prompt: vscode.l10n.t('Message ID (3 characters + 4 hex digits)'), value: suggested, ignoreFocusOut: true });
    if (!v) { return; }
    id = v.trim().toUpperCase();
  }
  const text = await vscode.window.showInputBox({ title: `${id} (1/3)`, prompt: vscode.l10n.t('Message text (use &1, &2… for message data)'), value: s(existing, 'T'), ignoreFocusOut: true,
    validateInput: v => (v.length > 132 ? '132 characters at most' : undefined) });
  if (!text) { return; }
  const help = await vscode.window.showInputBox({ title: `${id} (2/3)`, prompt: vscode.l10n.t('Help text (optional, &N starts a new line)'), value: s(existing, 'H'), ignoreFocusOut: true });
  if (help === undefined) { return; }
  const sev = await vscode.window.showInputBox({ title: `${id} (3/3)`, prompt: vscode.l10n.t('Severity (0–99)'), value: s(existing, 'SEV') || '0', ignoreFocusOut: true });
  if (sev === undefined) { return; }
  const m = { id, text, help, severity: Number(sev) };
  const cmd = existing ? changeMessageCommand(lib, f, m) : addMessageCommand(lib, f, m);
  if (await runCl(conn, cmd)) { await messageFile(manager, { library: lib, name: f }); }
}

async function fieldFinder(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const q = await vscode.window.showInputBox({ title: vscode.l10n.t('Field finder'), prompt: vscode.l10n.t('Field (column) name or part of it — * and % are wildcards'), placeHolder: 'CUSTNO', ignoreFocusOut: true });
  if (!q) { return; }
  const scope = await pickScope(conn, 'Look in which libraries?');
  if (!scope) { return; }
  const alsoText = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Field names only'), v: false }, { label: vscode.l10n.t('Field names and descriptions / headings'), v: true }], { title: vscode.l10n.t('Search') });
  if (!alsoText) { return; }
  const like = sqlString(likePattern(q));
  const libs = scope[0] === '*ALLUSR' ? `C.SYSTEM_TABLE_SCHEMA NOT LIKE 'Q%' AND C.SYSTEM_TABLE_SCHEMA NOT LIKE 'SYS%'` : `C.SYSTEM_TABLE_SCHEMA IN (${scope.map(sqlString).join(', ')})`;
  const textCond = alsoText.v ? ` OR UPPER(COALESCE(C.COLUMN_TEXT, '')) LIKE ${like} OR UPPER(COALESCE(C.COLUMN_HEADING, '')) LIKE ${like}` : '';
  const rows = await progress(`Searching for ${q}…`, () => conn.rows<Row>(
    `SELECT C.SYSTEM_TABLE_SCHEMA AS LIB, C.SYSTEM_TABLE_NAME AS TBL, C.SYSTEM_COLUMN_NAME AS COL, C.COLUMN_NAME AS SQLCOL, C.DATA_TYPE AS TYPE, C.LENGTH AS LEN, ` +
    `COALESCE(C.NUMERIC_SCALE, 0) AS SCALE, COALESCE(C.COLUMN_TEXT, '') AS TXT, T.TABLE_TYPE AS TT FROM QSYS2.SYSCOLUMNS C ` +
    `JOIN QSYS2.SYSTABLES T ON T.SYSTEM_TABLE_SCHEMA = C.SYSTEM_TABLE_SCHEMA AND T.SYSTEM_TABLE_NAME = C.SYSTEM_TABLE_NAME ` +
    `WHERE ${libs} AND (C.SYSTEM_COLUMN_NAME LIKE ${like} OR C.COLUMN_NAME LIKE ${like}${textCond}) ORDER BY C.SYSTEM_COLUMN_NAME, C.SYSTEM_TABLE_SCHEMA, C.SYSTEM_TABLE_NAME FETCH FIRST 2000 ROWS ONLY`, 2000));
  const kinds: Record<string, string> = { P: 'physical file', T: 'table', L: 'logical file', V: 'view', I: 'index', A: 'alias' };
  const distinctDefs = new Set(rows.map(r => `${s(r, 'TYPE')}(${s(r, 'LEN')}${n(r, 'SCALE') ? `,${n(r, 'SCALE')}` : ''})`));
  showReport('fieldfinder', {
    title: vscode.l10n.t('Field finder — {0}', q.toUpperCase()),
    subtitle: `${rows.length} match(es) in ${new Set(rows.map(r => `${s(r, 'LIB')}/${s(r, 'TBL')}`)).size} file(s). ${distinctDefs.size > 1 ? `Defined in ${distinctDefs.size} different ways: ${[...distinctDefs].slice(0, 6).join(', ')}.` : ''} Click a row for where the file is used.`,
    actions: [{ label: vscode.l10n.t('Search again'), command: 'vanthrex.fieldFinder' }],
    tables: [{ title: vscode.l10n.t('Fields'), filter: true, columns: ['Field', 'SQL name', 'File', 'Kind', 'Type', 'Description'],
      rows: rows.map(r => [s(r, 'COL'), s(r, 'SQLCOL'), `${s(r, 'LIB')}/${s(r, 'TBL')}`, kinds[s(r, 'TT')] ?? s(r, 'TT'), `${s(r, 'TYPE')}(${s(r, 'LEN')}${n(r, 'SCALE') ? `,${n(r, 'SCALE')}` : ''})`, s(r, 'TXT')]),
      rowActions: rows.map(r => row('field', { LIB: s(r, 'LIB'), NAME: s(r, 'TBL') })), empty: vscode.l10n.t('No field matches.') }],
    note: vscode.l10n.t('Fields with the same name but a different type or length are a common cause of data truncation — the summary above shows them.'),
  }, ALLOWED);
}

interface LogEntry { when: string; user: string; system: string; source: string; target: string; objects: string[]; backupSavf?: string; ok: boolean; error?: string }

async function promoteObjects(manager: ConnectionManager, state: vscode.Memento, o?: Obj): Promise<void> {
  const conn = manager.require();
  const src = (o?.library ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Promote objects (1/3)'), prompt: vscode.l10n.t('From library (e.g. DEV)'), value: conn.profile.currentLibrary ?? '', ignoreFocusOut: true })))?.trim().toUpperCase();
  if (!src) { return; }
  assertSystemName(src, 'library');
  const all = await progress(`Reading ${src}…`, () => conn.rows<Row>(
    `SELECT OBJNAME AS NAME, OBJTYPE AS TYPE, COALESCE(OBJATTRIBUTE, '') AS ATTR, VARCHAR_FORMAT(CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS CHG, COALESCE(OBJTEXT, '') AS TXT ` +
    `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(src)}, '*ALL')) X WHERE OBJTYPE NOT IN ('*JRN', '*JRNRCV') AND NOT (OBJTYPE = '*FILE' AND OBJATTRIBUTE = 'SAVF') ORDER BY CHANGE_TIMESTAMP DESC`, 20000));
  const picks = await vscode.window.showQuickPick(all.map(r => ({ label: s(r, 'NAME'), description: `${s(r, 'TYPE')} ${s(r, 'ATTR')} · ${s(r, 'CHG')}`, detail: s(r, 'TXT'), r,
    picked: !!o?.name && s(r, 'NAME') === o.name.toUpperCase() && (!o.type || s(r, 'TYPE') === o.type) })), {
    title: vscode.l10n.t('Promote objects (2/3): pick objects from {0} (most recently changed first)', src), canPickMany: true, matchOnDescription: true, ignoreFocusOut: true });
  if (!picks?.length) { return; }
  const cfgBackup = vscode.workspace.getConfiguration('vanthrex.promotion').get<string>('backupLibrary', 'QGPL');
  const tgt = (await vscode.window.showInputBox({ title: vscode.l10n.t('Promote objects (3/3)'), prompt: vscode.l10n.t('To library (e.g. TEST or PROD)'), value: state.get<string>('vanthrex.promotion.lastTarget', ''), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!tgt) { return; }
  assertSystemName(tgt, 'library');
  const inTarget = await conn.rows<Row>(
    `SELECT OBJNAME AS NAME, OBJTYPE AS TYPE, VARCHAR_FORMAT(CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS CHG FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(tgt)}, '*ALL')) X ` +
    `WHERE OBJNAME IN (${picks.map(p => sqlString(p.label)).join(', ')})`, 5000);
  const items = picks.map(p => {
    const t = inTarget.find(x => s(x, 'NAME') === p.label && s(x, 'TYPE') === s(p.r, 'TYPE'));
    return { name: p.label, type: s(p.r, 'TYPE'), attribute: s(p.r, 'ATTR'), sourceChanged: s(p.r, 'CHG'), targetChanged: t ? s(t, 'CHG') : undefined, existsInTarget: !!t };
  });
  const plan: PromotionPlan = { source: src, target: tgt, backupLibrary: cfgBackup, when: new Date().toISOString(), objects: items.map(i => ({ name: i.name, type: i.type })) };
  const existing = items.filter(i => i.existsInTarget).map(i => ({ name: i.name, type: i.type }));
  const cmds = promotionCommands(plan, existing);
  const warnNewer = items.filter(i => promoteStatus(i) === 'NEWER IN TARGET');
  const data = items.filter(carriesData);
  showReport('promote', {
    title: vscode.l10n.t('Promote {0} object(s): {1} → {2}', items.length, src, tgt),
    subtitle: `${items.filter(i => !i.existsInTarget).length} new, ${existing.length} replaced${existing.length ? ` (backed up first to ${cmds.backupSavf})` : ''}.` +
      `${warnNewer.length ? ` ⚠ ${warnNewer.length} object(s) are NEWER in ${tgt} — someone changed them there.` : ''}${data.length ? ` ⚠ ${data.length} physical file(s) carry data: the ${tgt} data would be replaced by the ${src} data.` : ''}`,
    actions: [{ label: vscode.l10n.t('Promote {0} object(s)…', items.length), command: 'vanthrex.promote.run', args: [plan, existing] }, { label: vscode.l10n.t('Promotion log'), command: 'vanthrex.promotionLog' }],
    tables: [
      { title: vscode.l10n.t('Compare before promoting'), columns: ['Object', 'Type', 'Attribute', `Changed in ${src}`, `Changed in ${tgt}`, 'Status'],
        rows: items.map(i => [i.name, i.type, i.attribute ?? '', i.sourceChanged ?? '', i.targetChanged ?? '—', carriesData(i) ? `${promoteStatus(i)} · DATA` : promoteStatus(i)]),
        rowClass: items.map(i => (promoteStatus(i) === 'NEWER IN TARGET' || carriesData(i) ? 'bad' : promoteStatus(i) === 'new' ? 'onlyA' : 'different')) },
      { title: vscode.l10n.t('Commands that will run'), columns: ['#', 'Command'], rows: cmds.steps.map((c, i) => [i + 1, c]) },
    ],
    note: vscode.l10n.t('Objects are copied with SAVOBJ / RSTOBJ through a save file, so their attributes and authorities come along. Programs that are in use in the target cannot be replaced until they are released. Backup library: setting vanthrex.promotion.backupLibrary.'),
  }, ALLOWED);
}

async function runPromotion(manager: ConnectionManager, state: vscode.Memento, plan: PromotionPlan, existing: { name: string; type: string }[]): Promise<void> {
  const conn = manager.require();
  const cmds = promotionCommands(plan, existing);
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Promote {0} object(s) from {1} to {2}?', plan.objects.length, plan.source, plan.target), {
    modal: true, detail: cmds.steps.join('\n') }, vscode.l10n.t('Promote'));
  if (ok !== vscode.l10n.t('Promote')) { return; }
  const entry: LogEntry = { when: new Date().toISOString(), user: conn.user, system: conn.profile.name, source: plan.source, target: plan.target,
    objects: plan.objects.map(o => `${o.name} ${o.type}`), backupSavf: cmds.backupSavf, ok: false };
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Promoting {0} → {1}…', plan.source, plan.target) }, async (p) => {
      for (const [i, c] of cmds.steps.entries()) {
        p.report({ message: `${i + 1}/${cmds.steps.length} ${c.split(' ')[0]}` });
        const r = await conn.runCL(c);
        if (!r.ok && !c.startsWith('DLTF')) { throw new Error(`${c.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
      }
    });
    entry.ok = true;
    vscode.window.showInformationMessage(vscode.l10n.t('Promoted {0} object(s) to {1}.', plan.objects.length, plan.target));
  } catch (e) {
    entry.error = errorMessage(e);
    throw e;
  } finally {
    const log0 = state.get<LogEntry[]>('vanthrex.promotion.log', []);
    await state.update('vanthrex.promotion.log', [entry, ...log0].slice(0, 500));
    await state.update('vanthrex.promotion.lastTarget', plan.target);
  }
}

function promotionLog(state: vscode.Memento): void {
  const entries = state.get<LogEntry[]>('vanthrex.promotion.log', []);
  showReport('promolog', {
    title: vscode.l10n.t('Promotion log'), subtitle: vscode.l10n.t('{0} promotion(s) made from this VS Code, newest first. Click one with a backup to undo it.', entries.length),
    actions: [{ label: vscode.l10n.t('Promote objects…'), command: 'vanthrex.promoteObjects' }],
    tables: [{ title: vscode.l10n.t('Promotions'), filter: true, columns: ['When', 'System', 'User', 'From', 'To', 'Objects', 'Backup', 'Result'],
      rows: entries.map(e => [e.when.replace('T', ' ').slice(0, 19), e.system, e.user, e.source, e.target, e.objects.join(', '), e.backupSavf ?? '—', e.ok ? 'OK' : `failed: ${e.error ?? ''}`]),
      rowActions: entries.map(e => (e.backupSavf ? { label: vscode.l10n.t('Undo'), command: 'vanthrex.promote.undo', args: [e.target, e.backupSavf] } : undefined)),
      rowClass: entries.map(e => (e.ok ? undefined : 'bad')), empty: vscode.l10n.t('No promotions yet.') }],
    note: vscode.l10n.t('Undo restores the backup taken just before the promotion. Objects that were new in the target are not removed by an undo.'),
  }, ALLOWED);
}

async function rowMenu(manager: ConnectionManager, kind: string, r: Row): Promise<void> {
  const conn = manager.require();
  const lib = s(r, 'LIB'); const name = s(r, 'NAME'); const type = s(r, 'TYPE');
  type Opt = { label: string; run: () => Thenable<unknown> };
  let opts: Opt[] = [];
  switch (kind) {
    case 'reorg':
      opts = [
        { label: vscode.l10n.t('$(fold) Reorganize (RGZPFM)…'), run: () => runCl(conn, reorgCommand(lib, name), vscode.l10n.t('RGZPFM locks the file exclusively while it runs; run it when nobody uses the file.')) },
        { label: vscode.l10n.t('$(table) Open the data'), run: () => vscode.commands.executeCommand('vanthrex.editData', { library: lib, name, type: '*FILE' }) },
      ];
      break;
    case 'obj':
      opts = [
        { label: vscode.l10n.t('$(info) Object information'), run: () => vscode.commands.executeCommand('vanthrex.objectInfo', { library: lib, name, type }) },
        { label: vscode.l10n.t('$(references) Where used'), run: () => vscode.commands.executeCommand('vanthrex.whereUsed', { library: lib, name, type }) },
        { label: vscode.l10n.t('$(trash) Delete…'), run: () => runCl(conn, deleteCommand(lib, name, type), vscode.l10n.t('The object is deleted. Save it first if you may need it again.')) },
      ];
      break;
    case 'rcv':
      opts = [{ label: vscode.l10n.t('$(trash) Delete receiver (DLTJRNRCV)…'), run: () => runCl(conn, `DLTJRNRCV JRNRCV(${lib}/${name})`, vscode.l10n.t('The receiver is saved, so it can be restored if needed.')) }];
      break;
    case 'oldspool': {
      const u = s(r, 'USR');
      opts = [{ label: vscode.l10n.t('$(trash) Delete spooled files of {0} older than 30 days…', u), run: async () => {
        const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Delete all spooled files of {0} older than 30 days?', u), { modal: true }, vscode.l10n.t('Delete'));
        if (ok !== vscode.l10n.t('Delete')) { return; }
        await progress(vscode.l10n.t('Deleting…'), () => conn.sql(`CALL SYSTOOLS.DELETE_OLD_SPOOLED_FILES(DELETE_OLDER_THAN => CURRENT DATE - 30 DAYS, P_USER_NAME => ${sqlString(u)}, PREVIEW => 'NO')`, 1));
        vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
      } }];
      break;
    }
    case 'msgd': {
      const f = s(r, 'F'); const id = s(r, 'ID');
      opts = [
        { label: vscode.l10n.t('$(edit) Change…'), run: () => editMessage(manager, lib, f, r) },
        { label: vscode.l10n.t('$(copy) Copy as ADDMSGD'), run: () => vscode.env.clipboard.writeText(addMessageCommand(lib, f, { id, text: s(r, 'T'), help: s(r, 'H'), severity: n(r, 'SEV') })) },
        { label: vscode.l10n.t('$(trash) Remove…'), run: async () => { if (await runCl(conn, removeMessageCommand(lib, f, id), vscode.l10n.t('Programs that send this message will fail to find it.'))) { await messageFile(manager, { library: lib, name: f }); } } },
      ];
      break;
    }
    case 'field':
      opts = [
        { label: vscode.l10n.t('$(references) Programs using this file'), run: () => vscode.commands.executeCommand('vanthrex.whereUsed', { library: lib, name, type: '*FILE' }) },
        { label: vscode.l10n.t('$(table) Open the data'), run: () => vscode.commands.executeCommand('vanthrex.editData', { library: lib, name, type: '*FILE' }) },
        { label: vscode.l10n.t('$(info) Object information'), run: () => vscode.commands.executeCommand('vanthrex.objectInfo', { library: lib, name, type: '*FILE' }) },
      ];
      break;
  }
  if (!opts.length) { return; }
  const pick = await vscode.window.showQuickPick(opts, { title: [lib, name].filter(Boolean).join('/') || kind });
  if (pick) { await pick.run(); }
}

// ================================================================ registration

export function registerOperations(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const objOf = (x: unknown): Obj | undefined => {
    const o = x as Partial<Obj> | undefined;
    return o && typeof o === 'object' && o.library ? { library: o.library, name: o.name ?? '', type: o.type } : undefined;
  };
  const alerts = new Alerts(manager);
  const state = context.globalState;
  context.subscriptions.push(
    alerts,
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vanthrex.alerts')) { alerts.restart(); } }),
    vscode.commands.registerCommand('vanthrex.storageAdvisor', guard((x?: unknown) => storageAdvisor(manager, typeof x === 'string' ? x : objOf(x)?.library))),
    vscode.commands.registerCommand('vanthrex.ifsStorage', guard(() => ifsStorage(manager))),
    vscode.commands.registerCommand('vanthrex.extras.row', guard((kind: string, r: Row) => rowMenu(manager, String(kind), r ?? {}))),
    vscode.commands.registerCommand('vanthrex.alerts.show', guard(() => alerts.show())),
    vscode.commands.registerCommand('vanthrex.alerts.toggle', guard(async () => {
      const on = !vscode.workspace.getConfiguration('vanthrex.alerts').get<boolean>('enabled', false);
      await vscode.workspace.getConfiguration('vanthrex.alerts').update('enabled', on, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(on ? vscode.l10n.t('Live alerts are on.') : vscode.l10n.t('Live alerts are off.'));
      alerts.show();
    })),
    vscode.commands.registerCommand('vanthrex.alerts.reply', guard((a: Alert) => replyToInquiry(manager, a))),
    vscode.commands.registerCommand('vanthrex.messageFile', guard((x?: unknown) => messageFile(manager, objOf(x)))),
    vscode.commands.registerCommand('vanthrex.messageFile.add', guard((x: Obj) => editMessage(manager, x.library, x.name))),
    vscode.commands.registerCommand('vanthrex.fieldFinder', guard(() => fieldFinder(manager))),
    vscode.commands.registerCommand('vanthrex.promoteObjects', guard((x?: unknown) => {
      const o = objOf(x);
      return promoteObjects(manager, state, o?.name ? o : o ? { library: o.library, name: '' } : undefined);
    })),
    vscode.commands.registerCommand('vanthrex.promote.run', guard((plan: PromotionPlan, existing: { name: string; type: string }[]) => runPromotion(manager, state, plan, existing ?? []))),
    vscode.commands.registerCommand('vanthrex.promotionLog', guard(() => promotionLog(state))),
    vscode.commands.registerCommand('vanthrex.promote.undo', guard((target: string, savf: string) => runCl(manager.require(), undoPromotionCommand(target, savf),
      vscode.l10n.t('The objects saved before the promotion are restored over {0}.', target)))),
  );
  alerts.restart();
}
