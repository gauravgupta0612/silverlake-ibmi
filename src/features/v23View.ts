import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { assertSystemName, parseMemberPath, sqlString } from '../core/util';
import { formatBytes } from '../core/extras';
import {
  COMMON_CCSIDS, convertCcsidCommand, httpOptions, httpStatus, indicatorProblems, indicatorUsage, parseHeaders, parsePing, pingCommand, prettyBody, stackLine, tagCcsidCommand,
} from '../core/v23';
import { MEMBER_SCHEME } from './fileSystems';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const pick = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { if (r && r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') { return String(r[k]).trim(); } } return ''; };
const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
const ALLOWED = new Set(['vanthrex.jobDetails', 'vanthrex.jobLog', 'vanthrex.analyzeJobLog', 'vanthrex.historyLog', 'vanthrex.tableDependents', 'vanthrex.whereUsed',
  'vanthrex.objectInfo', 'vanthrex.indicatorUsage', 'vanthrex.v22.gotoLine', 'vanthrex.ifsCcsid', 'vanthrex.ifsCcsid.change', 'vanthrex.networkTest', 'vanthrex.callWebApi',
  'vanthrex.explainMessage', 'vanthrex.watchJob', 'vanthrex.rowLocks']);

async function q(conn: IbmiConnection, sql: string, n = 500): Promise<Row[]> {
  try { return await conn.rows<Row>(sql, n); } catch (e) { log(`${sql.slice(0, 80)}…: ${errorMessage(e)}`); return []; }
}

// ================================================================ 1. job details

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

// ================================================================ 2. history log

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

// ================================================================ 3. table dependents

async function tableDependents(manager: ConnectionManager, o?: { library?: string; name?: string }): Promise<void> {
  const conn = manager.require();
  if (!o?.library || !o.name) { throw new Error(vscode.l10n.t('Right-click a file in the Libraries view.')); }
  const lib = assertSystemName(o.library, 'library'); const f = assertSystemName(o.name, 'file');
  if (conn.sqlKeepsJob) { await conn.sql(`CALL QSYS2.QCMDEXC('DSPDBR FILE(${lib}/${f}) OUTPUT(*OUTFILE) OUTFILE(QTEMP/VTXDBR)')`, 1).catch(e => log(errorMessage(e))); }
  const [dbr, idx, views, cst, trg] = await progress(vscode.l10n.t('Finding what depends on {0}/{1}…', lib, f), () => Promise.all([
    conn.sqlKeepsJob ? q(conn, `SELECT WHRELI AS L, WHREFI AS F, COALESCE(WHTYPE, '') AS T FROM QTEMP/VTXDBR WHERE WHREFI <> ' '`, 2000) : Promise.resolve([] as Row[]),
    q(conn, `SELECT SYSTEM_INDEX_SCHEMA AS L, SYSTEM_INDEX_NAME AS N, COALESCE(IS_UNIQUE, '') AS U FROM QSYS2.SYSINDEXES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f)}`, 500),
    q(conn, `SELECT DISTINCT SYSTEM_VIEW_SCHEMA AS L, SYSTEM_VIEW_NAME AS N FROM QSYS2.SYSVIEWDEP WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f)}`, 500),
    q(conn, `SELECT CONSTRAINT_NAME AS N, CONSTRAINT_TYPE AS T FROM QSYS2.SYSCST WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f)}`, 200),
    q(conn, `SELECT * FROM QSYS2.SYSTRIGGERS WHERE EVENT_OBJECT_SCHEMA = (SELECT TABLE_SCHEMA FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f)}) ` +
      `AND EVENT_OBJECT_TABLE = (SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f)})`, 200),
  ]));
  const fks = await q(conn, `SELECT C.SYSTEM_TABLE_SCHEMA AS L, C.SYSTEM_TABLE_NAME AS N, C.CONSTRAINT_NAME AS CN FROM QSYS2.SYSREFCST R JOIN QSYS2.SYSCST C ON C.CONSTRAINT_SCHEMA = R.CONSTRAINT_SCHEMA AND C.CONSTRAINT_NAME = R.CONSTRAINT_NAME ` +
    `JOIN QSYS2.SYSCST P ON P.CONSTRAINT_SCHEMA = R.UNIQUE_CONSTRAINT_SCHEMA AND P.CONSTRAINT_NAME = R.UNIQUE_CONSTRAINT_NAME WHERE P.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND P.SYSTEM_TABLE_NAME = ${sqlString(f)}`, 200);
  const rows: (string | number)[][] = [
    ...dbr.map(r => [`${s(r, 'L')}/${s(r, 'F')}`, s(r, 'T') === 'D' ? 'logical file / index (data)' : s(r, 'T') === 'V' ? 'view' : s(r, 'T') === 'O' ? 'access path sharing' : `dependent (${s(r, 'T')})`]),
    ...idx.filter(r => !dbr.some(d => s(d, 'F') === s(r, 'N'))).map(r => [`${s(r, 'L')}/${s(r, 'N')}`, s(r, 'U') === 'U' || s(r, 'U') === 'Y' ? 'unique index' : 'index']),
    ...views.filter(r => !dbr.some(d => s(d, 'F') === s(r, 'N'))).map(r => [`${s(r, 'L')}/${s(r, 'N')}`, 'SQL view']),
    ...fks.map(r => [`${s(r, 'L')}/${s(r, 'N')}`, `foreign key ${s(r, 'CN')} refers to this table`]),
    ...trg.map(r => [`${pick(r, 'TRIGGER_SCHEMA')}.${pick(r, 'TRIGGER_NAME')}`, `trigger ${pick(r, 'ACTION_TIMING')} ${pick(r, 'EVENT_MANIPULATION')}${pick(r, 'TRIGGER_PROGRAM_NAME') ? ` → ${pick(r, 'TRIGGER_PROGRAM_LIBRARY')}/${pick(r, 'TRIGGER_PROGRAM_NAME')}` : ''}`]),
    ...cst.map(r => [s(r, 'N'), `constraint ${s(r, 'T')}`]),
  ];
  showReport('dependents', {
    title: vscode.l10n.t('What depends on {0}/{1}', lib, f), subtitle: vscode.l10n.t('{0} dependent object(s): logical files, indexes, views, constraints, foreign keys and triggers. Programs using the file are in "Where used".', rows.length),
    actions: [{ label: vscode.l10n.t('Programs using it (where used)'), command: 'vanthrex.whereUsed', args: [{ library: lib, name: f, type: '*FILE' }] }, { label: vscode.l10n.t('Who is locking rows?'), command: 'vanthrex.rowLocks', args: [{ library: lib, name: f }] }],
    tables: [{ title: vscode.l10n.t('Dependents'), filter: true, columns: ['Object', 'Dependency'], rows, empty: vscode.l10n.t('Nothing depends on it.') }],
    note: vscode.l10n.t('Check this list before changing or dropping a table: logical files and views must be recreated when the record format changes, and triggers and foreign keys may stop a change.'),
  }, ALLOWED);
}

// ================================================================ 4. indicator usage

async function indicatorUsageCmd(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { throw new Error(vscode.l10n.t('Open an RPG or DDS source first.')); }
  const u = indicatorUsage(ed.document.getText());
  const problems = indicatorProblems(u);
  const name = ed.document.uri.scheme === MEMBER_SCHEME ? parseMemberPath(ed.document.uri.path).member : ed.document.fileName.split(/[\\/]/).pop();
  const lines = (a: number[]) => a.slice(0, 15).map(l => l + 1).join(', ') + (a.length > 15 ? ` … (+${a.length - 15})` : '');
  showReport('indicators', {
    title: vscode.l10n.t('Indicators — {0}', String(name)), subtitle: vscode.l10n.t('{0} indicator(s) used; {1} look suspicious. Click one to go to its first use.', u.length, problems.length),
    tables: [
      { title: vscode.l10n.t('Indicators'), columns: ['Indicator', 'Set on lines', 'Tested on lines'], rows: u.map(x => [x.indicator, lines(x.set), lines(x.tested)]),
        rowActions: u.map(x => ({ label: 'Go to', command: 'vanthrex.v22.gotoLine', args: [ed.document.uri.toString(), Math.min(...x.set, ...x.tested)] })), empty: vscode.l10n.t('No numbered indicators — nice.') },
      { title: vscode.l10n.t('Suspicious'), columns: ['Indicator', 'Why'], rows: problems.map(p => [p.indicator, p.problem]), empty: vscode.l10n.t('None.') },
    ],
    note: vscode.l10n.t('Indicators set by a display file (CA03, SFLEND…) and tested in the program show as "tested but never set here" in the program — compare with the display file. Named indicators (dcl-s x ind) are easier to read.'),
  }, ALLOWED);
}

// ================================================================ 5. IFS CCSID

async function ifsCcsid(manager: ConnectionManager, n?: { path?: string; isDirectory?: boolean }): Promise<void> {
  const conn = manager.require();
  const path = n?.path ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('IFS file or folder'), value: conn.profile.ifsHome ?? '/home', ignoreFocusOut: true }))?.trim();
  if (!path) { return; }
  const rows = await progress(vscode.l10n.t('Reading CCSIDs…'), () => conn.rows<Row>(
    `SELECT PATH_NAME AS P, OBJECT_TYPE AS T, COALESCE(CCSID, 0) AS C, COALESCE(DATA_SIZE, 0) AS SZ FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => ${sqlString(path)}, SUBTREE_DIRECTORIES => 'NO', OBJECT_TYPE_LIST => '*ALLSTMF')) X ORDER BY PATH_NAME FETCH FIRST 2000 ROWS ONLY`, 2000));
  const byC = new Map<number, number>(); rows.forEach(r => byC.set(Number(r.C), (byC.get(Number(r.C)) ?? 0) + 1));
  showReport('ifsCcsid', {
    title: vscode.l10n.t('Character sets — {0}', path), subtitle: vscode.l10n.t('{0} stream file(s). Files tagged with the wrong CCSID show garbled text in VS Code, ACS and programs. Click a file to change it.', rows.length),
    facts: [...byC.entries()].map(([c, k]) => [`${c} ${COMMON_CCSIDS[c] ?? ''}`.trim(), k] as [string, number]),
    actions: [{ label: n?.isDirectory !== false ? 'Tag every file in this folder…' : 'Change…', command: 'vanthrex.ifsCcsid.change', args: [path, true] }],
    tables: [{ title: vscode.l10n.t('Files'), filter: true, columns: ['File', 'CCSID', 'Character set', 'Size'], rows: rows.map(r => [s(r, 'P'), s(r, 'C'), COMMON_CCSIDS[Number(r.C)] ?? '', formatBytes(Number(r.SZ))]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Change…'), command: 'vanthrex.ifsCcsid.change', args: [s(r, 'P'), false] })),
      rowClass: rows.map(r => (Number(r.C) === 65535 ? 'bad' : undefined)) }],
    note: vscode.l10n.t('"Tag" only changes the label (when the content is already in that character set); "Convert" rewrites the content into the new character set.'),
  }, ALLOWED);
}

async function changeCcsid(manager: ConnectionManager, path: string, many: boolean): Promise<void> {
  const conn = manager.require();
  const how = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(tag) Tag only (the content already is in that character set)'), v: 'tag' },
    ...(many ? [] : [{ label: vscode.l10n.t('$(sync) Convert the content to another character set'), v: 'convert' }]),
  ], { title: path });
  if (!how) { return; }
  const c = await vscode.window.showQuickPick([...Object.entries(COMMON_CCSIDS).map(([k, v]) => ({ label: k, description: v })), { label: vscode.l10n.t('Other…'), description: '' }], { title: vscode.l10n.t('CCSID') });
  if (!c) { return; }
  const ccsid = Number(c.description ? c.label : await vscode.window.showInputBox({ title: vscode.l10n.t('CCSID'), validateInput: x => (/^\d+$/.test(x) ? undefined : vscode.l10n.t('A number')) }));
  if (!ccsid) { return; }
  const cmd = how.v === 'tag' ? tagCcsidCommand(path, ccsid, many) : convertCcsidCommand(path, ccsid);
  const ok = await vscode.window.showWarningMessage(cmd, { modal: true, detail: how.v === 'convert' ? vscode.l10n.t('The file is rewritten in the new character set.') : undefined }, vscode.l10n.t('Run'));
  if (ok !== vscode.l10n.t('Run')) { return; }
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
}

// ================================================================ 6. network test

async function networkTest(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const host = (await vscode.window.showInputBox({ title: vscode.l10n.t('Can the IBM i reach this host?'), prompt: vscode.l10n.t('Host name or IP address (tested from the IBM i, not from your PC)'), ignoreFocusOut: true }))?.trim();
  if (!host) { return; }
  const r = await progress(vscode.l10n.t('Pinging {0} from {1}…', host, conn.profile.name), () => conn.runCL(pingCommand(host)));
  const p = parsePing(r.stdout + '\n' + r.stderr);
  const msg = p.sent ? vscode.l10n.t('{0}: {1} of {2} answers{3}.', host, p.received ?? 0, p.sent, p.avgMs !== undefined ? `, ${p.avgMs} ms` : '') : vscode.l10n.t('{0} did not answer.', host);
  const c = await (p.ok ? vscode.window.showInformationMessage(msg, vscode.l10n.t('Call a Web API…')) : vscode.window.showWarningMessage(msg, { modal: false, detail: p.text } as vscode.MessageOptions, vscode.l10n.t('Details')));
  if (c === vscode.l10n.t('Details')) { await vscode.window.showInformationMessage(p.text || msg, { modal: true }); }
  if (c === vscode.l10n.t('Call a Web API…')) { await vscode.commands.executeCommand('vanthrex.callWebApi'); }
}

// ================================================================ 7. call a web API from the IBM i

async function callWebApi(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const url = (await vscode.window.showInputBox({ title: vscode.l10n.t('Call a web API from the IBM i (1/3)'), prompt: vscode.l10n.t('https://…'), value: state.get<string>('vanthrex.http.lastUrl', 'https://'), ignoreFocusOut: true,
    validateInput: v => (/^https?:\/\/\S+$/i.test(v.trim()) ? undefined : 'http(s)://…') }))?.trim();
  if (!url) { return; }
  await state.update('vanthrex.http.lastUrl', url);
  const method = await vscode.window.showQuickPick(['GET', 'POST'], { title: vscode.l10n.t('Call a web API from the IBM i (2/3): method') });
  if (!method) { return; }
  const hdrText = await vscode.window.showInputBox({ title: vscode.l10n.t('Call a web API from the IBM i (3/3): headers (optional)'), prompt: vscode.l10n.t('Accept: application/json; Authorization: Bearer …'), value: state.get<string>('vanthrex.http.lastHeaders', 'Accept: application/json'), ignoreFocusOut: true });
  if (hdrText === undefined) { return; }
  await state.update('vanthrex.http.lastHeaders', /authorization/i.test(hdrText) ? '' : hdrText);
  let body = '';
  if (method === 'POST') { const b = await vscode.window.showInputBox({ title: vscode.l10n.t('Request body'), value: '{}', ignoreFocusOut: true }); if (b === undefined) { return; } body = b; }
  const opts = httpOptions(parseHeaders(hdrText), { timeoutSeconds: 30 });
  const sql = method === 'GET'
    ? `SELECT * FROM TABLE(QSYS2.HTTP_GET_VERBOSE(${sqlString(url)}, ${sqlString(opts)})) X`
    : `SELECT * FROM TABLE(QSYS2.HTTP_POST_VERBOSE(${sqlString(url)}, ${sqlString(body)}, ${sqlString(opts)})) X`;
  const started = Date.now();
  const rows = await progress(vscode.l10n.t('Calling {0} from {1}…', url, conn.profile.name), () => conn.rows<Row>(sql, 1));
  const ms = Date.now() - started;
  const r = rows[0] ?? {};
  const hdr = pick(r, 'RESPONSE_HTTP_HEADER', 'RESPONSE_HEADER');
  const resp = pick(r, 'RESPONSE_MESSAGE', 'RESPONSE');
  const status = httpStatus(hdr);
  const pretty = prettyBody(resp);
  const doc = await vscode.workspace.openTextDocument({ language: pretty.language, content: pretty.text });
  await vscode.window.showTextDocument(doc, { preview: false });
  vscode.window.showInformationMessage(vscode.l10n.t('{0} {1} → HTTP {2} in {3} ms (called from {4}).', method, url, status ?? '?', ms, conn.profile.name), vscode.l10n.t('Show Headers')).then(async c => {
    if (c) { const d = await vscode.workspace.openTextDocument({ language: 'json', content: prettyBody(hdr).text }); await vscode.window.showTextDocument(d, { preview: true }); }
  });
}

// ================================================================ registration

export function registerV23(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.jobDetails', guard((j?: unknown) => jobDetails(manager, j))),
    vscode.commands.registerCommand('vanthrex.historyLog', guard(() => historyLog(manager))),
    vscode.commands.registerCommand('vanthrex.tableDependents', guard((o?: { library?: string; name?: string }) => tableDependents(manager, o))),
    vscode.commands.registerCommand('vanthrex.indicatorUsage', guard(() => indicatorUsageCmd())),
    vscode.commands.registerCommand('vanthrex.ifsCcsid', guard((n?: { path?: string; isDirectory?: boolean }) => ifsCcsid(manager, n))),
    vscode.commands.registerCommand('vanthrex.ifsCcsid.change', guard((p: string, many: boolean) => changeCcsid(manager, p, !!many))),
    vscode.commands.registerCommand('vanthrex.networkTest', guard(() => networkTest(manager))),
    vscode.commands.registerCommand('vanthrex.callWebApi', guard(() => callWebApi(manager, context.globalState))),
  );
}
