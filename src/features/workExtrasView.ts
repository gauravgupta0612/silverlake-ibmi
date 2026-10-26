// More work-management screens: Work with Job Descriptions (WRKJOBD) with library list and job queue changes, what
// Vanthrex's own SQL job looks like (library list, job log), and Retrieve CL Source (RTVCLSRC) from a CL program.
import * as vscode from 'vscode';
import { chgjobdJobQueue, chgjobdLibraryList, jobDescriptionsSql, JobDescription, toJobDescription } from '../core/jobDescriptions';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { assertSystemName, sqlString } from '../core/util';
import { reportProgress, showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const ALLOWED = new Set(['vanthrex.wrkJobDescriptions', 'vanthrex.jobd.row', 'vanthrex.mySqlJob', 'vanthrex.explainMessage']);

async function wrkjobd(manager: ConnectionManager, state: vscode.Memento, lib?: string | { name?: string; kind?: string }): Promise<void> {
  const conn = manager.require();
  let library = typeof lib === 'string' ? lib : lib && typeof lib === 'object' && lib.kind === 'library' ? lib.name : undefined;
  if (!library) {
    library = await vscode.window.showInputBox({ title: vscode.l10n.t('Job descriptions in which library?'), value: state.get<string>('vanthrex.wrkjobd.lib', '*LIBL'), prompt: vscode.l10n.t('A library, *LIBL or *ALL') });
    if (!library) { return; }
  }
  library = library.trim().toUpperCase();
  await state.update('vanthrex.wrkjobd.lib', library);
  const list = await reportProgress('wrkjobd', vscode.l10n.t('Reading job descriptions…'), async () => (await conn.rows<Row>(jobDescriptionsSql(library!), 2000)).map(toJobDescription));
  showReport('wrkjobd', {
    title: vscode.l10n.t('Job descriptions — {0}', library), subtitle: vscode.l10n.t('{0} job description(s). Click one to change its library list or job queue, or to use its library list.', list.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.wrkJobDescriptions', args: [library] }, { label: vscode.l10n.t('Another library…'), command: 'vanthrex.wrkJobDescriptions', args: [''] }],
    tables: [{ title: vscode.l10n.t('Job descriptions'), filter: true, columns: ['Job description', 'User', 'Job queue', 'Output queue', 'Initial library list', 'Log', 'Text'],
      rows: list.map(j => [`${j.library}/${j.name}`, j.user, j.jobQueue, j.outputQueue, j.special ?? j.libraries.join(' '), j.log, j.text]),
      rowActions: list.map(j => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.jobd.row', args: [j] })) }],
  }, ALLOWED);
}

async function jobdRow(manager: ConnectionManager, j: JobDescription): Promise<void> {
  const conn = manager.require();
  const pick = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(list-ordered) Change the initial library list…'), id: 'libl' },
    { label: vscode.l10n.t('$(inbox) Change the job queue…'), id: 'jobq' },
    { label: vscode.l10n.t('$(plug) Use this library list for my connection'), id: 'use' },
    { label: vscode.l10n.t('$(copy) Copy the library list'), id: 'copy' },
  ], { title: `${j.library}/${j.name}` });
  if (!pick) { return; }
  if (pick.id === 'copy') { await vscode.env.clipboard.writeText(j.special ?? j.libraries.join(' ')); return; }
  if (pick.id === 'use') { await vscode.commands.executeCommand('vanthrex.libraryListFromJobd', `${j.library}/${j.name}`); return; }
  let cmd: string;
  if (pick.id === 'libl') {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Initial library list of {0}/{1}', j.library, j.name), value: j.special ?? j.libraries.join(' '),
      prompt: vscode.l10n.t('Libraries separated by blanks (top first), or *SYSVAL / *NONE'),
      validateInput: x => { try { chgjobdLibraryList(j.library, j.name, /^\*(SYSVAL|NONE)$/i.test(x.trim()) ? x.trim().toUpperCase() as '*SYSVAL' : x.split(/\s+/).filter(Boolean)); return undefined; } catch (e) { return errorMessage(e); } } });
    if (v === undefined) { return; }
    cmd = chgjobdLibraryList(j.library, j.name, /^\*(SYSVAL|NONE)$/i.test(v.trim()) ? v.trim().toUpperCase() as '*SYSVAL' | '*NONE' : v.split(/\s+/).filter(Boolean));
  } else {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Job queue of {0}/{1}', j.library, j.name), value: j.jobQueue, prompt: 'LIBRARY/QUEUE',
      validateInput: x => { try { chgjobdJobQueue(j.library, j.name, x.trim()); return undefined; } catch (e) { return errorMessage(e); } } });
    if (!v) { return; }
    cmd = chgjobdJobQueue(j.library, j.name, v.trim());
  }
  const run = vscode.l10n.t('Run');
  if (await vscode.window.showWarningMessage(vscode.l10n.t('Change the job description? New jobs started with it are affected.'), { modal: true, detail: cmd }, run) !== run) { return; }
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim() || cmd); }
  vscode.window.showInformationMessage(vscode.l10n.t('{0}/{1} changed.', j.library, j.name));
  await vscode.commands.executeCommand('vanthrex.wrkJobDescriptions', j.library);
}

async function mySqlJob(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const { info, libl, log } = await reportProgress('mysqljob', vscode.l10n.t('Reading the SQL job…'), async () => {
    const info = (await conn.rows<Row>('SELECT QSYS2.JOB_NAME AS J, CURRENT USER AS U, CURRENT SCHEMA AS S, CURRENT PATH AS P FROM SYSIBM.SYSDUMMY1', 1))[0];
    const [libl, log] = await Promise.all([
      conn.rows<Row>('SELECT ORDINAL_POSITION AS N, SYSTEM_SCHEMA_NAME AS L, TYPE AS T, COALESCE(TEXT_DESCRIPTION, \'\') AS X FROM QSYS2.LIBRARY_LIST_INFO ORDER BY ORDINAL_POSITION', 300),
      conn.rows<Row>("SELECT ORDINAL_POSITION AS O, VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'HH24:MI:SS') AS TS, COALESCE(MESSAGE_ID, '') AS ID, COALESCE(MESSAGE_TYPE, '') AS T, COALESCE(SEVERITY, 0) AS SEV, COALESCE(MESSAGE_TEXT, '') AS X FROM TABLE(QSYS2.JOBLOG_INFO('*')) J ORDER BY ORDINAL_POSITION DESC FETCH FIRST 300 ROWS ONLY", 300),
    ]);
    return { info, libl, log };
  });
  showReport('mysqljob', {
    title: vscode.l10n.t('My SQL job — {0}', conn.profile.name),
    subtitle: conn.sqlKeepsJob ? vscode.l10n.t('The job that runs your SQL, F4 prompts and command line commands in Vanthrex. Newest job log messages first.')
      : vscode.l10n.t('With the db2util SQL engine every statement runs in a new job: this is only the job of this query.'),
    facts: [[vscode.l10n.t('Job'), s(info, 'J')], [vscode.l10n.t('User'), s(info, 'U')], [vscode.l10n.t('Current schema'), s(info, 'S')], [vscode.l10n.t('SQL engine'), conn.sqlEngineName], [vscode.l10n.t('Path'), s(info, 'P')]],
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.mySqlJob' }],
    tables: [
      { title: vscode.l10n.t('Library list'), columns: ['#', 'Library', 'Type', 'Text'], rows: libl.map(r => [Number(r.N), s(r, 'L'), s(r, 'T'), s(r, 'X')]) },
      { title: vscode.l10n.t('Job log'), filter: true, columns: ['Time', 'Message', 'Type', 'Sev', 'Text'],
        rows: log.map(r => [s(r, 'TS'), s(r, 'ID'), s(r, 'T'), Number(r.SEV), s(r, 'X')]),
        rowActions: log.map(r => (s(r, 'ID') ? { label: vscode.l10n.t('Explain {0}', s(r, 'ID')), command: 'vanthrex.explainMessage', args: [s(r, 'ID')] } : undefined)),
        rowClass: log.map(r => (Number(r.SEV) >= 30 ? 'bad' : undefined)) },
    ],
  }, ALLOWED);
}

async function retrieveClSource(manager: ConnectionManager, o?: { library?: string; name?: string }): Promise<void> {
  const conn = manager.require();
  let lib = o?.library; let pgm = o?.name;
  if (!lib || !pgm) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Retrieve CL source from a program'), prompt: 'LIBRARY/PROGRAM', ignoreFocusOut: true });
    if (!v?.includes('/')) { return; }
    [lib, pgm] = v.trim().toUpperCase().split('/');
  }
  lib = assertSystemName(lib, 'library'); pgm = assertSystemName(pgm, 'program');
  if (!conn.sqlKeepsJob) { throw new Error(vscode.l10n.t('Retrieve CL source needs the Mapepire SQL engine (it uses a work file in QTEMP).')); }
  const text = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Retrieving the CL source of {0}/{1}…', lib, pgm) }, async () => {
    const q = (c: string) => conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(c)})`, 1);
    await q('DLTF FILE(QTEMP/VXCLSRC)').catch(() => undefined);
    await q('CRTSRCPF FILE(QTEMP/VXCLSRC) RCDLEN(112) MBR(*NONE)');
    try { await q(`RTVCLSRC PGM(${lib}/${pgm}) SRCFILE(QTEMP/VXCLSRC) SRCMBR(${pgm})`); }
    catch (e) {
      const m = errorMessage(e);
      throw new Error(/CPF0560|CPF0571|retriev/i.test(m) ? vscode.l10n.t('{0}/{1} was not created with ALWRTVSRC(*YES), so its source cannot be retrieved. ({2})', lib!, pgm!, m.split('\n')[0]) : m);
    }
    const rows = await conn.rows<Row>('SELECT SRCDTA FROM QTEMP.VXCLSRC ORDER BY SRCSEQ', 100000);
    return rows.map(r => String(r.SRCDTA ?? '').replace(/\s+$/, '')).join('\n') + '\n';
  });
  const doc = await vscode.workspace.openTextDocument({ language: 'cl', content: `/* Retrieved from ${lib}/${pgm} on ${conn.profile.name} (RTVCLSRC) */\n` + text });
  await vscode.window.showTextDocument(doc, { preview: false });
}

export function registerWorkExtras(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.wrkJobDescriptions', wrap((lib?: string | { name?: string; kind?: string }) => wrkjobd(manager, context.globalState, lib))),
    vscode.commands.registerCommand('vanthrex.jobd.row', wrap((j: JobDescription) => jobdRow(manager, j))),
    vscode.commands.registerCommand('vanthrex.mySqlJob', wrap(() => mySqlJob(manager))),
    vscode.commands.registerCommand('vanthrex.retrieveClSource', wrap((o?: { library?: string; name?: string }) => retrieveClSource(manager, o))),
  );
}
