// System audits: programs that adopt authority (and whose), the job schedule laid out day by day, objects hidden by
// another of the same name earlier in the library list, and the NetServer file shares.
import * as vscode from 'vscode';
import { programFindings, scheduleRuns, shadowedObjects } from '../core/dataQuality';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { assertSystemName, sqlString } from '../core/util';
import { reportProgress, showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row, k: string) => String(r[k] ?? '').trim();
const ALLOWED = new Set(['vanthrex.programAudit', 'vanthrex.scheduleCalendar', 'vanthrex.shadowedObjects', 'vanthrex.netServerShares', 'vanthrex.objectInfo', 'vanthrex.checkAuthority', 'vanthrex.wrkJobSchedule']);

async function programAudit(manager: ConnectionManager, a?: unknown): Promise<void> {
  const n = a as { kind?: string; name?: string } | undefined;
  const given = n?.kind === 'library' ? n.name : typeof a === 'string' ? a : undefined;
  const v = given ?? await vscode.window.showInputBox({ title: vscode.l10n.t('Audit the programs of which library?'), value: manager.require().profile.currentLibrary ?? '' });
  if (!v?.trim()) { return; }
  const lib = assertSystemName(v.trim(), 'library');
  const conn = manager.require();
  const data = await reportProgress('programAudit', vscode.l10n.t('Reading the programs of {0}…', lib), async () => {
    const [rows, powerful, rel] = await Promise.all([
      conn.rows<Row>(`SELECT * FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} FETCH FIRST 20000 ROWS ONLY`, 20000),
      conn.rows<Row>("SELECT AUTHORIZATION_NAME AS U FROM QSYS2.USER_INFO WHERE SPECIAL_AUTHORITIES LIKE '%*ALLOBJ%'", 5000).catch(() => [] as Row[]),
      conn.rows<Row>('SELECT OS_VERSION AS V, OS_RELEASE AS R FROM SYSIBMADM.ENV_SYS_INFO', 1).catch(() => [] as Row[]),
    ]);
    return { rows, powerful: new Set(powerful.map(r => s(r, 'U'))), release: rel[0] ? `V${s(rel[0], 'V')}R${s(rel[0], 'R')}M0` : '' };
  });
  const f = programFindings(data.rows, data.powerful, data.release);
  const count = (l: string) => f.filter(x => x.level === l).length;
  showReport('programAudit', {
    title: vscode.l10n.t('Program attributes — {0}', lib),
    subtitle: vscode.l10n.t('{0} program(s) and service program(s): {1} high, {2} medium, {3} for information.', data.rows.length, count('high'), count('medium'), count('info')),
    facts: [[vscode.l10n.t('Adopt their owner'), data.rows.filter(r => s(r, 'USER_PROFILE') === '*OWNER').length], [vscode.l10n.t('Owners with *ALLOBJ'), [...new Set(data.rows.map(r => s(r, 'PROGRAM_OWNER')).filter(o => o === 'QSECOFR' || data.powerful.has(o)))].join(', ') || '—'],
      [vscode.l10n.t('System release'), data.release || '—']],
    actions: [{ label: vscode.l10n.t('Another library…'), command: 'vanthrex.programAudit' }],
    tables: [{ title: vscode.l10n.t('Findings'), filter: true, columns: ['Level', 'Program', 'Type', 'Finding', 'What to do'],
      rows: f.map(x => [x.level, x.program, x.type, x.finding, x.fix]),
      rowActions: f.map(x => ({ label: vscode.l10n.t('Authority'), command: 'vanthrex.checkAuthority', args: [{ library: x.library, name: x.program, type: x.type }] })),
      rowClass: f.map(x => (x.level === 'high' ? 'bad' : x.level === 'medium' ? 'different' : undefined)), empty: vscode.l10n.t('Nothing to report.') }],
    note: vscode.l10n.t('From QSYS2.PROGRAM_INFO. A program that adopts a powerful owner gives that power to every caller: check who can run it.'),
  }, ALLOWED);
}

async function scheduleCalendar(manager: ConnectionManager): Promise<void> {
  const days = vscode.workspace.getConfiguration('vanthrex').get<number>('scheduleDays', 7);
  const rows = await reportProgress('schedule', vscode.l10n.t('Reading the job schedule…'), () => manager.require().rows<Row>('SELECT * FROM QSYS2.SCHEDULED_JOB_INFO', 5000));
  const runs = scheduleRuns(rows, new Date(), days);
  const held = rows.filter(r => s(r, 'STATUS') && s(r, 'STATUS') !== 'SCHEDULED');
  const perDay = new Map<string, number>(); runs.forEach(r => perDay.set(r.day, (perDay.get(r.day) ?? 0) + 1));
  let prev = '';
  showReport('schedule', {
    title: vscode.l10n.t('Job schedule — next {0} days', days),
    subtitle: vscode.l10n.t('{0} run(s) of {1} entr(ies); {2} entr(ies) held or saved are not run.', runs.length, rows.length - held.length, held.length),
    facts: [...perDay.entries()].map(([d, c]) => [d, c] as [string, number]),
    actions: [{ label: vscode.l10n.t('Work with the job schedule'), command: 'vanthrex.wrkJobSchedule' }],
    tables: [
      { title: vscode.l10n.t('Runs'), filter: true, columns: ['Day', '', 'Time', 'Entry', 'Command', 'User', 'Frequency'],
        rows: runs.map(r => { const first = r.day !== prev; prev = r.day; return [first ? r.day : '', first ? r.weekday : '', r.time, r.entry, r.command, r.user, r.frequency]; }), empty: vscode.l10n.t('Nothing scheduled.') },
      ...(held.length ? [{ title: vscode.l10n.t('Held or saved (not run)'), columns: ['Entry', 'Status', 'Command'], rows: held.map(r => [s(r, 'SCHEDULED_JOB_ENTRY_NAME'), s(r, 'STATUS'), s(r, 'COMMAND_STRING')]), rowClass: held.map(() => 'different') }] : []),
    ],
    note: vscode.l10n.t('Computed from each entry\'s frequency, days and next submission date (vanthrex.scheduleDays). Holidays (calendar objects) are not applied.'),
  }, ALLOWED);
}

async function shadowed(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const res = await reportProgress('shadowed', vscode.l10n.t('Reading the library list…'), async () => {
    const libl = (await conn.rows<Row>("SELECT SCHEMA_NAME AS L, TYPE AS T FROM QSYS2.LIBRARY_LIST_INFO WHERE TYPE IN ('CURRENT', 'USER') ORDER BY ORDINAL_POSITION", 300)).map(r => s(r, 'L'));
    const objs: Row[] = [];
    for (const l of libl) {
      objs.push(...(await conn.rows<Row>(`SELECT '${l.replace(/'/g, "''")}' AS L, OBJNAME AS N, OBJTYPE AS T FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(l)}, '*PGM *SRVPGM *FILE *CMD *DTAARA *MENU *MODULE')) O`, 50000).catch(() => [] as Row[])));
    }
    return { libl, list: shadowedObjects(objs, libl) };
  });
  showReport('shadowed', {
    title: vscode.l10n.t('Objects hidden in the library list'),
    subtitle: vscode.l10n.t('{0} object(s) exist in more than one library of the library list: the first one is used, the others are never reached — a common cause of "my change does nothing".', res.list.length),
    facts: [[vscode.l10n.t('Library list'), res.libl.join(' ')]],
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.shadowedObjects' }],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: ['Object', 'Type', 'Used from', 'Hidden in'],
      rows: res.list.map(x => [x.name, x.type, x.used, x.hidden.join(', ')]),
      rowActions: res.list.map(x => ({ label: vscode.l10n.t('Info'), command: 'vanthrex.objectInfo', args: [{ library: x.used, name: x.name, type: x.type }] })), empty: vscode.l10n.t('No object is hidden.') }],
    note: vscode.l10n.t('The library list of the SQL job of this connection (current library and user part).'),
  }, ALLOWED);
}

async function netShares(manager: ConnectionManager): Promise<void> {
  const rows = await reportProgress('netShares', vscode.l10n.t('Reading the NetServer shares…'), () => manager.require().rows<Row>('SELECT * FROM QSYS2.SERVER_SHARE_INFO', 2000));
  const risky = (r: Row) => /WRITE/i.test(s(r, 'PERMISSIONS')) && /^\/(QSYS\.LIB)?\/?$/i.test(s(r, 'PATH_NAME'));
  showReport('netShares', {
    title: vscode.l10n.t('NetServer file shares'),
    subtitle: vscode.l10n.t('{0} share(s). Shares of the root or of QSYS.LIB with write access are marked: anyone with a Windows drive mapped there can change system objects.', rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.netServerShares' }],
    tables: [{ title: vscode.l10n.t('Shares'), filter: true, columns: ['Share', 'Type', 'Path', 'Permissions', 'Users now', 'Max users', 'Text'],
      rows: rows.map(r => [s(r, 'SERVER_SHARE_NAME'), s(r, 'SHARE_TYPE'), s(r, 'PATH_NAME'), s(r, 'PERMISSIONS'), r.CURRENT_USERS as number ?? null, r.MAXIMUM_USERS as number ?? null, s(r, 'TEXT_DESCRIPTION')]),
      rowClass: rows.map(r => (risky(r) ? 'bad' : undefined)), empty: vscode.l10n.t('No share.') }],
  }, ALLOWED);
}

export function registerSystemAudit(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.programAudit', wrap((a?: unknown) => programAudit(manager, a))),
    vscode.commands.registerCommand('vanthrex.scheduleCalendar', wrap(() => scheduleCalendar(manager))),
    vscode.commands.registerCommand('vanthrex.shadowedObjects', wrap(() => shadowed(manager))),
    vscode.commands.registerCommand('vanthrex.netServerShares', wrap(() => netShares(manager))),
  );
}
