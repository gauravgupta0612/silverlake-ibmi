// Pure helpers for the PDM view (WRKLIBPDM / WRKOBJPDM / WRKMBRPDM in one screen): option lists,
// generic name subsets, CL commands for each option and PDM-style user-defined options.
// No vscode import, unit tested.

import { isValidSystemName } from './util';

export type PdmLevel = 'libraries' | 'objects' | 'members';

export interface PdmOption { code: string; label: string; /** Needs one extra answer for each row (new name, target…). */ asks?: boolean; types?: RegExp }

/** The options PDM users know, with the same numbers. Extra two-letter options are Vanthrex additions. */
export const MEMBER_OPTIONS: PdmOption[] = [
  { code: '2', label: 'Edit' }, { code: '3', label: 'Copy', asks: true }, { code: '4', label: 'Delete' },
  { code: '5', label: 'Display' }, { code: '6', label: 'Print' }, { code: '7', label: 'Rename', asks: true }, { code: '8', label: 'Display description' },
  { code: '13', label: 'Change text and type', asks: true }, { code: '14', label: 'Compile' }, { code: '15', label: 'Create module' },
  { code: '16', label: 'Local history' }, { code: '25', label: 'Find string', asks: true }, { code: '54', label: 'Compare (two members)' },
  { code: 'OB', label: 'Objects built from it' }, { code: 'SC', label: 'Changes since last compile' }, { code: 'PN', label: 'Pin / unpin' }, { code: 'GH', label: 'Git history' }, { code: 'UC', label: 'Unused code' }, { code: 'HL', label: 'Hard-coded libraries' },
];

export const OBJECT_OPTIONS: PdmOption[] = [
  { code: '4', label: 'Delete' }, { code: '5', label: 'Display (object information)' }, { code: '7', label: 'Rename', asks: true },
  { code: '8', label: 'Display description' }, { code: '11', label: 'Move', asks: true },
  { code: '12', label: 'Work with (members of a source file)', types: /^\*FILE$/ }, { code: '13', label: 'Change text', asks: true },
  { code: '15', label: 'Copy (duplicate)', asks: true }, { code: '16', label: 'Run (call program)', types: /^\*PGM$/ },
  { code: '18', label: 'Change data (edit table)', types: /^\*FILE$/ }, { code: '34', label: 'Debug', types: /^\*PGM$/ },
  { code: 'PN', label: 'Pin / unpin' }, { code: 'WU', label: 'Where used' }, { code: 'LK', label: 'Who has it locked' }, { code: 'DP', label: 'What depends on this file', types: /^\*FILE$/ },
];

export const LIBRARY_OPTIONS: PdmOption[] = [
  { code: '5', label: 'Display objects' }, { code: '8', label: 'Display description' }, { code: '12', label: 'Work with objects' },
  { code: '13', label: 'Change text', asks: true }, { code: 'SF', label: 'Work with source files' }, { code: 'AM', label: 'Work with all members' },
  { code: 'PN', label: 'Pin / unpin' }, { code: 'LL', label: 'Add to library list' }, { code: 'CL', label: 'Set as current library' },
];

export function optionsFor(level: PdmLevel): PdmOption[] {
  return level === 'members' ? MEMBER_OPTIONS : level === 'objects' ? OBJECT_OPTIONS : LIBRARY_OPTIONS;
}

// ---------------------------------------------------------------- names and subsets

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** PDM generic names: ABC*, *ABC, *ABC*, *ALL, or a plain name. */
export function matchGeneric(name: string, pattern: string): boolean {
  const p = pattern.trim().toUpperCase();
  if (!p || p === '*ALL') { return true; }
  const re = new RegExp(`^${p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(name.trim());
}

export interface PdmRow { name: string; type: string; /** Source file of a member (lists over several source files). */ file?: string; attribute?: string; text: string; changed?: string; size?: number; lockedBy?: string; objStatus?: ObjStatus; /** Full source change timestamp (for the object status). */ srcChanged?: string }
/** '' = not something you compile, none = no object yet, current = object newer than the source, stale = source changed after the object. */
export type ObjStatus = '' | 'none' | 'current' | 'stale';
export interface Subset { name?: string; type?: string; text?: string; since?: string; needsCompile?: boolean; locked?: boolean }

export function applySubset(rows: PdmRow[], s: Subset): PdmRow[] {
  const since = s.since?.trim();
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) { throw new Error('Enter the date as YYYY-MM-DD.'); }
  return rows.filter(r => matchGeneric(r.name, s.name ?? '*ALL')
    && (!s.type?.trim() || matchGeneric(r.type, s.type) || (!!r.attribute && matchGeneric(r.attribute, s.type)))
    && (!s.text?.trim() || r.text.toLowerCase().includes(s.text.trim().toLowerCase()))
    && (!since || (r.changed ?? '') >= since)
    && (!s.needsCompile || r.objStatus === 'stale' || r.objStatus === 'none')
    && (!s.locked || !!r.lockedBy));
}

/** Index of the first row at or after a name (PDM "Position to"). */
export function positionTo(rows: PdmRow[], name: string): number {
  const n = name.trim().toUpperCase();
  if (!n) { return 0; }
  const i = rows.findIndex(r => r.name.toUpperCase() >= n);
  return i < 0 ? Math.max(0, rows.length - 1) : i;
}

/** Normalize what was typed in the option column; empty entries are dropped. */
export function parseEntries(entries: { index: number; option: string }[], valid: string[]): { index: number; option: string }[] {
  const ok = new Set(valid.map(v => v.toUpperCase()));
  const out: { index: number; option: string }[] = [];
  for (const e of entries) {
    const o = e.option.trim().toUpperCase();
    if (!o) { continue; }
    if (!ok.has(o)) { throw new Error(`Option ${o} is not valid here.`); }
    out.push({ index: e.index, option: o });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------- CL for each option

export function addMemberCommand(lib: string, file: string, mbr: string, type: string, text: string): string {
  const t = type.trim().toUpperCase();
  if (t && !/^[A-Z0-9]{1,10}$/.test(t)) { throw new Error('The source type is 1–10 letters or digits.'); }
  return `ADDPFM FILE(${NAME(lib, 'library')}/${NAME(file, 'file')}) MBR(${NAME(mbr, 'member')}) TEXT(${q(text.slice(0, 50))})${t ? ` SRCTYPE(${t})` : ''}`;
}

export function removeMemberCommand(lib: string, file: string, mbr: string): string {
  return `RMVM FILE(${NAME(lib, 'library')}/${NAME(file, 'file')}) MBR(${NAME(mbr, 'member')})`;
}

export function renameMemberCommand(lib: string, file: string, mbr: string, to: string): string {
  return `RNMM FILE(${NAME(lib, 'library')}/${NAME(file, 'file')}) MBR(${NAME(mbr, 'member')}) NEWMBR(${NAME(to, 'member')})`;
}

export function changeMemberCommand(lib: string, file: string, mbr: string, text: string, type?: string): string {
  const t = type?.trim().toUpperCase();
  if (t && !/^[A-Z0-9]{1,10}$/.test(t)) { throw new Error('The source type is 1–10 letters or digits.'); }
  return `CHGPFM FILE(${NAME(lib, 'library')}/${NAME(file, 'file')}) MBR(${NAME(mbr, 'member')}) TEXT(${q(text.slice(0, 50))})${t ? ` SRCTYPE(${t})` : ''}`;
}

export function copyMemberCommand(lib: string, file: string, mbr: string, toLib: string, toFile: string, toMbr: string): string {
  return `CPYSRCF FROMFILE(${NAME(lib, 'library')}/${NAME(file, 'file')}) TOFILE(${NAME(toLib, 'library')}/${NAME(toFile, 'file')}) ` +
    `FROMMBR(${NAME(mbr, 'member')}) TOMBR(${NAME(toMbr, 'member')}) MBROPT(*REPLACE)`;
}

/** CRTxxxMOD for option 15, by source type. */
export function createModuleCommand(lib: string, file: string, mbr: string, type: string, objLib: string): string {
  const cmd: Record<string, string> = { RPGLE: 'CRTRPGMOD', SQLRPGLE: 'CRTSQLRPGI', CLLE: 'CRTCLMOD', CBLLE: 'CRTCBLMOD', SQLCBLLE: 'CRTSQLCBLI', C: 'CRTCMOD', CPP: 'CRTCPPMOD' };
  const t = type.trim().toUpperCase();
  const c = cmd[t];
  if (!c) { throw new Error(`Option 15 works on RPGLE, SQLRPGLE, CLLE, CBLLE, SQLCBLLE, C and CPP members, not ${t || 'this type'}.`); }
  const m = `${NAME(objLib, 'library')}/${NAME(mbr, 'member')}`;
  const src = `SRCFILE(${NAME(lib, 'library')}/${NAME(file, 'file')}) SRCMBR(${NAME(mbr, 'member')})`;
  return c.startsWith('CRTSQL') ? `${c} OBJ(${m}) ${src} OBJTYPE(*MODULE) DBGVIEW(*SOURCE)` : `${c} MODULE(${m}) ${src} DBGVIEW(*SOURCE)`;
}

export function renameObjectCommand(lib: string, obj: string, type: string, to: string): string {
  return `RNMOBJ OBJ(${NAME(lib, 'library')}/${NAME(obj, 'object')}) OBJTYPE(${type}) NEWOBJ(${NAME(to, 'object')})`;
}

export function moveObjectCommand(lib: string, obj: string, type: string, toLib: string): string {
  return `MOVOBJ OBJ(${NAME(lib, 'library')}/${NAME(obj, 'object')}) OBJTYPE(${type}) TOLIB(${NAME(toLib, 'library')})`;
}

export function duplicateObjectCommand(lib: string, obj: string, type: string, toLib: string, newName: string): string {
  return `CRTDUPOBJ OBJ(${NAME(obj, 'object')}) FROMLIB(${NAME(lib, 'library')}) OBJTYPE(${type}) TOLIB(${NAME(toLib, 'library')}) NEWOBJ(${NAME(newName, 'object')}) DATA(*YES)`;
}

const DELETE_BY_TYPE: Record<string, [string, string]> = {
  '*PGM': ['DLTPGM', 'PGM'], '*SRVPGM': ['DLTSRVPGM', 'SRVPGM'], '*MODULE': ['DLTMOD', 'MODULE'], '*FILE': ['DLTF', 'FILE'],
  '*DTAARA': ['DLTDTAARA', 'DTAARA'], '*DTAQ': ['DLTDTAQ', 'DTAQ'], '*CMD': ['DLTCMD', 'CMD'], '*BNDDIR': ['DLTBNDDIR', 'BNDDIR'],
  '*MSGF': ['DLTMSGF', 'MSGF'], '*JOBD': ['DLTJOBD', 'JOBD'], '*OUTQ': ['DLTOUTQ', 'OUTQ'], '*USRSPC': ['DLTUSRSPC', 'USRSPC'], '*MENU': ['DLTMNU', 'MENU'],
};

export function deleteObjectCommand(lib: string, obj: string, type: string): string {
  const t = type.trim().toUpperCase();
  if (!/^\*[A-Z]{2,9}$/.test(t)) { throw new Error(`"${type}" is not an object type.`); }
  const d = DELETE_BY_TYPE[t];
  const o = `${NAME(lib, 'library')}/${NAME(obj, 'object')}`;
  return d ? `${d[0]} ${d[1]}(${o})` : `DLTOBJ OBJ(${o}) OBJTYPE(${t})`;
}

export function createLibraryCommand(lib: string, text: string, test: boolean): string {
  return `CRTLIB LIB(${NAME(lib, 'library')}) TYPE(${test ? '*TEST' : '*PROD'}) TEXT(${q(text.slice(0, 50))})`;
}

export function objectTextCommand(lib: string, obj: string, type: string, text: string): string {
  return `CHGOBJD OBJ(${NAME(lib, 'library')}/${NAME(obj, 'object')}) OBJTYPE(${type}) TEXT(${q(text.slice(0, 50))})`;
}

export function libraryTextCommand(lib: string, text: string): string {
  return `CHGLIB LIB(${NAME(lib, 'library')}) TEXT(${q(text.slice(0, 50))})`;
}

// ---------------------------------------------------------------- user-defined options (PDM F16)

export const DEFAULT_USER_OPTIONS: Record<string, string> = {
  CB: 'CRTBNDRPG PGM(&O/&N) SRCFILE(&L/&F) SRCMBR(&N) DBGVIEW(*SOURCE)',
  CS: 'CRTSQLRPGI OBJ(&O/&N) SRCFILE(&L/&F) SRCMBR(&N) DBGVIEW(*SOURCE)',
  CC: 'CRTBNDCL PGM(&O/&N) SRCFILE(&L/&F) SRCMBR(&N) DBGVIEW(*SOURCE)',
  DF: 'CRTDSPF FILE(&O/&N) SRCFILE(&L/&F) SRCMBR(&N)',
  PF: 'CRTPF FILE(&O/&N) SRCFILE(&L/&F) SRCMBR(&N)',
  RS: 'RUNSQLSTM SRCFILE(&L/&F) SRCMBR(&N) COMMIT(*NONE) NAMING(*SYS)',
};

export interface PdmVars { library: string; file?: string; name: string; type?: string; attribute?: string; objectLibrary: string; user: string; text?: string }

/**
 * PDM substitution variables: &L library, &F file, &N member or object name, &T type, &A attribute,
 * &O object library, &U user, &X text, && a literal &.
 */
export function substitutePdm(template: string, v: PdmVars): string {
  const map: Record<string, string> = { L: v.library, F: v.file ?? '', N: v.name, T: v.type ?? '', A: v.attribute ?? '', O: v.objectLibrary, U: v.user, X: v.text ?? '' };
  return template.replace(/&(&|[LFNTAOUX])/gi, (_, k: string) => (k === '&' ? '&' : map[k.toUpperCase()]));
}

export function validUserOptionCode(code: string, level: PdmLevel): boolean {
  const c = code.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]?$|^[0-9][A-Z]$/.test(c) && !optionsFor(level).some(o => o.code === c);
}

// ---------------------------------------------------------------- PDM commands typed on a command line

export interface PdmTarget { level: PdmLevel; library?: string; file?: string; name?: string; type?: string }

/** WRKMBRPDM FILE(LIB/FILE) MBR(X*) MBRTYPE(RPGLE), WRKOBJPDM LIB(L) OBJ(..) OBJTYPE(..), WRKLIBPDM LIB(A*), STRPDM. */
export function parsePdmCommand(cmd: string): PdmTarget | undefined {
  const c = cmd.trim().toUpperCase();
  const m = /^(WRKMBRPDM|WRKOBJPDM|WRKLIBPDM|STRPDM)\b/.exec(c);
  if (!m) { return undefined; }
  const kw = (k: string) => new RegExp(`\\b${k}\\(\\s*([^)]*?)\\s*\\)`).exec(c)?.[1];
  const pos = c.slice(m[0].length).trim().split(/\s+/).filter(x => x && !/\(/.test(x));
  if (m[1] === 'WRKMBRPDM') {
    const f = kw('FILE') ?? pos[0] ?? '';
    const [lib, file] = f.includes('/') ? f.split('/') : ['*LIBL', f];
    return { level: 'members', library: lib, file, name: kw('MBR'), type: kw('MBRTYPE') };
  }
  if (m[1] === 'WRKOBJPDM') { return { level: 'objects', library: kw('LIB') ?? pos[0], name: kw('OBJ'), type: kw('OBJTYPE') }; }
  if (m[1] === 'WRKLIBPDM') { return { level: 'libraries', name: kw('LIB') ?? pos[0] }; }
  return { level: 'libraries' };
}

// ---------------------------------------------------------------- export

export function rowsToCsv(rows: PdmRow[], level: PdmLevel): string {
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = level === 'members' ? ['Member', 'Type', 'Text', 'Changed', 'Lines'] : level === 'objects' ? ['Object', 'Type', 'Attribute', 'Text', 'Changed', 'Size'] : ['Library', 'Type', 'Text'];
  const body = rows.map(r => (level === 'members' ? [r.name, r.type, r.text, r.changed, r.size] : level === 'objects' ? [r.name, r.type, r.attribute, r.text, r.changed, r.size] : [r.name, r.type, r.text]).map(cell).join(','));
  return [head.join(','), ...body].join('\n') + '\n';
}

// ---------------------------------------------------------------- robustness helpers

export function printMemberCommand(lib: string, file: string, mbr: string): string {
  return `CPYSRCF FROMFILE(${NAME(lib, 'library')}/${NAME(file, 'file')}) TOFILE(*PRINT) FROMMBR(${NAME(mbr, 'member')})`;
}

/** The useful line of a failed CL command: the escape message (CPF…: text) rather than QSH noise. */
export function clError(stdout: string, stderr: string): string {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const msg = [...lines].reverse().find(l => /\b[A-Z]{3}[0-9A-F]{4}\b/.test(l) && !/^CPC|\bCPC[0-9A-F]{4}\b/.test(l));
  return (msg ?? lines.pop() ?? 'The command failed.').replace(/^qsh:\s*/i, '').slice(0, 300);
}

/** Options that change something on the system (confirmed when typed on many rows). */
export function changesSomething(level: PdmLevel, option: string, userCodes: string[]): boolean {
  const o = option.toUpperCase();
  if (userCodes.includes(o)) { return true; }
  const c: Record<PdmLevel, string[]> = { members: ['3', '4', '7', '13', '15'], objects: ['4', '7', '11', '13', '15'], libraries: ['13'] };
  return c[level].includes(o);
}

const NOT_COMPILED = /^(RPGLEINC|SQLRPGLEINC|INC|CPY|COPY|TXT|TEXT|MNUDDS|HELP|PNLGRP|BND|BNDSRC|SQL|CLP?INC|README|MD)$/;
const OBJECT_TYPES: Record<string, string[]> = {
  RPGLE: ['*PGM', '*MODULE'], SQLRPGLE: ['*PGM', '*MODULE'], RPG: ['*PGM'], SQLRPG: ['*PGM'], CLLE: ['*PGM', '*MODULE'], CLP: ['*PGM'], CL: ['*PGM'],
  CBLLE: ['*PGM', '*MODULE'], SQLCBLLE: ['*PGM', '*MODULE'], CBL: ['*PGM'], C: ['*PGM', '*MODULE'], CPP: ['*PGM', '*MODULE'],
  DSPF: ['*FILE'], PRTF: ['*FILE'], PF: ['*FILE'], LF: ['*FILE'], CMD: ['*CMD'], MENU: ['*MENU'],
};

/** Is the object built from this member older than the source? Timestamps as YYYY-MM-DD-HH.MM.SS (any precision). */
export function objectStatus(srcType: string, memberChanged: string | undefined, objects: { type: string; created: string }[]): ObjStatus {
  const t = srcType.trim().toUpperCase();
  const types = OBJECT_TYPES[t];
  if (!t || NOT_COMPILED.test(t) || !types) { return ''; }
  const norm = (x: string) => x.replace(/[ T]/, '-').replace(/:/g, '.').slice(0, 19);
  const mine = objects.filter(o => types.includes(o.type.trim().toUpperCase()) && o.created);
  if (!mine.length) { return 'none'; }
  if (!memberChanged) { return 'current'; }
  const newest = mine.map(o => norm(o.created)).sort().pop()!;
  return norm(memberChanged) > newest ? 'stale' : 'current';
}

/** Rows per type, most common first (for the type chips). */
export function typeCounts(rows: PdmRow[]): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) { const t = (r.attribute === 'PF-SRC' ? 'PF-SRC' : r.type) || '—'; m.set(t, (m.get(t) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
}

// ---------------------------------------------------------------- members of several source files

/** FILE(*ALL) or a generic name like Q*SRC: list members of every matching source file. */
export function isMultiFile(file: string | undefined): boolean {
  const f = (file ?? '').trim().toUpperCase();
  return f === '*ALL' || f.includes('*');
}

/** SQL LIKE pattern for a PDM generic name (*ALL → %). */
export function likePattern(generic: string): string {
  const g = generic.trim().toUpperCase();
  if (!g || g === '*ALL') { return '%'; }
  if (!/^[A-Z0-9$#@_.*]{1,11}$/.test(g)) { throw new Error(`"${generic}" is not a valid generic name.`); }
  return g.replace(/\*/g, '%');   // _ stays a one-character wildcard: harmless for a list
}
