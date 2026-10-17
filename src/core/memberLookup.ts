// Find a member anywhere, objects built from a source member, compile on save and the member status bar. Pure functions
// (no vscode import), unit tested.


const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** First non-empty value among several possible column names (IBM i services differ between releases). */
export function pick(r: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const k of keys) {
    const v = r?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') { return String(v).trim(); }
  }
  return '';
}

/** SQL that finds members by generic name in some libraries (or every user library when libs is empty). */
export function findMemberSql(generic: string, libs: string[], typeFilter?: string): string {
  const g = generic.trim().toUpperCase();
  if (!/^[A-Z0-9$#@_.*]{1,11}$/.test(g) || g === '*') { throw new Error('Enter a member name or a generic name such as ORD* or *CUST*.'); }
  const like = g.replace(/\*/g, '%');
  const where = [`SYSTEM_TABLE_MEMBER LIKE ${q(like)}`, 'SOURCE_TYPE IS NOT NULL'];
  if (libs.length) {
    where.push(`SYSTEM_TABLE_SCHEMA IN (${libs.map(l => q(l.toUpperCase())).join(', ')})`);
  } else {
    where.push(`SYSTEM_TABLE_SCHEMA NOT LIKE 'Q%'`, `SYSTEM_TABLE_SCHEMA NOT LIKE 'SYS%'`, `SYSTEM_TABLE_SCHEMA NOT LIKE '#%'`);
  }
  const t = typeFilter?.trim().toUpperCase();
  if (t) {
    if (!/^[A-Z0-9*]{1,10}$/.test(t)) { throw new Error('The source type is 1–10 letters or digits.'); }
    where.push(`SOURCE_TYPE LIKE ${q(t.replace(/\*/g, '%'))}`);
  }
  return `SELECT SYSTEM_TABLE_SCHEMA AS L, SYSTEM_TABLE_NAME AS F, SYSTEM_TABLE_MEMBER AS M, SOURCE_TYPE AS T, ` +
    `COALESCE(PARTITION_TEXT, '') AS X, VARCHAR(COALESCE(LAST_SOURCE_UPDATE_TIMESTAMP, LAST_CHANGE_TIMESTAMP)) AS C ` +
    `FROM QSYS2.SYSPARTITIONSTAT WHERE ${where.join(' AND ')} ORDER BY C DESC`;
}

/** Order of the libraries a member was found in, by library list position (first = what *LIBL would pick). */
export function libraryRank(lib: string, libl: string[]): number {
  const i = libl.map(l => l.toUpperCase()).indexOf(lib.toUpperCase());
  return i < 0 ? 999 : i;
}

const norm = (x: string) => x.replace(/[ T]/, '-').replace(/:/g, '.').slice(0, 19);

/** Was the object compiled from the member as it is now? Uses the source change time recorded in the object. */
export function builtFromStatus(memberChanged: string | undefined, sourceAtCompile: string | undefined): 'current' | 'stale' | 'unknown' {
  if (!memberChanged || !sourceAtCompile) { return 'unknown'; }
  return norm(memberChanged) > norm(sourceAtCompile) ? 'stale' : 'current';
}

export interface BuiltObject { library: string; name: string; type: string; module?: string; created?: string; sourceAtCompile?: string; status: 'current' | 'stale' | 'unknown' }

/** Rows of QSYS2.PROGRAM_INFO (OPM) and QSYS2.BOUND_MODULE_INFO (ILE) as one list, newest first. */
export function builtObjects(programRows: Record<string, unknown>[], moduleRows: Record<string, unknown>[], memberChanged?: string): BuiltObject[] {
  const out: BuiltObject[] = [];
  for (const r of programRows) {
    const src = pick(r, 'SOURCE_FILE_CHANGE_TIMESTAMP', 'SOURCE_CHANGE_TIMESTAMP');
    out.push({ library: pick(r, 'PROGRAM_LIBRARY'), name: pick(r, 'PROGRAM_NAME'), type: pick(r, 'OBJECT_TYPE') || '*PGM',
      created: pick(r, 'PROGRAM_CREATE_TIMESTAMP', 'CREATE_TIMESTAMP', 'CREATION_TIMESTAMP'), sourceAtCompile: src, status: builtFromStatus(memberChanged, src) });
  }
  for (const r of moduleRows) {
    const src = pick(r, 'SOURCE_CHANGE_TIMESTAMP', 'SOURCE_FILE_CHANGE_TIMESTAMP');
    out.push({ library: pick(r, 'PROGRAM_LIBRARY'), name: pick(r, 'PROGRAM_NAME'), type: pick(r, 'OBJECT_TYPE', 'PROGRAM_TYPE') || '*PGM',
      module: `${pick(r, 'BOUND_MODULE_LIBRARY')}/${pick(r, 'BOUND_MODULE')}`.replace(/^\//, ''), created: pick(r, 'MODULE_CREATE_TIMESTAMP', 'CREATE_TIMESTAMP'),
      sourceAtCompile: src, status: builtFromStatus(memberChanged, src) });
  }
  const seen = new Set<string>();
  return out.filter(o => { const k = `${o.library}/${o.name}/${o.type}/${o.module ?? ''}`; if (seen.has(k)) { return false; } seen.add(k); return true; })
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
}

export function builtFromSql(view: 'PROGRAM_INFO' | 'BOUND_MODULE_INFO', lib: string, file: string, member: string, programLibs: string[]): string {
  const where = [`SOURCE_FILE_LIBRARY = ${q(lib.toUpperCase())}`, `SOURCE_FILE = ${q(file.toUpperCase())}`, `SOURCE_FILE_MEMBER = ${q(member.toUpperCase())}`];
  if (programLibs.length) { where.push(`PROGRAM_LIBRARY IN (${[...new Set(programLibs.map(l => l.toUpperCase()))].map(q).join(', ')})`); }
  return `SELECT * FROM QSYS2.${view} WHERE ${where.join(' AND ')}`;
}

export type CompileOnSave = 'off' | 'ask' | 'always';

const COMPILABLE = /^(RPGLE|SQLRPGLE|RPG|SQLRPG|CLLE|CLP|CL|CBLLE|SQLCBLLE|CBL|C|CPP|DSPF|PRTF|PF|LF|CMD|SQL|TABLE|VIEW|INDEX|PROCEDURE|FUNCTION|TRIGGER|BND)$/;

/** Should saving a member of this type compile it? Copy members (INC, RPGLEINC…) never do. */
export function compileOnSaveAction(type: string, mode: CompileOnSave, types: string[] = []): 'none' | 'ask' | 'compile' {
  const t = type.trim().toUpperCase();
  if (mode === 'off' || !COMPILABLE.test(t)) { return 'none'; }
  if (types.length && !types.map(x => x.toUpperCase()).includes(t)) { return 'none'; }
  return mode === 'always' ? 'compile' : 'ask';
}

export interface MemberStatus { lockedBy?: string; changed?: string; objects: BuiltObject[] }

/** One short status bar text for the active member. */
export function statusText(s: MemberStatus): { text: string; tooltip: string; warn: boolean } {
  const parts: string[] = [];
  const tips: string[] = [];
  let warn = false;
  if (s.lockedBy) { parts.push(`$(lock) ${s.lockedBy.split('/').slice(1, 2).join('') || s.lockedBy}`); tips.push(`In use by ${s.lockedBy}`); warn = true; }
  const stale = s.objects.filter(o => o.status === 'stale');
  if (!s.objects.length) { parts.push('$(circle-outline) not compiled'); tips.push('No program or module in your library list was built from this member.'); }
  else if (stale.length) { parts.push(`$(warning) ${stale.length} out of date`); tips.push(`Changed after compiling: ${stale.map(o => `${o.library}/${o.name}`).join(', ')}`); warn = true; }
  else { parts.push(`$(check) ${s.objects.length === 1 ? `${s.objects[0].library}/${s.objects[0].name}` : `${s.objects.length} objects`}`); tips.push(`Built into ${s.objects.map(o => `${o.library}/${o.name}`).join(', ')}`); }
  return { text: parts.join('  '), tooltip: tips.join('\n'), warn };
}
