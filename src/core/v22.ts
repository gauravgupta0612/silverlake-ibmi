// Pure helpers for the third 2.1 batch: hard-coded library scan, unused RPG code, table structure
// compare, IFS authority, journal and message queue commands, PTF lookup. No vscode import.

import { isValidSystemName } from './util';
import { findOccurrences, parseRpg } from '../rpg/parser';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------- hard-coded library names

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

// ---------------------------------------------------------------- unused RPG code

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

// ---------------------------------------------------------------- table structure compare

export interface ColDef { name: string; type: string; length: number; scale: number; nullable: boolean; dflt?: string; text?: string }

export interface StructDiff { column: string; status: 'only in A' | 'only in B' | 'different'; a?: string; b?: string }

const desc = (c: ColDef) => `${c.type}${/CHAR|DECIMAL|NUMERIC|GRAPHIC|BINARY/i.test(c.type) ? `(${c.length}${/DECIMAL|NUMERIC/i.test(c.type) ? `,${c.scale}` : ''})` : ''}${c.nullable ? '' : ' NOT NULL'}${c.dflt ? ` DEFAULT ${c.dflt}` : ''}`;

export function compareStructure(a: ColDef[], b: ColDef[]): StructDiff[] {
  const mb = new Map(b.map(c => [c.name.toUpperCase(), c]));
  const out: StructDiff[] = [];
  for (const c of a) {
    const o = mb.get(c.name.toUpperCase());
    if (!o) { out.push({ column: c.name, status: 'only in A', a: desc(c) }); continue; }
    mb.delete(c.name.toUpperCase());
    if (desc(c) !== desc(o)) { out.push({ column: c.name, status: 'different', a: desc(c), b: desc(o) }); }
  }
  for (const o of mb.values()) { out.push({ column: o.name, status: 'only in B', b: desc(o) }); }
  return out;
}

/** ALTER TABLE statements that would make B look like A (columns only; review before running). */
export function alterScript(libB: string, table: string, a: ColDef[], diffs: StructDiff[]): string {
  const t = `${NAME(libB, 'library')}/${NAME(table, 'table')}`;
  const byName = new Map(a.map(c => [c.name.toUpperCase(), c]));
  const out = [`-- Make ${t} match the other copy. Review before running: dropping columns loses data.`];
  for (const d of diffs) {
    const c = byName.get(d.column.toUpperCase());
    const col = `"${d.column.replace(/"/g, '""')}"`;
    if (d.status === 'only in A' && c) { out.push(`ALTER TABLE ${t} ADD COLUMN ${col} ${desc(c)};`); }
    if (d.status === 'different' && c) {
      const typ = desc({ ...c, nullable: true, dflt: undefined });
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} SET DATA TYPE ${typ};`);
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
      if (c.dflt) { out.push(`ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${c.dflt};`); }
    }
    if (d.status === 'only in B') { out.push(`-- ALTER TABLE ${t} DROP COLUMN ${col};   -- only in this copy: remove the comment to drop it`); }
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- IFS authority

export const DATA_AUTHORITIES = ['*RWX', '*RX', '*RW', '*WX', '*R', '*W', '*X', '*EXCLUDE', '*NONE'];

export function chgautCommand(path: string, user: string, dtaaut: string, subtree: boolean): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  const u = user.trim().toUpperCase() === '*PUBLIC' ? '*PUBLIC' : NAME(user, 'user profile');
  if (!DATA_AUTHORITIES.includes(dtaaut.toUpperCase())) { throw new Error('Unknown data authority.'); }
  return `CHGAUT OBJ(${q(path)}) USER(${u}) DTAAUT(${dtaaut.toUpperCase()}) OBJAUT(*NONE)${subtree ? ' SUBTREE(*ALL)' : ''}`;
}

export function chgownCommand(path: string, owner: string, subtree: boolean): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  return `CHGOWN OBJ(${q(path)}) NEWOWN(${NAME(owner, 'user profile')}) RVKOLDAUT(*YES)${subtree ? ' SUBTREE(*ALL)' : ''}`;
}

// ---------------------------------------------------------------- journals

export function chgjrnCommand(lib: string, jrn: string): string {
  return `CHGJRN JRN(${NAME(lib, 'library')}/${NAME(jrn, 'journal')}) JRNRCV(*GEN)`;
}

export function strjrnlibCommand(lib: string, jrnLib: string, jrn: string): string {
  return `STRJRNLIB LIB(${NAME(lib, 'library')}) JRN(${NAME(jrnLib, 'library')}/${NAME(jrn, 'journal')}) INHRULES((*ALL *ALLOPR *INCLUDE *BOTH *OPNCLO))`;
}

// ---------------------------------------------------------------- message queues

export function removeMessageCommand(msgqLib: string, msgq: string, keyHex: string): string {
  if (!/^[0-9A-F]{8}$/i.test(keyHex)) { throw new Error('Invalid message key.'); }
  return `RMVMSG MSGQ(${NAME(msgqLib, 'library')}/${NAME(msgq, 'message queue')}) MSGKEY(X'${keyHex.toUpperCase()}')`;
}

export function sendMessageCommand(msgqLib: string, msgq: string, text: string, inquiry: boolean): string {
  if (!text.trim()) { throw new Error('Enter the message.'); }
  return `SNDMSG MSG(${q(text.slice(0, 512))}) TOMSGQ(${NAME(msgqLib, 'library')}/${NAME(msgq, 'message queue')})${inquiry ? ' MSGTYPE(*INQ)' : ''}`;
}

// ---------------------------------------------------------------- PTF lookup

/** PTF identifiers like SI12345 or MF67890, from any text. */
export function parsePtfIds(input: string): string[] {
  return [...new Set((input.toUpperCase().match(/\b[A-Z]{2}\d{5}\b/g) ?? []))];
}
