// RPG editor help: folding of blocks, parameter hints while typing a call, re-indenting fully free source and the
// field under the cursor on a fixed-format line. Pure (no vscode import), unit tested.

import { isFixedLine, isFullyFreeSource, maskLine } from './parser';
import { layoutFor, SpecField } from './specLayout';

export interface Fold { start: number; end: number }

/** Free-form block openers and the word that closes each. */
const FREE_OPEN: [RegExp, string][] = [
  [/^dcl-proc\b/i, 'END-PROC'], [/^dcl-ds\b/i, 'END-DS'], [/^dcl-pr\b/i, 'END-PR'], [/^dcl-pi\b/i, 'END-PI'], [/^dcl-enum\b/i, 'END-ENUM'],
  [/^if\b/i, 'ENDIF'], [/^dow\b|^dou\b/i, 'ENDDO'], [/^for\b|^for-each\b/i, 'ENDFOR'], [/^select\b/i, 'ENDSL'],
  [/^monitor\b/i, 'ENDMON'], [/^begsr\b/i, 'ENDSR'],
];
const FREE_CLOSE = /^(end-proc|end-ds|end-pr|end-pi|end-enum|endif|enddo|endfor|endsl|endmon|endsr)\b/i;
/** Fixed-format opcodes (columns 26-35) that open and close blocks. */
const FIXED_OPEN = /^(IF(EQ|NE|GT|GE|LT|LE)?|DO|DOW(EQ|NE|GT|GE|LT|LE)?|DOU(EQ|NE|GT|GE|LT|LE)?|FOR|SELECT|MONITOR|BEGSR|CAS(EQ|NE|GT|GE|LT|LE)?)$/;
const FIXED_CLOSE = /^(END|ENDIF|ENDDO|ENDFOR|ENDSL|ENDMON|ENDSR|ENDCS)$/;

/** A declaration that closes on its own line (no END-xx needed). */
function selfContained(statement: string): boolean {
  if (/^dcl-(ds|pr|pi|enum)\b/i.test(statement)) {
    return /\bend-(ds|pr|pi|enum)\b/i.test(statement) || (/^dcl-ds\b/i.test(statement) && /\b(likeds|likerec)\s*\(/i.test(statement));
  }
  return false;
}

/** Code of each free-form statement start (strings and comments blanked), with the statement's first line. */
function freeStatements(lines: string[], fullyFree: boolean): { line: number; code: string; fixedOp?: string; pSpec?: 'B' | 'E' }[] {
  const out: { line: number; code: string; fixedOp?: string; pSpec?: 'B' | 'E' }[] = [];
  let open: { line: number; code: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (i === 0 && /^\s*\*\*free/i.test(raw)) { continue; }
    if (/^\s*\*\*(ctdata|ftrans|altseq|\s|$)/i.test(raw) && i > 0) { break; } // compile-time data
    if (isFixedLine(raw, fullyFree)) {
      if (open) { out.push(open); open = undefined; }
      const spec = raw[5].toUpperCase();
      if (raw[6] === '*') { continue; }
      if (spec === 'C') { out.push({ line: i, code: '', fixedOp: raw.substring(25, 35).trim().toUpperCase().replace(/\(.*$/, '') }); }
      if (spec === 'P') { const be = (raw[23] ?? '').toUpperCase(); if (be === 'B' || be === 'E') { out.push({ line: i, code: '', pSpec: be }); } }
      continue;
    }
    const code = maskLine(raw, fullyFree);
    const body = (fullyFree ? code : code.substring(7)).trim();
    if (!body || /^\//.test(body)) { continue; } // compiler directives
    if (open) { open.code += ' ' + body; } else { open = { line: i, code: body }; }
    if (/;\s*$/.test(body)) { out.push(open); open = undefined; }
  }
  if (open) { out.push(open); }
  return out;
}

/** Folding ranges of an RPG IV source (free and fixed form, mixed). */
export function rpgFolds(text: string): Fold[] {
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const stack: { close: string; line: number }[] = [];
  const folds: Fold[] = [];
  const close = (word: string, line: number) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].close === word || (word === 'END' && stack[k].close.startsWith('END') && !stack[k].close.includes('-'))) {
        const s = stack.splice(k)[0];
        if (line > s.line) { folds.push({ start: s.line, end: line }); }
        return;
      }
    }
  };
  for (const st of freeStatements(lines, fullyFree)) {
    if (st.pSpec) { if (st.pSpec === 'B') { stack.push({ close: 'P-E', line: st.line }); } else { close('P-E', st.line); } continue; }
    if (st.fixedOp !== undefined) {
      const op = st.fixedOp;
      if (FIXED_CLOSE.test(op)) {
        const word = op === 'END' ? 'END' : op === 'ENDCS' ? 'ENDCS' : op;
        close(word, st.line);
      } else if (FIXED_OPEN.test(op)) {
        const word = /^IF/.test(op) ? 'ENDIF' : /^DO/.test(op) ? 'ENDDO' : op === 'FOR' ? 'ENDFOR' : op === 'SELECT' ? 'ENDSL' : op === 'MONITOR' ? 'ENDMON' : op === 'BEGSR' ? 'ENDSR' : 'ENDCS';
        stack.push({ close: word, line: st.line });
      }
      continue;
    }
    const code = st.code.replace(/^[A-Za-z_][\w$#@]*:\s*/, '');
    const m = code.match(FREE_CLOSE);
    if (m) { close(m[1].toUpperCase(), st.line); continue; }
    if (selfContained(code)) { continue; }
    for (const [re, word] of FREE_OPEN) { if (re.test(code)) { stack.push({ close: word, line: st.line }); break; } }
  }
  return folds.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- parameter hints

export interface RpgSignature { name: string; params: { name: string; definition: string }[]; returns: string; line: number }

/** Prototypes, procedures and their parameters declared in the source (free and fixed form). */
export function rpgSignatures(text: string): RpgSignature[] {
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const sigs = new Map<string, RpgSignature>();
  let current: RpgSignature | undefined;
  let procName: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (isFixedLine(raw, fullyFree)) {
      const spec = raw[5].toUpperCase();
      if (raw[6] === '*') { continue; }
      if (spec === 'P') { const nm = raw.substring(6, 21).trim(); if ((raw[23] ?? '').toUpperCase() === 'B' && nm) { procName = nm; } continue; }
      if (spec !== 'D') { current = undefined; continue; }
      const name = raw.substring(6, 21).trim(); const type = raw.substring(23, 25).trim().toUpperCase();
      const def = raw.substring(25, 80).replace(/\s+/g, ' ').trim();
      if (type === 'PR' || type === 'PI') {
        const key = (name || procName || '').toUpperCase();
        if (!key) { current = undefined; continue; }
        current = sigs.get(key) && type === 'PI' ? { ...sigs.get(key)!, params: [] } : { name: name || procName!, params: [], returns: def, line: i };
        sigs.set(key, current);
      } else if (!type && current) {
        current.params.push({ name: name || `parm${current.params.length + 1}`, definition: def });
      } else { current = undefined; }
      continue;
    }
    const code = maskLine(raw, fullyFree).trim();
    if (!code) { continue; }
    let m: RegExpMatchArray | null;
    if ((m = code.match(/^dcl-proc\s+([A-Za-z_$#@][\w$#@]*)/i))) { procName = m[1]; continue; }
    if (/^end-proc\b/i.test(code)) { procName = undefined; continue; }
    if ((m = code.match(/^dcl-(pr|pi)\s+(\*n|[A-Za-z_$#@][\w$#@]*)(.*)$/i))) {
      const name = m[2].toUpperCase() === '*N' ? procName : m[2];
      if (!name) { current = undefined; continue; }
      const rest = raw.substring(raw.toLowerCase().indexOf(m[2].toLowerCase()) + m[2].length).replace(/\/\/.*$/, '').replace(/;\s*$/, '').trim();
      const returns = rest.replace(/\bend-p[ri]\b/i, '').trim();
      const sig: RpgSignature = { name, params: [], returns, line: i };
      if (m[1].toLowerCase() === 'pi' && sigs.has(name.toUpperCase())) { sig.line = sigs.get(name.toUpperCase())!.line; }
      sigs.set(name.toUpperCase(), sig);
      current = /\bend-p[ri]\b/i.test(m[3]) ? undefined : sig;
      continue;
    }
    if (current) {
      if (/^end-p[ri]\b/i.test(code)) { current = undefined; continue; }
      const p = code.match(/^(?:dcl-parm\s+)?([A-Za-z_$#@][\w$#@]*)\s*(.*?);?\s*$/i);
      const original = raw.replace(/\/\/.*$/, '').trim().replace(/^dcl-parm\s+/i, '').replace(/;\s*$/, '');
      if (p) { current.params.push({ name: p[1], definition: original.substring(p[1].length).trim() }); }
    }
  }
  return [...sigs.values()];
}

/** The call being typed at the end of `before`: the procedure name and which parameter (0-based) the cursor is in. */
export function activeCall(before: string): { name: string; index: number } | undefined {
  let depth = 0; let commas = 0; let inString = false;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === "'") { inString = !inString; continue; }
    if (inString) { continue; }
    if (c === ')') { depth++; continue; }
    if (c === '(') {
      if (depth > 0) { depth--; continue; }
      const m = before.substring(0, i).match(/(%?[A-Za-z_$#@][\w$#@]*)\s*$/);
      if (!m) { return undefined; }
      return { name: m[1], index: commas };
    }
    if (c === ':' && depth === 0) { commas++; }
    if (c === ';' && depth === 0) { return undefined; }
  }
  return undefined;
}

/** Signatures of the built-in functions people call most (shown when no prototype matches). */
export const BIF_SIGNATURES: Record<string, string[]> = {
  '%SUBST': ['string', 'start', 'length (optional)'], '%SCAN': ['search argument', 'source string', 'start (optional)', 'length (optional)'],
  '%SCANRPL': ['scan string', 'replacement', 'source', 'start (optional)', 'length (optional)'], '%REPLACE': ['replacement', 'source', 'start (optional)', 'source length to replace (optional)'],
  '%TRIM': ['string', 'characters to trim (optional)'], '%TRIML': ['string', 'characters to trim (optional)'], '%TRIMR': ['string', 'characters to trim (optional)'],
  '%XLATE': ['from', 'to', 'string', 'start (optional)'], '%CHAR': ['expression', 'format (optional)'], '%DEC': ['expression', 'digits', 'decimals'],
  '%INT': ['expression'], '%EDITC': ['number', 'edit code', '*ASTFILL | *CURSYM | currency (optional)'], '%EDITW': ['number', 'edit word'],
  '%DATE': ['expression (optional)', 'format (optional)'], '%TIMESTAMP': ['expression (optional)', 'format (optional)'], '%DIFF': ['date 1', 'date 2', 'unit (*DAYS, *MONTHS…)'],
  '%LOOKUP': ['argument', 'array', 'start index (optional)', 'number of elements (optional)'], '%ELEM': ['array, table or multiple-occurrence DS'],
  '%LEN': ['expression'], '%SIZE': ['variable', '*ALL (optional)'], '%CHECK': ['allowed characters', 'string', 'start (optional)'], '%CHECKR': ['allowed characters', 'string', 'start (optional)'],
  '%SPLIT': ['string', 'separators (optional)', '*ALLSEP (optional)'], '%CONCAT': ['separator', 'string 1', 'string 2', '…'], '%UPPER': ['string', 'start (optional)', 'length (optional)'], '%LOWER': ['string', 'start (optional)', 'length (optional)'],
  '%FOUND': ['file name (optional)'], '%EOF': ['file name (optional)'], '%EQUAL': ['file name (optional)'], '%OPEN': ['file name'], '%ERROR': [], '%STATUS': ['file name (optional)'],
  '%ADDR': ['variable', '*DATA (optional)'], '%PADDR': ['procedure name'], '%RANGE': ['low', 'high'], '%LIST': ['item 1', 'item 2', '…'], '%MAX': ['value 1', 'value 2', '…'], '%MIN': ['value 1', 'value 2', '…'],
};

// ---------------------------------------------------------------- formatter

const FMT_OPEN = /^(dcl-proc|dcl-ds|dcl-pr|dcl-pi|dcl-enum|if|dow|dou|for|for-each|select|monitor|begsr)\b/i;
const FMT_CLOSE = /^(end-proc|end-ds|end-pr|end-pi|end-enum|endif|enddo|endfor|endsl|endmon|endsr)\b/i;
const FMT_MIDDLE = /^(else|elseif|other|when|when-is|when-in|on-error|on-exit)\b/i;

/**
 * Re-indent a fully free (**FREE) source: nesting by blocks, ELSE/WHEN/ON-ERROR one level back, continuation lines
 * keep their offset from the statement's first line, directives and compile-time data stay where they are.
 * Returns the new lines (same count) or undefined when the source is not fully free.
 */
export function formatFreeRpg(text: string, indent = 2): string[] | undefined {
  const lines = text.split(/\r?\n/);
  if (!isFullyFreeSource(text)) { return undefined; }
  const unit = ' '.repeat(Math.max(1, Math.min(8, indent)));
  let level = 0;
  let inStatement = false; let stmtShift = 0;
  let inSql = false;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (i === 0) { out.push(raw.trimEnd()); continue; }
    if (/^\*\*(ctdata|ftrans|altseq)?(\s|$)/i.test(raw)) { out.push(...lines.slice(i)); break; }
    const trimmed = raw.trim();
    if (!trimmed) { out.push(''); continue; }
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) { out.push(raw.trimEnd()); continue; }
    const code = maskLine(raw, true).trim();
    if (inStatement) {
      // Continuation: keep the original offset relative to where the statement now starts.
      const own = raw.length - raw.trimStart().length;
      out.push(' '.repeat(Math.max(0, own + stmtShift)) + trimmed);
      if (/;\s*$/.test(code)) { inStatement = false; inSql = false; }
      continue;
    }
    if (!code) { out.push(unit.repeat(level) + trimmed); continue; } // comment-only line
    const word = code.replace(/^[A-Za-z_][\w$#@]*:\s*/, '');
    let my = level;
    const isSelect = /^select\b/i.test(word);
    if (FMT_CLOSE.test(word)) { level = Math.max(0, level - (/^endsl\b/i.test(word) ? 2 : 1)); my = level; }
    else if (FMT_MIDDLE.test(word)) { my = Math.max(0, level - 1); }
    const own = raw.length - raw.trimStart().length;
    out.push(unit.repeat(my) + trimmed);
    const statementEnds = /;\s*$/.test(code);
    if (FMT_OPEN.test(word) && !selfContained(word + (statementEnds ? '' : ' ' + lookAheadStatement(lines, i + 1)))) { level += isSelect ? 2 : 1; }
    if (!statementEnds) { inStatement = true; stmtShift = unit.length * my - own; inSql = /^exec\s+sql\b/i.test(word); }
  }
  void inSql;
  return out;
}

/** Rest of a statement continued on the next lines (for DCL-DS … LIKEDS(…) written over several lines). */
function lookAheadStatement(lines: string[], from: number): string {
  let s = '';
  for (let i = from; i < lines.length && i < from + 20; i++) {
    const c = maskLine(lines[i], true).trim();
    s += ' ' + c;
    if (/;\s*$/.test(c)) { break; }
  }
  return s;
}

// ---------------------------------------------------------------- fixed-format columns

export interface FieldAt { spec: string; title: string; field?: SpecField; index: number; fields: SpecField[] }

/** Which fixed-format field the cursor (0-based character) is in. */
export function fieldAt(line: string, character: number, language: 'rpgle' | 'dds'): FieldAt | undefined {
  if (language === 'rpgle' && !isFixedLine(line.padEnd(6), false)) { return undefined; }
  const layout = layoutFor(line.padEnd(7), language);
  if (!layout) { return undefined; }
  const col = character + 1;
  const index = layout.fields.findIndex(f => col >= f.from && col <= f.to);
  return { spec: layout.spec, title: layout.title, field: index >= 0 ? layout.fields[index] : undefined, index, fields: layout.fields };
}

/** Column (0-based) of the next or previous field start on a fixed-format line. */
export function nextFieldColumn(line: string, character: number, language: 'rpgle' | 'dds', backwards = false): number | undefined {
  const at = fieldAt(line, character, language);
  if (!at) { return undefined; }
  const starts = at.fields.map(f => f.from - 1);
  if (backwards) { const prev = starts.filter(s => s < character).pop(); return prev; }
  return starts.find(s => s > character);
}
