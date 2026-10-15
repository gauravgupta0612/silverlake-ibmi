// Pure helpers for 2.3: source quality report, library list from a job description, public authority scan
// and system value comparison between two systems. No vscode import, unit tested.

import { lintRpg } from '../rpg/lint';
import { parseRpg } from '../rpg/parser';
import { indicatorUsage } from './v23';

// ---------------------------------------------------------------- source quality

export interface SourceHealth {
  lines: number; code: number; fixed: number; free: number; fixedPct: number;
  errors: number; warnings: number; infos: number; rules: Record<string, number>;
  indicators: number; gotos: number; subroutines: number; procedures: number; score: number;
}

const RPG_TYPES = /^(RPGLE|SQLRPGLE|RPGLEINC|SQLRPGLEINC)$/i;
export function isRpgType(t: string): boolean { return RPG_TYPES.test(t.trim()); }

/** One member's numbers. Score: 100, minus errors, warnings, GOTOs, indicators and fixed format. */
export function sourceHealth(text: string): SourceHealth {
  const lines = text.split(/\r?\n/);
  const fullyFree = /^\s*\*\*FREE/i.test(lines[0] ?? '');
  let code = 0; let fixed = 0; let gotos = 0;
  for (const raw of lines) {
    const t = raw.trimEnd();
    if (!t.trim()) { continue; }
    if (!fullyFree && raw.length > 6 && raw[6] === '*') { continue; }          // fixed comment
    if (/^\s*\/\//.test(t)) { continue; }                                        // free comment
    code++;
    // Fixed format: a spec letter in column 6; free-form code in a mixed source leaves column 6 blank.
    const isFixed = !fullyFree && raw.length > 6 && /[HFDICOP]/i.test(raw[5] ?? '');
    if (isFixed) { fixed++; }
    const body = raw.replace(/'[^']*'/g, "''");
    if (/\bGOTO\b|\bCAB(EQ|NE|LT|LE|GT|GE)\b/i.test(body)) { gotos++; }
  }
  const free = code - fixed;
  const findings = lintRpg(text);
  const rules: Record<string, number> = {};
  for (const f of findings) { rules[f.rule] = (rules[f.rule] ?? 0) + 1; }
  const errors = findings.filter(f => f.severity === 'error').length;
  const warnings = findings.filter(f => f.severity === 'warning').length;
  const infos = findings.length - errors - warnings;
  const ind = indicatorUsage(text).filter(u => /^\d{2}$/.test(u.indicator)).length;
  let subroutines = 0; let procedures = 0;
  try {
    const p = parseRpg(text);
    subroutines = p.definitions.filter(d => d.kind === 'subroutine').length;
    procedures = p.definitions.filter(d => d.kind === 'procedure').length;
  } catch { /* parser problems do not stop the report */ }
  const fixedPct = code ? Math.round(100 * fixed / code) : 0;
  const per1000 = (n: number) => (code ? n * 1000 / code : 0);
  const score = Math.max(0, Math.round(100 - Math.min(30, errors * 5) - Math.min(20, per1000(warnings)) - Math.min(15, gotos * 3) - Math.min(15, ind) - fixedPct * 0.2));
  return { lines: lines.length, code, fixed, free, fixedPct, errors, warnings, infos, rules, indicators: ind, gotos, subroutines, procedures, score };
}

export function grade(score: number): 'A' | 'B' | 'C' | 'D' | 'E' {
  return score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E';
}

// ---------------------------------------------------------------- library list of a job description

/** JOB_DESCRIPTION_INFO.LIBRARY_LIST holds the names separated by blanks (or *SYSVAL / *NONE). */
export function parseLibraryList(v: string): { libraries: string[]; special?: string } {
  const parts = (v ?? '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (parts.length === 1 && /^\*(SYSVAL|NONE)$/.test(parts[0])) { return { libraries: [], special: parts[0] }; }
  return { libraries: parts.filter(p => /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/.test(p)) };
}

/** Before / after for a library list change. */
export function libraryListChange(current: string[], next: string[]): { added: string[]; removed: string[]; same: boolean } {
  const c = current.map(x => x.toUpperCase()); const n = next.map(x => x.toUpperCase());
  return { added: n.filter(x => !c.includes(x)), removed: c.filter(x => !n.includes(x)), same: c.join(',') === n.join(',') };
}

// ---------------------------------------------------------------- *PUBLIC authority

export type Risk = 'bad' | 'warn' | 'info' | 'ok';

export function publicRisk(authority: string, autl?: string): Risk {
  const a = authority.trim().toUpperCase();
  if (a === '*ALL') { return 'bad'; }
  if (a === '*CHANGE') { return 'warn'; }
  if (a === '*AUTL') { return autl ? 'info' : 'warn'; }
  if (a === 'USER DEF' || a === 'USER DEFINED') { return 'info'; }
  return 'ok';
}

const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;
export function setPublicCommand(lib: string, obj: string, type: string, aut: '*USE' | '*EXCLUDE' | '*CHANGE'): string {
  const l = lib.trim().toUpperCase(); const o = obj.trim().toUpperCase(); const t = type.trim().toUpperCase();
  if (!NAME.test(l) || !NAME.test(o) || !/^\*[A-Z]{2,9}$/.test(t)) { throw new Error('Invalid object.'); }
  return aut === '*EXCLUDE' ? `RVKOBJAUT OBJ(${l}/${o}) OBJTYPE(${t}) USER(*PUBLIC) AUT(*ALL)` : `GRTOBJAUT OBJ(${l}/${o}) OBJTYPE(${t}) USER(*PUBLIC) AUT(${aut}) REPLACE(*YES)`;
}

// ---------------------------------------------------------------- system values on two systems

export interface SysvalDiff { name: string; a: string; b: string; same: boolean; text?: string }

export function diffSystemValues(a: Record<string, string>, b: Record<string, string>, texts: Record<string, string> = {}): SysvalDiff[] {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const norm = (v?: string) => (v ?? '').trim().replace(/\s+/g, ' ');
  return names.map(n => ({ name: n, a: norm(a[n]), b: norm(b[n]), same: norm(a[n]) === norm(b[n]), text: texts[n] }))
    .sort((x, y) => Number(x.same) - Number(y.same) || x.name.localeCompare(y.name));
}

/** System values that usually differ between systems on purpose (names, dates, serials). */
export const EXPECTED_DIFFERENT = /^(QDATE|QTIME|QDAY|QMONTH|QYEAR|QHOUR|QMINUTE|QSECOND|QDATETIME|QUTCOFFSET|QSRLNBR|QMODEL|QPRCFEAT|QIPLDATTIM|QIPLSTS|QABNORMSW|QCENTURY|QDAYOFWEEK|QPRCMLTTSK|QPWRDWNLMT|QSTRUPPGM|QCONSOLE|QPRTDEV|QSYSLIBL)$/;

// ---------------------------------------------------------------- create library / IFS

export const STANDARD_SOURCE_FILES: { file: string; text: string }[] = [
  { file: 'QRPGLESRC', text: 'RPG IV source' }, { file: 'QCLLESRC', text: 'CL source' }, { file: 'QDDSSRC', text: 'DDS source' },
  { file: 'QSQLSRC', text: 'SQL source' }, { file: 'QCPYSRC', text: 'Copy members' }, { file: 'QSRVSRC', text: 'Binder source' }, { file: 'QCMDSRC', text: 'Command source' },
];

export function createSourceFileCommand(lib: string, file: string, text: string, recordLength = 112): string {
  const l = lib.trim().toUpperCase(); const f = file.trim().toUpperCase();
  if (!NAME.test(l) || !NAME.test(f)) { throw new Error('Invalid name.'); }
  const len = Math.max(13, Math.min(32766, Math.floor(recordLength)));
  return `CRTSRCPF FILE(${l}/${f}) RCDLEN(${len}) TEXT('${text.slice(0, 50).replace(/'/g, "''")}')`;
}

/** An absolute IFS path without empty or relative parts. */
export function checkIfsPath(path: string): string {
  const p = path.trim().replace(/\/+$/, '') || '/';
  if (!p.startsWith('/')) { throw new Error('Start the path with / (for example /home/me/app).'); }
  if (/(^|\/)\.\.?(\/|$)/.test(p) || /\/\//.test(p) || /[\0\n]/.test(p)) { throw new Error('The path cannot contain //, . or .. parts.'); }
  return p;
}

/** chmod mode like 755 or 640. */
export function checkMode(mode: string): string {
  const m = mode.trim();
  if (!/^[0-7]{3,4}$/.test(m)) { throw new Error('Use an octal mode such as 755 or 640.'); }
  return m;
}
