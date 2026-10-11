import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { assertSystemName, sqlString } from '../core/util';
import {
  AUDIT_TYPES, SYSTEM_VALUES, addJobScheduleCommand, auditJournalSql, endConnectionCommand, restoreCommand,
  saveCommand, serverStatus, targetReleases, TCP_SERVERS,
} from '../core/workWith';
import { printable } from '../core/admin';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const progress = <T>(title: string, fn: () => Promise<T>) =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

const ALLOWED = new Set([
  'vanthrex.workWith', 'vanthrex.ww.row', 'vanthrex.wrkSubsystems', 'vanthrex.wrkJobQueues', 'vanthrex.wrkOutputQueues',
  'vanthrex.wrkOutputQueue', 'vanthrex.wrkJobQueue', 'vanthrex.wrkSubsystemJobs', 'vanthrex.wrkJobSchedule', 'vanthrex.addJobSchedule',
  'vanthrex.wrkUserProfiles', 'vanthrex.wrkSystemValues', 'vanthrex.auditJournal', 'vanthrex.wrkSaveFiles', 'vanthrex.saveFileContents',
  'vanthrex.saveToSaveFile', 'vanthrex.restoreFromSaveFile', 'vanthrex.downloadSaveFile', 'vanthrex.uploadSaveFile',
  'vanthrex.wrkConnections', 'vanthrex.wrkTcpServers', 'vanthrex.wrkInterfaces', 'vanthrex.jobLog', 'vanthrex.spoolOpen',
  'vanthrex.analyzeJobLog', 'vanthrex.checkAuthority',
]);

/** Run a CL command after showing it, then refresh the page. */
async function runCl(conn: IbmiConnection, cmd: string, opts: { warn?: string; done?: string; refresh?: () => Promise<void> } = {}): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(cmd, { modal: true, detail: opts.warn ?? vscode.l10n.t('Run this command on the IBM i?') }, 'Run', vscode.l10n.t('Copy Command'));
  if (pick === vscode.l10n.t('Copy Command')) { await vscode.env.clipboard.writeText(cmd); return false; }
  if (pick !== 'Run') { return false; }
  const r = await progress(cmd, () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(vscode.l10n.t('{0} failed: {1}', cmd.split(' ')[0], (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' '))); }
  vscode.window.showInformationMessage(opts.done ?? vscode.l10n.t('Done.'));
  if (opts.refresh) { await opts.refresh(); }
  return true;
}

function rowAction(kind: string, data: Row): { label: string; command: string; args: unknown[] } {
  return { label: vscode.l10n.t('Options…'), command: 'vanthrex.ww.row', args: [kind, data] };
}

// ================================================================ work management

async function subsystems(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await progress('Reading subsystems…', () => conn.rows<Row>(
    `SELECT SUBSYSTEM_DESCRIPTION_LIBRARY AS LIB, SUBSYSTEM_DESCRIPTION AS SBS, STATUS, COALESCE(CURRENT_ACTIVE_JOBS, 0) AS JOBS, ` +
    `COALESCE(MAXIMUM_ACTIVE_JOBS, 0) AS MAXJ, COALESCE(TEXT_DESCRIPTION, '') AS TXT FROM QSYS2.SUBSYSTEM_INFO ORDER BY STATUS, SUBSYSTEM_DESCRIPTION`, 1000));
  showReport('wrksbs', {
    title: vscode.l10n.t('Subsystems'),
    subtitle: vscode.l10n.t('{0} active, {1} in total. Click a subsystem for its jobs, start or end.', rows.filter(r => s(r, 'STATUS') === 'ACTIVE').length, rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkSubsystems' }, { label: vscode.l10n.t('Job queues'), command: 'vanthrex.wrkJobQueues' }, { label: vscode.l10n.t('Output queues'), command: 'vanthrex.wrkOutputQueues' }],
    tables: [{
      title: vscode.l10n.t('Subsystems'), filter: true, columns: ['Subsystem', 'Library', 'Status', 'Active jobs', 'Max jobs', 'Description'],
      rows: rows.map(r => [s(r, 'SBS'), s(r, 'LIB'), s(r, 'STATUS'), s(r, 'JOBS'), s(r, 'MAXJ') === '0' ? '*NOMAX' : s(r, 'MAXJ'), s(r, 'TXT')]),
      rowActions: rows.map(r => rowAction('sbs', r)), rowClass: rows.map(r => (s(r, 'STATUS') === 'ACTIVE' ? undefined : 'dim')),
    }],
  }, ALLOWED);
}

async function subsystemJobs(manager: ConnectionManager, sbs: string): Promise<void> {
  const conn = manager.require();
  const rows = await progress(`Reading the jobs in ${sbs}…`, () => conn.rows<Row>(
    `SELECT JOB_NAME, JOB_TYPE, JOB_STATUS, COALESCE(AUTHORIZATION_NAME, '') AS USR, COALESCE(FUNCTION, '') AS FN, COALESCE(ELAPSED_CPU_PERCENTAGE, 0) AS CPU ` +
    `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(SUBSYSTEM_LIST_FILTER => ${sqlString(sbs)}, DETAILED_INFO => 'NONE')) X ORDER BY JOB_NAME`, 5000));
  showReport('wrksbsjob', {
    title: vscode.l10n.t('Jobs in {0}', sbs), subtitle: vscode.l10n.t('{0} active job(s). Click a job for its job log.', rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkSubsystemJobs', args: [sbs] }, { label: vscode.l10n.t('All subsystems'), command: 'vanthrex.wrkSubsystems' }],
    tables: [{ title: vscode.l10n.t('Active jobs'), filter: true, columns: ['Job', 'Type', 'Status', 'User', 'Function', 'CPU %'],
      rows: rows.map(r => [s(r, 'JOB_NAME'), s(r, 'JOB_TYPE'), s(r, 'JOB_STATUS'), s(r, 'USR'), s(r, 'FN'), s(r, 'CPU')]),
      rowActions: rows.map(r => rowAction('job', { JOB: s(r, 'JOB_NAME') })) }],
  }, ALLOWED);
}

async function jobQueues(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await progress('Reading job queues…', () => conn.rows<Row>(
    `SELECT JOB_QUEUE_LIBRARY AS LIB, JOB_QUEUE_NAME AS Q, JOB_QUEUE_STATUS AS ST, COALESCE(NUMBER_OF_JOBS, 0) AS N, COALESCE(HELD_JOBS, 0) AS HELD, ` +
    `COALESCE(SUBSYSTEM_NAME, '') AS SBS, COALESCE(TEXT_DESCRIPTION, '') AS TXT FROM QSYS2.JOB_QUEUE_INFO ORDER BY NUMBER_OF_JOBS DESC, JOB_QUEUE_NAME`, 2000));
  showReport('wrkjobq', {
    title: vscode.l10n.t('Job queues'), subtitle: vscode.l10n.t('{0} job queue(s); {1} have jobs waiting.', rows.length, rows.filter(r => Number(r.N) > 0).length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkJobQueues' }, { label: vscode.l10n.t('Subsystems'), command: 'vanthrex.wrkSubsystems' }],
    tables: [{ title: vscode.l10n.t('Job queues'), filter: true, columns: ['Job queue', 'Library', 'Status', 'Jobs', 'Held jobs', 'Subsystem', 'Description'],
      rows: rows.map(r => [s(r, 'Q'), s(r, 'LIB'), s(r, 'ST'), s(r, 'N'), s(r, 'HELD'), s(r, 'SBS') || '(not attached)', s(r, 'TXT')]),
      rowActions: rows.map(r => rowAction('jobq', r)), rowClass: rows.map(r => (s(r, 'ST') === 'HELD' ? 'different' : undefined)) }],
  }, ALLOWED);
}

async function jobQueue(manager: ConnectionManager, lib: string, q: string): Promise<void> {
  const conn = manager.require();
  const rows = await progress(`Reading ${lib}/${q}…`, () => conn.rows<Row>(
    `SELECT JOB_NAME, JOB_STATUS, COALESCE(JOB_QUEUE_STATUS, '') AS QST, VARCHAR_FORMAT(JOB_ENTERED_SYSTEM_TIME, 'YYYY-MM-DD HH24:MI:SS') AS T, COALESCE(JOB_QUEUE_PRIORITY, 0) AS PRTY ` +
    `FROM TABLE(QSYS2.JOB_INFO(JOB_STATUS_FILTER => '*JOBQ', JOB_USER_FILTER => '*ALL')) X ` +
    `WHERE JOB_QUEUE_LIBRARY = ${sqlString(lib)} AND JOB_QUEUE_NAME = ${sqlString(q)} ORDER BY JOB_QUEUE_PRIORITY, JOB_ENTERED_SYSTEM_TIME`, 5000));
  showReport('wrkjobqjobs', {
    title: vscode.l10n.t('Job queue {0}/{1}', lib, q), subtitle: vscode.l10n.t('{0} job(s) waiting. Click a job to release, hold or end it.', rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkJobQueue', args: [lib, q] }, { label: vscode.l10n.t('All job queues'), command: 'vanthrex.wrkJobQueues' }],
    tables: [{ title: vscode.l10n.t('Jobs on the queue'), filter: true, columns: ['Job', 'Status', 'Queue status', 'Priority', 'Entered'],
      rows: rows.map(r => [s(r, 'JOB_NAME'), s(r, 'JOB_STATUS'), s(r, 'QST'), s(r, 'PRTY'), s(r, 'T')]),
      rowActions: rows.map(r => rowAction('qjob', { JOB: s(r, 'JOB_NAME'), LIB: lib, Q: q })), empty: vscode.l10n.t('No jobs waiting.') }],
  }, ALLOWED);
}

async function outputQueues(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await progress('Reading output queues…', () => conn.rows<Row>(
    `SELECT OUTPUT_QUEUE_LIBRARY_NAME AS LIB, OUTPUT_QUEUE_NAME AS Q, COALESCE(NUMBER_OF_FILES, 0) AS N, COALESCE(OUTPUT_QUEUE_STATUS, '') AS ST, ` +
    `COALESCE(WRITER_JOB_NAME, '') AS WTR, COALESCE(PRINTER_DEVICE_NAME, '') AS DEV, COALESCE(TEXT_DESCRIPTION, '') AS TXT ` +
    `FROM QSYS2.OUTPUT_QUEUE_INFO ORDER BY NUMBER_OF_FILES DESC, OUTPUT_QUEUE_NAME`, 2000));
  showReport('wrkoutq', {
    title: vscode.l10n.t('Output queues'), subtitle: vscode.l10n.t('{0} output queue(s), {1} spooled file(s) in total.', rows.length, rows.reduce((a, r) => a + Number(r.N || 0), 0)),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkOutputQueues' }],
    tables: [{ title: vscode.l10n.t('Output queues'), filter: true, columns: ['Output queue', 'Library', 'Files', 'Status', 'Writer', 'Printer', 'Description'],
      rows: rows.map(r => [s(r, 'Q'), s(r, 'LIB'), s(r, 'N'), s(r, 'ST'), s(r, 'WTR'), s(r, 'DEV'), s(r, 'TXT')]),
      rowActions: rows.map(r => rowAction('outq', r)), rowClass: rows.map(r => (s(r, 'ST') === 'HELD' ? 'different' : undefined)) }],
  }, ALLOWED);
}

async function outputQueue(manager: ConnectionManager, lib: string, q: string): Promise<void> {
  const conn = manager.require();
  const rows = await progress(`Reading ${lib}/${q}…`, () => conn.rows<Row>(
    `SELECT SPOOLED_FILE_NAME AS NAME, JOB_NAME AS JOB, FILE_NUMBER AS NBR, COALESCE(USER_NAME, '') AS USR, COALESCE(USER_DATA, '') AS UDATA, STATUS, ` +
    `COALESCE(TOTAL_PAGES, 0) AS PAGES, COALESCE(SIZE, 0) AS SZ, VARCHAR_FORMAT(CREATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS T ` +
    `FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE OUTPUT_QUEUE_LIBRARY_NAME = ${sqlString(lib)} AND OUTPUT_QUEUE_NAME = ${sqlString(q)} ` +
    `ORDER BY CREATE_TIMESTAMP DESC FETCH FIRST 2000 ROWS ONLY`, 2000));
  showReport('wrkoutqsplf', {
    title: vscode.l10n.t('Output queue {0}/{1}', lib, q), subtitle: vscode.l10n.t('{0} spooled file(s), newest first. Click one to open, hold, release, move or delete it.', rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkOutputQueue', args: [lib, q] }, { label: vscode.l10n.t('All output queues'), command: 'vanthrex.wrkOutputQueues' }],
    tables: [{ title: vscode.l10n.t('Spooled files'), filter: true, columns: ['File', 'User', 'User data', 'Status', 'Pages', 'Size (KB)', 'Created', 'Job', '#'],
      rows: rows.map(r => [s(r, 'NAME'), s(r, 'USR'), s(r, 'UDATA'), s(r, 'STATUS'), s(r, 'PAGES'), s(r, 'SZ'), s(r, 'T'), s(r, 'JOB'), s(r, 'NBR')]),
      rowActions: rows.map(r => rowAction('splf', { ...r, LIB: lib, Q: q })), empty: vscode.l10n.t('The output queue is empty.') }],
  }, ALLOWED);
}

async function jobSchedule(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await progress('Reading the job scheduler…', () => conn.rows<Row>(
    `SELECT SCHEDULED_JOB_NAME AS NAME, SCHEDULED_JOB_ENTRY_NUMBER AS NBR, STATUS, FREQUENCY AS FRQ, COALESCE(SCHEDULED_DATE_VALUE, '') AS SDATE, ` +
    `COALESCE(VARCHAR(SCHEDULED_TIME), '') AS STIME, COALESCE(SCHEDULED_DAYS, '') AS SDAYS, COALESCE(VARCHAR(NEXT_SUBMISSION_DATE), '') AS NEXT, ` +
    `COALESCE(COMMAND_STRING, '') AS CMD, COALESCE(USER_PROFILE_FOR_SUBMITTED_JOB, '') AS USR, COALESCE(DESCRIPTION, '') AS TXT ` +
    `FROM QSYS2.SCHEDULED_JOB_INFO ORDER BY NEXT_SUBMISSION_DATE, SCHEDULED_TIME`, 2000));
  showReport('wrkjobscde', {
    title: vscode.l10n.t('Job schedule entries'), subtitle: vscode.l10n.t('{0} entr(ies). Click one to hold, release or remove it.', rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkJobSchedule' }, { label: vscode.l10n.t('Add an entry…'), command: 'vanthrex.addJobSchedule' }],
    tables: [{ title: vscode.l10n.t('Scheduled jobs'), filter: true, columns: ['Job', 'Entry', 'Status', 'Frequency', 'Date', 'Time', 'Days', 'Next run', 'User', 'Command', 'Description'],
      rows: rows.map(r => [s(r, 'NAME'), s(r, 'NBR'), s(r, 'STATUS'), s(r, 'FRQ'), s(r, 'SDATE'), s(r, 'STIME'), s(r, 'SDAYS'), s(r, 'NEXT'), s(r, 'USR'), s(r, 'CMD'), s(r, 'TXT')]),
      rowActions: rows.map(r => rowAction('scde', r)), rowClass: rows.map(r => (s(r, 'STATUS') === 'HELD' ? 'different' : undefined)), empty: vscode.l10n.t('No job schedule entries.') }],
  }, ALLOWED);
}

async function addJobSchedule(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const name = await vscode.window.showInputBox({ title: vscode.l10n.t('New job schedule entry (1/4)'), prompt: vscode.l10n.t('Job name'), ignoreFocusOut: true,
    validateInput: v => (/^[A-Za-z$#@][\w$#@]{0,9}$/.test(v.trim()) ? undefined : '1–10 characters, a valid system name') });
  if (!name) { return; }
  const command = await vscode.window.showInputBox({ title: vscode.l10n.t('New job schedule entry (2/4)'), prompt: vscode.l10n.t('Command to run'), placeHolder: 'CALL PGM(APPLIB/NIGHTLY)', ignoreFocusOut: true });
  if (!command) { return; }
  const frq = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('Once, today'), value: '*ONCE' as const, date: '*CURRENT' },
    { label: vscode.l10n.t('Every day'), value: '*WEEKLY' as const, days: ['*ALL'] },
    { label: vscode.l10n.t('Some days of the week…'), value: '*WEEKLY' as const },
    { label: vscode.l10n.t('Monthly, first day of the month'), value: '*MONTHLY' as const, date: '*MONTHSTR' },
    { label: vscode.l10n.t('Monthly, last day of the month'), value: '*MONTHLY' as const, date: '*MONTHEND' },
  ], { title: vscode.l10n.t('New job schedule entry (3/4): how often?') });
  if (!frq) { return; }
  let days = frq.days;
  if (frq.value === '*WEEKLY' && !days) {
    const d = await vscode.window.showQuickPick(['*MON', '*TUE', '*WED', '*THU', '*FRI', '*SAT', '*SUN'], { canPickMany: true, title: vscode.l10n.t('Which days?') });
    if (!d?.length) { return; }
    days = d;
  }
  const time = await vscode.window.showInputBox({ title: vscode.l10n.t('New job schedule entry (4/4)'), prompt: vscode.l10n.t('Time (HH:MM, 24 hours)'), value: '22:00', ignoreFocusOut: true });
  if (!time) { return; }
  const cmd = addJobScheduleCommand({ name, command, frequency: frq.value, date: frq.date, days, time });
  await runCl(conn, cmd, { done: vscode.l10n.t('Job schedule entry added.'), refresh: () => jobSchedule(manager) });
}

// ================================================================ users & security

async function userProfiles(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const scope = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('User profiles (not IBM-supplied)'), where: `AUTHORIZATION_NAME NOT LIKE 'Q%'` },
    { label: vscode.l10n.t('All user profiles'), where: '1 = 1' },
    { label: vscode.l10n.t('Disabled profiles'), where: `STATUS = '*DISABLED'` },
    { label: vscode.l10n.t('Profiles with special authorities'), where: `SPECIAL_AUTHORITIES <> '*NONE' AND AUTHORIZATION_NAME NOT LIKE 'Q%'` },
    { label: vscode.l10n.t('Group profiles'), where: `GROUP_ID_NUMBER IS NOT NULL AND GROUP_ID_NUMBER > 0` },
  ], { title: vscode.l10n.t('Work with user profiles') });
  if (!scope) { return; }
  const rows = await progress('Reading user profiles…', () => conn.rows<Row>(
    `SELECT AUTHORIZATION_NAME AS USR, STATUS, COALESCE(USER_CLASS_NAME, '') AS CLS, COALESCE(SPECIAL_AUTHORITIES, '') AS SPC, ` +
    `COALESCE(GROUP_PROFILE_NAME, '') AS GRP, VARCHAR_FORMAT(PREVIOUS_SIGNON, 'YYYY-MM-DD HH24:MI') AS LAST, ` +
    `COALESCE(SIGN_ON_ATTEMPTS_NOT_VALID, 0) AS BAD, VARCHAR_FORMAT(DATE_PASSWORD_EXPIRES, 'YYYY-MM-DD') AS PWDEXP, COALESCE(TEXT_DESCRIPTION, '') AS TXT ` +
    `FROM QSYS2.USER_INFO WHERE ${scope.where} ORDER BY AUTHORIZATION_NAME`, 10000));
  showReport('wrkusrprf', {
    title: vscode.l10n.t('User profiles'), subtitle: vscode.l10n.t('{0}: {1}. Click a profile to enable, disable, expire its password, or see its jobs and objects.', scope.label, rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkUserProfiles' }, { label: vscode.l10n.t('Security audit journal'), command: 'vanthrex.auditJournal' }, { label: vscode.l10n.t('System values'), command: 'vanthrex.wrkSystemValues' }],
    tables: [{ title: vscode.l10n.t('Profiles'), filter: true, columns: ['User', 'Status', 'Class', 'Special authorities', 'Group', 'Last sign-on', 'Bad sign-ons', 'Password expires', 'Description'],
      rows: rows.map(r => [s(r, 'USR'), s(r, 'STATUS'), s(r, 'CLS'), s(r, 'SPC'), s(r, 'GRP'), s(r, 'LAST'), s(r, 'BAD'), s(r, 'PWDEXP'), s(r, 'TXT')]),
      rowActions: rows.map(r => rowAction('usr', r)),
      rowClass: rows.map(r => (s(r, 'STATUS') === '*DISABLED' ? 'dim' : /\*ALLOBJ/.test(s(r, 'SPC')) ? 'different' : undefined)) }],
    note: vscode.l10n.t('Passwords are never shown or changed here. Profiles with *ALLOBJ are highlighted.'),
  }, ALLOWED);
}

async function userDetails(manager: ConnectionManager, user: string): Promise<void> {
  const conn = manager.require();
  const [jobs, owned] = await progress(`Reading ${user}…`, () => Promise.all([
    conn.rows<Row>(`SELECT JOB_NAME, JOB_STATUS, COALESCE(SUBSYSTEM, '') AS SBS, COALESCE(FUNCTION, '') AS FN FROM TABLE(QSYS2.ACTIVE_JOB_INFO(CURRENT_USER_LIST_FILTER => ${sqlString(user)}, DETAILED_INFO => 'NONE')) X`, 500).catch(() => []),
    conn.rows<Row>(`SELECT OBJECT_LIBRARY AS LIB, OBJECT_NAME AS OBJ, OBJECT_TYPE AS TYPE FROM QSYS2.OBJECT_OWNERSHIP WHERE AUTHORIZATION_NAME = ${sqlString(user)} AND OBJECT_LIBRARY IS NOT NULL ORDER BY 1, 2 FETCH FIRST 1000 ROWS ONLY`, 1000).catch(() => []),
  ]));
  showReport('usrdetail', {
    title: vscode.l10n.t('User {0}', user), subtitle: vscode.l10n.t('{0} active job(s), {1} object(s) owned (first 1000).', jobs.length, owned.length),
    actions: [{ label: vscode.l10n.t('All user profiles'), command: 'vanthrex.wrkUserProfiles' }],
    tables: [
      { title: vscode.l10n.t('Active jobs'), columns: ['Job', 'Status', 'Subsystem', 'Function'], rows: jobs.map(r => [s(r, 'JOB_NAME'), s(r, 'JOB_STATUS'), s(r, 'SBS'), s(r, 'FN')]),
        rowActions: jobs.map(r => rowAction('job', { JOB: s(r, 'JOB_NAME') })), empty: vscode.l10n.t('No active jobs.') },
      { title: vscode.l10n.t('Objects owned (in libraries)'), filter: true, columns: ['Library', 'Object', 'Type'], rows: owned.map(r => [s(r, 'LIB'), s(r, 'OBJ'), s(r, 'TYPE')]), empty: vscode.l10n.t('None.') },
    ],
  }, ALLOWED);
}

async function systemValues(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await progress('Reading system values…', () => conn.rows<Row>(
    `SELECT SYSTEM_VALUE_NAME AS NAME, COALESCE(VARCHAR(CURRENT_NUMERIC_VALUE), '') AS NUM, COALESCE(CURRENT_CHARACTER_VALUE, '') AS CHR ` +
    `FROM QSYS2.SYSTEM_VALUE_INFO ORDER BY SYSTEM_VALUE_NAME`, 2000));
  const known = (n: string) => SYSTEM_VALUES[n];
  const sorted = [...rows].sort((a, b) => (known(s(a, 'NAME')) ? 0 : 1) - (known(s(b, 'NAME')) ? 0 : 1) || (known(s(a, 'NAME'))?.group ?? 'zz').localeCompare(known(s(b, 'NAME'))?.group ?? 'zz') || s(a, 'NAME').localeCompare(s(b, 'NAME')));
  showReport('wrksysval', {
    title: vscode.l10n.t('System values'), subtitle: vscode.l10n.t('{0} system values (read-only). The ones people look up most come first, grouped.', rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkSystemValues' }],
    tables: [{ title: vscode.l10n.t('System values'), filter: true, columns: ['Name', 'Group', 'Value', 'What it is'],
      rows: sorted.map(r => [s(r, 'NAME'), known(s(r, 'NAME'))?.group ?? '', s(r, 'NUM') || s(r, 'CHR'), known(s(r, 'NAME'))?.text ?? '']) }],
    note: vscode.l10n.t('Change a system value with CHGSYSVAL (needs *ALLOBJ and *SECADM for security values). Vanthrex only shows them.'),
  }, ALLOWED);
}

async function auditJournal(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const picks = await vscode.window.showQuickPick(Object.entries(AUDIT_TYPES).map(([k, v]) => ({ label: k, description: v, picked: ['AF', 'PW', 'CP', 'SV', 'DO'].includes(k) })),
    { title: vscode.l10n.t('Security audit journal: which events?'), canPickMany: true, ignoreFocusOut: true });
  if (!picks?.length) { return; }
  const range = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Last hour'), hours: 1 }, { label: vscode.l10n.t('Last 24 hours'), hours: 24 }, { label: vscode.l10n.t('Last 7 days'), hours: 168 }], { title: vscode.l10n.t('Time range') });
  if (!range) { return; }
  const user = await vscode.window.showInputBox({ title: vscode.l10n.t('Only one user? (optional)'), prompt: vscode.l10n.t('User profile, or leave empty for everyone') });
  if (user === undefined) { return; }
  const rows = await progress('Reading QAUDJRN…', () => conn.rows<Row>(auditJournalSql(picks.map(p => p.label), range.hours, user), 500));
  const byType = new Map<string, number>(); rows.forEach(r => byType.set(s(r, 'TYPE'), (byType.get(s(r, 'TYPE')) ?? 0) + 1));
  showReport('audit', {
    title: vscode.l10n.t('Security audit journal'), subtitle: `${rows.length} event(s) in the ${range.label.toLowerCase()}${user.trim() ? ` for ${user.trim().toUpperCase()}` : ''}, newest first (max 500).`,
    facts: [...byType.entries()].map(([t, n]) => [`${t} — ${AUDIT_TYPES[t] ?? ''}`, n] as [string, number]),
    actions: [{ label: vscode.l10n.t('Change filter'), command: 'vanthrex.auditJournal' }],
    tables: [{ title: vscode.l10n.t('Events'), filter: true, columns: ['Time', 'Type', 'Event', 'User', 'Job', 'Program', 'Remote address', 'Entry data'],
      rows: rows.map(r => [s(r, 'TIME'), s(r, 'TYPE'), AUDIT_TYPES[s(r, 'TYPE')] ?? '', s(r, 'USR'), s(r, 'JOB'), s(r, 'PGM'), s(r, 'RMT'), printable(String(r.DATA ?? '').trim(), 160)]),
      rowClass: rows.map(r => (['AF', 'PW'].includes(s(r, 'TYPE')) ? 'bad' : undefined)), empty: vscode.l10n.t('No events — auditing may be off for these types (see QAUDCTL / QAUDLVL).') }],
    note: vscode.l10n.t('Needs *AUDIT or *ALLOBJ special authority to read QAUDJRN. The entry data is shown as text; field layouts per type are in the IBM i Security reference.'),
  }, ALLOWED);
}

// ================================================================ save / restore

async function saveFiles(manager: ConnectionManager, lib?: string): Promise<void> {
  const conn = manager.require();
  const l = lib ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Work with save files'), prompt: vscode.l10n.t('Library'), value: conn.profile.currentLibrary ?? '', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!l) { return; }
  assertSystemName(l, 'library');
  const rows = await progress(`Reading save files in ${l}…`, () => conn.rows<Row>(
    `SELECT OBJNAME AS NAME, COALESCE(OBJSIZE, 0) AS SZ, VARCHAR_FORMAT(OBJCREATED, 'YYYY-MM-DD HH24:MI') AS CREATED, VARCHAR_FORMAT(CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS CHANGED, COALESCE(OBJTEXT, '') AS TXT ` +
    `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(l)}, '*FILE')) X WHERE OBJATTRIBUTE = 'SAVF' ORDER BY OBJNAME`, 5000));
  showReport('wrksavf', {
    title: vscode.l10n.t('Save files in {0}', l), subtitle: vscode.l10n.t('{0} save file(s). Click one to see its contents, restore from it, or download it.', rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkSaveFiles', args: [l] }, { label: vscode.l10n.t('Save a library or objects…'), command: 'vanthrex.saveToSaveFile' },
      { label: vscode.l10n.t('Upload a save file from this PC…'), command: 'vanthrex.uploadSaveFile', args: [l] }],
    tables: [{ title: vscode.l10n.t('Save files'), filter: true, columns: ['Save file', 'Size (MB)', 'Created', 'Changed', 'Description'],
      rows: rows.map(r => [s(r, 'NAME'), (Number(r.SZ) / 1048576).toFixed(1), s(r, 'CREATED'), s(r, 'CHANGED'), s(r, 'TXT')]),
      rowActions: rows.map(r => rowAction('savf', { LIB: l, NAME: s(r, 'NAME') })), empty: vscode.l10n.t('No save files in this library.') }],
  }, ALLOWED);
}

async function saveFileContents(manager: ConnectionManager, lib: string, f: string): Promise<void> {
  const conn = manager.require();
  const rows = await progress(`Reading ${lib}/${f}…`, () => conn.rows<Row>(
    `SELECT LIBRARY_NAME AS SAVLIB, OBJECT_NAME AS OBJ, OBJECT_TYPE AS TYPE, COALESCE(OBJECT_ATTRIBUTE, '') AS ATTR, COALESCE(OBJECT_SIZE, 0) AS SZ, ` +
    `VARCHAR_FORMAT(SAVE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS SAVED, COALESCE(TEXT_DESCRIPTION, '') AS TXT ` +
    `FROM TABLE(QSYS2.SAVE_FILE_OBJECTS(SAVE_FILE => ${sqlString(f)}, SAVE_FILE_LIBRARY => ${sqlString(lib)})) X ORDER BY LIBRARY_NAME, OBJECT_NAME`, 20000));
  const libs = [...new Set(rows.map(r => s(r, 'SAVLIB')))];
  showReport('savfcontents', {
    title: vscode.l10n.t('Save file {0}/{1}', lib, f), subtitle: rows.length ? `${rows.length} object(s) saved from ${libs.join(', ')} on ${s(rows[0], 'SAVED')}.` : 'The save file is empty.',
    actions: [
      { label: vscode.l10n.t('Restore from it…'), command: 'vanthrex.restoreFromSaveFile', args: [lib, f, libs[0]] },
      { label: vscode.l10n.t('Download to this PC…'), command: 'vanthrex.downloadSaveFile', args: [lib, f] },
      { label: vscode.l10n.t('All save files'), command: 'vanthrex.wrkSaveFiles', args: [lib] },
    ],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: ['Library', 'Object', 'Type', 'Attribute', 'Size (KB)', 'Description'],
      rows: rows.map(r => [s(r, 'SAVLIB'), s(r, 'OBJ'), s(r, 'TYPE'), s(r, 'ATTR'), Math.round(Number(r.SZ) / 1024), s(r, 'TXT')]), empty: vscode.l10n.t('Empty.') }],
    note: vscode.l10n.t('Listing save file contents uses QSYS2.SAVE_FILE_OBJECTS (IBM i 7.4 with recent Db2 PTF groups, or later).'),
  }, ALLOWED);
}

async function ensureSaveFile(conn: IbmiConnection, lib: string, f: string): Promise<boolean> {
  const exists = await conn.rows<Row>(`SELECT 1 AS X FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*FILE', ${sqlString(f)})) X WHERE OBJATTRIBUTE = 'SAVF'`, 1).catch(() => []);
  if (!exists.length) {
    const r = await conn.runCL(`CRTSAVF FILE(${lib}/${f})`);
    if (!r.ok) { throw new Error(vscode.l10n.t('CRTSAVF failed: {0}', (r.stderr || r.stdout).trim())); }
    return true;
  }
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Save file {0}/{1} already exists. Clear it and save over it?', lib, f), { modal: true }, vscode.l10n.t('Clear and Save'));
  if (ok !== vscode.l10n.t('Clear and Save')) { return false; }
  const r = await conn.runCL(`CLRSAVF FILE(${lib}/${f})`);
  if (!r.ok) { throw new Error(vscode.l10n.t('CLRSAVF failed: {0}', (r.stderr || r.stdout).trim())); }
  return true;
}

async function saveToSaveFile(manager: ConnectionManager, lib?: string): Promise<void> {
  const conn = manager.require();
  const what = await vscode.window.showQuickPick([{ label: vscode.l10n.t('A whole library'), value: 'library' as const }, { label: vscode.l10n.t('Some objects of a library'), value: 'objects' as const }], { title: vscode.l10n.t('Save to a save file') });
  if (!what) { return; }
  const library = (await vscode.window.showInputBox({ title: vscode.l10n.t('Library to save from'), value: lib ?? conn.profile.currentLibrary ?? '', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!library) { return; }
  let objects: string[] | undefined;
  if (what.value === 'objects') {
    const o = await vscode.window.showInputBox({ title: vscode.l10n.t('Objects to save'), prompt: vscode.l10n.t('Names separated by spaces; generic names like ORD* are allowed'), ignoreFocusOut: true });
    if (!o) { return; }
    objects = o.split(/[\s,]+/);
  }
  const target = (await vscode.window.showInputBox({ title: vscode.l10n.t('Save file'), prompt: vscode.l10n.t('LIBRARY/SAVEFILE (created if it does not exist)'), value: `QGPL/${library.slice(0, 10)}`, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!target?.includes('/')) { return; }
  const [sl, sf] = target.split('/');
  const env = await conn.rows<Row>(`SELECT OS_VERSION, OS_RELEASE FROM SYSIBMADM.ENV_SYS_INFO`, 1).catch(() => []);
  const rel = await vscode.window.showQuickPick(targetReleases(env[0] ? `${s(env[0], 'OS_VERSION')}.${s(env[0], 'OS_RELEASE')}` : ''), { title: vscode.l10n.t('Target release (to restore on an older system, pick its release)') });
  if (!rel) { return; }
  const cmd = saveCommand({ what: what.value, library, objects, savfLibrary: sl, savf: sf, targetRelease: rel, compress: true });
  const go = await vscode.window.showInformationMessage(cmd, { modal: true, detail: vscode.l10n.t('Saving a large library can take a long time. Run it in a batch job to keep working.') }, 'Run Now', vscode.l10n.t('Submit to Batch'), vscode.l10n.t('Copy Command'));
  if (go === vscode.l10n.t('Copy Command')) { await vscode.env.clipboard.writeText(cmd); return; }
  if (!go) { return; }
  if (!(await ensureSaveFile(conn, sl, sf))) { return; }
  if (go === vscode.l10n.t('Submit to Batch')) {
    const sbm = `SBMJOB CMD(${cmd}) JOB(SAV${library.slice(0, 7)}) JOBQ(QSYSNOMAX)`;
    const r = await conn.runCL(sbm);
    if (!r.ok) { throw new Error(vscode.l10n.t('SBMJOB failed: {0}', (r.stderr || r.stdout).trim())); }
    vscode.window.showInformationMessage(vscode.l10n.t('Save submitted as a batch job. Check its job log when it ends.'));
    return;
  }
  const r = await progress(`Saving ${library}…`, () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(vscode.l10n.t('Save failed: {0}', (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' '))); }
  vscode.window.showInformationMessage(vscode.l10n.t('Saved into {0}/{1}.', sl, sf));
  await saveFileContents(manager, sl, sf).catch(e => log(errorMessage(e)));
}

async function restoreFromSaveFile(manager: ConnectionManager, lib: string, f: string, savedLib?: string): Promise<void> {
  const conn = manager.require();
  const what = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Everything that was saved (RSTLIB)'), value: 'library' as const }, { label: vscode.l10n.t('Some objects (RSTOBJ)'), value: 'objects' as const }], { title: vscode.l10n.t('Restore from {0}/{1}', lib, f) });
  if (!what) { return; }
  const saved = (await vscode.window.showInputBox({ title: vscode.l10n.t('Library the objects were saved from'), value: savedLib ?? '', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!saved) { return; }
  let objects: string[] | undefined;
  if (what.value === 'objects') {
    const o = await vscode.window.showInputBox({ title: vscode.l10n.t('Objects to restore'), prompt: vscode.l10n.t('Names separated by spaces, or *ALL'), value: '*ALL', ignoreFocusOut: true });
    if (!o) { return; }
    objects = o.split(/[\s,]+/);
  }
  const into = await vscode.window.showInputBox({ title: vscode.l10n.t('Restore into library'), value: saved, prompt: vscode.l10n.t('Use another library to restore a copy side by side'), ignoreFocusOut: true });
  if (into === undefined) { return; }
  const cmd = restoreCommand({ what: what.value, savedLibrary: saved, objects, savfLibrary: lib, savf: f, restoreInto: into });
  await runCl(conn, cmd, { warn: vscode.l10n.t('Objects that already exist in {0} are replaced (objects in use or locked are not restored).', into.trim().toUpperCase() || saved), done: vscode.l10n.t('Restore finished. Check the job log for objects that were not restored.') });
}

async function downloadSaveFile(manager: ConnectionManager, lib: string, f: string): Promise<void> {
  const conn = manager.require();
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), `${f}.savf`)), filters: { 'Save file': ['savf'] }, saveLabel: 'Download' });
  if (!target) { return; }
  const tmp = conn.tempPath('.savf');
  await progress(`Downloading ${lib}/${f}…`, async () => {
    const r = await conn.runCL(`CPYTOSTMF FROMMBR('/QSYS.LIB/${lib}.LIB/${f}.FILE') TOSTMF('${tmp}') STMFOPT(*REPLACE) CVTDTA(*NONE)`);
    if (!r.ok) { throw new Error(vscode.l10n.t('CPYTOSTMF failed: {0}', (r.stderr || r.stdout).trim())); }
    try { await conn.downloadToLocal(tmp, target.fsPath); } finally { await conn.removePath(tmp, false).catch(() => undefined); }
  });
  vscode.window.showInformationMessage(vscode.l10n.t('Downloaded to {0}', target.fsPath));
}

async function uploadSaveFile(manager: ConnectionManager, lib?: string): Promise<void> {
  const conn = manager.require();
  const src = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Save file': ['savf', '*'] }, openLabel: 'Upload' });
  if (!src?.[0]) { return; }
  const base = path.basename(src[0].fsPath).replace(/\.[^.]*$/, '').toUpperCase().replace(/[^A-Z0-9$#@_]/g, '').slice(0, 10) || 'UPLOAD';
  const target = (await vscode.window.showInputBox({ title: vscode.l10n.t('Upload into save file'), prompt: 'LIBRARY/SAVEFILE', value: `${lib ?? 'QGPL'}/${/^[A-Z$#@]/.test(base) ? base : 'S' + base.slice(0, 9)}`, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!target?.includes('/')) { return; }
  const [sl, sf] = target.split('/');
  assertSystemName(sl, 'library'); assertSystemName(sf, 'save file');
  if (!(await ensureSaveFile(conn, sl, sf))) { return; }
  const tmp = conn.tempPath('.savf');
  await progress(`Uploading to ${sl}/${sf}…`, async () => {
    await conn.writeStreamFile(tmp, await vscode.workspace.fs.readFile(src[0]));
    try {
      const r = await conn.runCL(`CPYFRMSTMF FROMSTMF('${tmp}') TOMBR('/QSYS.LIB/${sl}.LIB/${sf}.FILE') MBROPT(*REPLACE) CVTDTA(*NONE)`);
      if (!r.ok) { throw new Error(vscode.l10n.t('CPYFRMSTMF failed: {0}', (r.stderr || r.stdout).trim())); }
    } finally { await conn.removePath(tmp, false).catch(() => undefined); }
  });
  vscode.window.showInformationMessage(vscode.l10n.t('Uploaded into {0}/{1}.', sl, sf));
  await saveFileContents(manager, sl, sf).catch(e => log(errorMessage(e)));
}

// ================================================================ network & services

async function connections(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await progress('Reading TCP/IP connections…', () => conn.rows<Row>(
    `SELECT N.LOCAL_ADDRESS AS LADDR, N.LOCAL_PORT AS LPORT, COALESCE(N.LOCAL_PORT_NAME, '') AS LNAME, N.REMOTE_ADDRESS AS RADDR, N.REMOTE_PORT AS RPORT, ` +
    `N.TCP_STATE AS ST, COALESCE(N.IDLE_TIME, 0) AS IDLE, COALESCE(J.JOB_NAME, '') AS JOB, COALESCE(J.AUTHORIZATION_NAME, '') AS USR ` +
    `FROM QSYS2.NETSTAT_INFO N LEFT JOIN QSYS2.NETSTAT_JOB_INFO J ON J.LOCAL_ADDRESS = N.LOCAL_ADDRESS AND J.LOCAL_PORT = N.LOCAL_PORT ` +
    `AND J.REMOTE_ADDRESS = N.REMOTE_ADDRESS AND J.REMOTE_PORT = N.REMOTE_PORT ` +
    `WHERE N.CONNECTION_TYPE IN ('IPV4', 'IPV6') AND N.TCP_STATE IS NOT NULL ORDER BY CASE WHEN N.TCP_STATE = 'LISTEN' THEN 1 ELSE 0 END, N.LOCAL_PORT FETCH FIRST 3000 ROWS ONLY`, 3000));
  const listen = rows.filter(r => s(r, 'ST') === 'LISTEN');
  const active = rows.filter(r => s(r, 'ST') !== 'LISTEN');
  showReport('netstat', {
    title: vscode.l10n.t('TCP/IP connections'), subtitle: vscode.l10n.t('{0} connection(s), {1} listening port(s). Click a connection to see its job or end it.', active.length, listen.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkConnections' }, { label: vscode.l10n.t('TCP servers'), command: 'vanthrex.wrkTcpServers' }, { label: vscode.l10n.t('IP interfaces'), command: 'vanthrex.wrkInterfaces' }],
    tables: [
      { title: vscode.l10n.t('Connections'), filter: true, columns: ['Remote address', 'Remote port', 'Local port', 'Service', 'State', 'Idle (s)', 'Job', 'User'],
        rows: active.map(r => [s(r, 'RADDR'), s(r, 'RPORT'), s(r, 'LPORT'), s(r, 'LNAME'), s(r, 'ST'), s(r, 'IDLE'), s(r, 'JOB'), s(r, 'USR')]),
        rowActions: active.map(r => rowAction('cnn', r)) },
      { title: vscode.l10n.t('Listening ports'), filter: true, columns: ['Local address', 'Port', 'Service', 'Job'],
        rows: listen.map(r => [s(r, 'LADDR'), s(r, 'LPORT'), s(r, 'LNAME'), s(r, 'JOB')]) },
    ],
  }, ALLOWED);
}

async function tcpServers(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const rows = await progress('Checking TCP servers…', () => conn.rows<Row>(
    `SELECT DISTINCT LOCAL_PORT AS P FROM QSYS2.NETSTAT_INFO WHERE TCP_STATE = 'LISTEN'`, 5000));
  const st = serverStatus(rows.map(r => Number(r.P)));
  showReport('tcpsvr', {
    title: vscode.l10n.t('TCP/IP servers'), subtitle: vscode.l10n.t('{0} of {1} known servers are listening. Click one to start or end it.', st.filter(x => x.listening).length, st.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkTcpServers' }, { label: vscode.l10n.t('Connections'), command: 'vanthrex.wrkConnections' }],
    tables: [{ title: vscode.l10n.t('Servers'), columns: ['Server', 'What it is', 'Status', 'Ports listening', 'Note'],
      rows: st.map(x => [x.server, x.name, x.listening ? 'listening' : 'not listening', x.open.join(', ') || x.ports.join(', '), x.note ?? '']),
      rowActions: st.map(x => (x.start ? rowAction('svr', { SERVER: x.server, LISTENING: x.listening }) : undefined)),
      rowClass: st.map(x => (x.listening ? undefined : 'dim')) }],
    note: vscode.l10n.t('Status comes from the ports in LISTEN state (NETSTAT). A server can listen on other ports if it was configured so. Starting and ending servers needs *IOSYSCFG special authority.'),
  }, ALLOWED);
}

async function interfaces(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const [ifs, routes] = await progress('Reading IP interfaces…', () => Promise.all([
    conn.rows<Row>(`SELECT * FROM QSYS2.NETSTAT_INTERFACE_INFO`, 500),
    conn.rows<Row>(`SELECT * FROM QSYS2.NETSTAT_ROUTE_INFO`, 500).catch(() => []),
  ]));
  showReport('netif', {
    title: vscode.l10n.t('IP interfaces and routes'), subtitle: vscode.l10n.t('{0} interface(s), {1} route(s).', ifs.length, routes.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkInterfaces' }, { label: vscode.l10n.t('Connections'), command: 'vanthrex.wrkConnections' }],
    tables: [
      { title: vscode.l10n.t('Interfaces'), filter: true, columns: ['Address', 'Status', 'Line', 'Subnet mask', 'Network', 'Type'],
        rows: ifs.map(r => [s(r, 'INTERNET_ADDRESS'), s(r, 'INTERFACE_STATUS'), s(r, 'LINE_DESCRIPTION'), s(r, 'SUBNET_MASK'), s(r, 'NETWORK_ADDRESS'), s(r, 'CONNECTION_TYPE')]) },
      { title: vscode.l10n.t('Routes'), filter: true, columns: ['Destination', 'Subnet mask', 'Next hop', 'Status', 'Local binding interface'],
        rows: routes.map(r => [s(r, 'ROUTE_DESTINATION'), s(r, 'SUBNET_MASK'), s(r, 'NEXT_HOP'), s(r, 'ROUTE_STATUS'), s(r, 'LOCAL_BINDING_INTERFACE')]), empty: vscode.l10n.t('Not available.') },
    ],
  }, ALLOWED);
}

// ================================================================ row options

async function rowMenu(manager: ConnectionManager, kind: string, r: Row): Promise<void> {
  const conn = manager.require();
  type Opt = { label: string; run: () => Thenable<unknown> };
  let opts: Opt[] = [];
  switch (kind) {
    case 'sbs': {
      const sbs = s(r, 'SBS'); const lib = s(r, 'LIB'); const active = s(r, 'STATUS') === 'ACTIVE';
      opts = active ? [
        { label: vscode.l10n.t('$(list-unordered) Work with its jobs'), run: () => subsystemJobs(manager, sbs) },
        { label: vscode.l10n.t('$(debug-stop) End subsystem (controlled)…'), run: () => runCl(conn, `ENDSBS SBS(${sbs}) OPTION(*CNTRLD) DELAY(60)`, { warn: vscode.l10n.t('All jobs in the subsystem are ended.'), refresh: () => subsystems(manager) }) },
      ] : [{ label: vscode.l10n.t('$(play) Start subsystem'), run: () => runCl(conn, `STRSBS SBSD(${lib}/${sbs})`, { refresh: () => subsystems(manager) }) }];
      break;
    }
    case 'job': {
      const job = s(r, 'JOB');
      opts = [
        { label: vscode.l10n.t('$(output) Job log'), run: () => vscode.commands.executeCommand('vanthrex.jobLog', { job }) },
        { label: vscode.l10n.t('$(search-fuzzy) Analyze job log'), run: () => vscode.commands.executeCommand('vanthrex.analyzeJobLog', job) },
        { label: vscode.l10n.t('$(debug-pause) Hold job'), run: () => runCl(conn, `HLDJOB JOB(${job})`) },
        { label: vscode.l10n.t('$(debug-continue) Release job'), run: () => runCl(conn, `RLSJOB JOB(${job})`) },
        { label: vscode.l10n.t('$(debug-stop) End job (controlled)…'), run: () => runCl(conn, `ENDJOB JOB(${job}) OPTION(*CNTRLD) DELAY(30)`) },
      ];
      break;
    }
    case 'jobq': {
      const lib = s(r, 'LIB'); const q = s(r, 'Q'); const refresh = () => jobQueues(manager);
      opts = [
        { label: vscode.l10n.t('$(list-unordered) Work with its jobs'), run: () => jobQueue(manager, lib, q) },
        s(r, 'ST') === 'HELD'
          ? { label: vscode.l10n.t('$(debug-continue) Release job queue'), run: () => runCl(conn, `RLSJOBQ JOBQ(${lib}/${q})`, { refresh }) }
          : { label: vscode.l10n.t('$(debug-pause) Hold job queue'), run: () => runCl(conn, `HLDJOBQ JOBQ(${lib}/${q})`, { warn: vscode.l10n.t('Waiting jobs stay on the queue but do not start.'), refresh }) },
        { label: vscode.l10n.t('$(trash) Clear job queue…'), run: () => runCl(conn, `CLRJOBQ JOBQ(${lib}/${q})`, { warn: vscode.l10n.t('Every waiting job is removed from the queue. This can\'t be undone.'), refresh }) },
      ];
      break;
    }
    case 'qjob': {
      const job = s(r, 'JOB'); const refresh = () => jobQueue(manager, s(r, 'LIB'), s(r, 'Q'));
      opts = [
        { label: vscode.l10n.t('$(debug-continue) Release job'), run: () => runCl(conn, `RLSJOB JOB(${job})`, { refresh }) },
        { label: vscode.l10n.t('$(debug-pause) Hold job'), run: () => runCl(conn, `HLDJOB JOB(${job})`, { refresh }) },
        { label: vscode.l10n.t('$(arrow-up) Run next (priority 1)'), run: () => runCl(conn, `CHGJOB JOB(${job}) JOBPTY(1)`, { refresh }) },
        { label: vscode.l10n.t('$(debug-stop) Remove from queue (end job)…'), run: () => runCl(conn, `ENDJOB JOB(${job}) OPTION(*IMMED)`, { refresh }) },
      ];
      break;
    }
    case 'outq': {
      const lib = s(r, 'LIB'); const q = s(r, 'Q'); const refresh = () => outputQueues(manager);
      opts = [
        { label: vscode.l10n.t('$(list-unordered) Work with its spooled files'), run: () => outputQueue(manager, lib, q) },
        s(r, 'ST') === 'HELD'
          ? { label: vscode.l10n.t('$(debug-continue) Release output queue'), run: () => runCl(conn, `RLSOUTQ OUTQ(${lib}/${q})`, { refresh }) }
          : { label: vscode.l10n.t('$(debug-pause) Hold output queue'), run: () => runCl(conn, `HLDOUTQ OUTQ(${lib}/${q})`, { refresh }) },
        { label: vscode.l10n.t('$(trash) Clear output queue…'), run: () => runCl(conn, `CLROUTQ OUTQ(${lib}/${q})`, { warn: vscode.l10n.t('Every spooled file on the queue is deleted. This can\'t be undone.'), refresh }) },
      ];
      break;
    }
    case 'splf': {
      const name = s(r, 'NAME'); const job = s(r, 'JOB'); const nbr = s(r, 'NBR'); const refresh = () => outputQueue(manager, s(r, 'LIB'), s(r, 'Q'));
      const target = `FILE(${name}) JOB(${job}) SPLNBR(${nbr})`;
      opts = [
        { label: vscode.l10n.t('$(go-to-file) Open'), run: () => vscode.commands.executeCommand('vanthrex.spoolOpen', { name, job, number: Number(nbr), userData: s(r, 'UDATA'), status: s(r, 'STATUS'), pages: Number(r.PAGES ?? 0), created: s(r, 'T'), outq: s(r, 'Q') }) },
        { label: vscode.l10n.t('$(debug-pause) Hold'), run: () => runCl(conn, `HLDSPLF ${target}`, { refresh }) },
        { label: vscode.l10n.t('$(debug-continue) Release'), run: () => runCl(conn, `RLSSPLF ${target}`, { refresh }) },
        { label: vscode.l10n.t('$(arrow-right) Move to another output queue…'), run: async () => {
          const to = (await vscode.window.showInputBox({ title: vscode.l10n.t('Move to output queue'), prompt: 'LIBRARY/OUTQ or OUTQ', ignoreFocusOut: true }))?.trim().toUpperCase();
          if (to) { await runCl(conn, `CHGSPLFA ${target} OUTQ(${to})`, { refresh }); }
        } },
        { label: vscode.l10n.t('$(trash) Delete…'), run: () => runCl(conn, `DLTSPLF ${target}`, { warn: vscode.l10n.t('The spooled file is deleted. This can\'t be undone.'), refresh }) },
      ];
      break;
    }
    case 'scde': {
      const name = s(r, 'NAME'); const nbr = s(r, 'NBR'); const refresh = () => jobSchedule(manager);
      const id = `JOB(${name}) ENTRYNBR(${nbr})`;
      opts = [
        s(r, 'STATUS') === 'HELD'
          ? { label: vscode.l10n.t('$(debug-continue) Release entry'), run: () => runCl(conn, `RLSJOBSCDE ${id}`, { refresh }) }
          : { label: vscode.l10n.t('$(debug-pause) Hold entry'), run: () => runCl(conn, `HLDJOBSCDE ${id}`, { refresh }) },
        { label: vscode.l10n.t('$(copy) Copy its command'), run: () => vscode.env.clipboard.writeText(s(r, 'CMD')) },
        { label: vscode.l10n.t('$(trash) Remove entry…'), run: () => runCl(conn, `RMVJOBSCDE ${id}`, { warn: vscode.l10n.t('The entry is removed from the job scheduler.'), refresh }) },
      ];
      break;
    }
    case 'usr': {
      const u = s(r, 'USR'); const refresh = () => userProfiles(manager);
      opts = [
        { label: vscode.l10n.t('$(account) Active jobs and objects owned'), run: () => userDetails(manager, u) },
        s(r, 'STATUS') === '*DISABLED'
          ? { label: vscode.l10n.t('$(unlock) Enable profile'), run: () => runCl(conn, `CHGUSRPRF USRPRF(${u}) STATUS(*ENABLED)`, { warn: vscode.l10n.t('Needs *SECADM special authority.'), refresh }) }
          : { label: vscode.l10n.t('$(lock) Disable profile…'), run: () => runCl(conn, `CHGUSRPRF USRPRF(${u}) STATUS(*DISABLED)`, { warn: vscode.l10n.t('{0} will not be able to sign on. Jobs already running continue.', u), refresh }) },
        { label: vscode.l10n.t('$(key) Expire password (must change at next sign-on)…'), run: () => runCl(conn, `CHGUSRPRF USRPRF(${u}) PWDEXP(*YES)`, { warn: vscode.l10n.t('Needs *SECADM special authority.'), refresh }) },
        { label: vscode.l10n.t('$(shield) Check this user\'s authority on an object…'), run: () => vscode.commands.executeCommand('vanthrex.checkAuthority') },
      ];
      break;
    }
    case 'savf': {
      const lib = s(r, 'LIB'); const f = s(r, 'NAME');
      opts = [
        { label: vscode.l10n.t('$(list-unordered) Show contents'), run: () => saveFileContents(manager, lib, f) },
        { label: vscode.l10n.t('$(history) Restore from it…'), run: () => restoreFromSaveFile(manager, lib, f) },
        { label: vscode.l10n.t('$(cloud-download) Download to this PC…'), run: () => downloadSaveFile(manager, lib, f) },
      ];
      break;
    }
    case 'cnn': {
      const job = s(r, 'JOB');
      opts = [
        ...(job ? [{ label: vscode.l10n.t('$(output) Job log of the server job'), run: () => vscode.commands.executeCommand('vanthrex.jobLog', { job }) }] : []),
        { label: vscode.l10n.t('$(debug-disconnect) End this connection…'), run: () => runCl(conn, endConnectionCommand(s(r, 'LADDR'), Number(r.LPORT), s(r, 'RADDR'), Number(r.RPORT)),
          { warn: vscode.l10n.t('The client is disconnected. If this is your own SSH connection, Vanthrex is disconnected too.'), refresh: () => connections(manager) }) },
      ];
      break;
    }
    case 'svr': {
      const svr = TCP_SERVERS.find(x => x.server === s(r, 'SERVER'));
      if (!svr) { return; }
      const refresh = () => tcpServers(manager);
      opts = [
        { label: vscode.l10n.t('$(play) Start'), run: () => runCl(conn, svr.start, { refresh }) },
        { label: vscode.l10n.t('$(debug-stop) End…'), run: () => runCl(conn, svr.end, { warn: svr.note ?? 'Clients of this server are disconnected.', refresh }) },
      ];
      break;
    }
  }
  if (!opts.length) { return; }
  const pick = await vscode.window.showQuickPick(opts, { title: Object.values(r).slice(0, 2).map(String).join(' ').trim() || 'Options' });
  if (pick) { await pick.run(); }
}

// ================================================================ hub & registration

const HUB: { label: string; detail: string; cmd: string }[] = [
  { label: vscode.l10n.t('$(server-process) Subsystems'), detail: vscode.l10n.t('WRKSBS — start, end, see the jobs in each subsystem'), cmd: 'vanthrex.wrkSubsystems' },
  { label: vscode.l10n.t('$(list-ordered) Job queues'), detail: vscode.l10n.t('WRKJOBQ — waiting jobs, hold, release, clear'), cmd: 'vanthrex.wrkJobQueues' },
  { label: vscode.l10n.t('$(output) Output queues'), detail: vscode.l10n.t('WRKOUTQ — spooled files of any queue: open, hold, release, move, delete'), cmd: 'vanthrex.wrkOutputQueues' },
  { label: vscode.l10n.t('$(calendar) Job scheduler'), detail: vscode.l10n.t('WRKJOBSCDE — scheduled jobs: add, hold, release, remove'), cmd: 'vanthrex.wrkJobSchedule' },
  { label: vscode.l10n.t('$(account) User profiles'), detail: vscode.l10n.t('WRKUSRPRF — enable, disable, expire password, jobs and objects owned'), cmd: 'vanthrex.wrkUserProfiles' },
  { label: vscode.l10n.t('$(settings) System values'), detail: vscode.l10n.t('WRKSYSVAL — all system values, the important ones explained'), cmd: 'vanthrex.wrkSystemValues' },
  { label: vscode.l10n.t('$(shield) Security audit journal'), detail: vscode.l10n.t('DSPAUDJRNE — authority failures, invalid passwords, profile and system value changes'), cmd: 'vanthrex.auditJournal' },
  { label: vscode.l10n.t('$(archive) Save files'), detail: vscode.l10n.t('WRKSAVF — contents, restore, download / upload'), cmd: 'vanthrex.wrkSaveFiles' },
  { label: vscode.l10n.t('$(save) Save a library or objects…'), detail: vscode.l10n.t('SAVLIB / SAVOBJ to a save file'), cmd: 'vanthrex.saveToSaveFile' },
  { label: vscode.l10n.t('$(plug) TCP/IP connections'), detail: vscode.l10n.t('NETSTAT — who is connected, from where, to which job'), cmd: 'vanthrex.wrkConnections' },
  { label: vscode.l10n.t('$(radio-tower) TCP/IP servers'), detail: vscode.l10n.t('STRTCPSVR / ENDTCPSVR — SSH, host servers, FTP, Telnet, HTTP admin…'), cmd: 'vanthrex.wrkTcpServers' },
  { label: vscode.l10n.t('$(globe) IP interfaces and routes'), detail: 'NETSTAT *IFC / *RTE', cmd: 'vanthrex.wrkInterfaces' },
];

export function registerWorkWith(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const libOf = (n: unknown): string | undefined => (typeof n === 'string' ? n : (n as { library?: string } | undefined)?.library);
  const reg = (id: string, fn: (...a: never[]) => Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand(id, guard(fn as (...a: unknown[]) => Promise<unknown>)));
  reg('vanthrex.workWith', async () => {
    const p = await vscode.window.showQuickPick(HUB, { title: vscode.l10n.t('IBM i: Work with…'), matchOnDetail: true });
    if (p) { await vscode.commands.executeCommand(p.cmd); }
  });
  reg('vanthrex.ww.row', (kind: string, r: Row) => rowMenu(manager, String(kind), r ?? {}));
  reg('vanthrex.wrkSubsystems', () => subsystems(manager));
  reg('vanthrex.wrkSubsystemJobs', (sbs: string) => subsystemJobs(manager, String(sbs)));
  reg('vanthrex.wrkJobQueues', () => jobQueues(manager));
  reg('vanthrex.wrkJobQueue', (lib: string, q: string) => jobQueue(manager, lib, q));
  reg('vanthrex.wrkOutputQueues', () => outputQueues(manager));
  reg('vanthrex.wrkOutputQueue', (lib: string, q: string) => outputQueue(manager, lib, q));
  reg('vanthrex.wrkJobSchedule', () => jobSchedule(manager));
  reg('vanthrex.addJobSchedule', () => addJobSchedule(manager));
  reg('vanthrex.wrkUserProfiles', () => userProfiles(manager));
  reg('vanthrex.wrkSystemValues', () => systemValues(manager));
  reg('vanthrex.auditJournal', () => auditJournal(manager));
  reg('vanthrex.wrkSaveFiles', (n?: unknown) => saveFiles(manager, libOf(n)));
  reg('vanthrex.saveFileContents', (n?: unknown) => {
    const o = n as { library?: string; name?: string } | undefined;
    return o?.library && o?.name ? saveFileContents(manager, o.library, o.name) : saveFiles(manager);
  });
  reg('vanthrex.saveToSaveFile', (n?: unknown) => saveToSaveFile(manager, libOf(n)));
  reg('vanthrex.restoreFromSaveFile', (lib: string, f: string, saved?: string) => restoreFromSaveFile(manager, lib, f, saved));
  reg('vanthrex.downloadSaveFile', (lib: string, f: string) => downloadSaveFile(manager, lib, f));
  reg('vanthrex.uploadSaveFile', (n?: unknown) => uploadSaveFile(manager, libOf(n)));
  reg('vanthrex.wrkConnections', () => connections(manager));
  reg('vanthrex.wrkTcpServers', () => tcpServers(manager));
  reg('vanthrex.wrkInterfaces', () => interfaces(manager));
}

