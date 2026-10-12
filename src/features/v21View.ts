import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { assertSystemName, clString, sqlString } from '../core/util';
import {
  ChangeItem, TEMPLATES, Template, addBnddirEntryCommand, bulkAuthorityCommand, changeReportMarkdown, chgobjownCommand, matchesGeneric, removeBnddirEntryCommand,
  renderTemplate, rtvbndsrcCommand, syncStatus, unprotectedExitPoints, NETWORK_EXIT_POINTS,
} from '../core/v21';
import { memberUri } from './fileSystems';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
type Obj = { library: string; name: string; type?: string };
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
const ALLOWED = new Set(['vanthrex.outOfSync', 'vanthrex.v21.openCompile', 'vanthrex.codeMetrics.open', 'vanthrex.changeReport', 'vanthrex.changeReport.copy',
  'vanthrex.bindingDirectory', 'vanthrex.bnddir.add', 'vanthrex.bnddir.remove', 'vanthrex.rowLocks', 'vanthrex.rowLocks.row', 'vanthrex.activeSql', 'vanthrex.activeSql.cancel',
  'vanthrex.exitPoints', 'vanthrex.jobLog', 'vanthrex.securityCenter']);

async function askLib(title: string, x?: unknown, conn?: IbmiConnection): Promise<string | undefined> {
  const lib = typeof x === 'string' ? x : (x as { library?: string } | undefined)?.library;
  const v = lib ?? (await vscode.window.showInputBox({ title, prompt: vscode.l10n.t('Library'), value: conn?.profile.currentLibrary ?? '', ignoreFocusOut: true }));
  return v ? assertSystemName(v, 'library') : undefined;
}

async function run(conn: IbmiConnection, cmd: string, warn = ''): Promise<boolean> {
  const p = await vscode.window.showWarningMessage(cmd, { modal: true, detail: warn || undefined }, vscode.l10n.t('Run'));
  if (p !== vscode.l10n.t('Run')) { return false; }
  const r = await progress(cmd.split(' ')[0], () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  return true;
}

// ================================================================ 1. objects out of sync with their source

async function outOfSync(manager: ConnectionManager, x?: unknown): Promise<void> {
  const conn = manager.require();
  const lib = await askLib(vscode.l10n.t('Objects out of sync with their source'), x, conn);
  if (!lib) { return; }
  const rows = await progress(vscode.l10n.t('Comparing objects of {0} with their source…', lib), () => conn.rows<Row>(
    `SELECT O.OBJNAME AS N, O.OBJTYPE AS T, COALESCE(O.OBJATTRIBUTE, '') AS A, COALESCE(O.SOURCE_LIBRARY, '') AS SL, COALESCE(O.SOURCE_FILE, '') AS SF, COALESCE(O.SOURCE_MEMBER, '') AS SM, ` +
    `VARCHAR_FORMAT(O.SOURCE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS COMPILED_FROM, VARCHAR_FORMAT(O.CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS OBJCHG, ` +
    `VARCHAR_FORMAT(P.LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS MBRCHG, P.SYSTEM_TABLE_MEMBER AS PM, COALESCE(P.SOURCE_TYPE, '') AS ST ` +
    `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*PGM *SRVPGM *MODULE *CMD *FILE')) O ` +
    `LEFT JOIN QSYS2.SYSPARTITIONSTAT P ON P.SYSTEM_TABLE_SCHEMA = O.SOURCE_LIBRARY AND P.SYSTEM_TABLE_NAME = O.SOURCE_FILE AND P.SYSTEM_TABLE_MEMBER = O.SOURCE_MEMBER ` +
    `WHERE NOT (O.OBJTYPE = '*FILE' AND O.SOURCE_FILE IS NULL) ORDER BY O.OBJNAME`, 20000));
  const items = rows.map(r => ({ r, status: syncStatus({ sourceFile: s(r, 'SF'), sourceMember: s(r, 'SM'), compiledFrom: s(r, 'COMPILED_FROM'), memberChanged: s(r, 'MBRCHG'), memberExists: !!s(r, 'PM') }) }));
  const bad = items.filter(i => i.status === 'source newer' || i.status === 'source missing');
  const order: Record<string, number> = { 'source newer': 0, 'source missing': 1, 'no source info': 2, 'in sync': 3 };
  items.sort((a, b) => order[a.status] - order[b.status]);
  showReport('outOfSync', {
    title: vscode.l10n.t('Source vs objects — {0}', lib),
    subtitle: vscode.l10n.t('{0} object(s) whose source changed after the last compile, {1} whose source member is gone, {2} in sync. Click one to open its source.', items.filter(i => i.status === 'source newer').length, items.filter(i => i.status === 'source missing').length, items.filter(i => i.status === 'in sync').length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.outOfSync', args: [lib] }],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: ['Object', 'Type', 'Attribute', 'Status', 'Source', 'Source at compile', 'Source now', 'Object changed'],
      rows: items.map(({ r, status }) => [s(r, 'N'), s(r, 'T'), s(r, 'A'), status, s(r, 'SF') ? `${s(r, 'SL')}/${s(r, 'SF')}(${s(r, 'SM')})` : '', s(r, 'COMPILED_FROM'), s(r, 'MBRCHG'), s(r, 'OBJCHG')]),
      rowActions: items.map(({ r }) => (s(r, 'PM') ? { label: vscode.l10n.t('Open the source'), command: 'vanthrex.codeMetrics.open', args: [s(r, 'SL'), s(r, 'SF'), s(r, 'SM'), s(r, 'ST') || 'mbr'] } : undefined)),
      rowClass: items.map(i => (i.status === 'source newer' ? 'different' : i.status === 'source missing' ? 'bad' : i.status === 'in sync' ? 'dim' : undefined)) }],
    note: bad.length ? 'Objects marked "source newer" run code that is not what the source shows — recompile them (right-click the source file → Compile Changed Members) or check who changed the source. "Source missing" objects cannot be rebuilt from source.' : 'Every object with source information matches its source.',
  }, ALLOWED);
}

// ================================================================ 2. change report

let lastReport = '';

async function changeReport(manager: ConnectionManager, x?: unknown): Promise<void> {
  const conn = manager.require();
  const lib = await askLib(vscode.l10n.t('What changed in a library'), x, conn);
  if (!lib) { return; }
  const days = Number(await vscode.window.showQuickPick(['1', '7', '14', '30', '90'], { title: vscode.l10n.t('Changes of the last how many days?') }) ?? 0);
  if (!days) { return; }
  const [objs, mbrs] = await progress(vscode.l10n.t('Reading changes in {0}…', lib), () => Promise.all([
    conn.rows<Row>(`SELECT OBJNAME AS N, OBJTYPE AS T, VARCHAR_FORMAT(CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS C, COALESCE(OBJTEXT, '') AS X FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*ALL')) O ` +
      `WHERE CHANGE_TIMESTAMP > CURRENT TIMESTAMP - ${days} DAYS AND NOT (OBJTYPE = '*FILE' AND OBJATTRIBUTE = 'PF' AND SOURCE_FILE IS NULL AND OBJTEXT LIKE '%source%') ORDER BY CHANGE_TIMESTAMP DESC`, 20000),
    conn.rows<Row>(`SELECT P.SYSTEM_TABLE_NAME AS F, P.SYSTEM_TABLE_MEMBER AS M, COALESCE(P.SOURCE_TYPE, '') AS T, VARCHAR_FORMAT(P.LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS C, COALESCE(P.PARTITION_TEXT, '') AS X ` +
      `FROM QSYS2.SYSPARTITIONSTAT P JOIN QSYS2.SYSTABLES T ON T.SYSTEM_TABLE_SCHEMA = P.SYSTEM_TABLE_SCHEMA AND T.SYSTEM_TABLE_NAME = P.SYSTEM_TABLE_NAME AND T.FILE_TYPE = 'S' ` +
      `WHERE P.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND P.LAST_SOURCE_UPDATE_TIMESTAMP > CURRENT TIMESTAMP - ${days} DAYS ORDER BY P.LAST_SOURCE_UPDATE_TIMESTAMP DESC`, 20000),
  ]));
  const items: ChangeItem[] = [
    ...mbrs.map(r => ({ kind: 'member' as const, name: s(r, 'M'), type: s(r, 'T'), where: s(r, 'F'), changed: s(r, 'C'), text: s(r, 'X') })),
    ...objs.map(r => ({ kind: 'object' as const, name: s(r, 'N'), type: s(r, 'T'), where: lib, changed: s(r, 'C'), text: s(r, 'X') })),
  ];
  lastReport = changeReportMarkdown(lib, days, items);
  showReport('changeReport', {
    title: vscode.l10n.t('Changes in {0} — last {1} day(s)', lib, days), subtitle: vscode.l10n.t('{0} source member(s) and {1} object(s) changed. Use it for release notes or a code review.', mbrs.length, objs.length),
    actions: [{ label: vscode.l10n.t('Copy as Markdown (release notes)'), command: 'vanthrex.changeReport.copy' }, { label: vscode.l10n.t('Another period'), command: 'vanthrex.changeReport', args: [lib] }],
    tables: [
      { title: vscode.l10n.t('Source members'), filter: true, columns: ['Member', 'Type', 'Source file', 'Changed', 'Description'], rows: mbrs.map(r => [s(r, 'M'), s(r, 'T'), s(r, 'F'), s(r, 'C'), s(r, 'X')]),
        rowActions: mbrs.map(r => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.codeMetrics.open', args: [lib, s(r, 'F'), s(r, 'M'), s(r, 'T') || 'mbr'] })), empty: vscode.l10n.t('None.') },
      { title: vscode.l10n.t('Objects'), filter: true, columns: ['Object', 'Type', 'Changed', 'Description'], rows: objs.map(r => [s(r, 'N'), s(r, 'T'), s(r, 'C'), s(r, 'X')]), empty: vscode.l10n.t('None.') },
    ],
  }, ALLOWED);
}

// ================================================================ 3. new member from a template

async function newFromTemplate(manager: ConnectionManager, n?: { library?: string; file?: string }): Promise<void> {
  const conn = manager.require();
  let lib = n?.library; let file = n?.file;
  if (!lib || !file) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('New member from a template'), prompt: 'LIBRARY/SOURCEFILE', ignoreFocusOut: true });
    if (!v?.includes('/')) { return; }
    [lib, file] = v.trim().toUpperCase().split('/');
  }
  const own = vscode.workspace.getConfiguration('vanthrex').get<Template[]>('templates', []);
  const pick = await vscode.window.showQuickPick([...own, ...TEMPLATES].map(t => ({ label: t.name, description: t.type, detail: t.description, t })), { title: vscode.l10n.t('Template'), matchOnDetail: true });
  if (!pick) { return; }
  const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('Member name'), ignoreFocusOut: true, validateInput: v => (/^[A-Za-z$#@][\w$#@]{0,9}$/.test(v.trim()) ? undefined : vscode.l10n.t('1–10 characters, a valid name')) }))?.trim().toUpperCase();
  if (!name) { return; }
  const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Description'), ignoreFocusOut: true });
  if (text === undefined) { return; }
  const r = await conn.runCL(`ADDPFM FILE(${lib}/${file}) MBR(${name}) SRCTYPE(${pick.t.type}) TEXT(${clString(text || ' ')})`);
  if (!r.ok) { throw new Error(vscode.l10n.t('Could not add member {0}: {1}', name, (r.stderr || r.stdout).trim())); }
  await conn.writeMember(lib, file, name, renderTemplate(pick.t.text, { name, text, user: conn.user }));
  await vscode.window.showTextDocument(memberUri(lib, file, name, pick.t.type.toLowerCase()));
  void vscode.commands.executeCommand('vanthrex.refreshLibraries');
}

// ================================================================ 4. binder source & binding directories

async function retrieveBinderSource(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  if (!o?.library || !o.name) { throw new Error(vscode.l10n.t('Right-click a service program in the Libraries view.')); }
  const target = (await vscode.window.showInputBox({ title: vscode.l10n.t('Binder source for {0} — write it into', o.name), prompt: 'LIBRARY/SOURCEFILE', value: `${o.library}/QSRVSRC`, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!target?.includes('/')) { return; }
  const [sl, sf] = target.split('/');
  const exists = await conn.rows<Row>(`SELECT 1 AS X FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(sl)} AND SYSTEM_TABLE_NAME = ${sqlString(sf)}`, 1).catch(() => []);
  if (!exists.length) {
    const r = await conn.runCL(`CRTSRCPF FILE(${sl}/${sf}) RCDLEN(112) TEXT('Binder source')`);
    if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
  }
  const r = await progress(vscode.l10n.t('Retrieving binder source…'), () => conn.runCL(rtvbndsrcCommand(o.library, o.name, sl, sf, o.name)));
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
  await vscode.window.showTextDocument(memberUri(sl, sf, o.name, 'bnd'));
  vscode.window.showInformationMessage(vscode.l10n.t('Binder source of {0} written to {1}/{2}({0}). Add new exports at the end to keep programs working without a rebind.', o.name, sl, sf));
}

async function bindingDirectory(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  if (!o?.library || !o.name) { throw new Error(vscode.l10n.t('Right-click a binding directory in the Libraries view.')); }
  const rows = await conn.rows<Row>(`SELECT * FROM QSYS2.BINDING_DIRECTORY_INFO WHERE BINDING_DIRECTORY_LIBRARY = ${sqlString(o.library)} AND BINDING_DIRECTORY = ${sqlString(o.name)}`, 5000);
  const bd = `${o.library}/${o.name}`;
  showReport('bnddir', {
    title: vscode.l10n.t('Binding directory {0}', bd), subtitle: vscode.l10n.t('{0} entr(ies). Click one to remove it.', rows.length),
    actions: [{ label: vscode.l10n.t('Add an entry…'), command: 'vanthrex.bnddir.add', args: [o] }, { label: vscode.l10n.t('Refresh'), command: 'vanthrex.bindingDirectory', args: [o] }],
    tables: [{ title: vscode.l10n.t('Entries'), filter: true, columns: ['Library', 'Object', 'Type', 'Activation', 'Created'],
      rows: rows.map(r => [s(r, 'ENTRY_LIBRARY'), s(r, 'ENTRY'), s(r, 'ENTRY_TYPE'), s(r, 'ENTRY_ACTIVATION'), s(r, 'ENTRY_CREATE_TIMESTAMP').slice(0, 16)]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Remove…'), command: 'vanthrex.bnddir.remove', args: [o, s(r, 'ENTRY_LIBRARY'), s(r, 'ENTRY'), s(r, 'ENTRY_TYPE')] })), empty: vscode.l10n.t('Empty.') }],
  }, ALLOWED);
}

// ================================================================ 5. row locks

async function rowLocks(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  if (!o?.library || !o.name) { throw new Error(vscode.l10n.t('Right-click a file in the Libraries view.')); }
  const rows = await progress(vscode.l10n.t('Reading row locks…'), () => conn.rows<Row>(
    `SELECT SYSTEM_TABLE_MEMBER AS MBR, RELATIVE_RECORD_NUMBER AS RRN, LOCK_STATE AS STATE, LOCK_STATUS AS STATUS, COALESCE(LOCK_TYPE, '') AS TYPE, JOB_NAME AS JOB ` +
    `FROM QSYS2.RECORD_LOCK_INFO WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(o.library)} AND SYSTEM_TABLE_NAME = ${sqlString(o.name)} ORDER BY RELATIVE_RECORD_NUMBER`, 2000));
  const sample = await Promise.all(rows.slice(0, 15).map(r => conn.rows<Row>(`SELECT * FROM ${o.library}/${o.name} X WHERE RRN(X) = ${Number(r.RRN)}`, 1).catch(() => [])));
  const preview = (i: number) => { const x = sample[i]?.[0]; return x ? Object.values(x).slice(0, 4).map(v => String(v ?? '').trim()).join(' · ') : ''; };
  showReport('rowLocks', {
    title: vscode.l10n.t('Row locks — {0}/{1}', o.library, o.name), subtitle: rows.length ? `${rows.length} row lock(s), held or waited for by ${new Set(rows.map(r => s(r, 'JOB'))).size} job(s). Click one for its job.` : 'No row is locked right now.',
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.rowLocks', args: [o] }],
    tables: [{ title: vscode.l10n.t('Locked rows'), filter: true, columns: ['RRN', 'Member', 'Lock', 'Status', 'Job', 'Row (first columns)'],
      rows: rows.map((r, i) => [s(r, 'RRN'), s(r, 'MBR'), s(r, 'STATE'), s(r, 'STATUS'), s(r, 'JOB'), preview(i)]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Job options…'), command: 'vanthrex.rowLocks.row', args: [s(r, 'JOB')] })),
      rowClass: rows.map(r => (/WAIT/i.test(s(r, 'STATUS')) ? 'bad' : undefined)), empty: vscode.l10n.t('None.') }],
    note: vscode.l10n.t('A job waiting for a row (status WAITING) is blocked by the job that holds it. Ending a job releases its locks but rolls back its uncommitted work.'),
  }, ALLOWED);
}

// ================================================================ 6. running SQL statements

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

// ================================================================ 7. exit points

async function exitPoints(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const progs = await progress(vscode.l10n.t('Reading exit programs…'), () => conn.rows<Row>(
    `SELECT EXIT_POINT_NAME AS P, EXIT_POINT_FORMAT AS F, EXIT_PROGRAM_NUMBER AS N, EXIT_PROGRAM_LIBRARY AS L, EXIT_PROGRAM AS PGM, COALESCE(EXIT_PROGRAM_DESCRIPTION, '') AS D FROM QSYS2.EXIT_PROGRAM_INFO ORDER BY 1, 3`, 5000));
  const open = unprotectedExitPoints(progs.map(p => ({ point: s(p, 'P') })));
  showReport('exitPoints', {
    title: vscode.l10n.t('Exit points and exit programs'), subtitle: vscode.l10n.t('{0} exit program(s) registered. {1} of {2} network exit points have none — requests through them are not checked by any exit program.', progs.length, open.length, Object.keys(NETWORK_EXIT_POINTS).length),
    actions: [{ label: vscode.l10n.t('Security Admin'), command: 'vanthrex.securityCenter' }],
    tables: [
      { title: vscode.l10n.t('Network exit points without an exit program'), columns: ['Exit point', 'What goes through it'], rows: open.map(o => [o.point, o.what]), rowClass: open.map(() => 'different'), empty: vscode.l10n.t('Every listed network exit point has an exit program.') },
      { title: vscode.l10n.t('Registered exit programs'), filter: true, columns: ['Exit point', 'Format', '#', 'Program', 'Description'], rows: progs.map(p => [s(p, 'P'), s(p, 'F'), s(p, 'N'), `${s(p, 'L')}/${s(p, 'PGM')}`, s(p, 'D') || NETWORK_EXIT_POINTS[s(p, 'P')] || '']) },
    ],
    note: vscode.l10n.t('Exit programs let you log or refuse ODBC, FTP, remote command and file-server requests. Registering them (ADDEXITPGM / WRKREGINF) needs *ALLOBJ and *SECADM; Vanthrex only reports them.'),
  }, ALLOWED);
}

// ================================================================ 8. bulk ownership & authority

async function bulkOwnerAuthority(manager: ConnectionManager, x?: unknown): Promise<void> {
  const conn = manager.require();
  const lib = await askLib(vscode.l10n.t('Change owner or authority of many objects'), x, conn);
  if (!lib) { return; }
  const what = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(person) Change the owner'), v: 'own' }, { label: vscode.l10n.t('$(add) Grant authority'), v: 'grt' }, { label: vscode.l10n.t('$(remove) Revoke authority'), v: 'rvk' },
  ], { title: vscode.l10n.t('Objects of {0}', lib) });
  if (!what) { return; }
  const pattern = (await vscode.window.showInputBox({ title: vscode.l10n.t('Which objects?'), prompt: vscode.l10n.t('A name, a generic name like ORD* or *ALL'), value: '*ALL', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!pattern) { return; }
  const type = (await vscode.window.showInputBox({ title: vscode.l10n.t('Object type'), value: '*ALL', prompt: '*ALL, *PGM, *FILE, *SRVPGM, *DTAARA…', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!type) { return; }
  if (what.v === 'own') {
    const owner = (await vscode.window.showInputBox({ title: vscode.l10n.t('New owner'), ignoreFocusOut: true }))?.trim().toUpperCase();
    if (!owner) { return; }
    const objs = (await conn.rows<Row>(`SELECT OBJNAME AS N, OBJTYPE AS T, OBJOWNER AS O FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, ${sqlString(type)})) X ORDER BY OBJNAME`, 50000))
      .filter(r => matchesGeneric(s(r, 'N'), pattern) && s(r, 'O') !== owner);
    if (!objs.length) { vscode.window.showInformationMessage(vscode.l10n.t('No object to change — they are already owned by {0}, or none match.', owner)); return; }
    const revoke = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Keep the old owner\'s authority'), v: false }, { label: vscode.l10n.t('Revoke the old owner\'s authority'), v: true }], { title: vscode.l10n.t('Old owner') });
    if (!revoke) { return; }
    const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Give {0} object(s) of {1} to {2}?', objs.length, lib, owner), { modal: true, detail: objs.slice(0, 20).map(r => `${s(r, 'N')} ${s(r, 'T')} (${s(r, 'O')})`).join('\n') + (objs.length > 20 ? '\n…' : '') }, vscode.l10n.t('Change Owner'));
    if (ok !== vscode.l10n.t('Change Owner')) { return; }
    const fails: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Changing owners…'), cancellable: true }, async (p, token) => {
      for (const r of objs) {
        if (token.isCancellationRequested) { break; }
        p.report({ message: s(r, 'N'), increment: 100 / objs.length });
        const res = await conn.runCL(chgobjownCommand(lib, s(r, 'N'), s(r, 'T'), owner, revoke.v));
        if (!res.ok) { fails.push(s(r, 'N')); }
      }
    });
    vscode.window.showInformationMessage(vscode.l10n.t('{0} object(s) changed.{1}', objs.length - fails.length, fails.length ? ` ${vscode.l10n.t('Failed: {0}', fails.slice(0, 20).join(', '))}` : ''));
    return;
  }
  const user = (await vscode.window.showInputBox({ title: vscode.l10n.t('User, group or *PUBLIC'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!user) { return; }
  const aut = await vscode.window.showQuickPick(['*USE', '*CHANGE', '*ALL', '*EXCLUDE', '*OBJOPR', '*READ', '*ADD', '*UPD', '*DLT', '*EXECUTE'], { title: vscode.l10n.t('Authority') });
  if (!aut) { return; }
  await run(conn, bulkAuthorityCommand(what.v === 'grt', lib, pattern, type, user, aut), vscode.l10n.t('One command covers every matching object.'));
}

// ================================================================ registration

export function registerV21(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const obj = (x: unknown): Obj | undefined => { const o = x as Partial<Obj> | undefined; return o?.library && o?.name ? { library: o.library, name: o.name, type: o.type } : undefined; };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.outOfSync', guard((x?: unknown) => outOfSync(manager, x))),
    vscode.commands.registerCommand('vanthrex.changeReport', guard((x?: unknown) => changeReport(manager, x))),
    vscode.commands.registerCommand('vanthrex.changeReport.copy', guard(async () => { await vscode.env.clipboard.writeText(lastReport); vscode.window.showInformationMessage(vscode.l10n.t('Release notes copied as Markdown.')); })),
    vscode.commands.registerCommand('vanthrex.newFromTemplate', guard((n?: { library?: string; file?: string }) => newFromTemplate(manager, n))),
    vscode.commands.registerCommand('vanthrex.retrieveBinderSource', guard((x?: unknown) => retrieveBinderSource(manager, obj(x)))),
    vscode.commands.registerCommand('vanthrex.bindingDirectory', guard((x?: unknown) => bindingDirectory(manager, obj(x)))),
    vscode.commands.registerCommand('vanthrex.bnddir.add', guard(async (o: Obj) => {
      const conn = manager.require();
      const v = (await vscode.window.showInputBox({ title: vscode.l10n.t('Add to {0}/{1}', o.library, o.name), prompt: 'LIBRARY/OBJECT or *LIBL/OBJECT', ignoreFocusOut: true }))?.trim().toUpperCase();
      if (!v) { return; }
      const [l, n] = v.includes('/') ? v.split('/') : ['*LIBL', v];
      const t = await vscode.window.showQuickPick(['*SRVPGM', '*MODULE'], { title: vscode.l10n.t('Object type') });
      if (t && await run(conn, addBnddirEntryCommand(`${o.library}/${o.name}`, l, n, t as '*SRVPGM' | '*MODULE'))) { await bindingDirectory(manager, o); }
    })),
    vscode.commands.registerCommand('vanthrex.bnddir.remove', guard(async (o: Obj, l: string, n: string, t: string) => {
      if (await run(manager.require(), removeBnddirEntryCommand(`${o.library}/${o.name}`, l, n, t), vscode.l10n.t('Programs created later will no longer bind to it through this directory.'))) { await bindingDirectory(manager, o); }
    })),
    vscode.commands.registerCommand('vanthrex.rowLocks', guard((x?: unknown) => rowLocks(manager, obj(x)))),
    vscode.commands.registerCommand('vanthrex.rowLocks.row', guard(async (job: string) => {
      const p = await vscode.window.showQuickPick([{ label: vscode.l10n.t('$(output) Job log'), v: 'log' }, { label: vscode.l10n.t('$(debug-stop) End the job (controlled)…'), v: 'end' }], { title: job });
      if (p?.v === 'log') { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); }
      if (p?.v === 'end') { await run(manager.require(), `ENDJOB JOB(${job}) OPTION(*CNTRLD) DELAY(30)`, vscode.l10n.t('Its uncommitted changes are rolled back and its locks released.')); }
    })),
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
    vscode.commands.registerCommand('vanthrex.exitPoints', guard(() => exitPoints(manager))),
    vscode.commands.registerCommand('vanthrex.bulkOwnerAuthority', guard((x?: unknown) => bulkOwnerAuthority(manager, x))),
  );
}
