// Pure helpers for RPG procedure and copybook tools (no vscode import, unit tested).
import { findOccurrences, isFixedLine, isFullyFreeSource, maskLine, parseRpg, RpgParse } from './parser';

const NAME = '[A-Za-z$#@_][\\w$#@]*';

/** Strip a trailing "// comment" and the final ';' from a free-form line. */
function code(line: string, fullyFree: boolean): string {
  return maskLine(line, fullyFree).replace(/\s+$/, '');
}

/** Keywords that belong on a prototype parameter / return (everything else on the PI is copied as is). */
function cleanReturn(rest: string): string {
  return rest.replace(/;\s*$/, '').replace(/\bend-pi\b.*$/i, '').trim();
}

export interface PrototypeResult {
  name: string;
  /** Free-form prototype source, ready to paste into a copybook. */
  text: string;
  /** Line where the procedure starts. */
  procedureLine: number;
}

/**
 * Build a free-form prototype (DCL-PR) from the procedure that contains `line`.
 * Copies the return type and every parameter from the procedure interface (DCL-PI).
 */
export function prototypeFromProcedure(text: string, line: number): PrototypeResult {
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const parse = parseRpg(text);
  const proc = parse.procedures.find(p => line >= p.start && line <= p.end)
    ?? parse.procedures.find(p => p.start === line);
  if (!proc) { throw new Error('Place the cursor inside a procedure (between DCL-PROC and END-PROC).'); }
  if (isFixedLine(lines[proc.start], fullyFree)) {
    throw new Error('This procedure uses fixed-format P/D specs. Prototype generation supports free-form DCL-PROC / DCL-PI.');
  }
  const procLine = code(lines[proc.start], fullyFree);
  const isExport = /\bexport\b/i.test(procLine);
  let ret = '';
  const parms: string[] = [];
  for (let i = proc.start + 1; i <= proc.end; i++) {
    const c = code(lines[i], fullyFree).trim();
    if (!c) { continue; }
    const m = c.match(new RegExp(`^dcl-pi\\s+(\\*n|${NAME})\\b(.*)$`, 'i'));
    if (!m) {
      if (/^dcl-/i.test(c) && !/^dcl-pi/i.test(c)) { break; } // past the interface
      continue;
    }
    const rest = m[2];
    if (/\bend-pi\b/i.test(rest)) { ret = cleanReturn(rest); break; }
    ret = cleanReturn(rest);
    for (let j = i + 1; j <= proc.end; j++) {
      const p = code(lines[j], fullyFree).trim();
      if (!p) { continue; }
      if (/^end-pi\b/i.test(p)) { break; }
      // A continuation line (keywords only) belongs to the previous parameter.
      const pm = p.match(new RegExp(`^(?:dcl-parm\\s+)?(${NAME})\\s+(.*)$`, 'i'));
      if (pm && !/^(const|value|options|like|likeds|dim)\b/i.test(pm[1])) {
        parms.push(`  ${pm[1]} ${pm[2].replace(/;\s*$/, '').trim()};`);
      } else if (parms.length) {
        parms[parms.length - 1] = parms[parms.length - 1].replace(/;$/, ` ${p.replace(/;\s*$/, '').trim()};`);
      }
    }
    break;
  }
  const head = `dcl-pr ${proc.name}${ret ? ' ' + ret : ''}`;
  const out = parms.length ? [`${head};`, ...parms, 'end-pr;'] : [`${head} end-pr;`];
  if (!isExport) {
    out.unshift(`// Note: ${proc.name} is not EXPORTed, so it can only be called from this module.`);
  }
  return { name: proc.name, text: out.join('\n'), procedureLine: proc.start };
}

export interface CopyUsage {
  line: number;
  target: string;
  /** Names the copybook declares. */
  declared: number;
  /** Declared names that the source uses. */
  used: string[];
}

/**
 * For each /COPY in `text`, which of the copybook's declarations does the source use?
 * `copyTexts` maps the directive's line number to the copybook's source (missing = not found).
 */
export function copybookUsage(text: string, copyTexts: Map<number, string>): CopyUsage[] {
  const parse = parseRpg(text);
  const out: CopyUsage[] = [];
  for (const c of parse.copies) {
    const src = copyTexts.get(c.line);
    if (src === undefined) { continue; }
    const defs = parseRpg(src).definitions.filter(d => d.kind !== 'parameter' && !d.procedure);
    const names = [...new Set(defs.map(d => d.upper))];
    const used = names.filter(n => findOccurrences(text, n).length > 0);
    out.push({ line: c.line, target: c.target, declared: names.length, used });
  }
  return out;
}

const OPENERS = /^(if|dow|dou|for|for-each|select|monitor)\b/i;
const CLOSERS = /^(endif|enddo|endfor|endsl|endmon)\b/i;
const EXITS = /^(return|leave|iter|leavesr)\b/i;

export interface ExtractResult {
  /** Replacement text for the selected lines (the call). */
  call: string;
  /** Text to insert as the new procedure. */
  procedure: string;
  /** Line before which the procedure is inserted (end of source, before compile-time data). */
  insertLine: number;
}

/**
 * "Extract to procedure" for free-form RPG: moves whole lines [start..end] into a new
 * procedure without parameters and replaces them with a call. Refuses when that would
 * change behaviour (local variables of the enclosing procedure, unbalanced blocks, early exits).
 */
export function extractProcedure(text: string, start: number, end: number, name: string): ExtractResult {
  if (!new RegExp(`^${NAME}$`).test(name)) { throw new Error(`"${name}" is not a valid RPG name.`); }
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const parse: RpgParse = parseRpg(text);
  if (parse.definitions.some(d => d.upper === name.toUpperCase())) { throw new Error(`${name} is already declared in this source.`); }
  let depth = 0;
  for (let i = start; i <= end; i++) {
    if (isFixedLine(lines[i], fullyFree)) { throw new Error('The selection contains fixed-format specs. Extract works on free-form calculations only.'); }
    for (const stmt of code(lines[i], fullyFree).split(';')) {
      const s = stmt.trim();
      if (!s) { continue; }
      if (/^(dcl-proc|end-proc|begsr|endsr)\b/i.test(s)) { throw new Error('The selection crosses a subroutine or procedure boundary.'); }
      if (/^(dcl-|end-(ds|pr|pi|enum)\b)/i.test(s)) { throw new Error('The selection contains declarations. Select calculations only.'); }
      if (EXITS.test(s)) { throw new Error(`The selection contains ${s.split(/\s/)[0].toUpperCase()}, which would behave differently inside a new procedure.`); }
      if (OPENERS.test(s)) { depth++; }
      else if (CLOSERS.test(s)) { depth--; if (depth < 0) { throw new Error('The selection closes a block it does not open. Select whole IF/DO/SELECT/MONITOR blocks.'); } }
    }
  }
  if (depth !== 0) { throw new Error('The selection opens a block it does not close. Select whole IF/DO/SELECT/MONITOR blocks.'); }

  const enclosing = parse.procedures.find(p => start > p.start && end < p.end);
  if (enclosing) {
    const locals = parse.definitions.filter(d => d.procedure === enclosing.name && d.kind !== 'procedure');
    const used = locals.filter(d => findOccurrences(text, d.name).some(o => o.line >= start && o.line <= end)).map(d => d.name);
    if (used.length) {
      throw new Error(`The selection uses local variables of ${enclosing.name} (${[...new Set(used)].join(', ')}). ` +
        'Extract from main-line code, or make them parameters by hand.');
    }
  }

  const body = lines.slice(start, end + 1);
  const indent = Math.min(...body.filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length));
  const firstIndent = (body.find(l => l.trim()) ?? '').match(/^\s*/)![0];
  const moved = body.map(l => (l.trim() ? '  ' + l.slice(indent) : ''));
  // Compile-time data (** or **CTDATA) must stay last.
  let insertLine = lines.length;
  const ct = lines.findIndex((l, i) => i > 0 && /^\*\*(\s|ctdata|ftrans|altseq|$)/i.test(l));
  if (ct > 0) { insertLine = ct; }
  const procedure = ['', `dcl-proc ${name};`, ...moved, 'end-proc;', ''].join('\n');
  return { call: `${firstIndent}${name}();`, procedure, insertLine };
}

/** True when the control options allow sub-procedures in a program (DFTACTGRP(*NO), NOMAIN or ACTGRP). */
export function hasProcedureFriendlyControl(text: string): boolean {
  return /\b(dftactgrp\s*\(\s*\*no\s*\)|nomain\b|actgrp\s*\()/i.test(text);
}
