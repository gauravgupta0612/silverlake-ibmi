// Quick fixes for common RPG compile errors: declare a name the compiler did not find (RNF7030) and remove a
// declaration that is never used (RNF7031). Pure (no vscode import), unit tested.

import { isFixedLine, isFullyFreeSource, maskLine, parseRpg } from '../rpg/parser';

/** The name an RNF7030 / RNF7031 message is about ("The name or indicator X is not defined."). */
export function nameFromMessage(message: string): string | undefined {
  const m = message.match(/[Nn]ame or indicator\s+([A-Z$#@_][A-Z0-9$#@_]*)\b/) ?? message.match(/\b(?:name|nom|nombre|Name)\s+([A-Z$#@_][\w$#@]*)\b/) ?? message.match(/'([A-Za-z$#@_][\w$#@]*)'/);
  return m?.[1];
}

export const DECLARE_TYPES = ['char(10)', 'varchar(50)', 'packed(9:2)', 'int(10)', 'ind', 'date', 'timestamp'];

/** Fixed D-spec for a standalone field of a free-form type (for sources that are not free form). */
export function fixedDeclaration(name: string, type: string): string {
  const t = type.toLowerCase();
  let len = '', kind = '', dec = '', kw = '';
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^char\((\d+)\)$/))) { len = m[1]; kind = 'A'; }
  else if ((m = t.match(/^varchar\((\d+)\)$/))) { len = m[1]; kind = 'A'; kw = 'VARYING'; }
  else if ((m = t.match(/^packed\((\d+):(\d+)\)$/))) { len = m[1]; kind = 'P'; dec = m[2]; }
  else if ((m = t.match(/^zoned\((\d+):(\d+)\)$/))) { len = m[1]; kind = 'S'; dec = m[2]; }
  else if ((m = t.match(/^int\((\d+)\)$/))) { len = m[1]; kind = 'I'; dec = '0'; }
  else if (t === 'ind') { kind = 'N'; }
  else if (t === 'date') { kind = 'D'; }
  else if (t === 'timestamp') { kind = 'Z'; }
  else { len = '10'; kind = 'A'; }
  // Columns: 6 D, 7-21 name, 24-25 S, 33-39 length (right), 40 type, 41-42 decimals (right), 44+ keywords.
  const head = `     D${name.padEnd(15).slice(0, 15)}  S`;
  return `${head.padEnd(32)}${len.padStart(7)}${kind}${dec.padStart(2)} ${kw}`.trimEnd();
}

export interface InsertPlan { line: number; text: string; where: 'global' | 'procedure' }

/** Where and what to insert to declare `name` used on `usedLine`: in the procedure that uses it, else globally. */
export function declarePlan(text: string, name: string, type: string, usedLine: number, local = true): InsertPlan {
  const lines = text.split(/\r?\n/);
  const free = isFullyFreeSource(text);
  const parse = parseRpg(text);
  const proc = local ? parse.procedures.find(p => usedLine > p.start && usedLine <= p.end) : undefined;
  const isFreeSection = (i: number) => free || !isFixedLine(lines[i] ?? '', false);
  if (proc) {
    // After the procedure interface (END-PI or the last PI parameter line), else right after DCL-PROC / P B.
    let at = proc.start + 1;
    for (let i = proc.start + 1; i < Math.min(proc.end, proc.start + 200); i++) {
      const code = maskLine(lines[i], free).trim();
      if (/^end-pi\b/i.test(code) || /^dcl-pi\b.*\bend-pi\b/i.test(code)) { at = i + 1; break; }
      const fixedPi = !free && isFixedLine(lines[i], false) && lines[i][5].toUpperCase() === 'D';
      if (fixedPi) { at = i + 1; continue; }
      if (code && !/^dcl-pi\b/i.test(code) && !/^(\w+\s+)?(char|varchar|packed|zoned|int|uns|ind|date|time|timestamp|like|likeds|pointer|float)\b/i.test(code)) { break; }
    }
    const indent = (lines[at] ?? lines[proc.start + 1] ?? '').match(/^\s*/)?.[0] ?? '  ';
    return { line: at, where: 'procedure', text: isFreeSection(proc.start) ? `${indent || '  '}dcl-s ${name} ${type};` : fixedDeclaration(name, type) };
  }
  // Global: after the last global declaration before the first procedure / executable code.
  let at = free ? 1 : 0;
  const limit = parse.procedures.length ? parse.procedures[0].start : lines.length;
  for (let i = free ? 1 : 0; i < limit; i++) {
    const raw = lines[i];
    if (!free && isFixedLine(raw, false)) {
      const spec = raw[5].toUpperCase();
      if ('HFD'.includes(spec)) { at = i + 1; continue; }
      if ('CIOP'.includes(spec)) { break; }
      continue;
    }
    const code = maskLine(raw, free).trim();
    if (!code) { continue; }
    if (/^(ctl-opt|dcl-[a-z]+|end-[a-z]+)\b/i.test(code) || /^\//.test(code)) { at = i + 1; continue; }
    if (/^(\w+)\s+(char|varchar|packed|zoned|int|uns|ind|date|time|timestamp|like|likeds|pointer|float)\b/i.test(code)) { at = i + 1; continue; }
    break;
  }
  const freeHere = free || !lines.slice(0, at).some(l => isFixedLine(l, false) && l[5].toUpperCase() === 'D');
  return { line: at, where: 'global', text: freeHere ? `dcl-s ${name} ${type};` : fixedDeclaration(name, type) };
}

/** The line to delete for an unused declaration (only one-line standalone fields and constants), or undefined. */
export function unusedLine(text: string, line: number, name: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const raw = lines[line] ?? '';
  const free = isFullyFreeSource(text);
  if (!free && isFixedLine(raw, false)) {
    const spec = raw[5].toUpperCase(); const nm = raw.substring(6, 21).trim(); const type = raw.substring(23, 25).trim().toUpperCase();
    if (spec === 'D' && (type === 'S' || type === 'C') && nm.toUpperCase() === name.toUpperCase()) {
      // A continued keyword line below (blank name, blank type) belongs to it: do not touch.
      const next = lines[line + 1] ?? '';
      if (isFixedLine(next, false) && next[5].toUpperCase() === 'D' && !next.substring(6, 25).trim() && next.substring(43).trim()) { return undefined; }
      return line;
    }
    return undefined;
  }
  const code = maskLine(raw, free).trim();
  const m = code.match(/^dcl-(s|c)\s+([A-Za-z$#@_][\w$#@]*)\b.*;\s*$/i);
  return m && m[2].toUpperCase() === name.toUpperCase() ? line : undefined;
}

/** The name declared on a line (dcl-s / dcl-c in free form, or a fixed D-spec), for messages that do not name it. */
export function declaredNameOn(line: string): string | undefined {
  if (isFixedLine(line, false)) { return line[5].toUpperCase() === 'D' ? line.substring(6, 21).trim() || undefined : undefined; }
  return maskLine(line, true).trim().match(/^dcl-(?:s|c)\s+([A-Za-z$#@_][\w$#@]*)/i)?.[1];
}
