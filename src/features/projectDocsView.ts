// Project and documentation generators: IBM i Project files (Bob / makei) for a local folder, Markdown documentation
// of a library (objects, files with columns, what each program uses, a diagram) and the CRUD matrix of a library.
import * as vscode from 'vscode';
import { ibmiJson, includeDirs, iprojJson, projectTargets, rulesMk, ProjectFile } from '../core/bobProject';
import { crudCsv, crudMatrix, DocColumn, DocObject, libraryMarkdown } from '../core/libraryDoc';
import { PgmRef } from '../core/callGraph';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { assertSystemName, sqlString } from '../core/util';
import { listFiles, pickFolder } from './localDevView';
import { reportProgress, showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row, k: string) => String(r[k] ?? '').trim();
const ALLOWED = new Set(['vanthrex.crudMatrix', 'vanthrex.crudMatrix.csv', 'vanthrex.documentLibrary']);

async function createProject(manager: ConnectionManager, uri?: vscode.Uri): Promise<void> {
  const folder = await pickFolder(uri);
  if (!folder) { return; }
  const files = await listFiles(folder.uri, ['node_modules/', '.vscode/', '.git/']);
  const project: ProjectFile[] = [];
  for (const f of files.slice(0, 5000)) {
    const isSource = /\.(rpgle|sqlrpgle|clle|cblle|sqlcblle|c|cpp|pf|lf|dspf|prtf|cmd|bnd|sql|table|view|index|rpgleinc|rpginc)$/i.test(f.rel);
    if (!isSource) { continue; }
    const text = f.size < 2_000_000 && !/\.(pf|lf|dspf|prtf)$/i.test(f.rel) ? new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, ...f.rel.split('/')))) : undefined;
    project.push({ rel: f.rel, text });
  }
  const targets = projectTargets(project);
  if (!targets.length) { vscode.window.showInformationMessage(vscode.l10n.t('No IBM i sources found in {0} (.rpgle, .clle, .pf, .dspf, .sql…).', folder.name)); return; }
  const conn = manager.connection;
  const curlib = await vscode.window.showInputBox({ title: vscode.l10n.t('Library to build into (current library)'), value: conn?.profile.currentLibrary ?? '', prompt: vscode.l10n.t('Empty: &CURLIB (the current library of the build job)') });
  if (curlib === undefined) { return; }
  const opts = { name: folder.name, curlib: curlib.trim().toUpperCase() || undefined, libl: conn?.profile.libraries ?? [] };
  const write = async (rel: string, text: string) => {
    const u = vscode.Uri.joinPath(folder.uri, ...rel.split('/'));
    try { await vscode.workspace.fs.stat(u);
      const keep = vscode.l10n.t('Keep mine'); const replace = vscode.l10n.t('Replace');
      if (await vscode.window.showWarningMessage(vscode.l10n.t('{0} already exists.', rel), { modal: true }, replace, keep) !== replace) { return false; }
    } catch { /* new file */ }
    await vscode.workspace.fs.writeFile(u, new TextEncoder().encode(text));
    return true;
  };
  const written: string[] = [];
  if (await write('iproj.json', iprojJson(opts, includeDirs(project)))) { written.push('iproj.json'); }
  if (await write('.ibmi.json', ibmiJson(opts))) { written.push('.ibmi.json'); }
  for (const dir of [...new Set(targets.map(t => t.dir))]) {
    const rel = dir ? `${dir}/Rules.mk` : 'Rules.mk';
    if (await write(rel, rulesMk(dir, targets))) { written.push(rel); }
  }
  const settings = vscode.workspace.getConfiguration('vanthrex.deploy', folder.uri);
  if (!settings.get<string>('buildCommand')) { await settings.update('buildCommand', 'makei build', vscode.ConfigurationTarget.WorkspaceFolder); }
  const build = vscode.l10n.t('Build Now');
  void vscode.window.showInformationMessage(vscode.l10n.t('IBM i project ready: {0} target(s) in {1}. Written: {2}.', targets.length, folder.name, written.join(', ') || '—'), build)
    .then(c => { if (c) { void vscode.commands.executeCommand('vanthrex.build', folder.uri); } });
}

async function libraryArg(manager: ConnectionManager, a: unknown, title: string): Promise<string | undefined> {
  const n = a as { kind?: string; name?: string; library?: string } | undefined;
  const lib = n?.kind === 'library' ? n.name : typeof a === 'string' ? a : undefined;
  if (lib) { return assertSystemName(lib, 'library'); }
  const v = await vscode.window.showInputBox({ title, value: manager.require().profile.currentLibrary ?? '' });
  return v ? assertSystemName(v, 'library') : undefined;
}

async function programRefs(conn: IbmiConnection, lib: string): Promise<PgmRef[]> {
  if (!conn.sqlKeepsJob) { throw new Error(vscode.l10n.t('This needs the Mapepire SQL engine (it builds a cross-reference in QTEMP).')); }
  try { await conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(`DSPPGMREF PGM(${lib}/*ALL) OUTPUT(*OUTFILE) OBJTYPE(*ALL) OUTFILE(QTEMP/VXDOCREF)`)})`, 1); }
  catch (e) { log(`DSPPGMREF ${lib}: ${errorMessage(e)}`); return []; }
  const rows = await conn.rows<Row>("SELECT WHLIB, WHPNAM, COALESCE(WHTEXT, '') AS WHTEXT, WHFNAM, WHLNAM, WHOTYP, WHFUSG, WHSPKG FROM QTEMP.VXDOCREF", 50000);
  const usage = new Map<string, PgmRef>();
  for (const r of rows) {
    const ref: PgmRef = { lib: s(r, 'WHLIB'), pgm: s(r, 'WHPNAM'), text: s(r, 'WHTEXT'), refLib: s(r, 'WHLNAM'), refName: s(r, 'WHFNAM'), refType: s(r, 'WHOTYP'), usage: Number(r.WHFUSG) || 0,
      pgmType: s(r, 'WHSPKG') === 'V' ? '*SRVPGM' : '*PGM' };
    if (!ref.refName) { continue; }
    const k = `${ref.pgm}|${ref.refLib}|${ref.refName}|${ref.refType}`;
    const prev = usage.get(k);
    if (prev) { prev.usage = (prev.usage ?? 0) | (ref.usage ?? 0); } else { usage.set(k, ref); }
  }
  return [...usage.values()];
}

async function documentLibrary(manager: ConnectionManager, a?: unknown): Promise<void> {
  const lib = await libraryArg(manager, a, vscode.l10n.t('Document which library?'));
  if (!lib) { return; }
  const conn = manager.require();
  const md = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Documenting {0}…', lib) }, async progress => {
    progress.report({ message: vscode.l10n.t('objects') });
    const objects: DocObject[] = (await conn.rows<Row>(`SELECT OBJNAME AS N, OBJTYPE AS T, COALESCE(OBJATTRIBUTE, '') AS A, COALESCE(OBJTEXT, '') AS X, OBJSIZE AS S, ` +
      `VARCHAR_FORMAT(LAST_USED_TIMESTAMP, 'YYYY-MM-DD') AS U FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*ALL')) O ORDER BY OBJTYPE, OBJNAME`, 20000))
      .map(r => ({ name: s(r, 'N'), type: s(r, 'T'), attribute: s(r, 'A'), text: s(r, 'X'), size: Number(r.S) || 0, lastUsed: s(r, 'U') || undefined }));
    progress.report({ message: vscode.l10n.t('columns') });
    const columns: DocColumn[] = (await conn.rows<Row>(`SELECT SYSTEM_TABLE_NAME AS F, SYSTEM_COLUMN_NAME AS N, DATA_TYPE AS T, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS SC, COALESCE(COLUMN_TEXT, '') AS X ` +
      `FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} ORDER BY SYSTEM_TABLE_NAME, ORDINAL_POSITION`, 50000).catch(() => [] as Row[]))
      .map(r => ({ file: s(r, 'F'), name: s(r, 'N'), type: s(r, 'T'), length: Number(r.L) || 0, scale: Number(r.SC) || 0, text: s(r, 'X') }));
    progress.report({ message: vscode.l10n.t('program references') });
    const refs = await programRefs(conn, lib).catch(e => { log(errorMessage(e)); return [] as PgmRef[]; });
    return libraryMarkdown(lib, conn.profile.name, objects, columns, refs);
  });
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.commands.executeCommand('markdown.showPreviewToSide');
}

let lastMatrix: { lib: string; csv: string } | undefined;

async function crudCommand(manager: ConnectionManager, a?: unknown): Promise<void> {
  const lib = await libraryArg(manager, a, vscode.l10n.t('CRUD matrix of which library?'));
  if (!lib) { return; }
  const conn = manager.require();
  const refs = await reportProgress('crud', vscode.l10n.t('Reading what the programs of {0} use…', lib), () => programRefs(conn, lib));
  const m = crudMatrix(refs);
  lastMatrix = { lib, csv: crudCsv(m) };
  const files = m.files.slice(0, 60);
  showReport('crud', {
    title: vscode.l10n.t('CRUD matrix — {0}', lib),
    subtitle: vscode.l10n.t('{0} program(s) × {1} file(s). C = creates (writes), R = reads, UD = updates or deletes, ? = unspecified.', m.programs.length, m.files.length),
    actions: [{ label: vscode.l10n.t('Save as CSV…'), command: 'vanthrex.crudMatrix.csv' }, { label: vscode.l10n.t('Document the library'), command: 'vanthrex.documentLibrary', args: [lib] }],
    tables: [{ title: vscode.l10n.t('Programs and files'), filter: true, columns: ['Program', ...files.map(f => f.replace(`${lib}/`, ''))],
      rows: m.programs.map(p => [p, ...files.map(f => m.cells[p][f] ?? '')]), empty: vscode.l10n.t('No program of {0} uses a file.', lib) }],
    note: m.files.length > 60 ? vscode.l10n.t('Only the first 60 files are shown; the CSV has all of them.') : undefined,
  }, ALLOWED);
}

export function registerProjectDocs(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.createProject', wrap((uri?: vscode.Uri) => createProject(manager, uri))),
    vscode.commands.registerCommand('vanthrex.documentLibrary', wrap((a?: unknown) => documentLibrary(manager, a))),
    vscode.commands.registerCommand('vanthrex.crudMatrix', wrap((a?: unknown) => crudCommand(manager, a))),
    vscode.commands.registerCommand('vanthrex.crudMatrix.csv', wrap(async () => {
      if (!lastMatrix) { return; }
      const to = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`crud-${lastMatrix.lib.toLowerCase()}.csv`), filters: { CSV: ['csv'] } });
      if (to) { await vscode.workspace.fs.writeFile(to, new TextEncoder().encode(lastMatrix.csv)); vscode.window.setStatusBarMessage(vscode.l10n.t('Saved {0}', to.fsPath), 5000); }
    })),
  );
}
