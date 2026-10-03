// Lightweight RPG IV source scanner (pure, unit tested). Finds declarations, /COPY directives
// and word occurrences for navigation, rename and lint. It is deliberately tolerant: it never
// throws on unusual source, it just finds less.

export type RpgKind =
  | 'variable' | 'constant' | 'ds' | 'subfield' | 'prototype' | 'procedure'
  | 'file' | 'subroutine' | 'parameter' | 'enum';

export interface RpgDefinition {
  name: string;
  upper: string;
  kind: RpgKind;
  line: number;
  column: number;
  /** Enclosing data structure / prototype / procedure interface. */
  parent?: string;
  /** Enclosing procedure (undefined = global / main). */
  procedure?: string;
  detail: string;
}

export interface CopyDirective {
  line: number;
  /** Start / end character of the target text on the line (for document links). */
  start: number;
  end: number;
  target: string;
  library?: string;
  file?: string;
  member?: string;
  ifsPath?: string;
}

export interface RpgParse {
  fullyFree: boolean;
  definitions: RpgDefinition[];
  copies: CopyDirective[];
  /** Procedure ranges (start/end line). */
  procedures: { name: string; start: number; end: number }[];
}

const NAME = '[A-Za-z$#@_][\\w$#@]*';
const WORD_CHAR = /[\w$#@]/;
/** /COPY or /INCLUDE: only blanks (or a fixed-format sequence number + spec column) may precede it. */
const COPY_RE = /^((?:[ 0-9]{5}[ A-Za-z])?\s*)\/(copy|include)\s+('[^']+'|"[^"]+"|\S+)/i;
const COPY_LINE = /^(?:[ 0-9]{5}[ A-Za-z])?\s*\/(copy|include)\b/i;
const FIELD_TYPES = 'char|varchar|graph|vargraph|ucs2|varucs2|packed|zoned|int|uns|bindec|float|date|time|timestamp|ind|pointer|object|like|likeds|likerec|dim|pos|overlay|inz';

/** True when the line is a fixed-format spec (column 6 letter, not a free-form line). */
export function isFixedLine(line: string, fullyFree: boolean): boolean {
  if (fullyFree || line.length < 6) { return false; }
  const spec = line[5].toUpperCase();
  return 'HFDICOP'.includes(spec) && spec !== ' ' && /^[ 0-9A-Za-z]{5}$/.test(line.substring(0, 5));
}

/**
 * Replace string literals and comments by spaces so searches only see code.
 * Keeps the line length identical so columns still match the original.
 */
export function maskLine(line: string, fullyFree: boolean): string {
  if (!fullyFree && line.length > 6 && (line[6] === '*') && /^[ 0-9A-Za-z]{5}[ A-Za-z]$/.test(line.substring(0, 6))) {
    return ' '.repeat(line.length);
  }
  let out = '';
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (!inString && c === '/' && line[i + 1] === '/') {
      return out + ' '.repeat(line.length - i);
    }
    if (c === "'") {
      inString = !inString;
      out += ' ';
      continue;
    }
    out += inString ? ' ' : c;
  }
  // Fixed-format comment area (cols 81+) is not code.
  if (!fullyFree && isFixedLine(line, false) && out.length > 80) { out = out.substring(0, 80) + ' '.repeat(out.length - 80); }
  // Sequence-number area (cols 1-5) of non-free sources is not code either.
  if (!fullyFree && out.length >= 5) { out = '     ' + out.substring(5); }
  return out;
}

export function isFullyFreeSource(text: string): boolean {
  return /^\s*\*\*free/i.test(text.split(/\r?\n/, 1)[0] ?? '');
}

export function parseRpg(text: string): RpgParse {
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const definitions: RpgDefinition[] = [];
  const copies: CopyDirective[] = [];
  const procedures: { name: string; start: number; end: number }[] = [];

  let block: { kind: 'ds' | 'pr' | 'pi' | 'enum'; name: string } | undefined;
  let procedure: { name: string; start: number } | undefined;
  let fixedParent: { kind: 'ds' | 'pr' | 'pi'; name: string } | undefined;

  const add = (name: string, kind: RpgKind, line: number, column: number, detail: string, parent?: string) => {
    if (!name || name.startsWith('*')) { return; }
    definitions.push({ name, upper: name.toUpperCase(), kind, line, column, parent, procedure: procedure?.name, detail: detail.trim() });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // /COPY and /INCLUDE (free or fixed, directive may start in column 7).
    const copy = raw.match(COPY_RE);
    if (copy) {
      const targetRaw = copy[3];
      const start = raw.indexOf(targetRaw, copy[1].length);
      copies.push({ line: i, start, end: start + targetRaw.length, ...parseCopyTarget(targetRaw) });
      continue;
    }

    const code = maskLine(raw, fullyFree);
    if (!code.trim()) { continue; }

    if (isFixedLine(raw, fullyFree)) {
      parseFixed(raw, i);
      continue;
    }

    const trimmed = code.trim();
    const col = (name: string) => Math.max(0, raw.indexOf(name, code.search(/\S/)));
    let m: RegExpMatchArray | null;

    if (/^end-(ds|pr|pi|enum)\b/i.test(trimmed)) { block = undefined; continue; }
    if (/^end-proc\b/i.test(trimmed)) {
      if (procedure) { procedures.push({ name: procedure.name, start: procedure.start, end: i }); }
      procedure = undefined; block = undefined;
      continue;
    }

    if ((m = trimmed.match(new RegExp(`^dcl-(s|c|ds|pr|pi|proc|f|enum)\\s+(\\*n|${NAME})(.*)$`, 'i')))) {
      const kw = m[1].toLowerCase();
      const name = m[2];
      const rest = m[3];
      const singleLine = /\bend-(ds|pr|pi|enum)\b/i.test(rest) || (kw === 'ds' && /\b(likeds|likerec)\s*\(/i.test(rest));
      switch (kw) {
        case 's': add(name, 'variable', i, col(name), rest.replace(/;\s*$/, '')); break;
        case 'c': add(name, 'constant', i, col(name), rest.replace(/;\s*$/, '')); break;
        case 'f': add(name, 'file', i, col(name), rest.replace(/;\s*$/, '')); break;
        case 'proc':
          add(name, 'procedure', i, col(name), 'procedure');
          procedure = { name, start: i };
          break;
        case 'ds': add(name, 'ds', i, col(name), rest.replace(/;\s*$/, '') || 'data structure');
          if (!singleLine) { block = { kind: 'ds', name }; }
          break;
        case 'pr': add(name, 'prototype', i, col(name), rest.replace(/;\s*$/, '') || 'prototype');
          if (!singleLine) { block = { kind: 'pr', name }; }
          break;
        case 'pi':
          if (!singleLine) { block = { kind: 'pi', name: name.startsWith('*') ? (procedure?.name ?? '*N') : name }; }
          break;
        case 'enum': add(name, 'enum', i, col(name), 'enumeration');
          if (!singleLine) { block = { kind: 'enum', name }; }
          break;
      }
      continue;
    }

    // Subfields / parameters: "dcl-subf x", or a name followed by a type keyword or ';'.
    // (A continued keyword line such as "inz('x');" is not a declaration.)
    if (block && (m = trimmed.match(block.kind === 'enum'
      ? new RegExp(`^(${NAME})\\b(.*)$`, 'i')
      : new RegExp(`^(?:dcl-subf\\s+|dcl-parm\\s+)(${NAME})\\b(.*)$|^(${NAME})(\\s+(?:${FIELD_TYPES})\\b.*|\\s*;.*)$`, 'i')))) {
      if (m[1] === undefined && m[3] !== undefined) { m[1] = m[3]; m[2] = m[4]; }
      const kind: RpgKind = block.kind === 'ds' ? 'subfield' : block.kind === 'enum' ? 'constant' : 'parameter';
      // Prototype parameter names are documentation only; don't offer them as definitions.
      if (block.kind !== 'pr') { add(m[1], kind, i, col(m[1]), m[2].replace(/;\s*$/, ''), block.name); }
      continue;
    }

    if ((m = trimmed.match(new RegExp(`^begsr\\s+(${NAME})`, 'i')))) {
      add(m[1], 'subroutine', i, col(m[1]), 'subroutine');
    }
  }
  if (procedure) { procedures.push({ name: procedure.name, start: procedure.start, end: lines.length - 1 }); }
  return { fullyFree, definitions, copies, procedures };

  function parseFixed(line: string, i: number): void {
    const spec = line[5].toUpperCase();
    if (spec === 'D') {
      const name = line.substring(6, 21).trim();
      const type = line.substring(23, 25).trim().toUpperCase();
      const detail = line.substring(25, 80).trim();
      if (type === 'DS' || type === 'PR' || type === 'PI') {
        if (type === 'DS') { add(name, 'ds', i, 6, detail || 'data structure'); }
        if (type === 'PR') { add(name, 'prototype', i, 6, detail || 'prototype'); }
        fixedParent = { kind: type.toLowerCase() as 'ds' | 'pr' | 'pi', name: name || procedure?.name || '*N' };
      } else if (type === 'S') {
        add(name, 'variable', i, 6, detail); fixedParent = undefined;
      } else if (type === 'C') {
        add(name, 'constant', i, 6, detail); fixedParent = undefined;
      } else if (!type && name && fixedParent) {
        if (fixedParent.kind !== 'pr') {
          add(name, fixedParent.kind === 'ds' ? 'subfield' : 'parameter', i, 6, detail, fixedParent.name);
        }
      }
    } else if (spec === 'F') {
      const name = line.substring(6, 16).trim();
      if (name) { add(name, 'file', i, 6, line.substring(16, 80).trim()); }
    } else if (spec === 'P') {
      const name = line.substring(6, 21).trim();
      const be = (line[23] ?? '').toUpperCase();
      if (be === 'B' && name) {
        add(name, 'procedure', i, 6, 'procedure');
        procedure = { name, start: i };
      } else if (be === 'E') {
        if (procedure) { procedures.push({ name: procedure.name, start: procedure.start, end: i }); }
        procedure = undefined; fixedParent = undefined;
      }
    } else if (spec === 'C') {
      const op = line.substring(25, 35).trim().toUpperCase();
      if (op === 'BEGSR') {
        const name = line.substring(11, 25).trim();
        add(name, 'subroutine', i, 11, 'subroutine');
      }
    }
  }
}

export function parseCopyTarget(targetRaw: string): Omit<CopyDirective, 'line' | 'start' | 'end'> {
  const target = targetRaw.trim();
  if (/^['"]/.test(target)) {
    return { target, ifsPath: target.slice(1, -1) };
  }
  if (target.startsWith('/') || /\.\w+$/.test(target) && !target.includes(',')) {
    return { target, ifsPath: target };
  }
  const m = target.match(/^(?:([^/,\s]+)\/)?(?:([^/,\s]+),)?([^/,\s]+)$/);
  if (!m) { return { target }; }
  return {
    target,
    library: m[1]?.toUpperCase(),
    file: m[2]?.toUpperCase(),
    member: m[3].toUpperCase(),
  };
}

export interface Occurrence { line: number; start: number; end: number; }

/** All whole-word, case-insensitive occurrences of name in code (not in strings or comments). */
export function findOccurrences(text: string, name: string): Occurrence[] {
  const lines = text.split(/\r?\n/);
  const fullyFree = isFullyFreeSource(text);
  const target = name.toUpperCase();
  const out: Occurrence[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (COPY_LINE.test(lines[i])) { continue; }
    const code = maskLine(lines[i], fullyFree).toUpperCase();
    let from = 0;
    for (;;) {
      const idx = code.indexOf(target, from);
      if (idx === -1) { break; }
      const before = idx > 0 ? code[idx - 1] : ' ';
      const after = code[idx + target.length] ?? ' ';
      // '%' before means a BIF (e.g. %LEN vs LEN), '*' a special value (*IN vs IN).
      // '*' is a special-value prefix (*IN, *ON) only when it doesn't follow an operand (qty*price).
      const beforeStar = idx > 1 ? code[idx - 2] : ' ';
      const specialValue = before === '*' && !WORD_CHAR.test(beforeStar) && beforeStar !== ')';
      if (!WORD_CHAR.test(before) && before !== '%' && !specialValue && !WORD_CHAR.test(after)) {
        out.push({ line: i, start: idx, end: idx + target.length });
      }
      from = idx + target.length;
    }
  }
  return out;
}

/** The identifier at a character position, if any. */
export function wordAt(line: string, character: number): { word: string; start: number; end: number } | undefined {
  let s = character;
  let e = character;
  while (s > 0 && WORD_CHAR.test(line[s - 1])) { s--; }
  while (e < line.length && WORD_CHAR.test(line[e])) { e++; }
  if (s === e) { return undefined; }
  const word = line.substring(s, e);
  if (/^\d/.test(word)) { return undefined; }
  return { word, start: s, end: e };
}

/** Pick the best definition for a name used at a given line (local to procedure first). */
export function resolveDefinition(parse: RpgParse, name: string, line: number): RpgDefinition | undefined {
  const upper = name.toUpperCase();
  const candidates = parse.definitions.filter(d => d.upper === upper);
  if (!candidates.length) { return undefined; }
  const proc = parse.procedures.find(p => line >= p.start && line <= p.end);
  return candidates.find(d => proc && d.procedure === proc.name && d.kind !== 'procedure')
    ?? candidates.find(d => !d.procedure || d.kind === 'procedure')
    ?? candidates[0];
}
