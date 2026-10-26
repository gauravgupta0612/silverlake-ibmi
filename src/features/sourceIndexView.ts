// Local source index: the sources of chosen libraries copied to this computer in a few round trips (many members per
// QSH script) and refreshed incrementally (only members changed since). Searched as you type, in milliseconds; also
// used to jump to a procedure defined in another member (Go to Definition across members and service programs).
import * as vscode from 'vscode';
import { batches, bulkReadScript, parseBulk, procedureDefinitions, runPool, searchIndex, staleMembers, IndexEntry, MemberRow } from '../core/speed';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { assertSystemName, sqlString } from '../core/util';
import { memberUri } from './fileSystems';
import { OPCODES } from '../rpg/docs';

type Row = Record<string, unknown>;
interface LibIndex { library: string; system: string; built: string; members: Record<string, IndexEntry> }

let root: vscode.Uri | undefined;
const loaded = new Map<string, LibIndex>(); // `${system}|${LIB}`

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
const fileFor = (system: string, lib: string) => vscode.Uri.joinPath(root!, safe(system), `${lib}.json`);

async function readIndex(system: string, lib: string): Promise<LibIndex | undefined> {
  const k = `${system}|${lib}`;
  if (loaded.has(k)) { return loaded.get(k); }
  try {
    const x = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(fileFor(system, lib)))) as LibIndex;
    loaded.set(k, x);
    return x;
  } catch { return undefined; }
}

async function writeIndex(x: LibIndex): Promise<void> {
  loaded.set(`${x.system}|${x.library}`, x);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root!, safe(x.system)));
  await vscode.workspace.fs.writeFile(fileFor(x.system, x.library), new TextEncoder().encode(JSON.stringify(x)));
}

export async function indexedLibraries(system: string): Promise<string[]> {
  try { return (await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root!, safe(system)))).filter(([n]) => n.endsWith('.json')).map(([n]) => n.replace(/\.json$/, '')); }
  catch { return []; }
}

/** Every indexed member of the system as [LIB/FILE/MBR, text]. */
async function* allDocs(system: string): AsyncGenerator<[string, string, string]> {
  for (const lib of await indexedLibraries(system)) {
    const x = await readIndex(system, lib);
    if (!x) { continue; }
    for (const [k, e] of Object.entries(x.members)) { yield [`${lib}/${k}`, e.text, e.type]; }
  }
}

async function docsArray(system: string): Promise<{ docs: [string, string][]; types: Map<string, string> }> {
  const docs: [string, string][] = []; const types = new Map<string, string>();
  for await (const [k, t, ty] of allDocs(system)) { docs.push([k, t]); types.set(k, ty); }
  return { docs, types };
}

/** Builds or refreshes the index of a library: only new and changed members are read, many per round trip. */
export async function refreshLibrary(conn: IbmiConnection, lib: string, progress?: vscode.Progress<{ message?: string; increment?: number }>, token?: vscode.CancellationToken): Promise<{ read: number; removed: number; total: number }> {
  const rows: MemberRow[] = (await conn.rows<Row>(`SELECT P.SYSTEM_TABLE_NAME AS F, P.SYSTEM_TABLE_MEMBER AS M, COALESCE(P.SOURCE_TYPE, '') AS T, VARCHAR(COALESCE(P.LAST_SOURCE_UPDATE_TIMESTAMP, P.CREATE_TIMESTAMP)) AS C ` +
    `FROM QSYS2.SYSPARTITIONSTAT P JOIN QSYS2.SYSTABLES T ON T.SYSTEM_TABLE_SCHEMA = P.SYSTEM_TABLE_SCHEMA AND T.SYSTEM_TABLE_NAME = P.SYSTEM_TABLE_NAME AND T.FILE_TYPE = 'S' ` +
    `WHERE P.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND P.SYSTEM_TABLE_NAME NOT IN ('EVFEVENT', 'QSQLTEMP') ORDER BY 1, 2`, 200000))
    .map(r => ({ file: String(r.F).trim(), member: String(r.M).trim(), type: String(r.T).trim(), changed: String(r.C ?? '').trim() }));
  const x = (await readIndex(conn.profile.id, lib)) ?? { library: lib, system: conn.profile.id, built: '', members: {} };
  const { refresh, removed } = staleMembers(x.members, rows);
  removed.forEach(k => delete x.members[k]);
  const size = vscode.workspace.getConfiguration('vanthrex.index').get<number>('membersPerTrip', 150);
  const parallel = vscode.workspace.getConfiguration('vanthrex.index').get<number>('parallel', 3);
  const work = [...groupBy(refresh, r => r.file).entries()].flatMap(([file, ms]) => batches(ms, size).map(b => ({ file, ms: b })));
  let done = 0;
  await runPool(work, parallel, async w => {
    const r = await conn.qsh(bulkReadScript(lib, w.file, w.ms.map(m => m.member)));
    const texts = parseBulk(r.stdout);
    for (const m of w.ms) {
      const t = texts.get(m.member.toUpperCase());
      if (t !== undefined) { x.members[`${m.file}/${m.member}`] = { type: m.type, changed: m.changed, text: t }; }
    }
    done += w.ms.length;
    progress?.report({ message: `${lib}: ${done}/${refresh.length}`, increment: refresh.length ? (w.ms.length / refresh.length) * 100 : 0 });
  }, () => !!token?.isCancellationRequested);
  x.built = new Date().toISOString();
  await writeIndex(x);
  return { read: done, removed: removed.length, total: rows.length };
}

function groupBy<T>(a: T[], f: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  a.forEach(x => { const k = f(x); m.set(k, [...(m.get(k) ?? []), x]); });
  return m;
}

async function buildCommand(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const indexed = await indexedLibraries(conn.profile.id);
  const libl = [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean) as string[])];
  const all = [...new Set([...indexed, ...libl])];
  const picks = await vscode.window.showQuickPick([...all.map(l => ({ label: l, description: indexed.includes(l) ? vscode.l10n.t('indexed — refresh changed members') : vscode.l10n.t('in the library list'), picked: indexed.includes(l) || !indexed.length })),
    { label: vscode.l10n.t('$(add) Another library…'), description: '', picked: false }], { canPickMany: true, title: vscode.l10n.t('Index the sources of which libraries?') });
  if (!picks?.length) { return; }
  const libs = picks.filter(p => !p.label.startsWith('$(')).map(p => p.label);
  if (picks.some(p => p.label.startsWith('$('))) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Library to index') });
    if (v?.trim()) { libs.push(assertSystemName(v.trim(), 'library')); }
  }
  const t0 = Date.now();
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Indexing sources…'), cancellable: true }, async (p, token) => {
    const out: [string, { read: number; removed: number; total: number }][] = [];
    for (const lib of libs) { if (token.isCancellationRequested) { break; } out.push([lib, await refreshLibrary(conn, lib, p, token)]); }
    return out;
  });
  await state.update('vanthrex.index.libraries', libs);
  const total = res.reduce((s, [, r]) => s + r.total, 0); const read = res.reduce((s, [, r]) => s + r.read, 0);
  const search = vscode.l10n.t('Search Now');
  void vscode.window.showInformationMessage(vscode.l10n.t('{0} member(s) indexed in {1} library(ies) ({2} read from the IBM i) in {3} s. Search them instantly with Ctrl+Alt+Shift+F.', total, res.length, read, ((Date.now() - t0) / 1000).toFixed(1)), search)
    .then(c => { if (c) { void vscode.commands.executeCommand('vanthrex.index.search'); } });
}

async function openAt(lib: string, file: string, member: string, type: string, line: number, col = 0, len = 0): Promise<void> {
  const uri = memberUri(lib, file, member, type || 'mbr');
  const ed = await vscode.window.showTextDocument(uri, { preview: true });
  const r = new vscode.Range(line, col, line, col + len);
  ed.selection = new vscode.Selection(r.start, r.end);
  ed.revealRange(r, vscode.TextEditorRevealType.InCenter);
}

/** Search as you type in the indexed sources. */
async function instantSearch(manager: ConnectionManager, initial?: string): Promise<void> {
  const conn = manager.require();
  const libs = await indexedLibraries(conn.profile.id);
  if (!libs.length) {
    const build = vscode.l10n.t('Index Libraries');
    if (await vscode.window.showInformationMessage(vscode.l10n.t('No library is indexed yet for {0}. Indexing copies the sources once; after that, searching is instant.', conn.profile.name), build)) { await vscode.commands.executeCommand('vanthrex.index.build'); }
    return;
  }
  const { docs, types } = await docsArray(conn.profile.id);
  type Item = vscode.QuickPickItem & { hit?: { key: string; line: number; column: number; length: number } };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = vscode.l10n.t('Instant search in {0} indexed member(s) of {1} — "re:" for a regular expression, "w:" for whole words', docs.length, libs.join(', '));
  qp.placeholder = vscode.l10n.t('Type to search…');
  qp.matchOnDescription = false; qp.matchOnDetail = false;
  (qp as unknown as { sortByLabel: boolean }).sortByLabel = false;
  const ed = vscode.window.activeTextEditor;
  qp.value = initial ?? (ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection).split('\n')[0] : '');
  let timer: NodeJS.Timeout | undefined;
  const run = () => {
    const v = qp.value;
    if (v.trim().length < 2) { qp.items = []; return; }
    const regex = v.startsWith('re:'); const whole = v.startsWith('w:');
    const q = regex || whole ? v.slice(3) : v;
    try {
      const t0 = Date.now();
      const { hits, truncated } = searchIndex(docs, q, { regex, wholeWord: whole, max: 400 });
      const ms = Date.now() - t0;
      qp.items = [{ label: vscode.l10n.t('{0} match(es){1} in {2} ms', hits.length, truncated ? '+' : '', ms), kind: vscode.QuickPickItemKind.Separator },
        ...hits.map(h => ({ label: h.text.trim() || ' ', description: `${h.key}:${h.line + 1}`, alwaysShow: true, hit: h }))];
    } catch (e) { qp.items = [{ label: `$(error) ${errorMessage(e)}`, alwaysShow: true }]; }
  };
  qp.onDidChangeValue(() => { if (timer) { clearTimeout(timer); } timer = setTimeout(run, 120); });
  qp.onDidAccept(async () => {
    const h = qp.selectedItems[0]?.hit;
    if (!h) { return; }
    qp.hide();
    const [lib, file, member] = h.key.split('/');
    await openAt(lib, file, member, types.get(h.key) ?? '', h.line, h.column, h.length);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
  run();
}

// ---------------------------------------------------------------- Go to Definition across members

const defCache = new Map<string, vscode.Location | null>();

async function definitionElsewhere(manager: ConnectionManager, doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Location | undefined> {
  const conn = manager.connection;
  if (!conn) { return undefined; }
  const range = doc.getWordRangeAtPosition(pos, /[A-Za-z$#@_][\w$#@]*/);
  if (!range) { return undefined; }
  const word = doc.getText(range);
  // Built-in functions (%SUBST) and operation codes with an extender (CHAIN(N)) are not procedures.
  if (doc.lineAt(pos.line).text[range.start.character - 1] === '%' || OPCODES[word.toUpperCase()] || /^(IF|DOW|DOU|FOR|WHEN|ELSEIF|RETURN|EVAL|CALLP|DSPLY)$/i.test(word)) { return undefined; }
  const text = doc.getText();
  const W = word.replace(/[$#@]/g, '\\$&');
  // Defined in this source: the normal Go to Definition handles it.
  if (new RegExp(`^\\s*dcl-proc\\s+${W}\\b`, 'im').test(text) || new RegExp(`^\\s*(dcl-[sc]|dcl-ds|dcl-f)\\s+${W}\\b`, 'im').test(text)) { return undefined; }
  // Only for names used like a procedure (called, or declared with a prototype here).
  const line = doc.lineAt(pos.line).text;
  const called = new RegExp(`${W}\\s*\\(`, 'i').test(line.slice(range.start.character)) || /callp/i.test(line) || new RegExp(`^\\s*dcl-pr\\s+${W}\\b`, 'im').test(text);
  if (!called) { return undefined; }
  const key = `${conn.profile.id}|${word.toUpperCase()}`;
  if (defCache.has(key)) { return defCache.get(key) ?? undefined; }
  // 1. The local index: instant.
  const { docs, types } = await docsArray(conn.profile.id);
  const ext = new RegExp(`dcl-pr\\s+${W}\\b[^;]*extproc\\(\\s*'([^']+)'`, 'i').exec(text)?.[1] ?? word;
  const found = procedureDefinitions(docs, ext).concat(ext !== word ? procedureDefinitions(docs, word) : []);
  if (found.length) {
    const [lib, file, member] = found[0].key.split('/');
    const loc = new vscode.Location(memberUri(lib, file, member, types.get(found[0].key) ?? 'rpgle'), new vscode.Position(found[0].line, 0));
    defCache.set(key, loc);
    return loc;
  }
  // 2. The system: the service program that exports it, then the module source that defines it.
  try {
    const libs = [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean) as string[])];
    if (!libs.length) { return undefined; }
    const exp = await conn.rows<Row>(`SELECT PROGRAM_LIBRARY AS L, PROGRAM_NAME AS N FROM QSYS2.PROGRAM_EXPORT_IMPORT_INFO WHERE PROGRAM_LIBRARY IN (${libs.map(sqlString).join(', ')}) ` +
      `AND OBJECT_TYPE = '*SRVPGM' AND SYMBOL_USAGE = '*PROCEXP' AND UPPER(SYMBOL_NAME) = ${sqlString(ext.toUpperCase())} FETCH FIRST 3 ROWS ONLY`, 3);
    for (const e of exp) {
      const mods = await conn.rows<Row>(`SELECT SOURCE_FILE_LIBRARY AS SL, SOURCE_FILE AS SF, SOURCE_FILE_MEMBER AS SM FROM QSYS2.BOUND_MODULE_INFO WHERE PROGRAM_LIBRARY = ${sqlString(String(e.L).trim())} ` +
        `AND PROGRAM_NAME = ${sqlString(String(e.N).trim())} AND OBJECT_TYPE = '*SRVPGM' AND SOURCE_FILE_MEMBER IS NOT NULL`, 100);
      for (const m of mods) {
        const sl = String(m.SL).trim(), sf = String(m.SF).trim(), sm = String(m.SM).trim();
        const src = await conn.readMember(sl, sf, sm).catch(() => '');
        const defs = procedureDefinitions([[`${sl}/${sf}/${sm}`, src]], ext);
        if (defs.length) {
          const t = (await conn.rows<Row>(`SELECT COALESCE(SOURCE_TYPE, 'RPGLE') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(sl)} AND SYSTEM_TABLE_NAME = ${sqlString(sf)} AND SYSTEM_TABLE_MEMBER = ${sqlString(sm)}`, 1).catch(() => [] as Row[]))[0];
          const loc = new vscode.Location(memberUri(sl, sf, sm, String(t?.T ?? 'rpgle').trim()), new vscode.Position(defs[0].line, 0));
          defCache.set(key, loc);
          return loc;
        }
      }
    }
  } catch (e) { log(`Definition of ${word}: ${errorMessage(e)}`); }
  defCache.set(key, null);
  return undefined;
}

export function registerSourceIndex(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  root = vscode.Uri.joinPath(context.globalStorageUri, 'source-index');
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.index.build', wrap(() => buildCommand(manager, context.globalState))),
    vscode.commands.registerCommand('vanthrex.index.search', wrap((q?: string) => instantSearch(manager, typeof q === 'string' ? q : undefined))),
    vscode.commands.registerCommand('vanthrex.index.clear', wrap(async () => {
      const conn = manager.require();
      const yes = vscode.l10n.t('Remove');
      if (await vscode.window.showWarningMessage(vscode.l10n.t('Remove the local source index of {0}?', conn.profile.name), { modal: true }, yes) !== yes) { return; }
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(root!, safe(conn.profile.id)), { recursive: true }).then(undefined, () => undefined);
      [...loaded.keys()].filter(k => k.startsWith(conn.profile.id + '|')).forEach(k => loaded.delete(k));
      defCache.clear();
      vscode.window.setStatusBarMessage(vscode.l10n.t('Source index removed.'), 4000);
    })),
    vscode.languages.registerDefinitionProvider([{ language: 'rpgle' }], { provideDefinition: (doc, pos) => definitionElsewhere(manager, doc, pos) }),
    manager.onDidChange(() => defCache.clear()),
  );
}

/** Refreshes the libraries indexed before (used by the warm-up after connecting). */
export async function refreshIndexed(conn: IbmiConnection): Promise<number> {
  let n = 0;
  for (const lib of await indexedLibraries(conn.profile.id)) {
    try { n += (await refreshLibrary(conn, lib)).read; } catch (e) { log(`Index refresh of ${lib}: ${errorMessage(e)}`); }
  }
  return n;
}
