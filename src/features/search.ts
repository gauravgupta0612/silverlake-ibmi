import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError, showLog } from '../core/log';
import { isValidSystemName, shSingleQuote, sqlString } from '../core/util';
import { memberUri, ifsUri } from './fileSystems';
import { runSqlAndShow } from './sqlRunner';

const OBJECT_TYPES = ['*ALL', '*PGM', '*SRVPGM', '*MODULE', '*FILE', '*CMD', '*DTAARA', '*DTAQ', '*MSGF', '*BNDDIR', '*JOBD', '*OUTQ', '*USRSPC'];

interface FoundObject { library: string; name: string; type: string; attribute: string; text: string; lastUsed: string; }

function libraryScope(conn: IbmiConnection): string[] {
  return [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean) as string[])];
}

async function pickScope(conn: IbmiConnection, title: string): Promise<string[] | undefined> {
  const libs = libraryScope(conn);
  const pick = await vscode.window.showQuickPick([
    { label: '$(library) My library list', detail: libs.join(', ') || '(empty)', value: 'libl' },
    { label: '$(globe) All user libraries (*ALLUSR)', detail: 'Slower — searches every non-IBM library', value: 'allusr' },
    { label: '$(edit) One library…', value: 'one' },
  ], { title });
  if (!pick) { return undefined; }
  if (pick.value === 'libl') {
    if (!libs.length) { throw new Error('Your library list is empty – add a library first.'); }
    return libs;
  }
  if (pick.value === 'allusr') { return ['*ALLUSR']; }
  const lib = await vscode.window.showInputBox({ title: 'Library', validateInput: v => isValidSystemName(v.trim()) ? undefined : 'Not a valid library name' });
  return lib ? [lib.trim().toUpperCase()] : undefined;
}

/** Find the source member or stream file a program was compiled from. */
async function openProgramSource(conn: IbmiConnection, library: string, name: string): Promise<void> {
  const tries = [
    `SELECT SOURCE_FILE_LIBRARY AS LIB, SOURCE_FILE AS FILE, SOURCE_FILE_MEMBER AS MBR, COALESCE(SOURCE_STREAM_FILE_PATH, '') AS STMF ` +
    `FROM QSYS2.BOUND_MODULE_INFO WHERE PROGRAM_LIBRARY = ${sqlString(library)} AND PROGRAM_NAME = ${sqlString(name)} ` +
    `ORDER BY CASE WHEN BOUND_MODULE = PROGRAM_NAME THEN 0 ELSE 1 END FETCH FIRST 1 ROW ONLY`,
    `SELECT SOURCE_FILE_LIBRARY AS LIB, SOURCE_FILE AS FILE, SOURCE_FILE_MEMBER AS MBR, '' AS STMF ` +
    `FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(library)} AND PROGRAM_NAME = ${sqlString(name)} FETCH FIRST 1 ROW ONLY`,
  ];
  for (const sql of tries) {
    try {
      const r = (await conn.rows<Record<string, unknown>>(sql, 1))[0];
      if (!r) { continue; }
      const stmf = String(r.STMF ?? '').trim();
      if (stmf) { await vscode.window.showTextDocument(ifsUri(stmf)); return; }
      const lib = String(r.LIB ?? '').trim(), file = String(r.FILE ?? '').trim(), mbr = String(r.MBR ?? '').trim();
      if (lib && file && mbr) {
        const type = (await conn.rows<{ T: string }>(
          `SELECT COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} ` +
          `AND SYSTEM_TABLE_NAME = ${sqlString(file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(mbr)}`, 1))[0]?.T ?? '';
        await vscode.window.showTextDocument(memberUri(lib, file, mbr, String(type).trim() || 'mbr'));
        return;
      }
    } catch (e) { log(`Source lookup: ${errorMessage(e)}`); }
  }
  vscode.window.showWarningMessage(`No source information is recorded for ${library}/${name}.`);
}

async function objectActions(manager: ConnectionManager, state: vscode.Memento, o: FoundObject): Promise<void> {
  type A = vscode.QuickPickItem & { run: () => Promise<unknown> | Thenable<unknown> };
  const conn = manager.require();
  const actions: A[] = [{ label: '$(references) Where used…', run: () => whereUsed(manager, o.library, o.name, o.type) }];
  if (o.type === '*PGM' || o.type === '*SRVPGM' || o.type === '*MODULE') {
    actions.unshift({ label: '$(go-to-file) Open source', run: () => openProgramSource(conn, o.library, o.name) });
  }
  if (o.type === '*PGM') { actions.push({ label: '$(play) Call program…', run: () => vscode.commands.executeCommand('silverlake.objectCall', o) }); }
  if (o.type === '*FILE') {
    actions.unshift({ label: '$(table) Edit data', run: () => vscode.commands.executeCommand('silverlake.editData', o) });
    actions.push({ label: '$(preview) Preview first rows', run: () => runSqlAndShow(manager, state, `SELECT * FROM ${o.library}/${o.name} FETCH FIRST 100 ROWS ONLY`) });
  }
  actions.push({ label: '$(clippy) Copy qualified name', run: () => vscode.env.clipboard.writeText(`${o.library}/${o.name}`) });
  if (!(['*LIB'].includes(o.type)) && !libraryScope(conn).includes(o.library)) {
    actions.push({ label: '$(add) Add library to my list', run: () => manager.updateActiveProfile(p => { p.libraries = [...p.libraries, o.library]; }) });
  }
  const pick = await vscode.window.showQuickPick(actions, { title: `${o.library}/${o.name} ${o.type} ${o.attribute}`, placeHolder: o.text });
  if (pick) { await pick.run(); }
}

export async function searchObjects(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const term = await vscode.window.showInputBox({
    title: 'Search objects', prompt: 'Name or text to find. Use * as a wildcard (e.g. ORD*, *CUST*). Text descriptions are searched too.',
    ignoreFocusOut: true,
  });
  if (!term?.trim()) { return; }
  const type = await vscode.window.showQuickPick(OBJECT_TYPES, { title: 'Object type' });
  if (!type) { return; }
  const scope = await pickScope(conn, 'Where to search?');
  if (!scope) { return; }
  const t = term.trim().toUpperCase();
  const like = t.includes('*') ? t.replace(/\*/g, '%') : `%${t}%`;
  const parts = scope.map(lib =>
    `SELECT OBJLIB, OBJNAME, OBJTYPE, COALESCE(OBJATTRIBUTE, '') AS ATTR, COALESCE(OBJTEXT, '') AS TEXT, ` +
    `COALESCE(VARCHAR_FORMAT(LAST_USED_TIMESTAMP, 'YYYY-MM-DD'), '') AS USED ` +
    `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, ${sqlString(type)})) ` +
    `WHERE OBJNAME LIKE ${sqlString(like)} OR UPPER(COALESCE(OBJTEXT, '')) LIKE ${sqlString(like)}`);
  const rows = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Searching ${scope.join(', ')} for "${term}"…` },
    () => conn.rows<Record<string, unknown>>(`${parts.join(' UNION ALL ')} ORDER BY OBJNAME, OBJLIB FETCH FIRST 500 ROWS ONLY`, 500));
  if (!rows.length) { vscode.window.showInformationMessage(`No ${type} objects match "${term}".`); return; }
  const items = rows.map(r => {
    const o: FoundObject = {
      library: String(r.OBJLIB).trim(), name: String(r.OBJNAME).trim(), type: String(r.OBJTYPE).trim(),
      attribute: String(r.ATTR ?? '').trim(), text: String(r.TEXT ?? '').trim(), lastUsed: String(r.USED ?? ''),
    };
    return { label: o.name, description: `${o.library} · ${o.type} ${o.attribute}`, detail: [o.text, o.lastUsed && `last used ${o.lastUsed}`].filter(Boolean).join(' — ') || undefined, o };
  });
  const pick = await vscode.window.showQuickPick(items, { title: `${rows.length}${rows.length === 500 ? '+' : ''} object(s) found`, matchOnDescription: true, matchOnDetail: true });
  if (pick) { await objectActions(manager, state, pick.o); }
}

export async function whereUsed(manager: ConnectionManager, library: string, name: string, type: string): Promise<void> {
  const conn = manager.require();
  // Warm up the SQL engine so we know whether it keeps a single job (QTEMP).
  await conn.sql('VALUES 1', 1);
  if (!conn.sqlKeepsJob) {
    throw new Error('Where-used needs the Mapepire SQL engine (it builds a cross-reference in QTEMP). Change the SQL engine in the connection settings.');
  }
  const scope = await pickScope(conn, `Find programs that use ${library}/${name} — search which libraries?`);
  if (!scope) { return; }
  const libs = scope[0] === '*ALLUSR' ? ['*ALLUSR'] : scope;
  const rows = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Building cross-reference for ${libs.join(', ')}…`, cancellable: false },
    async progress => {
      let first = true;
      for (const lib of libs) {
        progress.report({ message: lib });
        const cmd = `DSPPGMREF PGM(${lib}/*ALL) OUTPUT(*OUTFILE) OBJTYPE(*ALL) OUTFILE(QTEMP/SLKPGMREF) OUTMBR(*FIRST ${first ? '*REPLACE' : '*ADD'})`;
        try { await conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(cmd)})`, 1); first = false; }
        catch (e) { log(`DSPPGMREF ${lib}: ${errorMessage(e)}`); }
      }
      if (first) { throw new Error('Could not build the cross-reference (DSPPGMREF failed for every library). See the log for details.'); }
      return conn.rows<Record<string, unknown>>(
        `SELECT DISTINCT WHLIB, WHPNAM, COALESCE(WHTEXT, '') AS WHTEXT, WHLNAM, WHOTYP FROM QTEMP/SLKPGMREF ` +
        `WHERE WHFNAM = ${sqlString(name)} AND (WHLNAM = ${sqlString(library)} OR WHLNAM IN ('*LIBL', '')) ` +
        `${type && type !== '*ALL' ? `AND WHOTYP = ${sqlString(type)} ` : ''}ORDER BY WHLIB, WHPNAM`, 5000);
    });
  if (!rows.length) { vscode.window.showInformationMessage(`No programs in ${libs.join(', ')} reference ${library}/${name}.`); return; }
  const pick = await vscode.window.showQuickPick(rows.map(r => ({
    label: `$(gear) ${String(r.WHPNAM).trim()}`,
    description: `${String(r.WHLIB).trim()}${String(r.WHLNAM).trim() === '*LIBL' ? ' · via *LIBL' : ''}`,
    detail: String(r.WHTEXT ?? '').trim() || undefined,
    lib: String(r.WHLIB).trim(), pgm: String(r.WHPNAM).trim(),
  })), { title: `${rows.length} program(s) use ${library}/${name} — pick one to open its source`, matchOnDescription: true });
  if (pick) { await openProgramSource(conn, pick.lib, pick.pgm); }
}

export async function searchSource(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const libs = libraryScope(conn);
  const lib = await vscode.window.showQuickPick([...libs, '$(edit) Other library…'], { title: 'Search source — library' });
  if (!lib) { return; }
  const library = lib.startsWith('$(') ? (await vscode.window.showInputBox({ title: 'Library' }))?.trim().toUpperCase() : lib;
  if (!library || !isValidSystemName(library)) { return; }
  const files = (await conn.rows<{ NAME: string }>(
    `SELECT SYSTEM_TABLE_NAME AS NAME FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(library)} AND FILE_TYPE = 'S' ORDER BY 1`)).map(r => String(r.NAME).trim());
  if (!files.length) { vscode.window.showInformationMessage(`${library} has no source files.`); return; }
  const filePick = await vscode.window.showQuickPick(['$(files) All source files', ...files], { title: `Search source in ${library}`, canPickMany: false });
  if (!filePick) { return; }
  const targets = filePick.startsWith('$(') ? files : [filePick];
  const term = await vscode.window.showInputBox({ title: 'Search text', prompt: 'Text to find (not case sensitive). Prefix with re: for a regular expression.', ignoreFocusOut: true });
  if (!term) { return; }
  const regex = term.startsWith('re:');
  const pattern = regex ? term.substring(3) : term;
  // Quote the fixed part ($ is valid in IBM i names but special in the shell); leave the glob outside.
  const paths = targets.map(f => `${shSingleQuote(`/QSYS.LIB/${library}.LIB/${f}.FILE/`)}*.MBR`).join(' ');
  const script = `/usr/bin/grep -inH ${regex ? '-E' : '-F'} -e ${shSingleQuote(pattern)} ${paths} 2>/dev/null | /usr/bin/head -n 2000`;

  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Searching ${library} for "${pattern}"…` },
    () => conn.qsh(script));
  const hits = r.stdout.split('\n').map(line => {
    const m = line.match(/^\/QSYS\.LIB\/([^.]+)\.LIB\/([^.]+)\.FILE\/([^.]+)\.MBR:(\d+):(.*)$/i);
    return m ? { library: m[1].toUpperCase(), file: m[2].toUpperCase(), member: m[3].toUpperCase(), line: Number(m[4]), text: m[5] } : undefined;
  }).filter((h): h is NonNullable<typeof h> => !!h);
  if (!hits.length) {
    if (r.stderr.trim()) { log(r.stderr); }
    vscode.window.showInformationMessage(`"${pattern}" was not found in ${library}/${targets.length === 1 ? targets[0] : '*ALL source files'}.`);
    return;
  }
  // Member types, so files open with the right language.
  const types = new Map<string, string>();
  try {
    const t = await conn.rows<{ F: string; M: string; T: string }>(
      `SELECT SYSTEM_TABLE_NAME AS F, SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT ` +
      `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(library)} AND SYSTEM_TABLE_NAME IN (${targets.map(sqlString).join(', ')})`, 50000);
    t.forEach(x => types.set(`${String(x.F).trim()}/${String(x.M).trim()}`, String(x.T).trim()));
  } catch (e) { logError(e); }
  const members = new Set(hits.map(h => `${h.file}/${h.member}`));
  const pick = await vscode.window.showQuickPick(hits.map(h => ({
    label: `$(file-code) ${h.member}:${h.line}`,
    description: `${h.library}/${h.file}`,
    detail: h.text.trim(),
    h,
  })), {
    title: `${hits.length}${hits.length >= 2000 ? '+' : ''} match(es) in ${members.size} member(s)`,
    matchOnDescription: true, matchOnDetail: true,
  });
  if (!pick) { return; }
  const h = pick.h;
  const uri = memberUri(h.library, h.file, h.member, types.get(`${h.file}/${h.member}`) || 'mbr');
  const editor = await vscode.window.showTextDocument(uri);
  const pos = new vscode.Position(Math.max(0, h.line - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

export function registerSearch(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]) => {
    try { await fn(...a); }
    catch (e) {
      logError(e);
      const c = await vscode.window.showErrorMessage(errorMessage(e), 'Show Log');
      if (c) { showLog(); }
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('silverlake.searchObjects', guard(() => searchObjects(manager, context.globalState))),
    vscode.commands.registerCommand('silverlake.searchSource', guard(() => searchSource(manager))),
    vscode.commands.registerCommand('silverlake.whereUsed', guard(async (n?: { library: string; name: string; type: string }) => {
      if (n?.library && n.name) { return whereUsed(manager, n.library, n.name, n.type); }
      const v = await vscode.window.showInputBox({ title: 'Where used', prompt: 'LIBRARY/OBJECT', placeHolder: 'MYLIB/CUSTMAST' });
      if (!v?.includes('/')) { return; }
      const [library, name] = v.trim().toUpperCase().split('/');
      return whereUsed(manager, library, name, '*ALL');
    })),
    vscode.commands.registerCommand('silverlake.openProgramSource', guard(async (n: { library: string; name: string }) =>
      openProgramSource(manager.require(), n.library, n.name))),
  );
}
