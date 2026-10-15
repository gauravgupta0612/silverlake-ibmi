// Pure helpers for the PDM view (WRKLIBPDM / WRKOBJPDM / WRKMBRPDM in one screen): option lists,
// generic name subsets, CL commands for each option and PDM-style user-defined options.
// No vscode import, unit tested.

import { isValidSystemName } from './util';

export type PdmLevel = 'libraries' | 'objects' | 'members';

export interface PdmOption { code: string; label: string; /** Needs one extra answer for each row (new name, target…). */ asks?: boolean; types?: RegExp }

/** The options PDM users know, with the same numbers. Extra two-letter options are Vanthrex additions. */
export const MEMBER_OPTIONS: PdmOption[] = [
  { code: '2', label: 'Edit' }, { code: '3', label: 'Copy', asks: true }, { code: '4', label: 'Delete' },
  { code: '5', label: 'Display' }, { code: '7', label: 'Rename', asks: true }, { code: '8', label: 'Display description' },
  { code: '13', label: 'Change text and type', asks: true }, { code: '14', label: 'Compile' }, { code: '15', label: 'Create module' },
  { code: '16', label: 'Local history' }, { code: '25', label: 'Find string', asks: true }, { code: '54', label: 'Compare (two members)' },
  { code: 'GH', label: 'Git history' }, { code: 'UC', label: 'Unused code' }, { code: 'HL', label: 'Hard-coded libraries' },
];

export const OBJECT_OPTIONS: PdmOption[] = [
  { code: '4', label: 'Delete' }, { code: '5', label: 'Display (object information)' }, { code: '7', label: 'Rename', asks: true },
  { code: '8', label: 'Display description' }, { code: '11', label: 'Move', asks: true },
  { code: '12', label: 'Work with (members of a source file)', types: /^\*FILE$/ }, { code: '13', label: 'Change text', asks: true },
  { code: '15', label: 'Copy (duplicate)', asks: true }, { code: '16', label: 'Run (call program)', types: /^\*PGM$/ },
  { code: '18', label: 'Change data (edit table)', types: /^\*FILE$/ }, { code: '34', label: 'Debug', types: /^\*PGM$/ },
  { code: 'WU', label: 'Where used' }, { code: 'LK', label: 'Who has it locked' }, { code: 'DP', label: 'What depends on this file', types: /^\*FILE$/ },
];

export const LIBRARY_OPTIONS: PdmOption[] = [
  { code: '5', label: 'Display objects' }, { code: '8', label: 'Display description' }, { code: '12', label: 'Work with objects' },
  { code: '13', label: 'Change text', asks: true }, { code: 'SF', label: 'Work with source files' },
  { code: 'LL', label: 'Add to library list' }, { code: 'CL', label: 'Set as current library' },
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

export interface PdmRow { name: string; type: string; attribute?: string; text: string; changed?: string; size?: number }
export interface Subset { name?: string; type?: string; text?: string; since?: string }

export function applySubset(rows: PdmRow[], s: Subset): PdmRow[] {
  const since = s.since?.trim();
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) { throw new Error('Enter the date as YYYY-MM-DD.'); }
  return rows.filter(r => matchGeneric(r.name, s.name ?? '*ALL')
    && (!s.type?.trim() || matchGeneric(r.type, s.type) || (!!r.attribute && matchGeneric(r.attribute, s.type)))
    && (!s.text?.trim() || r.text.toLowerCase().includes(s.text.trim().toLowerCase()))
    && (!since || (r.changed ?? '') >= since));
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
