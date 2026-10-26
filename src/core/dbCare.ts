// Database care: indexes nobody uses, files that are not journaled, programs that will get a level check after a
// file change, and library snapshots to see what a release really changed. Pure (no vscode import), unit tested.

type Row = Record<string, unknown>;
const s = (r: Row, ...keys: string[]) => { for (const k of keys) { const v = r[k]; if (v !== undefined && v !== null && String(v).trim() !== '') { return String(v).trim(); } } return ''; };
const n = (r: Row, ...keys: string[]) => Number(s(r, ...keys)) || 0;
const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

export function checkLibrary(lib: string): string {
  const l = lib.trim().toUpperCase();
  if (!NAME.test(l)) { throw new Error(`"${lib}" is not a valid library name.`); }
  return l;
}

// ---------------------------------------------------------------- unused indexes

export function indexStatsSql(lib: string): string {
  return `SELECT * FROM QSYS2.SYSINDEXSTAT WHERE SYSTEM_TABLE_SCHEMA = '${checkLibrary(lib)}' ORDER BY TABLE_NAME, INDEX_NAME FETCH FIRST 5000 ROWS ONLY`;
}

export interface IndexUse { schema: string; name: string; systemName: string; table: string; kind: string; columns: string; size: number; lastQuery: string; lastUsed: string; queryUses: number; unused: boolean; why: string; keep?: string }

const day = (ts: string) => (ts ? ts.replace('T', ' ').slice(0, 10) : '');

/**
 * Indexes and keyed logical files that no query used and nothing opened for `days` days. Unique and constraint indexes
 * are never proposed: they enforce data rules even when nobody reads through them.
 */
export function indexUse(rows: Row[], now: Date, days = 180): IndexUse[] {
  const limit = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  return rows.map(r => {
    const kind = s(r, 'INDEX_TYPE');
    const lastQuery = day(s(r, 'LAST_QUERY_USE')); const lastStats = day(s(r, 'LAST_STATISTICS_USE')); const lastUsed = day(s(r, 'LAST_USED_TIMESTAMP'));
    const created = day(s(r, 'CREATE_TIMESTAMP'));
    const unique = /UNIQUE|PRIMARY|FOREIGN|CONSTRAINT/i.test(kind) || /^(U|P|V)$/.test(s(r, 'IS_UNIQUE')) || /\bUNIQUE\b/i.test(s(r, 'INDEX_DEFINITION'));
    const recent = (d: string) => !!d && d >= limit;
    let keep: string | undefined;
    if (unique) { keep = 'enforces uniqueness or a constraint'; }
    else if (created && created >= limit) { keep = `created ${created}, too recent to judge`; }
    const unused = !keep && !recent(lastQuery) && !recent(lastStats) && !recent(lastUsed);
    const why = unused ? `no query use${lastQuery ? ` since ${lastQuery}` : ''}, not opened${lastUsed ? ` since ${lastUsed}` : ''}` : keep ?? `used ${[lastQuery && `by queries ${lastQuery}`, lastUsed && `opened ${lastUsed}`].filter(Boolean).join(', ')}`;
    return { schema: s(r, 'INDEX_SCHEMA', 'SYSTEM_INDEX_SCHEMA'), name: s(r, 'INDEX_NAME'), systemName: s(r, 'SYSTEM_INDEX_NAME', 'INDEX_NAME'), table: s(r, 'TABLE_NAME', 'SYSTEM_TABLE_NAME'), kind,
      columns: s(r, 'COLUMN_NAMES'), size: n(r, 'INDEX_SIZE'), lastQuery, lastUsed, queryUses: n(r, 'QUERY_USE_COUNT'), unused, why, keep };
  }).sort((a, b) => Number(b.unused) - Number(a.unused) || b.size - a.size);
}

/** The statement that removes an index (SQL index) or a keyed logical file (DDS). */
export function dropIndexCommand(i: IndexUse, library: string): string {
  return /LOGICAL/i.test(i.kind) ? `DLTF FILE(${library}/${i.systemName})` : `DROP INDEX ${i.schema}.${i.name.includes(' ') || /[a-z]/.test(i.name) ? `"${i.name}"` : i.name}`;
}

// ---------------------------------------------------------------- journal coverage

export function journalCoverageSql(lib: string): string {
  return `SELECT OBJNAME AS N, COALESCE(OBJTEXT, '') AS T, COALESCE(JOURNALED, 'NO') AS J, COALESCE(JOURNAL_LIBRARY, '') AS JL, COALESCE(JOURNAL_NAME, '') AS JN, ` +
    `COALESCE(JOURNAL_IMAGES, '') AS IMG, OBJSIZE AS S FROM TABLE(QSYS2.OBJECT_STATISTICS('${checkLibrary(lib)}', '*FILE')) X WHERE OBJATTRIBUTE = 'PF' ORDER BY OBJNAME`;
}

/** STRJRNPF commands (50 files each) to journal the given files to one journal. */
export function strjrnpfCommands(lib: string, files: string[], journal: string, images: '*BOTH' | '*AFTER' = '*BOTH'): string[] {
  const l = checkLibrary(lib);
  const [jl, jn] = journal.toUpperCase().includes('/') ? journal.toUpperCase().split('/') : [l, journal.toUpperCase()];
  if (!NAME.test(jl) || !NAME.test(jn)) { throw new Error(`"${journal}" is not a valid journal (LIBRARY/JOURNAL).`); }
  const out: string[] = [];
  for (let i = 0; i < files.length; i += 50) {
    out.push(`STRJRNPF FILE(${files.slice(i, i + 50).map(f => `${l}/${f}`).join(' ')}) JRN(${jl}/${jn}) IMAGES(${images}) OMTJRNE(*OPNCLO)`);
  }
  return out;
}

// ---------------------------------------------------------------- level checks

export interface FormatUse { lib: string; pgm: string; file: string; format: string; level: string }

/** Programs compiled against an older record format level than the file has now (they would end with CPF4131). */
export function levelMismatches(uses: FormatUse[], current: Map<string, string>): (FormatUse & { now: string })[] {
  return uses.filter(u => u.level && current.has(u.format) && current.get(u.format) !== u.level)
    .map(u => ({ ...u, now: current.get(u.format)! }))
    .sort((a, b) => a.lib.localeCompare(b.lib) || a.pgm.localeCompare(b.pgm));
}

/** Record format → level identifier from DSPFD TYPE(*RCDFMT) output (QAFDRFMT: RFNAME, RFID). */
export function currentLevels(rows: Row[]): Map<string, string> {
  return new Map(rows.map(r => [s(r, 'RFNAME', 'RCDFMT'), s(r, 'RFID', 'RFLVL', 'LEVEL')] as [string, string]).filter(([a, b]) => a && b));
}

/** Uses of a file's formats from DSPPGMREF output (QADSPPGM: WHLIB, WHPNAM, WHFNAM, WHRFNM, WHRFSN). */
export function formatUses(rows: Row[], file: string): FormatUse[] {
  return rows.filter(r => s(r, 'WHFNAM') === file.toUpperCase() && s(r, 'WHRFNM'))
    .map(r => ({ lib: s(r, 'WHLIB'), pgm: s(r, 'WHPNAM'), file: s(r, 'WHFNAM'), format: s(r, 'WHRFNM'), level: s(r, 'WHRFSN') }));
}

// ---------------------------------------------------------------- library snapshot

export interface SnapObject { name: string; type: string; attribute: string; size: number; changed: string; source: string; text: string }
export interface Snapshot { library: string; system: string; taken: string; objects: SnapObject[] }

export function snapshotSql(lib: string): string {
  return `SELECT OBJNAME AS N, OBJTYPE AS T, COALESCE(OBJATTRIBUTE, '') AS A, OBJSIZE AS S, VARCHAR(COALESCE(CHANGE_TIMESTAMP, OBJCREATED)) AS C, ` +
    `TRIM(COALESCE(SOURCE_LIBRARY, '')) || CASE WHEN SOURCE_FILE IS NULL THEN '' ELSE '/' || TRIM(SOURCE_FILE) || '(' || TRIM(COALESCE(SOURCE_MEMBER, '')) || ')' END AS SRC, ` +
    `COALESCE(OBJTEXT, '') AS X FROM TABLE(QSYS2.OBJECT_STATISTICS('${checkLibrary(lib)}', '*ALL')) O ORDER BY OBJTYPE, OBJNAME`;
}

export function toSnapObject(r: Row): SnapObject {
  return { name: s(r, 'N'), type: s(r, 'T'), attribute: s(r, 'A'), size: n(r, 'S'), changed: s(r, 'C').replace('T', ' ').slice(0, 19), source: s(r, 'SRC'), text: s(r, 'X') };
}

export interface SnapDiff { kind: 'added' | 'removed' | 'changed'; name: string; type: string; what: string; before?: SnapObject; after?: SnapObject }

export function compareSnapshots(before: SnapObject[], after: SnapObject[]): SnapDiff[] {
  const key = (o: SnapObject) => `${o.name}${o.type}`;
  const a = new Map(before.map(o => [key(o), o])); const b = new Map(after.map(o => [key(o), o]));
  const out: SnapDiff[] = [];
  for (const [k, o] of b) {
    const old = a.get(k);
    if (!old) { out.push({ kind: 'added', name: o.name, type: o.type, what: o.text, after: o }); continue; }
    const what: string[] = [];
    if (old.changed !== o.changed) { what.push(`changed ${old.changed} → ${o.changed}`); }
    if (old.size !== o.size) { what.push(`size ${old.size} → ${o.size}`); }
    if (old.source !== o.source) { what.push(`source ${old.source || '—'} → ${o.source || '—'}`); }
    if (old.text !== o.text) { what.push('text'); }
    if (what.length) { out.push({ kind: 'changed', name: o.name, type: o.type, what: what.join(', '), before: old, after: o }); }
  }
  for (const [k, o] of a) { if (!b.has(k)) { out.push({ kind: 'removed', name: o.name, type: o.type, what: o.text, before: o }); } }
  const order = { added: 0, changed: 1, removed: 2 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || x.type.localeCompare(y.type) || x.name.localeCompare(y.name));
}
