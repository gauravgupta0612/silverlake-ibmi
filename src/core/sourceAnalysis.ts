// Source analysis: hard-coded libraries, unused code, indicator usage and the source quality score. Pure functions (no
// vscode import), unit tested.
import { lintRpg } from '../rpg/lint';
import { findOccurrences, parseRpg } from '../rpg/parser';

export const DEFAULT_ALLOWED_LIBRARIES = ['QTEMP', 'QSYS', 'QSYS2', 'SYSIBM', 'SYSIBMADM', 'SYSTOOLS', 'QGPL', 'QUSRSYS', 'SYSPROC', 'SYSFUN', 'QSYSINC'];

/** Library-qualified names (LIB/OBJ) written into source, outside comments. */
export function findHardcodedLibraries(text: string, allowed: string[] = DEFAULT_ALLOWED_LIBRARIES): { line: number; library: string; object: string; text: string }[] {
  const ok = new Set(allowed.map(a => a.toUpperCase()));
  const out: { line: number; library: string; object: string; text: string }[] = [];
  const lines = text.split(/\r?\n/);
  const free = /^\s*\*\*FREE/i.test(lines[0] ?? '');
  lines.forEach((raw, i) => {
    let l = raw;
    if (!free && raw.length > 6 && /^.{5}[A-Za-z ]\*/.test(raw)) { return; }          // fixed-form comment
    if (/^\s*(\/\/|--|\*\s)/.test(l)) { return; }
    l = l.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/, '$1').replace(/--.*$/, '');
    for (const m of l.matchAll(/(?<![\w$#@*/.])([A-Za-z$#@][A-Za-z0-9$#@_]{0,9})\/([A-Za-z$#@*][A-Za-z0-9$#@_*]{0,9})\b/g)) {
      const lib = m[1].toUpperCase(); const obj = m[2].toUpperCase();
      if (ok.has(lib) || lib.startsWith('*') || /^(QOPENSYS|HOME|TMP|USR|ETC|VAR|QIBM|QSYS\.LIB)$/.test(lib)) { continue; }
      if (/^\d/.test(obj)) { continue; }
      // Only where a qualified name is expected: in a string, right after "(", or after an SQL keyword
      // (so RPG divisions like a/b are not reported).
      const before = l.slice(0, m.index ?? 0);
      const inString = (before.match(/'/g) ?? []).length % 2 === 1;
      if (!inString && !/\(\s*$/.test(before) && !/\b(FROM|JOIN|INTO|UPDATE|TABLE|CALL|ON|EXISTS|USING|MERGE|VIEW|INDEX)\s+$/i.test(before)) { continue; }
      out.push({ line: i, library: lib, object: obj, text: raw.trim().slice(0, 160) });
    }
  });
  return out;
}

export interface Unused { name: string; kind: string; line: number }

/** Definitions that nothing refers to: standalone fields, constants, data structures, prototypes, subroutines, internal procedures. */
export function unusedRpg(text: string): Unused[] {
  const p = parseRpg(text);
  const lines = text.split(/\r?\n/);
  const defLines = new Map<string, Set<number>>();
  for (const d of p.definitions) { const k = d.name.toUpperCase(); if (!defLines.has(k)) { defLines.set(k, new Set()); } defLines.get(k)!.add(d.line); }
  const out: Unused[] = [];
  const seen = new Set<string>();
  for (const d of p.definitions) {
    if (!['variable', 'constant', 'ds', 'prototype', 'subroutine', 'procedure'].includes(d.kind) || d.parent) { continue; }
    const key = `${d.kind}|${d.name.toUpperCase()}|${d.procedure ?? ''}`;
    if (seen.has(key)) { continue; } seen.add(key);
    if (d.kind === 'procedure' && /\bEXPORT\b/i.test(lines[d.line] ?? '')) { continue; }
    const own = defLines.get(d.name.toUpperCase()) ?? new Set<number>();
    const uses = findOccurrences(text, d.name).filter(o => !own.has(o.line) && !/^\s*end-(proc|ds|pr|pi)\b/i.test(lines[o.line] ?? '') && !/^.{5}P.{18}E/i.test(lines[o.line] ?? ''));
    if (!uses.length) { out.push({ name: d.name, kind: d.kind, line: d.line }); }
  }
  return out.sort((a, b) => a.line - b.line);
}

export interface IndicatorUse { indicator: string; set: number[]; tested: number[] }


/** Where each numbered indicator (01–99, KA–KY, LR, H1–H9, U1–U8) is set and where it is tested. */
export function indicatorUsage(text: string): IndicatorUse[] {
  const map = new Map<string, IndicatorUse>();
  const at = (ind: string) => { const k = ind.toUpperCase(); if (!map.has(k)) { map.set(k, { indicator: k, set: [], tested: [] }); } return map.get(k)!; };
  const lines = text.split(/\r?\n/);
  const fullyFree = /^\s*\*\*FREE/i.test(lines[0] ?? '');
  lines.forEach((raw, i) => {
    if (/^\s*\/\//.test(raw) || (!fullyFree && raw[6] === '*')) { return; }
    const spec = !fullyFree && raw.length > 6 ? raw[5].toUpperCase() : '';
    if (spec === 'C' && !/^\s*$/.test(raw.substring(25, 35))) {
      // Fixed-form C spec: conditioning in 9–11, resulting indicators in 71–76.
      for (const m of raw.substring(8, 11).matchAll(/N?([0-9]{2}|LR|L[1-9]|H[1-9]|U[1-8]|K[A-Y])/gi)) { at(m[1]).tested.push(i); }
      for (const m of raw.substring(70, 76).matchAll(/([0-9]{2}|LR|H[1-9])/gi)) { if (m[1].trim()) { at(m[1]).set.push(i); } }
    }
    if (spec === 'A') {
      // DDS: conditioning indicators in 8–16, and CAnn/CFnn response indicators.
      for (const m of raw.substring(7, 16).matchAll(/N?([0-9]{2})/g)) { at(m[1]).tested.push(i); }
      for (const m of raw.substring(44).matchAll(/\bC[AF]\d{2}\s*\(\s*(\d{2})/gi)) { at(m[1]).set.push(i); }
      for (const m of raw.substring(44).matchAll(/\b(?:CHANGE|ROLLUP|ROLLDOWN|PAGEUP|PAGEDOWN|SFLEND|SFLDSP|SFLDSPCTL|SFLCLR)\s*\(\s*(\d{2})/gi)) { at(m[1]).set.push(i); }
    }
    // *INxx anywhere in code (free or fixed extended factor 2).
    const code = raw.replace(/'[^']*'/g, "''").replace(/\/\/.*$/, '');
    for (const m of code.matchAll(/\*IN\(?\s*(\d{2}|LR|H[1-9]|U[1-8]|K[A-Y])\s*\)?/gi)) {
      const after = code.slice((m.index ?? 0) + m[0].length);
      if (/^\s*=(?!=)/.test(after) && !/\b(IF|WHEN|DOW|DOU|AND|OR)\b[^;]*$/i.test(code.slice(0, m.index))) { at(m[1]).set.push(i); } else { at(m[1]).tested.push(i); }
    }
    if (spec !== 'C') { for (const m of code.matchAll(/\b(SETON|SETOFF)\b\s+(?:\*IN)?([0-9]{2}|LR)/gi)) { at(m[2]).set.push(i); } }
  });
  return [...map.values()].map(u => ({ ...u, set: [...new Set(u.set)], tested: [...new Set(u.tested)] }))
    .sort((a, b) => a.indicator.localeCompare(b.indicator, undefined, { numeric: true }));
}

/** Indicators that are set but never tested, or tested but never set (in this source). */
export function indicatorProblems(u: IndicatorUse[]): { indicator: string; problem: string }[] {
  const out: { indicator: string; problem: string }[] = [];
  for (const x of u) {
    if (x.indicator === 'LR' || /^K[A-Y]$/.test(x.indicator) || /^U[1-8]$/.test(x.indicator)) { continue; }
    if (x.set.length && !x.tested.length) { out.push({ indicator: x.indicator, problem: 'set but never tested' }); }
    if (!x.set.length && x.tested.length) { out.push({ indicator: x.indicator, problem: 'tested but never set here (set by a display file or another program?)' }); }
  }
  return out;
}

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
