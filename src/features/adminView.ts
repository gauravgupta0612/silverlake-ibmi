import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { assertSystemName, sqlString } from '../core/util';
import {
  AuthFlag, JOURNAL_ENTRY_TYPES, NEEDS, Privilege, changeDataAreaCommand, diffImages, grantCommand,
  healthFindings, journalSql, pairJournalEntries, printable, resolveAuthority, summarizeChanges,
} from '../core/admin';
import { Report, showReport } from './reportPanel';

type ObjArg = { library: string; name: string; type?: string };
const s = (r: Record<string, unknown> | undefined, k: string) => String(r?.[k] ?? '').trim();
const progress = <T>(title: string, fn: () => Promise<T>) =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

const ALLOWED = new Set([
  'vanthrex.journalExplorer', 'vanthrex.checkAuthority', 'vanthrex.grantAuthority', 'vanthrex.dataQueue',
  'vanthrex.sendDataQueue', 'vanthrex.clearDataQueue', 'vanthrex.dataArea', 'vanthrex.editDataArea',
  'vanthrex.systemHealth', 'vanthrex.objectInfo', 'vanthrex.explainMessage',
]);

async function askObject(title: string, type: string, o?: ObjArg): Promise<ObjArg | undefined> {
  if (o?.library && o?.name) { return { library: o.library.toUpperCase(), name: o.name.toUpperCase(), type: o.type ?? type }; }
  const v = await vscode.window.showInputBox({ title, prompt: 'LIBRARY/NAME', placeHolder: type === '*FILE' ? 'APPLIB/CUSTMAST' : 'APPLIB/NAME', ignoreFocusOut: true });
  if (!v?.includes('/')) { return undefined; }
  const [library, name] = v.trim().toUpperCase().split('/');
  return { library: assertSystemName(library, 'library'), name: assertSystemName(name, 'object'), type };
}

// ================================================================ 1. Journal explorer

async function journalExplorer(manager: ConnectionManager, o?: ObjArg, rrn?: number): Promise<void> {
  const conn = manager.require();
  const obj = await askObject('Journal explorer — which table?', '*FILE', o);
  if (!obj) { return; }
  const info = await conn.rows<Record<string, unknown>>(
    `SELECT JOURNALED, COALESCE(JOURNAL_LIBRARY, '') AS JL, COALESCE(JOURNAL_NAME, '') AS JN, COALESCE(JOURNAL_IMAGES, '') AS IMG ` +
    `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(obj.library)}, '*FILE', ${sqlString(obj.name)})) X`, 1);
  if (!info.length) { throw new Error(`${obj.library}/${obj.name} was not found.`); }
  if (s(info[0], 'JOURNALED') !== 'YES' || !s(info[0], 'JN')) {
    const cmd = `STRJRNPF FILE(${obj.library}/${obj.name}) JRN(${obj.library}/QSQJRN) IMAGES(*BOTH)`;
    const pick = await vscode.window.showWarningMessage(`${obj.library}/${obj.name} is not journaled, so there is no change history to show.`,
      { modal: true, detail: `To record changes from now on, start journaling, for example:\n${cmd}\n(The journal must exist; SQL schemas have QSQJRN.)` }, 'Copy Command');
    if (pick) { await vscode.env.clipboard.writeText(cmd); }
    return;
  }
  const jl = s(info[0], 'JL'); const jn = s(info[0], 'JN');
  const range = await vscode.window.showQuickPick([
    { label: 'Last hour', hours: 1 }, { label: 'Last 24 hours', hours: 24 }, { label: 'Last 7 days', hours: 168 }, { label: 'Last 30 days', hours: 720 },
  ], { title: `Changes to ${obj.library}/${obj.name} (journal ${jl}/${jn})${rrn ? ` — row ${rrn}` : ''}` });
  if (!range) { return; }
  const user = await vscode.window.showInputBox({ title: 'Only changes by one user? (optional)', prompt: 'User profile, or leave empty for everyone', ignoreFocusOut: true });
  if (user === undefined) { return; }
  const q = { journalLibrary: jl, journal: jn, library: obj.library, table: obj.name, hours: range.hours, user: user.trim() || undefined, rrn, limit: 500 };
  let rows: Record<string, unknown>[];
  let withData = true;
  try {
    rows = await progress('Reading the journal…', () => conn.rows<Record<string, unknown>>(journalSql({ ...q, withData: true }), 500));
  } catch (e) {
    log(`Journal with entry data failed, retrying without: ${errorMessage(e)}`);
    withData = false;
    rows = await progress('Reading the journal…', () => conn.rows<Record<string, unknown>>(journalSql(q), 500));
  }
  const changes = pairJournalEntries(rows.reverse().map(r => ({
    seq: s(r, 'SEQ'), time: s(r, 'TIME'), type: s(r, 'TYPE'), rrn: s(r, 'RRN'), user: s(r, 'USR'), job: s(r, 'JOB'), program: s(r, 'PGM'),
    data: withData ? String(r.DATA ?? '') : undefined,
  }))).reverse();
  const who = summarizeChanges(changes);
  const detail = (c: typeof changes[number]) => c.action === 'updated' && c.before !== undefined && c.after !== undefined
    ? diffImages(c.before, c.after).slice(0, 6).join('\n') || '(no visible difference)'
    : printable((c.after ?? c.before ?? '').trimEnd(), 160);
  showReport('journal', {
    title: `Changes — ${obj.library}/${obj.name}`,
    subtitle: `${changes.length} row change(s) in the ${range.label.toLowerCase()}${q.user ? ` by ${q.user.toUpperCase()}` : ''}${rrn ? ` to row ${rrn}` : ''}, newest first. Journal ${jl}/${jn}${s(info[0], 'IMG') ? `, images ${s(info[0], 'IMG')}` : ''}.`,
    facts: [
      ['Rows added', changes.filter(c => c.action === 'added').length],
      ['Rows updated', changes.filter(c => c.action === 'updated').length],
      ['Rows deleted', changes.filter(c => c.action === 'deleted').length],
    ],
    actions: [{ label: 'Change the time range or user', command: 'vanthrex.journalExplorer', args: [obj, rrn] }],
    tables: [
      { title: 'Who changed it', columns: ['User', 'Program', 'Added', 'Updated', 'Deleted', 'Last change'],
        rows: who.map(w => [w.user, w.program, w.added, w.updated, w.deleted, w.last]), empty: 'No changes in this period.' },
      { title: 'Changes (click a row to see only that row\'s history)', filter: true,
        columns: ['Time', 'Action', 'RRN', 'User', 'Program', 'Job', withData ? 'What changed' : 'Data'],
        rows: changes.map(c => [c.time, c.action, c.rrn, c.user, c.program, c.job, withData ? detail(c) : '']),
        rowActions: changes.map(c => (rrn ? undefined : { label: 'History of this row', command: 'vanthrex.journalExplorer', args: [obj, Number(c.rrn)] })),
        rowClass: changes.map(c => (c.action === 'deleted' ? 'bad' : c.action === 'added' ? 'onlyB' : undefined)),
        empty: 'No changes in this period.' },
    ],
    note: `Shows at most 500 journal entries. Record images are shown as text (CCSID 37), so packed and binary fields look garbled; positions are byte positions in the record. ` +
      `For before-and-after values of updates, the file needs IMAGES(*BOTH). Entry types: ${Object.entries(JOURNAL_ENTRY_TYPES).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
  }, ALLOWED);
}

// ================================================================ 2. Authority checker

const FLAG_COLUMNS: [AuthFlag, string][] = [
  ['OBJOPR', 'OBJECT_OPERATIONAL'], ['OBJMGT', 'OBJECT_MANAGEMENT'], ['OBJEXIST', 'OBJECT_EXISTENCE'], ['OBJALTER', 'OBJECT_ALTER'],
  ['OBJREF', 'OBJECT_REFERENCE'], ['READ', 'DATA_READ'], ['ADD', 'DATA_ADD'], ['UPD', 'DATA_UPDATE'], ['DLT', 'DATA_DELETE'], ['EXECUTE', 'DATA_EXECUTE'],
];

async function privilegesOf(conn: IbmiConnection, lib: string, name: string, type: string): Promise<{ rows: Record<string, unknown>[]; privs: Privilege[] }> {
  const rows = await conn.rows<Record<string, unknown>>(
    `SELECT * FROM QSYS2.OBJECT_PRIVILEGES WHERE SYSTEM_OBJECT_SCHEMA = ${sqlString(lib)} AND SYSTEM_OBJECT_NAME = ${sqlString(name)} AND OBJECT_TYPE = ${sqlString(type)}`, 1000);
  const privs = rows.map(r => ({
    name: s(r, 'AUTHORIZATION_NAME') || s(r, 'AUTHORIZATION_USER'), authority: s(r, 'OBJECT_AUTHORITY'),
    flags: Object.fromEntries(FLAG_COLUMNS.map(([f, c]) => [f, s(r, c) === 'YES'])),
  }));
  return { rows, privs };
}

async function autlEntries(conn: IbmiConnection, autl: string): Promise<Privilege[]> {
  if (!autl || autl === '*NONE') { return []; }
  const rows = await conn.rows<Record<string, unknown>>(
    `SELECT * FROM QSYS2.AUTHORIZATION_LIST_USER_INFO WHERE AUTHORIZATION_LIST = ${sqlString(autl)}`, 1000).catch(e => { log(`AUTL ${autl}: ${errorMessage(e)}`); return []; });
  return rows.map(r => ({ name: s(r, 'AUTHORIZATION_NAME'), authority: s(r, 'OBJECT_AUTHORITY'),
    flags: Object.fromEntries(FLAG_COLUMNS.map(([f, c]) => [f, s(r, c) === 'YES'])) }));
}

async function checkAuthority(manager: ConnectionManager, o?: ObjArg): Promise<void> {
  const conn = manager.require();
  let obj = await askObject('Check authority — which object?', '*FILE', o);
  if (!obj) { return; }
  if (!o?.type) {
    const t = await vscode.window.showInputBox({ title: 'Object type', value: obj.type ?? '*FILE', prompt: '*FILE, *PGM, *SRVPGM, *DTAARA, *CMD…' });
    if (!t) { return; }
    obj = { ...obj, type: t.trim().toUpperCase() };
  }
  const type = obj.type!;
  const user = (await vscode.window.showInputBox({ title: `Who needs ${obj.library}/${obj.name} ${type}?`, prompt: 'User profile to check', value: conn.user, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!user) { return; }
  assertSystemName(user, 'user profile');
  const need = await vscode.window.showQuickPick(Object.entries(NEEDS).map(([k, v]) => ({ label: v.label, key: k })), { title: `What does ${user} need to do?` });
  if (!need) { return; }
  const n = NEEDS[need.key];

  const [{ rows, privs }, libPrivs, uinfo] = await progress(`Checking ${user}'s authority…`, () => Promise.all([
    privilegesOf(conn, obj!.library, obj!.name, type),
    privilegesOf(conn, 'QSYS', obj!.library, '*LIB'),
    conn.rows<Record<string, unknown>>(
      `SELECT STATUS, COALESCE(SPECIAL_AUTHORITIES, '') AS SPC, COALESCE(GROUP_PROFILE_NAME, '*NONE') AS GRP, COALESCE(SUPPLEMENTAL_GROUP_LIST, '') AS SUPP ` +
      `FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = ${sqlString(user)}`, 1),
  ]));
  if (!rows.length) { throw new Error(`${obj.library}/${obj.name} ${type} was not found, or you are not allowed to see its authorities.`); }
  if (!uinfo.length) { throw new Error(`User profile ${user} was not found.`); }
  const u = { user, specialAuthorities: s(uinfo[0], 'SPC'), status: s(uinfo[0], 'STATUS'),
    groups: [s(uinfo[0], 'GRP'), ...s(uinfo[0], 'SUPP').split(/\s+/)].filter(g => g && g !== '*NONE') };
  const autlName = s(rows[0], 'AUTHORIZATION_LIST');
  const autl = await autlEntries(conn, autlName);
  const objVerdict = resolveAuthority(u, privs, n.flags, autl, autlName);
  const libVerdict = resolveAuthority(u, libPrivs.privs, ['EXECUTE'], await autlEntries(conn, s(libPrivs.rows[0], 'AUTHORIZATION_LIST')), s(libPrivs.rows[0], 'AUTHORIZATION_LIST'));
  const disabled = u.status === '*DISABLED';
  const allowed = objVerdict.allowed && libVerdict.allowed && !disabled;

  const fixes: { label: string; command: string; args: unknown[] }[] = [];
  if (!libVerdict.allowed) { fixes.push({ label: `Grant *USE on library ${obj.library}…`, command: 'vanthrex.grantAuthority', args: [grantCommand('QSYS', obj.library, '*LIB', user, '*USE')] }); }
  if (!objVerdict.allowed) { fixes.push({ label: `Grant ${n.grant} on ${obj.name}…`, command: 'vanthrex.grantAuthority', args: [grantCommand(obj.library, obj.name, type, user, n.grant)] }); }

  const owner = s(rows[0], 'OWNER');
  showReport('authority', {
    title: `${allowed ? '✔' : '✘'} ${user} → ${obj.library}/${obj.name}`,
    subtitle: allowed
      ? `${user} can ${n.label.split(' (')[0].toLowerCase()}: ${objVerdict.explanation}`
      : disabled ? `${user} is disabled, so it cannot sign on at all.`
        : `${user} cannot ${n.label.split(' (')[0].toLowerCase()}. ${!libVerdict.allowed ? `It has no *EXECUTE authority on library ${obj.library}. ` : ''}${!objVerdict.allowed ? `${objVerdict.explanation} Missing: ${objVerdict.missing.join(', ')}.` : ''}`,
    facts: [
      ['Object authority comes from', `${objVerdict.source} (${objVerdict.authority})`],
      ['Library authority comes from', `${libVerdict.source} (${libVerdict.authority})`],
      ['Owner', owner], ['Authorization list', autlName || '*NONE'],
      ['Group profiles', u.groups.join(', ') || '*NONE'], ['Special authorities', u.specialAuthorities || '*NONE'],
    ],
    actions: [...fixes, { label: 'Check another user', command: 'vanthrex.checkAuthority', args: [obj] }],
    tables: [{
      title: `Everyone with authority on ${obj.library}/${obj.name}`, filter: true,
      columns: ['User / group', 'Authority', ...FLAG_COLUMNS.map(([f]) => f)],
      rows: privs.map(p => [p.name, p.authority, ...FLAG_COLUMNS.map(([f]) => (p.flags?.[f] ? '✔' : ''))]),
      rowClass: privs.map(p => (p.name === user || u.groups.includes(p.name) ? 'different' : undefined)),
    }],
    note: 'Simplified IBM i authority checking: *ALLOBJ → the user\'s own authority → group profiles → authorization list → *PUBLIC. Adopted authority (USRPRF(*OWNER) programs) and field-level authority are not taken into account.',
  }, ALLOWED);
}

async function grantAuthority(manager: ConnectionManager, cmd: string): Promise<void> {
  const conn = manager.require();
  if (!/^GRTOBJAUT /.test(cmd)) { return; }
  const pick = await vscode.window.showWarningMessage(cmd, { modal: true, detail: 'This changes security on the system. You need *OBJMGT on the object (or *ALLOBJ) to grant authority.' }, 'Run', 'Copy Command');
  if (pick === 'Copy Command') { await vscode.env.clipboard.writeText(cmd); return; }
  if (pick !== 'Run') { return; }
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error(`${cmd} failed: ${(r.stderr || r.stdout).trim()}`); }
  vscode.window.showInformationMessage('Authority granted.');
}

// ================================================================ 3. Data queues & data areas

async function dataQueue(manager: ConnectionManager, o?: ObjArg): Promise<void> {
  const conn = manager.require();
  const obj = await askObject('Data queue', '*DTAQ', o);
  if (!obj) { return; }
  const [info, entries] = await progress(`Reading ${obj.library}/${obj.name}…`, () => Promise.all([
    conn.rows<Record<string, unknown>>(`SELECT * FROM QSYS2.DATA_QUEUE_INFO WHERE DATA_QUEUE_LIBRARY = ${sqlString(obj.library)} AND DATA_QUEUE_NAME = ${sqlString(obj.name)}`, 1),
    conn.rows<Record<string, unknown>>(
      `SELECT ORDINAL_POSITION AS N, VARCHAR_FORMAT(MESSAGE_ENQUEUE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS T, COALESCE(MESSAGE_DATA, '') AS D, ` +
      `COALESCE(KEY_DATA, '') AS K, COALESCE(SENDER_JOB_NAME, '') AS JOB, COALESCE(SENDER_CURRENT_USER, '') AS USR ` +
      `FROM TABLE(QSYS2.DATA_QUEUE_ENTRIES(DATA_QUEUE => ${sqlString(obj.name)}, DATA_QUEUE_LIBRARY => ${sqlString(obj.library)})) X ORDER BY ORDINAL_POSITION FETCH FIRST 500 ROWS ONLY`, 500),
  ]));
  const i = info[0];
  if (!i) { throw new Error(`Data queue ${obj.library}/${obj.name} was not found.`); }
  const keyed = /KEYED/i.test(s(i, 'SEQUENCE'));
  showReport(`dtaq`, {
    title: `Data queue ${obj.library}/${obj.name}`,
    subtitle: `${s(i, 'CURRENT_MESSAGES') || entries.length} entr(ies) waiting. Peeking does not remove them.`,
    facts: [['Type', s(i, 'DATA_QUEUE_TYPE')], ['Order', s(i, 'SEQUENCE')], ['Max entry length', s(i, 'MAXIMUM_MESSAGE_LENGTH')],
      ['Key length', s(i, 'KEY_LENGTH')], ['Entries / max', `${s(i, 'CURRENT_MESSAGES')} / ${s(i, 'MAXIMUM_MESSAGES')}`], ['Description', s(i, 'TEXT_DESCRIPTION')]],
    actions: [
      { label: 'Refresh', command: 'vanthrex.dataQueue', args: [obj] },
      { label: 'Send a test entry…', command: 'vanthrex.sendDataQueue', args: [obj, keyed] },
      { label: 'Clear all entries…', command: 'vanthrex.clearDataQueue', args: [obj] },
    ],
    tables: [{
      title: 'Entries (first 500)', filter: true,
      columns: ['#', 'Sent', ...(keyed ? ['Key'] : []), 'Data', 'Sender job', 'Sender user'],
      rows: entries.map(e => [s(e, 'N'), s(e, 'T'), ...(keyed ? [printable(s(e, 'K'), 60)] : []), printable(String(e.D ?? '')), s(e, 'JOB'), s(e, 'USR')]),
      empty: 'The data queue is empty.',
    }],
    note: 'Entries are shown as text in the job CCSID; binary or packed data appears as dots. Data queues on another system (DDM) can\'t be peeked.',
  }, ALLOWED);
}

async function sendDataQueue(manager: ConnectionManager, o: ObjArg, keyed: boolean): Promise<void> {
  const conn = manager.require();
  const key = keyed ? await vscode.window.showInputBox({ title: 'Key', prompt: 'Key data for the entry', ignoreFocusOut: true }) : '';
  if (key === undefined) { return; }
  const data = await vscode.window.showInputBox({ title: `Send to ${o.library}/${o.name}`, prompt: 'Entry data (text)', ignoreFocusOut: true });
  if (data === undefined) { return; }
  const ok = await vscode.window.showWarningMessage(`Send this entry to ${o.library}/${o.name}?`, { modal: true, detail: 'A program waiting on the queue will receive and process it.' }, 'Send');
  if (ok !== 'Send') { return; }
  await conn.sql(`CALL QSYS2.SEND_DATA_QUEUE(MESSAGE_DATA => ${sqlString(data)}, DATA_QUEUE => ${sqlString(o.name)}, DATA_QUEUE_LIBRARY => ${sqlString(o.library)}` +
    `${keyed ? `, KEY_DATA => ${sqlString(key)}` : ''})`, 1);
  vscode.window.showInformationMessage('Entry sent.');
  await dataQueue(manager, o);
}

async function clearDataQueue(manager: ConnectionManager, o: ObjArg): Promise<void> {
  const conn = manager.require();
  const ok = await vscode.window.showWarningMessage(`Remove ALL entries from ${o.library}/${o.name}?`, { modal: true, detail: 'This can\'t be undone.' }, 'Clear');
  if (ok !== 'Clear') { return; }
  await conn.sql(`CALL QSYS2.CLEAR_DATA_QUEUE(DATA_QUEUE => ${sqlString(o.name)}, DATA_QUEUE_LIBRARY => ${sqlString(o.library)})`, 1);
  vscode.window.showInformationMessage('Data queue cleared.');
  await dataQueue(manager, o);
}

async function readDataArea(conn: IbmiConnection, o: ObjArg): Promise<Record<string, unknown>> {
  const r = await conn.rows<Record<string, unknown>>(
    `SELECT DATA_AREA_TYPE, LENGTH, COALESCE(DECIMAL_POSITIONS, 0) AS DEC, COALESCE(DATA_AREA_VALUE, '') AS VAL, COALESCE(TEXT_DESCRIPTION, '') AS TXT ` +
    `FROM TABLE(QSYS2.DATA_AREA_INFO(DATA_AREA_NAME => ${sqlString(o.name)}, DATA_AREA_LIBRARY => ${sqlString(o.library)})) X`, 1);
  if (!r[0]) { throw new Error(`Data area ${o.library}/${o.name} was not found.`); }
  return r[0];
}

async function dataArea(manager: ConnectionManager, o?: ObjArg): Promise<void> {
  const conn = manager.require();
  const obj = await askObject('Data area', '*DTAARA', o);
  if (!obj) { return; }
  const r = await readDataArea(conn, obj);
  const val = String(r.VAL ?? '');
  const chunks: string[][] = [];
  for (let p = 0; p < Math.max(val.length, 1); p += 50) { chunks.push([`${p + 1}–${Math.min(p + 50, val.length)}`, printable(val.slice(p, p + 50))]); }
  showReport('dtaara', {
    title: `Data area ${obj.library}/${obj.name}`,
    subtitle: s(r, 'TXT'),
    facts: [['Type', s(r, 'DATA_AREA_TYPE')], ['Length', `${s(r, 'LENGTH')}${s(r, 'DATA_AREA_TYPE') === '*DEC' ? `, ${s(r, 'DEC')}` : ''}`], ['Value', printable(val.trimEnd(), 200)]],
    actions: [{ label: 'Refresh', command: 'vanthrex.dataArea', args: [obj] }, { label: 'Change value…', command: 'vanthrex.editDataArea', args: [obj] }],
    tables: s(r, 'DATA_AREA_TYPE') === '*CHAR' ? [{ title: 'Value by position (positions are 1-based, as in CHGDTAARA)', columns: ['Positions', 'Text'], rows: chunks }] : [],
  }, ALLOWED);
}

async function editDataArea(manager: ConnectionManager, o?: ObjArg): Promise<void> {
  const conn = manager.require();
  const obj = await askObject('Change data area', '*DTAARA', o);
  if (!obj) { return; }
  const r = await readDataArea(conn, obj);
  const info = { type: s(r, 'DATA_AREA_TYPE'), length: Number(r.LENGTH ?? 0), decimals: Number(r.DEC ?? 0) };
  const current = String(r.VAL ?? '');
  const value = await vscode.window.showInputBox({
    title: `Change ${obj.library}/${obj.name} (${info.type} ${info.length}${info.type === '*DEC' ? `,${info.decimals}` : ''})`,
    value: info.type === '*CHAR' ? current.trimEnd() : current.trim(), ignoreFocusOut: true,
    validateInput: v => { try { changeDataAreaCommand(obj.library, obj.name, info, v); return undefined; } catch (e) { return errorMessage(e); } },
  });
  if (value === undefined) { return; }
  const cmd = changeDataAreaCommand(obj.library, obj.name, info, value);
  const ok = await vscode.window.showWarningMessage(`Change ${obj.library}/${obj.name}?`, { modal: true, detail: `Old: ${current.trimEnd()}\nNew: ${value}\n\n${cmd}` }, 'Change');
  if (ok !== 'Change') { return; }
  const res = await conn.runCL(cmd);
  if (!res.ok) { throw new Error(`CHGDTAARA failed: ${(res.stderr || res.stdout).trim()}`); }
  vscode.window.showInformationMessage(`${obj.library}/${obj.name} changed.`);
  await dataArea(manager, obj);
}

// ================================================================ 4. PTF & system health

async function trySql<T = Record<string, unknown>>(conn: IbmiConnection, what: string, sql: string, max: number, skipped: string[]): Promise<T[] | undefined> {
  try { return await conn.rows<T>(sql, max); } catch (e) { skipped.push(`${what}: ${errorMessage(e).split('\n')[0]}`); return undefined; }
}

async function systemHealth(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const skipped: string[] = [];
  const [env, status, currency, groupsLocal, pending, certs, users] = await progress('Checking PTFs and system health (PTF currency asks IBM, this can take a minute)…', () => Promise.all([
    trySql(conn, 'Release', `SELECT OS_NAME, OS_VERSION, OS_RELEASE, HOST_NAME FROM SYSIBMADM.ENV_SYS_INFO`, 1, skipped),
    trySql(conn, 'Storage', `SELECT * FROM QSYS2.SYSTEM_STATUS_INFO`, 1, skipped),
    trySql(conn, 'PTF group currency (needs internet access from the IBM i)',
      `SELECT PTF_GROUP_ID AS ID, PTF_GROUP_TITLE AS TITLE, PTF_GROUP_LEVEL_INSTALLED AS INST, PTF_GROUP_LEVEL_AVAILABLE AS AVAIL, PTF_GROUP_CURRENCY AS CUR, ` +
      `VARCHAR_FORMAT(PTF_GROUP_LAST_UPDATED_BY_IBM, 'YYYY-MM-DD') AS IBMDATE FROM SYSTOOLS.GROUP_PTF_CURRENCY ORDER BY PTF_GROUP_CURRENCY DESC, PTF_GROUP_ID`, 200, skipped),
    trySql(conn, 'PTF groups', `SELECT PTF_GROUP_NAME AS ID, PTF_GROUP_DESCRIPTION AS TITLE, PTF_GROUP_LEVEL AS INST, PTF_GROUP_STATUS AS STATUS FROM QSYS2.GROUP_PTF_INFO WHERE PTF_GROUP_STATUS = 'INSTALLED' ORDER BY PTF_GROUP_NAME`, 500, skipped),
    trySql(conn, 'Pending PTFs', `SELECT PTF_IDENTIFIER AS PTF, PTF_PRODUCT_ID AS PROD, PTF_LOADED_STATUS AS LOADED, PTF_IPL_ACTION AS ACT, COALESCE(PTF_IPL_REQUIRED, '') AS IPL ` +
      `FROM QSYS2.PTF_INFO WHERE PTF_IPL_ACTION <> 'NONE' OR PTF_LOADED_STATUS = 'LOADED' ORDER BY PTF_PRODUCT_ID, PTF_IDENTIFIER`, 1000, skipped),
    trySql(conn, 'Certificates (needs *ALLOBJ and *SECADM, and a stashed *SYSTEM store password)',
      `SELECT CERTIFICATE_LABEL AS LABEL, VARCHAR_FORMAT(VALIDITY_END, 'YYYY-MM-DD') AS ENDS, DAYS(VALIDITY_END) - DAYS(CURRENT DATE) AS DAYS ` +
      `FROM TABLE(QSYS2.CERTIFICATE_INFO(CERTIFICATE_STORE_PASSWORD => '*NOPWD')) C WHERE VALIDITY_END < CURRENT TIMESTAMP + 60 DAYS ORDER BY VALIDITY_END`, 200, skipped),
    trySql(conn, 'User profiles', `SELECT SUM(CASE WHEN STATUS = '*DISABLED' THEN 1 ELSE 0 END) AS DISABLED, ` +
      `SUM(CASE WHEN STATUS = '*ENABLED' AND DATE_PASSWORD_EXPIRES < CURRENT TIMESTAMP + 7 DAYS AND DATE_PASSWORD_EXPIRES > CURRENT TIMESTAMP THEN 1 ELSE 0 END) AS EXPIRING ` +
      `FROM QSYS2.USER_INFO_BASIC`, 1, skipped),
  ]));
  const defaults = await trySql(conn, 'Default passwords (needs *ALLOBJ and *SECADM)',
    `SELECT COUNT(*) AS N FROM QSYS2.USER_INFO WHERE STATUS = '*ENABLED' AND USER_DEFAULT_PASSWORD = 'YES'`, 1, skipped);
  const st = status?.[0];
  const aspNum = st && st.SYSTEM_ASP_USED !== undefined ? Number(st.SYSTEM_ASP_USED) : undefined;
  const groups = (currency ?? []).map(g => ({ id: s(g, 'ID'), title: s(g, 'TITLE'), installed: Number(g.INST ?? 0), available: Number(g.AVAIL ?? 0), currency: s(g, 'CUR') }));
  const findings = healthFindings({
    aspUsedPercent: aspNum !== undefined && !isNaN(aspNum) ? aspNum : undefined,
    groups: currency ? groups : undefined,
    pendingPtfs: pending?.map(p => ({ ptf: s(p, 'PTF'), product: s(p, 'PROD'), action: s(p, 'ACT'), ipl: s(p, 'IPL') })),
    expiringCerts: certs?.map(c => ({ label: s(c, 'LABEL'), ends: s(c, 'ENDS'), days: Number(c.DAYS ?? 0) })),
    disabledProfiles: users?.[0] ? Number(users[0].DISABLED ?? 0) : undefined,
    expiringPasswords: users?.[0] ? Number(users[0].EXPIRING ?? 0) : undefined,
    defaultPasswords: defaults?.[0] ? Number(defaults[0].N ?? 0) : undefined,
  });
  const e = env?.[0];
  const bad = findings.filter(f => f.level === 'bad').length; const warn = findings.filter(f => f.level === 'warn').length;
  const report: Report = {
    title: `System health — ${conn.profile.name}`,
    subtitle: bad ? `${bad} problem(s) and ${warn} warning(s) need attention.` : warn ? `${warn} warning(s), nothing critical.` : 'Everything checked looks fine.',
    facts: [
      ['Release', e ? `${s(e, 'OS_NAME')} ${s(e, 'OS_VERSION')}.${s(e, 'OS_RELEASE')}` : ''],
      ['System ASP used', aspNum !== undefined && !isNaN(aspNum) ? `${aspNum.toFixed(1)} %` : ''],
      ['System ASP size', st?.SYSTEM_ASP_STORAGE ? `${Math.round(Number(st.SYSTEM_ASP_STORAGE) / 1024)} GB` : ''],
      ['Active jobs', s(st, 'TOTAL_JOBS_IN_SYSTEM') || s(st, 'ACTIVE_JOBS_IN_SYSTEM')],
    ],
    actions: [{ label: 'Refresh', command: 'vanthrex.systemHealth' }],
    tables: [
      { title: 'Findings (worst first)', columns: ['', 'Area', 'Finding', 'What to do'],
        rows: findings.map(f => [f.level === 'bad' ? '✘' : f.level === 'warn' ? '!' : '✔', f.area, f.text, f.action ?? '']),
        rowClass: findings.map(f => (f.level === 'bad' ? 'bad' : f.level === 'warn' ? 'different' : undefined)) },
      currency
        ? { title: 'PTF groups compared with IBM', filter: true, columns: ['Group', 'Title', 'Installed', 'Available', 'Status', 'IBM updated'],
          rows: currency.map(g => [s(g, 'ID'), s(g, 'TITLE'), s(g, 'INST'), s(g, 'AVAIL'), s(g, 'CUR'), s(g, 'IBMDATE')]),
          rowClass: currency.map(g => (/UPDATE AVAILABLE/i.test(s(g, 'CUR')) ? 'different' : undefined)) }
        : { title: 'Installed PTF groups (IBM comparison not available)', filter: true, columns: ['Group', 'Description', 'Level'],
          rows: (groupsLocal ?? []).map(g => [s(g, 'ID'), s(g, 'TITLE'), s(g, 'INST')]), empty: 'Not available.' },
      { title: 'PTFs waiting for an IPL or not applied', filter: true, columns: ['PTF', 'Product', 'Loaded status', 'IPL action', 'IPL required'],
        rows: (pending ?? []).map(p => [s(p, 'PTF'), s(p, 'PROD'), s(p, 'LOADED'), s(p, 'ACT'), s(p, 'IPL')]), empty: 'None.' },
      ...(certs?.length ? [{ title: 'Certificates expiring within 60 days', columns: ['Label', 'Expires', 'Days left'],
        rows: certs.map(c => [s(c, 'LABEL'), s(c, 'ENDS'), s(c, 'DAYS')]) }] : []),
    ],
    note: (skipped.length ? `Not checked: ${skipped.join(' · ')}. ` : '') +
      'PTF currency comes from SYSTOOLS.GROUP_PTF_CURRENCY, which downloads IBM\'s current PTF group levels over the internet. Nothing is changed on the system.',
  };
  showReport('health', report, ALLOWED);
}

// ================================================================ registration

export function registerAdmin(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const obj = (n: unknown): ObjArg | undefined => {
    const o = n as Partial<ObjArg> | undefined;
    return o && typeof o === 'object' && o.library && o.name ? { library: o.library, name: o.name, type: o.type } : undefined;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.journalExplorer', guard((n?: unknown, rrn?: number) => journalExplorer(manager, obj(n), typeof rrn === 'number' && rrn > 0 ? rrn : undefined))),
    vscode.commands.registerCommand('vanthrex.checkAuthority', guard((n?: unknown) => checkAuthority(manager, obj(n)))),
    vscode.commands.registerCommand('vanthrex.grantAuthority', guard((cmd: string) => grantAuthority(manager, String(cmd ?? '')))),
    vscode.commands.registerCommand('vanthrex.dataQueue', guard((n?: unknown) => dataQueue(manager, obj(n)))),
    vscode.commands.registerCommand('vanthrex.sendDataQueue', guard((n: ObjArg, keyed: boolean) => sendDataQueue(manager, n, !!keyed))),
    vscode.commands.registerCommand('vanthrex.clearDataQueue', guard((n: ObjArg) => clearDataQueue(manager, n))),
    vscode.commands.registerCommand('vanthrex.dataArea', guard((n?: unknown) => dataArea(manager, obj(n)))),
    vscode.commands.registerCommand('vanthrex.editDataArea', guard((n?: unknown) => editDataArea(manager, obj(n)))),
    vscode.commands.registerCommand('vanthrex.systemHealth', guard(() => systemHealth(manager))),
  );
}
