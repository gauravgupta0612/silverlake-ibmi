// Finds procedure calls and dynamic calls in RPG and CL source (pure module, unit tested).
// Used by "Who calls each exported procedure?" and by the call graph's "Find dynamic calls".
// Like the rest of the RPG scanner it is tolerant: unusual source is never an error, it just finds less.

import { isFixedLine, isFullyFreeSource, maskLine, parseRpg, CopyDirective } from './parser';

const NAME = '[A-Za-z$#@_][\\w$#@]*';

export type ScanLanguage = 'rpg' | 'rpg3' | 'cl' | 'other';

/** Scanner language for a source type (RPGLE, SQLRPGLE, RPG, CLLE…) or a stream file extension. */
export function scanLanguage(sourceType: string): ScanLanguage {
  const t = (sourceType || '').trim().toUpperCase().replace(/^.*\./, '');
  if (['RPG', 'RPG38', 'RPT', 'RPT38', 'SQLRPG'].includes(t)) { return 'rpg3'; }
  if (t.includes('RPG')) { return 'rpg'; }
  if (/^CL(LE|P|P38|38)?$/.test(t)) { return 'cl'; }
  return 'other';
}

/** A prototype: how a local name maps to a bound procedure symbol or a program. */
export interface Prototype {
  name: string;
  line: number;            // 1-based
  isProgram: boolean;      // EXTPGM
  /** Bound symbol (procedures, case kept) or program name (EXTPGM, upper case). */
  target?: string;
  /** Variable or named constant in EXTPGM(x) / EXTPROC(x): the target is only known at run time. */
  dynamic?: string;
}

export interface ProcCall {
  symbol: string;          // exported symbol that is called
  via: string;             // name used in the source (prototype name, or the symbol itself)
  line: number;            // 1-based
  code: string;
  /** No prototype was found (it is probably in a /COPY member that was not read): matched by name. */
  guessed: boolean;
}

export interface DynamicCall {
  line: number;            // 1-based
  kind: 'program' | 'procedure';
  /** The variable (or named constant) holding the program / procedure. */
  target: string;
  via?: string;            // prototype name, when the call goes through one
  code: string;
}

/** Remove comments but keep string literals (prototype keywords need them). */
function stripComment(line: string, fullyFree: boolean): string {
  if (!fullyFree && line.length > 6 && line[6] === '*' && /^[ 0-9A-Za-z]{5}[ A-Za-z]$/.test(line.substring(0, 6))) { return ''; }
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "'") { inString = !inString; }
    else if (!inString && line[i] === '/' && line[i + 1] === '/') { line = line.substring(0, i); break; }
  }
  if (!fullyFree && isFixedLine(line, false) && line.length > 80) { line = line.substring(0, 80); }
  return line;
}

function protoFromKeywords(name: string, line: number, kw: string): Prototype {
  const pgm = kw.match(new RegExp(`\\bEXTPGM\\b(?:\\s*\\(\\s*(?:'([^']*)'|(${NAME}))\\s*\\))?`, 'i'));
  if (pgm) {
    if (pgm[1] !== undefined) { return { name, line, isProgram: true, target: pgm[1].trim().toUpperCase() }; }
    if (pgm[2]) { return { name, line, isProgram: true, dynamic: pgm[2] }; }
    return { name, line, isProgram: true, target: name.toUpperCase() };
  }
  const proc = kw.match(new RegExp(`\\bEXTPROC\\s*\\(\\s*(?:\\*(?:CL|CWIDEN|CNOWIDEN)\\s*:\\s*)?(?:'([^']*)'|(\\*DCLCASE)|(${NAME}))\\s*[:)]`, 'i'));
  if (proc) {
    if (proc[1] !== undefined) { return { name, line, isProgram: false, target: proc[1] }; }
    if (proc[2]) { return { name, line, isProgram: false, target: name }; }
    if (proc[3]) { return { name, line, isProgram: false, dynamic: proc[3] }; }
  }
  return { name, line, isProgram: false, target: name.toUpperCase() };
}

/** Prototypes declared in an RPG IV source (free-form DCL-PR and fixed-form D specs with PR). */
export function findPrototypes(text: string): Prototype[] {
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const out: Prototype[] = [];
  let longName = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (isFixedLine(raw, fullyFree)) {
      if (raw[5].toUpperCase() !== 'D' || raw[6] === '*') { longName = ''; continue; }
      // A long name is continued with '...' and may run past column 21.
      const rest = stripComment(raw, false).substring(6, 80).trim();
      if (/^\S+\.\.\.$/.test(rest)) { longName += rest.slice(0, -3); continue; }
      const name = longName + raw.substring(6, 21).trim();
      longName = '';
      if (raw.substring(23, 25).toUpperCase() !== 'PR' || !name) { continue; }
      let kw = stripComment(raw, false).substring(43, 80);
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!isFixedLine(next, fullyFree) || next[5].toUpperCase() !== 'D') { break; }
        if (next[6] === '*') { continue; }
        if (next.substring(6, 43).trim()) { break; }   // a parameter or another definition
        kw += ' ' + stripComment(next, false).substring(43, 80);
      }
      out.push(protoFromKeywords(name, i + 1, kw));
      continue;
    }
    longName = '';
    const code = maskLine(raw, fullyFree);
    const m = code.match(new RegExp(`^\\s*DCL-PR\\s+(${NAME})`, 'i'));
    if (!m) { continue; }
    // Gather the DCL-PR statement up to its ';' (the keywords may continue on the next lines).
    let stmt = stripComment(raw, fullyFree);
    for (let j = i; !maskLine(lines[j], fullyFree).includes(';') && j + 1 < lines.length; ) {
      j++;
      stmt += ' ' + stripComment(lines[j], fullyFree);
    }
    const name = raw.substr(code.search(/\S/)).replace(/^\s*dcl-pr\s+/i, '').match(new RegExp(NAME))![0];
    out.push(protoFromKeywords(name, i + 1, stmt.substring(stmt.toUpperCase().indexOf(name.toUpperCase()) + name.length)));
  }
  return out;
}

/** /COPY and /INCLUDE members of an RPG source (to read the prototypes they hold). */
export function copyMembers(text: string): CopyDirective[] {
  return parseRpg(text).copies;
}

interface CodeLine { line: number; code: string; raw: string; fixedC: boolean; }

/** Lines that can hold calls: free-form code and C specs (comments and literals blanked). */
function codeLines(text: string, lang: ScanLanguage): CodeLine[] {
  const lines = text.split(/\r?\n/);
  const fullyFree = lang === 'rpg' && isFullyFreeSource(text);
  const out: CodeLine[] = [];
  lines.forEach((raw, i) => {
    if (lang === 'rpg3') {
      if (raw.length > 6 && raw[5].toUpperCase() === 'C' && raw[6] !== '*') { out.push({ line: i + 1, code: maskLine(raw, false), raw, fixedC: true }); }
      return;
    }
    if (/^\s*\/(copy|include|if|else|elseif|endif|define|undefine|eof|free|end-free|title|eject|space)\b/i.test(raw.substring(fullyFree ? 0 : 6))) { return; }
    const code = maskLine(raw, fullyFree);
    if (!code.trim()) { return; }
    if (isFixedLine(raw, fullyFree)) {
      if (raw[5].toUpperCase() === 'C') { out.push({ line: i + 1, code, raw, fixedC: true }); }
      return;
    }
    if (/^\s*(dcl-pr|dcl-pi|dcl-proc|end-pr|end-pi|end-proc)\b/i.test(code)) { return; }
    out.push({ line: i + 1, code, raw, fixedC: false });
  });
  return out;
}

/** Fixed-form C spec opcode and factor 2 (RPG IV or RPG III columns). */
function fixedOp(raw: string, lang: ScanLanguage): { op: string; factor2: string } {
  return lang === 'rpg3'
    ? { op: raw.substring(27, 32).trim().toUpperCase(), factor2: raw.substring(32, 42).trim() }
    : { op: raw.substring(25, 35).trim().toUpperCase().replace(/\(.*$/, ''), factor2: raw.substring(35, 49).trim() };
}

/** Each position where `name` is called: `name(` or `CALLP name`. */
function callsOf(code: string, name: string): boolean {
  const re = new RegExp(`(^|[^\\w$#@%])${name.replace(/[$#@]/g, '\\$&')}\\s*\\(|\\bCALLP(?:\\([A-Z ]*\\))?\\s+${name.replace(/[$#@]/g, '\\$&')}(?![\\w$#@])`, 'i');
  return re.test(code);
}

/** CL statements joined over their continuation lines (+ / -), comments removed. */
function clStatements(text: string): { line: number; stmt: string; raw: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { line: number; stmt: string; raw: string }[] = [];
  let buf = ''; let start = -1; let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    let l = '';
    const raw = lines[i];
    for (let k = 0; k < raw.length; k++) {
      if (inComment) { if (raw[k] === '*' && raw[k + 1] === '/') { inComment = false; k++; } continue; }
      if (raw[k] === '/' && raw[k + 1] === '*') { inComment = true; k++; continue; }
      l += raw[k];
    }
    const t = l.trimEnd();
    if (start < 0) { if (!t.trim()) { continue; } start = i; }
    if (/[+-]$/.test(t)) { buf += t.slice(0, -1); continue; }
    buf += t;
    out.push({ line: start + 1, stmt: buf.replace(/\s+/g, ' ').trim(), raw: lines[start].trim() });
    buf = ''; start = -1;
  }
  return out;
}

const CL_LABEL = /^(?:[A-Za-z$#@][\w$#@]*:\s*)?/;

/**
 * Calls to the given bound procedure symbols.
 * @param symbols exported symbols (case-sensitive, as the binder sees them)
 * @param extraPrototypes prototypes from the source's /COPY members
 */
export function findProcedureCalls(text: string, lang: ScanLanguage, symbols: string[], extraPrototypes: Prototype[] = []): ProcCall[] {
  const wanted = new Set(symbols);
  const out: ProcCall[] = [];
  const seen = new Set<string>();
  const push = (c: ProcCall) => { const k = `${c.line}:${c.symbol}`; if (!seen.has(k)) { seen.add(k); out.push(c); } };

  if (lang === 'cl') {
    for (const s of clStatements(text)) {
      const m = s.stmt.replace(CL_LABEL, '').match(/^CALLPRC\s+(?:PRC\(\s*)?('([^']*)'|[^\s)]+)/i);
      if (!m) { continue; }
      const sym = m[2] !== undefined ? m[2] : m[1].toUpperCase();
      if (wanted.has(sym)) { push({ symbol: sym, via: sym, line: s.line, code: s.raw, guessed: false }); }
    }
    return out;
  }
  if (lang !== 'rpg' && lang !== 'rpg3') { return out; }

  const protos = [...extraPrototypes, ...(lang === 'rpg' ? findPrototypes(text) : [])].filter(p => !p.isProgram);
  const byLocal = new Map<string, Prototype>();
  for (const p of protos) { byLocal.set(p.name.toUpperCase(), p); }
  // Local name -> symbol: declared prototypes, plus symbols called by their own name without a prototype in sight.
  const targets: { local: string; symbol: string; guessed: boolean }[] = [];
  for (const p of byLocal.values()) { if (p.target && wanted.has(p.target)) { targets.push({ local: p.name, symbol: p.target, guessed: false }); } }
  for (const sym of wanted) {
    if (new RegExp(`^${NAME}$`).test(sym) && !byLocal.has(sym.toUpperCase())) { targets.push({ local: sym, symbol: sym, guessed: true }); }
  }

  for (const l of codeLines(text, lang)) {
    if (l.fixedC) {
      const { op, factor2 } = fixedOp(l.raw, lang);
      const lit = factor2.match(/^'([^']*)'/);
      if (op === 'CALLB' && lit && wanted.has(lit[1])) { push({ symbol: lit[1], via: lit[1], line: l.line, code: l.raw.trim(), guessed: false }); }
    }
    for (const m of l.raw.matchAll(/%PADDR\s*\(\s*'([^']*)'/gi)) {
      if (wanted.has(m[1])) { push({ symbol: m[1], via: `%PADDR('${m[1]}')`, line: l.line, code: l.raw.trim(), guessed: false }); }
    }
    for (const t of targets) {
      if (callsOf(l.code, t.local) || new RegExp(`%PADDR\\s*\\(\\s*${t.local.replace(/[$#@]/g, '\\$&')}\\s*\\)`, 'i').test(l.code)) {
        push({ symbol: t.symbol, via: t.local, line: l.line, code: l.raw.trim(), guessed: t.guessed });
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Calls whose target is only known at run time (program or procedure name in a variable). */
export function findDynamicCalls(text: string, lang: ScanLanguage, extraPrototypes: Prototype[] = []): DynamicCall[] {
  const out: DynamicCall[] = [];
  if (lang === 'cl') {
    for (const s of clStatements(text)) {
      const stmt = s.stmt.replace(CL_LABEL, '');
      const m = stmt.match(/^(CALL|CALLPRC)\s+(?:(?:PGM|PRC)\(\s*)?([^\s)]+)/i);
      if (!m) { continue; }
      const target = m[2].includes('/') ? m[2].split('/').pop()! : m[2];
      if (target.startsWith('&')) {
        out.push({ line: s.line, kind: m[1].toUpperCase() === 'CALL' ? 'program' : 'procedure', target: m[2], code: s.raw });
      }
    }
    return out;
  }
  if (lang !== 'rpg' && lang !== 'rpg3') { return out; }
  const dynProtos = [...extraPrototypes, ...(lang === 'rpg' ? findPrototypes(text) : [])].filter(p => p.dynamic);
  for (const l of codeLines(text, lang)) {
    if (l.fixedC) {
      const { op, factor2 } = fixedOp(l.raw, lang);
      if ((op === 'CALL' || op === 'CALLB') && factor2 && !factor2.startsWith("'")) {
        out.push({ line: l.line, kind: op === 'CALL' ? 'program' : 'procedure', target: factor2, code: l.raw.trim() });
        continue;
      }
    }
    for (const p of dynProtos) {
      if (callsOf(l.code, p.name)) {
        out.push({ line: l.line, kind: p.isProgram ? 'program' : 'procedure', target: p.dynamic!, via: p.name, code: l.raw.trim() });
      }
    }
  }
  return out;
}
