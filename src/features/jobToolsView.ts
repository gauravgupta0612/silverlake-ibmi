// Job tools: my recent jobs, running SQL, any message queue, job details, the history log, live job log, who is signed
// on and failed jobs.
import * as vscode from 'vscode';
import { replyCommand, validReplies } from '../core/alerts';
import { IbmiConnection } from '../core/connection';
import {
  breakMessageCommand, connectionKind, endCodeMeaning, endJobCommand, failedJobs, failuresByName, isAlarming, jobLogLine, JobLogMessage,
  jobLogSql, jobPhase, sbmjobCommand, stackLine, submittedJob,
} from '../core/jobTools';
import { errorMessage, log, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { removeMessageCommand, sendMessageCommand } from '../core/systemCommands';
import { sqlString } from '../core/util';
import { showReport } from './reportPanel';
import { spoolUri } from './spool';

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vanthrex.jobLog', 'vanthrex.analyzeJobLog', 'vanthrex.myRecentJobs', 'vanthrex.activeSql', 'vanthrex.activeSql.cancel',
  'vanthrex.messageQueue', 'vanthrex.messageQueue.row', 'vanthrex.messageQueue.send', 'vanthrex.explainMessage', 'vanthrex.jobDetails',
  'vanthrex.historyLog', 'vanthrex.watchJob',
]);

type Row = Record<string, unknown>;

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function myRecentJobs(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await progress(vscode.l10n.t('Reading your recent jobs…'), () => conn.rows<Row>(
    `SELECT * FROM TABLE(QSYS2.JOB_INFO(JOB_USER_FILTER => ${sqlString(conn.user)}, JOB_STATUS_FILTER => '*ALL')) X WHERE JOB_TYPE <> 'INT' OR JOB_TYPE IS NULL ORDER BY JOB_ENTERED_SYSTEM_TIME DESC FETCH FIRST 300 ROWS ONLY`, 300));
  const status = (r: Row) => s(r, 'COMPLETION_STATUS') || s(r, 'JOB_STATUS');
  showReport('recentjobs', {
    title: vscode.l10n.t('Recent jobs of {0}', conn.user), subtitle: vscode.l10n.t('{0} job(s), newest first; {1} ended abnormally. Click a job for its job log.', rows.length, rows.filter(r => /ABNORMAL/i.test(status(r))).length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.myRecentJobs' }],
    tables: [{ title: vscode.l10n.t('Jobs'), filter: true, columns: ['Job', 'Type', 'Status', 'Entered', 'Started', 'Ended', 'Job queue'],
      rows: rows.map(r => [s(r, 'JOB_NAME'), s(r, 'JOB_TYPE'), status(r), s(r, 'JOB_ENTERED_SYSTEM_TIME').slice(0, 19), s(r, 'JOB_ACTIVE_TIME').slice(0, 19), s(r, 'JOB_END_TIME').slice(0, 19), s(r, 'JOB_QUEUE_NAME')]),
      rowActions: rows.map(r => (/ABNORMAL/i.test(status(r)) ? { label: vscode.l10n.t('Analyze job log'), command: 'vanthrex.analyzeJobLog', args: [s(r, 'JOB_NAME')] } : { label: vscode.l10n.t('Job log'), command: 'vanthrex.jobLog', args: [{ job: s(r, 'JOB_NAME') }] })),
      rowClass: rows.map(r => (/ABNORMAL/i.test(status(r)) ? 'bad' : undefined)) }],
  }, ALLOWED);
}

async function activeSql(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await progress(vscode.l10n.t('Reading running SQL statements…'), () => conn.rows<Row>(
    `SELECT JOB_NAME, COALESCE(AUTHORIZATION_NAME, '') AS USR, COALESCE(SUBSYSTEM, '') AS SBS, VARCHAR_FORMAT(SQL_STATEMENT_START_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS STARTED, ` +
    `TIMESTAMPDIFF(2, CHAR(CURRENT TIMESTAMP - SQL_STATEMENT_START_TIMESTAMP)) AS SECS, COALESCE(CPU_TIME, 0) AS CPU, COALESCE(SQL_STATEMENT_TEXT, '') AS TXT ` +
    `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'ALL')) A WHERE SQL_STATEMENT_STATUS = 'ACTIVE' ORDER BY SQL_STATEMENT_START_TIMESTAMP FETCH FIRST 300 ROWS ONLY`, 300));
  showReport('activeSql', {
    title: vscode.l10n.t('Running SQL statements'), subtitle: vscode.l10n.t('{0} statement(s) running now, longest first. Click one to cancel it or see its job.', rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.activeSql' }],
    tables: [{ title: vscode.l10n.t('Statements'), filter: true, columns: ['Running (s)', 'Job', 'User', 'Subsystem', 'Started', 'Statement'],
      rows: rows.map(r => [s(r, 'SECS'), s(r, 'JOB_NAME'), s(r, 'USR'), s(r, 'SBS'), s(r, 'STARTED'), s(r, 'TXT').replace(/\s+/g, ' ').slice(0, 300)]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.activeSql.cancel', args: [s(r, 'JOB_NAME'), s(r, 'TXT').slice(0, 300)] })),
      rowClass: rows.map(r => (Number(r.SECS) > 300 ? 'bad' : Number(r.SECS) > 60 ? 'different' : undefined)), empty: vscode.l10n.t('No SQL is running.') }],
    note: vscode.l10n.t('Cancel uses QSYS2.CANCEL_SQL: the statement ends with SQL0952 and the job keeps running. Cancelling needs *JOBCTL or the same user profile.'),
  }, ALLOWED);
}

async function run(conn: IbmiConnection, cmd: string, warn = ''): Promise<boolean> {
  const p = await vscode.window.showWarningMessage(cmd, { modal: true, detail: warn || undefined }, vscode.l10n.t('Run'));
  if (p !== vscode.l10n.t('Run')) { return false; }
  const r = await progress(cmd.split(' ')[0], () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  return true;
}

async function messageQueue(manager: ConnectionManager, q?: string): Promise<void> {
  const conn = manager.require();
  const v = (q ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Message queue'), prompt: 'LIBRARY/MSGQ', value: 'QSYS/QSYSOPR', ignoreFocusOut: true })))?.trim().toUpperCase();
  if (!v?.includes('/')) { return; }
  const [lib, mq] = v.split('/');
  const rows = await progress(vscode.l10n.t('Reading {0}…', v), () => conn.rows<Row>(
    `SELECT HEX(MESSAGE_KEY) AS K, COALESCE(MESSAGE_ID, '') AS ID, MESSAGE_TYPE AS T, COALESCE(SEVERITY, 0) AS SEV, VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, ` +
    `COALESCE(MESSAGE_TEXT, '') AS TXT, COALESCE(FROM_USER, '') AS USR, COALESCE(FROM_JOB, '') AS JOB, HEX(ASSOCIATED_MESSAGE_KEY) AS AK FROM QSYS2.MESSAGE_QUEUE_INFO ` +
    `WHERE MESSAGE_QUEUE_LIBRARY = ${sqlString(lib)} AND MESSAGE_QUEUE_NAME = ${sqlString(mq)} ORDER BY MESSAGE_TIMESTAMP DESC FETCH FIRST 1000 ROWS ONLY`, 1000));
  const answered = new Set(rows.filter(r => s(r, 'T') === 'REPLY').map(r => s(r, 'AK')));
  const shown = rows.filter(r => s(r, 'T') !== 'REPLY');
  const waiting = shown.filter(r => s(r, 'T') === 'INQUIRY' && !answered.has(s(r, 'K')));
  showReport('msgq', {
    title: vscode.l10n.t('Message queue {0}', v), subtitle: vscode.l10n.t('{0} message(s), newest first; {1} inquiry message(s) waiting for a reply.', shown.length, waiting.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.messageQueue', args: [v] }, { label: vscode.l10n.t('Send a message…'), command: 'vanthrex.messageQueue.send', args: [v] }],
    tables: [{ title: vscode.l10n.t('Messages'), filter: true, columns: ['Time', 'Message', 'Type', 'Sev', 'Text', 'From user', 'From job'],
      rows: shown.map(r => [s(r, 'TS'), s(r, 'ID'), s(r, 'T') === 'INQUIRY' && !answered.has(s(r, 'K')) ? 'INQUIRY — waiting' : s(r, 'T'), s(r, 'SEV'), s(r, 'TXT'), s(r, 'USR'), s(r, 'JOB')]),
      rowActions: shown.map(r => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.messageQueue.row', args: [v, { key: s(r, 'K'), id: s(r, 'ID'), text: s(r, 'TXT'), job: s(r, 'JOB'), waiting: s(r, 'T') === 'INQUIRY' && !answered.has(s(r, 'K')) }] })),
      rowClass: shown.map(r => (s(r, 'T') === 'INQUIRY' && !answered.has(s(r, 'K')) ? 'bad' : Number(r.SEV) >= 40 ? 'different' : undefined)) }],
  }, ALLOWED);
}

async function messageRow(manager: ConnectionManager, q: string, m: { key: string; id: string; text: string; job: string; waiting: boolean }): Promise<void> {
  const conn = manager.require();
  const [lib, mq] = q.split('/');
  const opts = [
    ...(m.waiting ? [{ label: vscode.l10n.t('$(reply) Reply…'), v: 'reply' }] : []),
    ...(m.id ? [{ label: vscode.l10n.t('$(question) Explain {0}', m.id), v: 'explain' }] : []),
    ...(m.job ? [{ label: vscode.l10n.t('$(output) Job log of the sender'), v: 'log' }] : []),
    { label: vscode.l10n.t('$(trash) Remove'), v: 'remove' },
  ];
  const p = await vscode.window.showQuickPick(opts, { title: m.text.slice(0, 120) });
  if (!p) { return; }
  if (p.v === 'explain') { await vscode.commands.executeCommand('vanthrex.explainMessage', m.id); return; }
  if (p.v === 'log') { await vscode.commands.executeCommand('vanthrex.jobLog', { job: m.job }); return; }
  if (p.v === 'reply') {
    const valid = validReplies(m.text);
    let reply = valid.length ? await vscode.window.showQuickPick([...valid, vscode.l10n.t('Other…')], { title: m.text.slice(0, 120) }) : undefined;
    if (!reply || !valid.includes(reply)) { reply = await vscode.window.showInputBox({ title: vscode.l10n.t('Reply'), ignoreFocusOut: true }); }
    if (reply && await run(conn, replyCommand(m.key, lib, mq, reply))) { await messageQueue(manager, q); }
    return;
  }
  if (await run(conn, removeMessageCommand(lib, mq, m.key))) { await messageQueue(manager, q); }
}

const pick = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { if (r && r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') { return String(r[k]).trim(); } } return ''; };

async function q(conn: IbmiConnection, sql: string, n = 500): Promise<Row[]> {
  try { return await conn.rows<Row>(sql, n); } catch (e) { log(`${sql.slice(0, 80)}…: ${errorMessage(e)}`); return []; }
}

async function jobDetails(manager: ConnectionManager, j?: unknown): Promise<void> {
  const conn = manager.require();
  const job = (typeof j === 'string' ? j : (j as { job?: string } | undefined)?.job) ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('What is this job doing?'), prompt: vscode.l10n.t('Qualified job name (number/user/name)'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!job) { return; }
  const [info, stack, locks, ags] = await progress(vscode.l10n.t('Looking into {0}…', job), () => Promise.all([
    q(conn, `SELECT * FROM TABLE(QSYS2.ACTIVE_JOB_INFO(JOB_NAME_FILTER => ${sqlString(job.split('/')[2] ?? job)}, DETAILED_INFO => 'ALL')) A WHERE JOB_NAME = ${sqlString(job)}`, 1),
    q(conn, `SELECT * FROM TABLE(QSYS2.STACK_INFO(${sqlString(job)}, 'ALL')) S ORDER BY ORDINAL_POSITION DESC`, 300),
    q(conn, `SELECT * FROM TABLE(QSYS2.JOB_LOCK_INFO(${sqlString(job)})) L ORDER BY OBJECT_LIBRARY, OBJECT_NAME`, 1000),
    q(conn, `SELECT * FROM TABLE(QSYS2.ACTIVATION_GROUP_INFO(${sqlString(job)})) G`, 200),
  ]));
  const i = info[0];
  if (!i && !stack.length) { throw new Error(vscode.l10n.t('{0} is not active (or you are not allowed to see it).', job)); }
  const top = stack.find(r => !/^Q/.test(pick(r, 'PROGRAM_LIBRARY_NAME')) && pick(r, 'PROGRAM_NAME')) ?? stack[0];
  showReport('jobDetails', {
    title: vscode.l10n.t('What is {0} doing?', job),
    subtitle: `${pick(i, 'JOB_STATUS') || '?'} in ${pick(i, 'SUBSYSTEM') || '?'}${top ? ` — now in ${stackLine(top)}` : ''}.`,
    facts: [['Status / function', `${pick(i, 'JOB_STATUS')} ${pick(i, 'FUNCTION_TYPE')} ${pick(i, 'FUNCTION')}`], ['Current user', pick(i, 'AUTHORIZATION_NAME')],
      ['CPU used (ms) / disk I/O', `${pick(i, 'CPU_TIME')} / ${pick(i, 'TOTAL_DISK_IO_COUNT')}`], ['Temporary storage', pick(i, 'TEMPORARY_STORAGE') ? `${pick(i, 'TEMPORARY_STORAGE')} MB` : ''],
      ['SQL now', pick(i, 'SQL_STATEMENT_TEXT').slice(0, 300)], ['Waiting for', pick(i, 'MESSAGE_REPLY') === 'YES' ? 'a reply to a message (MSGW)' : pick(i, 'JOB_STATUS') === 'LCKW' ? 'a lock' : '']],
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.jobDetails', args: [job] }, { label: vscode.l10n.t('Job log'), command: 'vanthrex.jobLog', args: [{ job }] },
      { label: vscode.l10n.t('Analyze job log'), command: 'vanthrex.analyzeJobLog', args: [job] }, { label: vscode.l10n.t('Notify me when it ends'), command: 'vanthrex.watchJob', args: [{ job }] }],
    tables: [
      { title: vscode.l10n.t('Call stack (newest first)'), columns: ['#', 'Program / procedure', 'Type', 'Activation group'], rows: stack.map(r => [pick(r, 'ORDINAL_POSITION'), stackLine(r), pick(r, 'ENTRY_TYPE'), pick(r, 'ACTIVATION_GROUP_NAME')]),
        rowClass: stack.map(r => (r === top ? 'different' : /^Q/.test(pick(r, 'PROGRAM_LIBRARY_NAME')) ? 'dim' : undefined)), empty: vscode.l10n.t('Not available.') },
      { title: vscode.l10n.t('Locks held or waited for'), filter: true, columns: ['Object', 'Type', 'Member', 'Lock', 'Status', 'Scope'],
        rows: locks.map(r => [`${pick(r, 'OBJECT_LIBRARY')}/${pick(r, 'OBJECT_NAME')}`, pick(r, 'OBJECT_TYPE'), pick(r, 'MEMBER_NAME', 'MEMBER_LOCKS'), pick(r, 'LOCK_STATE'), pick(r, 'LOCK_STATUS'), pick(r, 'LOCK_SCOPE')]),
        rowClass: locks.map(r => (/WAIT/i.test(pick(r, 'LOCK_STATUS')) ? 'bad' : undefined)), empty: vscode.l10n.t('None.') },
      { title: vscode.l10n.t('Activation groups'), columns: ['Name', 'Number', 'Programs', 'Heap storage'], rows: ags.map(r => [pick(r, 'ACTIVATION_GROUP_NAME'), pick(r, 'ACTIVATION_GROUP_NUMBER'), pick(r, 'NUMBER_OF_PROGRAMS', 'PROGRAMS'), pick(r, 'HEAP_STORAGE')]), empty: vscode.l10n.t('Not available.') },
    ],
    note: vscode.l10n.t('The highlighted stack line is the first non-IBM program — usually where to look. A lock with status WAITING means this job is blocked by another one.'),
  }, ALLOWED);
}

async function historyLog(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const range = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Last hour'), h: 1 }, { label: vscode.l10n.t('Last 24 hours'), h: 24 }, { label: vscode.l10n.t('Last 7 days'), h: 168 }], { title: vscode.l10n.t('System history log (QHST)') });
  if (!range) { return; }
  const filter = await vscode.window.showInputBox({ title: vscode.l10n.t('Filter (optional)'), prompt: vscode.l10n.t('A message ID (CPF1164), a user, a job name or words of the text'), ignoreFocusOut: true });
  if (filter === undefined) { return; }
  const f = filter.trim().toUpperCase();
  const where = f ? ` WHERE MESSAGE_ID = ${sqlString(f)} OR FROM_USER = ${sqlString(f)} OR FROM_JOB LIKE ${sqlString(`%${f}%`)} OR UPPER(MESSAGE_TEXT) LIKE ${sqlString(`%${f.replace(/[%_]/g, '')}%`)}` : '';
  const rows = await progress(vscode.l10n.t('Reading the history log…'), () => conn.rows<Row>(
    `SELECT VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, COALESCE(MESSAGE_ID, '') AS ID, COALESCE(MESSAGE_TYPE, '') AS T, COALESCE(SEVERITY, 0) AS SEV, ` +
    `COALESCE(FROM_USER, '') AS USR, COALESCE(FROM_JOB, '') AS JOB, COALESCE(MESSAGE_TEXT, '') AS TXT FROM TABLE(QSYS2.HISTORY_LOG_INFO(START_TIME => CURRENT TIMESTAMP - ${range.h} HOURS)) H${where} ` +
    `ORDER BY MESSAGE_TIMESTAMP DESC FETCH FIRST 2000 ROWS ONLY`, 2000));
  const byId = new Map<string, number>(); rows.forEach(r => byId.set(s(r, 'ID'), (byId.get(s(r, 'ID')) ?? 0) + 1));
  showReport('qhst', {
    title: vscode.l10n.t('System history log'), subtitle: `${rows.length} message(s) in the ${range.label.toLowerCase()}${f ? ` matching "${filter.trim()}"` : ''}, newest first (max 2000).`,
    facts: [...byId.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => [id || '(none)', n] as [string, number]),
    actions: [{ label: vscode.l10n.t('Change filter'), command: 'vanthrex.historyLog' }],
    tables: [{ title: vscode.l10n.t('Messages'), filter: true, columns: ['Time', 'Message', 'Sev', 'User', 'Job', 'Text'], rows: rows.map(r => [s(r, 'TS'), s(r, 'ID'), s(r, 'SEV'), s(r, 'USR'), s(r, 'JOB'), s(r, 'TXT')]),
      rowActions: rows.map(r => (s(r, 'ID') ? { label: vscode.l10n.t('Explain'), command: 'vanthrex.explainMessage', args: [s(r, 'ID')] } : undefined)),
      rowClass: rows.map(r => (Number(r.SEV) >= 40 ? 'bad' : Number(r.SEV) >= 20 ? 'different' : undefined)) }],
    note: vscode.l10n.t('QHST holds job starts and ends (CPF1124 / CPF1164 with the end code), sign-on failures, subsystem events and operator messages.'),
  }, ALLOWED);
}

const live = new Map<string, { channel: vscode.OutputChannel; timer: NodeJS.Timeout; stop: () => void }>();

async function jobLogLive(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  const job = (typeof a === 'string' ? a : (a as { job?: string } | undefined)?.job)
    ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Live job log'), prompt: vscode.l10n.t('Qualified job name (number/user/name)'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!job) { return; }
  jobLogSql(job, 0);   // validates the name
  if (live.has(job)) { live.get(job)!.channel.show(true); return; }
  const channel = vscode.window.createOutputChannel(vscode.l10n.t('Job log {0}', job), 'log');
  channel.show(true);
  channel.appendLine(vscode.l10n.t('Following the job log of {0} — new messages appear here every few seconds. Stop with "Vanthrex: Stop Live Job Log".', job));
  let last = 0; let polls = 0; let busy = false; let lastAlarm = 0;
  const started = Date.now();
  const stop = (why: string) => {
    const l = live.get(job);
    if (!l) { return; }
    clearInterval(l.timer); live.delete(job);
    channel.appendLine(`— ${why} —`);
  };
  const tick = async () => {
    if (busy) { return; }
    busy = true;
    try {
      if (!manager.connection) { stop(vscode.l10n.t('disconnected')); return; }
      const rows = await conn.rows<Row>(jobLogSql(job, last), 2000);
      for (const r of rows) {
        const msg: JobLogMessage = { pos: Number(r.P), time: s(r, 'T'), id: s(r, 'I'), type: s(r, 'Y'), severity: Number(r.S ?? 0), text: s(r, 'X'), from: s(r, 'F') };
        last = Math.max(last, msg.pos);
        channel.appendLine(jobLogLine(msg));
        if (polls > 0 && isAlarming(msg) && Date.now() - lastAlarm > 15_000) {
          lastAlarm = Date.now();
          const explain = vscode.l10n.t('Explain');
          void vscode.window.showWarningMessage(`${job}: ${msg.id} ${msg.text}`.slice(0, 300), explain, vscode.l10n.t('Show')).then(c => {
            if (c === explain && msg.id) { void vscode.commands.executeCommand('vanthrex.explainMessage', msg.id); } else if (c) { channel.show(true); }
          });
        }
      }
      polls++;
      if (polls % 5 === 0) {
        const name = job.split('/')[2];
        const act = await conn.rows<Row>(`SELECT JOB_STATUS AS S FROM TABLE(QSYS2.ACTIVE_JOB_INFO(JOB_NAME_FILTER => '${name}')) A WHERE JOB_NAME = '${job}'`, 1).catch(() => [{ S: '?' }] as Row[]);
        if (!act.length) { stop(vscode.l10n.t('the job ended')); }
      }
      if (Date.now() - started > 2 * 3600_000) { stop(vscode.l10n.t('stopped after 2 hours')); }
    } catch (e) {
      logError(e);
      channel.appendLine(`✗ ${errorMessage(e).split('\n')[0]}`);
      if (polls === 0) { stop(vscode.l10n.t('could not read the job log')); }
      polls++;
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 3000);
  live.set(job, { channel, timer, stop: () => stop(vscode.l10n.t('stopped')) });
  await tick();
}

async function stopLive(): Promise<void> {
  if (!live.size) { vscode.window.showInformationMessage(vscode.l10n.t('No live job log is running.')); return; }
  const all = vscode.l10n.t('All');
  const p = await vscode.window.showQuickPick([...live.keys(), ...(live.size > 1 ? [all] : [])], { title: vscode.l10n.t('Stop following which job log?') });
  if (!p) { return; }
  for (const [k, v] of [...live]) { if (p === all || p === k) { v.stop(); } }
}

const SIGNED_ALLOWED = new Set(['vanthrex.signedOn', 'vanthrex.signedOn.row', 'vanthrex.signedOn.broadcast']);

async function signedOn(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const [inter, servers] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Who is signed on…') }, () => Promise.all([
    conn.rows<Row>(`SELECT JOB_NAME AS J, AUTHORIZATION_NAME AS U, SUBSYSTEM AS S, JOB_STATUS AS ST, COALESCE(FUNCTION, '') AS F, ELAPSED_CPU_PERCENTAGE AS C ` +
      `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X WHERE JOB_TYPE = 'INT' ORDER BY AUTHORIZATION_NAME`, 2000),
    conn.rows<Row>(`SELECT JOB_NAME AS J, AUTHORIZATION_NAME AS U, COALESCE(FUNCTION, '') AS F FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X ` +
      `WHERE JOB_TYPE IN ('PJ', 'BCI') AND AUTHORIZATION_NAME NOT IN ('QUSER', 'QSYS', 'QTCP')`, 5000).catch(() => [] as Row[]),
  ]));
  const groups = new Map<string, number>();
  for (const r of servers) { const k = `${s(r, 'U')}|${connectionKind(s(r, 'J'), s(r, 'F'))}`; groups.set(k, (groups.get(k) ?? 0) + 1); }
  const g = [...groups.entries()].map(([k, n]) => { const [u, kind] = k.split('|'); return [u, kind, n] as [string, string, number]; }).sort((a, b) => a[0].localeCompare(b[0]) || b[2] - a[2]);
  showReport('signedOn', {
    title: vscode.l10n.t('Who is signed on — {0}', conn.profile.name),
    subtitle: vscode.l10n.t('{0} 5250 session(s) and {1} server connection(s) from {2} user(s).', inter.length, servers.length, new Set([...inter, ...servers].map(r => s(r, 'U'))).size),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.signedOn' }, ...(inter.length ? [{ label: vscode.l10n.t('Message everyone signed on…'), command: 'vanthrex.signedOn.broadcast', args: [inter.map(r => s(r, 'J'))] }] : [])],
    tables: [
      { title: vscode.l10n.t('5250 sessions'), filter: true, columns: [vscode.l10n.t('User'), vscode.l10n.t('Job'), vscode.l10n.t('Subsystem'), vscode.l10n.t('Status'), vscode.l10n.t('Doing'), 'CPU %'],
        rows: inter.map(r => [s(r, 'U'), s(r, 'J'), s(r, 'S'), s(r, 'ST'), s(r, 'F'), s(r, 'C')]), rowClass: inter.map(r => (s(r, 'ST') === 'MSGW' ? 'bad' : undefined)),
        rowActions: inter.map(r => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.signedOn.row', args: [s(r, 'J')] })), empty: vscode.l10n.t('Nobody is signed on to a 5250 session.') },
      { title: vscode.l10n.t('Server connections by user'), filter: true, columns: [vscode.l10n.t('User'), vscode.l10n.t('Kind'), vscode.l10n.t('Jobs')], rows: g, empty: vscode.l10n.t('None.') },
    ],
    note: vscode.l10n.t('Click a session for details, job log, a break message or ending it (asked first).'),
  }, SIGNED_ALLOWED);
}

async function signedOnRow(manager: ConnectionManager, job: string): Promise<void> {
  const conn = manager.require();
  const o = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(info) Details'), k: 'details' }, { label: vscode.l10n.t('$(output) Job log'), k: 'log' },
    { label: vscode.l10n.t('$(comment) Send a break message…'), k: 'msg' }, { label: vscode.l10n.t('$(debug-stop) End the session (controlled, 30 s)'), k: 'end' },
    { label: vscode.l10n.t('$(close) End the session now'), k: 'endnow' },
  ], { title: job });
  if (!o) { return; }
  if (o.k === 'details') { await vscode.commands.executeCommand('vanthrex.jobDetails', job); return; }
  if (o.k === 'log') { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); return; }
  if (o.k === 'msg') { await broadcast(manager, [job]); return; }
  const cmd = endJobCommand(job, o.k === 'endnow');
  const yes = vscode.l10n.t('End It');
  if (await vscode.window.showWarningMessage(vscode.l10n.t('End {0}?', job), { modal: true, detail: vscode.l10n.t('Unsaved work in that session is lost.') + `\n${cmd}` }, yes) !== yes) { return; }
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || cmd); }
  vscode.window.setStatusBarMessage(`✓ ${cmd}`, 4000);
  await signedOn(manager);
}

async function broadcast(manager: ConnectionManager, jobs: string[]): Promise<void> {
  const conn = manager.require();
  const text = await vscode.window.showInputBox({ title: jobs.length > 1 ? vscode.l10n.t('Message to {0} session(s)', jobs.length) : vscode.l10n.t('Message to {0}', jobs[0]), ignoreFocusOut: true, placeHolder: vscode.l10n.t('The system will be down at 18:00 — please save your work') });
  if (!text?.trim()) { return; }
  let ok = 0; const failed: string[] = [];
  for (const j of jobs) {
    const dev = j.split('/')[2];
    try { const r = await conn.runCL(breakMessageCommand(text, dev)); if (r.ok) { ok++; } else { failed.push(dev); } } catch { failed.push(dev); }
  }
  vscode.window.showInformationMessage(failed.length ? vscode.l10n.t('Sent to {0}; not sent to {1}.', ok, failed.join(', ')) : vscode.l10n.t('Sent to {0} session(s).', ok));
}

class Watcher implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  private readonly jobs = new Map<string, { started: number; phase: string; conn: IbmiConnection }>();
  private timer: NodeJS.Timeout | undefined;

  watch(conn: IbmiConnection, job: string): void {
    this.jobs.set(job, { started: Date.now(), phase: 'queued', conn });
    this.refresh();
    if (!this.timer) { this.timer = setInterval(() => void this.poll(), 5000); }
    void this.poll();
  }

  private refresh(): void {
    if (!this.jobs.size) { this.item.hide(); return; }
    const [first] = this.jobs.keys();
    this.item.text = `$(sync~spin) ${first.split('/')[2]}${this.jobs.size > 1 ? ` +${this.jobs.size - 1}` : ''}`;
    this.item.tooltip = [...this.jobs.entries()].map(([j, v]) => `${j}: ${v.phase}`).join('\n');
    this.item.command = { command: 'vanthrex.jobLog', title: vscode.l10n.t('Job log'), arguments: [{ job: first }] };
    this.item.show();
  }

  private async poll(): Promise<void> {
    for (const [job, w] of [...this.jobs.entries()]) {
      try {
        const [num, user] = job.split('/');
        const r = await w.conn.rows<Row>(`SELECT * FROM TABLE(QSYS2.JOB_INFO(JOB_USER_FILTER => ${sqlString(user)}, JOB_STATUS_FILTER => '*ALL')) X WHERE JOB_NAME = ${sqlString(job)}`, 1);
        const phase = jobPhase(s(r[0], 'JOB_STATUS'));
        w.phase = phase;
        if (phase === 'ended' || Date.now() - w.started > 12 * 3600 * 1000) {
          this.jobs.delete(job);
          let ok = !/ABNORMAL/i.test(s(r[0], 'COMPLETION_STATUS'));
          const end = await w.conn.rows<Row>(`SELECT MESSAGE_TEXT AS T FROM TABLE(QSYS2.HISTORY_LOG_INFO(START_TIME => CURRENT TIMESTAMP - 1 DAY)) X WHERE MESSAGE_ID = 'CPF1164' AND FROM_JOB = ${sqlString(job)} FETCH FIRST 1 ROW ONLY`, 1).catch(() => []);
          const code = /end code\s+(\d+)/i.exec(s(end[0], 'T'))?.[1];
          if (code !== undefined) { ok = Number(code) < 10; }
          const mins = Math.max(1, Math.round((Date.now() - w.started) / 60000));
          const msg = ok ? vscode.l10n.t('Job {0} ended normally (about {1} min).', job, mins) : vscode.l10n.t('Job {0} ended abnormally{1}.', job, code !== undefined ? ` (end code ${code})` : '');
          const buttons = [vscode.l10n.t('Job Log'), ...(ok ? [] : [vscode.l10n.t('Analyze')])];
          const c = await (ok ? vscode.window.showInformationMessage(msg, ...buttons) : vscode.window.showErrorMessage(msg, ...buttons));
          if (c === vscode.l10n.t('Job Log')) { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); }
          if (c === vscode.l10n.t('Analyze')) { await vscode.commands.executeCommand('vanthrex.analyzeJobLog', job); }
          void vscode.commands.executeCommand('vanthrex.refreshSpool');
        } else { void num; }
      } catch (e) { log(`Watch ${job}: ${errorMessage(e)}`); }
    }
    this.refresh();
    if (!this.jobs.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  dispose(): void { if (this.timer) { clearInterval(this.timer); } this.item.dispose(); }
}

async function submitAndWatch(manager: ConnectionManager, watcher: Watcher, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const command = await vscode.window.showInputBox({ title: vscode.l10n.t('Submit to batch and watch (1/3)'), prompt: vscode.l10n.t('Command to run in batch'), value: state.get<string>('vanthrex.sbm.last', ''), placeHolder: 'CALL PGM(APPLIB/NIGHTLY)', ignoreFocusOut: true });
  if (!command) { return; }
  const job = await vscode.window.showInputBox({ title: vscode.l10n.t('Submit to batch and watch (2/3)'), prompt: vscode.l10n.t('Job name'), value: (/PGM\(([^)]*\/)?([\w$#@]+)\)/i.exec(command)?.[2] ?? 'VTXBATCH').slice(0, 10).toUpperCase(), ignoreFocusOut: true });
  if (!job) { return; }
  const jobq = await vscode.window.showInputBox({ title: vscode.l10n.t('Submit to batch and watch (3/3)'), prompt: vscode.l10n.t('Job queue (empty = your job description\'s)'), ignoreFocusOut: true });
  if (jobq === undefined) { return; }
  await state.update('vanthrex.sbm.last', command);
  const r = await conn.runCL(sbmjobCommand(command, job, jobq));
  if (!r.ok) { throw new Error(vscode.l10n.t('SBMJOB failed: {0}', (r.stderr || r.stdout).trim())); }
  const id = submittedJob(r.stdout + r.stderr);
  if (!id) { vscode.window.showWarningMessage(vscode.l10n.t('The job was submitted, but its number could not be read — watch it in Active Jobs.')); return; }
  watcher.watch(conn, id);
  vscode.window.showInformationMessage(vscode.l10n.t('{0} submitted — you will be told when it ends.', id));
}

async function compareSpool(manager: ConnectionManager, n: { name: string; job: string; number: number }): Promise<void> {
  const conn = manager.require();
  const rows = await conn.rows<Row>(`SELECT SPOOLED_FILE_NAME AS N, JOB_NAME AS J, FILE_NUMBER AS F, VARCHAR_FORMAT(CREATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS T, COALESCE(USER_DATA, '') AS U ` +
    `FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE USER_NAME = ${sqlString(conn.user)} ORDER BY CASE WHEN SPOOLED_FILE_NAME = ${sqlString(n.name)} THEN 0 ELSE 1 END, CREATE_TIMESTAMP DESC FETCH FIRST 300 ROWS ONLY`, 300);
  const pick = await vscode.window.showQuickPick(rows.filter(r => !(s(r, 'J') === n.job && Number(r.F) === n.number)).map(r => ({ label: s(r, 'N'), description: `${s(r, 'T')} · ${s(r, 'J')} #${s(r, 'F')}`, detail: s(r, 'U'), r })),
    { title: vscode.l10n.t('Compare {0} ({1}) with…', n.name, n.job), matchOnDescription: true });
  if (!pick) { return; }
  const other = { name: s(pick.r, 'N'), job: s(pick.r, 'J'), number: Number(pick.r.F) };
  await vscode.commands.executeCommand('vscode.diff', spoolUri(other), spoolUri(n), `${other.name} #${other.number} ↔ ${n.name} #${n.number}`);
}

const windowProgress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn);

const FAILED_ALLOWED = new Set(['vanthrex.failedJobs', 'vanthrex.failedJobs.row']);

async function failedJobsReport(manager: ConnectionManager, hoursArg?: number, minArg?: number): Promise<void> {
  const conn = manager.require();
  let hours = hoursArg; let min = minArg ?? 20;
  if (!hours) {
    const p = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('Last hour'), h: 1 }, { label: vscode.l10n.t('Last 8 hours'), h: 8 }, { label: vscode.l10n.t('Last 24 hours'), h: 24 }, { label: vscode.l10n.t('Last 3 days'), h: 72 }, { label: vscode.l10n.t('Last 7 days'), h: 168 },
    ], { title: vscode.l10n.t('Jobs that ended abnormally — since when?') });
    if (!p) { return; }
    hours = p.h;
  }
  const rows = await windowProgress(vscode.l10n.t('Reading the history log…'), () => conn.rows<Row>(
    `SELECT VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, COALESCE(FROM_JOB, '') AS J, COALESCE(MESSAGE_TEXT, '') AS T ` +
    `FROM TABLE(QSYS2.HISTORY_LOG_INFO(START_TIME => CURRENT TIMESTAMP - ${Math.floor(hours!)} HOURS)) X ` +
    `WHERE MESSAGE_ID = 'CPF1164' AND RTRIM(MESSAGE_TEXT) NOT LIKE '% 0 .' AND RTRIM(MESSAGE_TEXT) NOT LIKE '% 0.' ORDER BY MESSAGE_TIMESTAMP DESC`, 20000));
  const jobs = failedJobs(rows.map(r => ({ at: s(r, 'TS'), text: s(r, 'T'), fromJob: s(r, 'J') })), min);
  const byName = failuresByName(jobs);
  showReport('failedJobs', {
    title: vscode.l10n.t('Failed jobs — {0}', conn.profile.name),
    subtitle: vscode.l10n.t('{0} job(s) ended with end code {1} or higher in the last {2} hour(s).', jobs.length, min, hours!),
    facts: [[vscode.l10n.t('Failed jobs'), jobs.length], [vscode.l10n.t('Different job names'), byName.length], [vscode.l10n.t('Most failures'), byName[0] ? `${byName[0].name} (${byName[0].count})` : '—']],
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.failedJobs', args: [hours, min] },
      min > 10 ? { label: vscode.l10n.t('Include end code 10 (controlled end)'), command: 'vanthrex.failedJobs', args: [hours, 10] } : { label: vscode.l10n.t('Only real failures (20+)'), command: 'vanthrex.failedJobs', args: [hours, 20] },
      ...[1, 24, 168].filter(h => h !== hours).map(h => ({ label: h === 1 ? vscode.l10n.t('Last hour') : h === 24 ? vscode.l10n.t('Last 24 hours') : vscode.l10n.t('Last 7 days'), command: 'vanthrex.failedJobs', args: [h, min] }))],
    tables: [
      { title: vscode.l10n.t('Jobs'), filter: jobs.length > 15, columns: [vscode.l10n.t('Ended'), vscode.l10n.t('Job'), vscode.l10n.t('User'), vscode.l10n.t('End code'), vscode.l10n.t('Meaning')],
        rows: jobs.map(j => [j.at, j.job, j.user, j.code ?? '?', endCodeMeaning(j.code)]), rowClass: jobs.map(j => ((j.code ?? 99) >= 20 ? 'bad' : undefined)),
        rowActions: jobs.map(j => ({ label: vscode.l10n.t('Job log…'), command: 'vanthrex.failedJobs.row', args: [j.job] })), empty: vscode.l10n.t('No job failed in this period.') },
      { title: vscode.l10n.t('By job name'), columns: [vscode.l10n.t('Job name'), vscode.l10n.t('Failures'), vscode.l10n.t('Last'), vscode.l10n.t('End codes')], rows: byName.map(b => [b.name, b.count, b.last, b.codes]) },
    ],
    note: vscode.l10n.t('From the CPF1164 messages in the history log (QHST). Click a job to open its job log.'),
  }, FAILED_ALLOWED);
}

async function failedJobRow(manager: ConnectionManager, job: string): Promise<void> {
  const conn = manager.require();
  const spools = await conn.rows<Row>(`SELECT FILE_NUMBER AS N FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE JOB_NAME = ${sqlString(job)} AND SPOOLED_FILE_NAME = 'QPJOBLOG' ORDER BY FILE_NUMBER DESC`, 1).catch(() => [] as Row[]);
  const o = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(output) Open the job log'), description: spools.length ? 'QPJOBLOG' : vscode.l10n.t('pending job log'), k: 'log' },
    { label: vscode.l10n.t('$(list-unordered) All spooled files of the job'), k: 'spool' },
    ...(vscode.workspace.getConfiguration('vanthrex').get<boolean>('ai.enabled', true) ? [{ label: vscode.l10n.t('$(sparkle) Ask AI why it failed and how to fix it'), description: vscode.l10n.t('job log + failing source statement'), k: 'ai' }] : []),
    { label: vscode.l10n.t('$(copy) Copy the job name'), k: 'copy' },
  ], { title: job });
  if (o?.k === 'ai') { await vscode.commands.executeCommand('vanthrex.ai.jobLog', job); return; }
  if (!o) { return; }
  if (o.k === 'copy') { await vscode.env.clipboard.writeText(job); return; }
  if (o.k === 'log') {
    if (spools.length) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(spoolUri({ job, name: 'QPJOBLOG', number: Number(spools[0].N) })), { preview: true }); }
    else { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); }
    return;
  }
  const all = await conn.rows<Row>(`SELECT SPOOLED_FILE_NAME AS F, FILE_NUMBER AS N, TOTAL_PAGES AS P, COALESCE(USER_DATA, '') AS UD FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE JOB_NAME = ${sqlString(job)} ORDER BY FILE_NUMBER`, 500);
  if (!all.length) { vscode.window.showInformationMessage(vscode.l10n.t('{0} has no spooled files left.', job)); return; }
  const p = await vscode.window.showQuickPick(all.map(r => ({ r, label: s(r, 'F'), description: `#${s(r, 'N')} · ${s(r, 'P')} p · ${s(r, 'UD')}` })), { title: job });
  if (p) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(spoolUri({ job, name: s(p.r, 'F'), number: Number(p.r.N) })), { preview: true }); }
}

// ================================================================ registration

export function registerJobTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const watcher = new Watcher();
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.myRecentJobs', guard(() => myRecentJobs(manager))),
    vscode.commands.registerCommand('vanthrex.activeSql', guard(() => activeSql(manager))),
    vscode.commands.registerCommand('vanthrex.activeSql.cancel', guard(async (job: string, text: string) => {
      const p = await vscode.window.showQuickPick([{ label: vscode.l10n.t('$(stop) Cancel this statement'), v: 'cancel' }, { label: vscode.l10n.t('$(output) Job log'), v: 'log' }], { title: `${job}: ${text.slice(0, 80)}` });
      if (p?.v === 'log') { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); return; }
      if (p?.v !== 'cancel') { return; }
      const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Cancel the SQL statement running in {0}?', job), { modal: true, detail: text }, vscode.l10n.t('Cancel Statement'));
      if (ok !== vscode.l10n.t('Cancel Statement')) { return; }
      await manager.require().sql(`CALL QSYS2.CANCEL_SQL(${sqlString(job)})`, 1);
      vscode.window.showInformationMessage(vscode.l10n.t('Cancel request sent.'));
      await activeSql(manager);
    })),
    vscode.commands.registerCommand('vanthrex.messageQueue', guard((q?: string) => messageQueue(manager, typeof q === 'string' ? q : undefined))),
    vscode.commands.registerCommand('vanthrex.messageQueue.row', guard((q: string, m: { key: string; id: string; text: string; job: string; waiting: boolean }) => messageRow(manager, q, m))),
    vscode.commands.registerCommand('vanthrex.messageQueue.send', guard(async (q: string) => {
      const conn = manager.require();
      const [lib, mq] = q.split('/');
      const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Message to {0}', q), ignoreFocusOut: true });
      if (!text) { return; }
      const r = await conn.runCL(sendMessageCommand(lib, mq, text, false));
      if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
      await messageQueue(manager, q);
    })),
    vscode.commands.registerCommand('vanthrex.jobDetails', guard((j?: unknown) => jobDetails(manager, j))),
    vscode.commands.registerCommand('vanthrex.historyLog', guard(() => historyLog(manager))),
    vscode.commands.registerCommand('vanthrex.jobLogLive', guard((a?: unknown) => jobLogLive(manager, a))),
    vscode.commands.registerCommand('vanthrex.jobLogLive.stop', guard(() => stopLive())),
    { dispose: () => { for (const v of live.values()) { v.stop(); } } },
    vscode.commands.registerCommand('vanthrex.signedOn', guard(() => signedOn(manager))),
    vscode.commands.registerCommand('vanthrex.signedOn.row', guard((job: string) => signedOnRow(manager, job))),
    vscode.commands.registerCommand('vanthrex.signedOn.broadcast', guard((jobs: string[]) => broadcast(manager, jobs))),
    watcher,
    vscode.commands.registerCommand('vanthrex.submitAndWatch', guard(() => submitAndWatch(manager, watcher, context.globalState))),
    vscode.commands.registerCommand('vanthrex.watchJob', guard(async (n?: { job?: string }) => {
      const conn = manager.require();
      const job = n?.job ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Watch a job'), prompt: vscode.l10n.t('Qualified job name (number/user/name)'), ignoreFocusOut: true }))?.trim().toUpperCase();
      if (job) { watcher.watch(conn, job); vscode.window.showInformationMessage(vscode.l10n.t('Watching {0} — you will be told when it ends.', job)); }
    })),
    vscode.commands.registerCommand('vanthrex.spoolCompare', guard(async (n: { name: string; job: string; number: number }) => {
      if (!n?.name) { throw new Error(vscode.l10n.t('Right-click a spooled file in the Spooled Files view.')); }
      await compareSpool(manager, n);
    })),
    vscode.commands.registerCommand('vanthrex.failedJobs', guard((h?: number, m?: number) => failedJobsReport(manager, typeof h === 'number' ? h : undefined, typeof m === 'number' ? m : undefined))),
    vscode.commands.registerCommand('vanthrex.failedJobs.row', guard((job: string) => failedJobRow(manager, job))),
  );
}
