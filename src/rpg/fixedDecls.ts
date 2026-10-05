// Fixed-format RPG IV H, F, D and P specs -> free-form declarations (pure module, unit tested).
// ctl-opt, dcl-f, dcl-s, dcl-c, dcl-ds / end-ds, dcl-pr / end-pr, dcl-pi / end-pi, dcl-proc / end-proc.
// Anything it can't convert safely is kept with a "// TODO" comment so nothing is silently lost.

export interface DeclResult {
  lines: string[];
  todo: number;
}

/** Names that are also free-form op codes need DCL-SUBF / DCL-PARM. */
const OPCODE_NAMES = new Set([
  'ACQ', 'BEGSR', 'CALLP', 'CHAIN', 'CLEAR', 'CLOSE', 'COMMIT', 'DEALLOC', 'DELETE', 'DOU', 'DOW', 'DSPLY', 'DUMP',
  'ELSE', 'ELSEIF', 'ENDDO', 'ENDFOR', 'ENDIF', 'ENDMON', 'ENDSL', 'ENDSR', 'EVAL', 'EVALR', 'EXCEPT', 'EXFMT', 'EXSR',
  'FEOD', 'FOR', 'FORCE', 'IF', 'IN', 'ITER', 'LEAVE', 'LEAVESR', 'MONITOR', 'NEXT', 'ON-ERROR', 'OPEN', 'OTHER', 'OUT',
  'POST', 'READ', 'READC', 'READE', 'READP', 'READPE', 'REL', 'RESET', 'RETURN', 'ROLBK', 'SELECT', 'SETGT', 'SETLL',
  'SORTA', 'TEST', 'UNLOCK', 'UPDATE', 'WHEN', 'WRITE', 'XML-INTO', 'XML-SAX', 'DATA-INTO', 'DATA-GEN', 'SND-MSG',
]);

interface DSpec {
  name: string;
  ext: string;      // col 22: E = externally described
  dsType: string;   // col 23: S = PSDS, U = data area DS
  def: string;      // cols 24-25: '', C, DS, PR, PI, S
  from: string;     // 26-32
  to: string;       // 33-39
  type: string;     // 40
  dec: string;      // 41-42
  keywords: string; // 44-80
  comment: string;  // 81+
}

function col(line: string, from: number, to: number): string {
  return line.substring(from - 1, to).trim();
}

function parseD(line: string): DSpec {
  const l = line.padEnd(80, ' ');
  return {
    name: col(l, 7, 21), ext: col(l, 22, 22).toUpperCase(), dsType: col(l, 23, 23).toUpperCase(),
    def: col(l, 24, 25).toUpperCase(), from: col(l, 26, 32), to: col(l, 33, 39), type: col(l, 40, 40).toUpperCase(),
    dec: col(l, 41, 42), keywords: col(l, 44, 80), comment: line.length > 80 ? line.substring(80).trim() : '',
  };
}

/** Split "A(1) B(X:Y) 'lit eral' C" into keywords, respecting parentheses and quotes. */
export function splitKeywords(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote = false;
  for (const ch of text) {
    if (ch === "'") { quote = !quote; }
    if (!quote) {
      if (ch === '(') { depth++; }
      if (ch === ')') { depth = Math.max(0, depth - 1); }
      if (/\s/.test(ch) && depth === 0) { if (cur) { out.push(cur); cur = ''; } continue; }
    }
    cur += ch;
  }
  if (cur) { out.push(cur); }
  return out;
}

function kwName(k: string): string {
  return k.replace(/\(.*$/s, '').toUpperCase();
}

function kwArg(k: string): string | undefined {
  const m = k.match(/^[^(]+\(([\s\S]*)\)$/);
  return m ? m[1].trim() : undefined;
}

/** Free-form type for a D-spec, plus keywords that the type absorbed. */
export function freeType(d: { from: string; to: string; type: string; dec: string; def: string }, keywords: string[],
  defaultNumeric?: 'P' | 'S'):
  { type: string; keywords: string[]; todo?: string } {
  let kws = [...keywords];
  const take = (name: string) => {
    const i = kws.findIndex(k => kwName(k) === name);
    if (i < 0) { return undefined; }
    const k = kws[i];
    kws.splice(i, 1);
    return k;
  };
  // LIKE(x) with a length adjustment (+n / -n in the length columns) -> LIKE(x:+n).
  if (/^[+-]\d+$/.test(d.to)) {
    const i = kws.findIndex(k => kwName(k) === 'LIKE');
    if (i >= 0) { kws[i] = `${kws[i].replace(/\)\s*$/, '')}:${d.to})`; return { type: '', keywords: kws }; }
    return { type: '', keywords: kws, todo: `length adjustment ${d.to} without LIKE – check the declaration` };
  }
  const from = Number(d.from) || 0;
  const toLen = Number(d.to) || 0;
  const hasLen = toLen > 0;
  // With from/to positions the length is in bytes.
  const bytes = from > 0 && hasLen ? toLen - from + 1 : 0;
  let len = bytes || toLen;
  const decimals = d.dec === '' ? undefined : Number(d.dec);
  let t = d.type;
  if (!t) {
    if (!hasLen) { return { type: '', keywords: kws }; } // LIKE / LIKEDS / no type
    // Blank type: character without decimals; with decimals, zoned in a DS and packed elsewhere.
    t = decimals === undefined ? 'A' : (defaultNumeric ?? 'P');
  }
  const varying = take('VARYING');
  const vArg = varying ? kwArg(varying) : undefined;
  switch (t) {
    case 'A': return { type: `${varying ? 'varchar' : 'char'}(${len}${vArg ? ':' + vArg : ''})`, keywords: kws };
    case 'G': return { type: `${varying ? 'vargraph' : 'graph'}(${bytes ? bytes / 2 : len}${vArg ? ':' + vArg : ''})`, keywords: kws };
    case 'C': return { type: `${varying ? 'varucs2' : 'ucs2'}(${bytes ? bytes / 2 : len}${vArg ? ':' + vArg : ''})`, keywords: kws };
    case 'P': if (bytes) { len = bytes * 2 - 1; } return { type: `packed(${len}:${decimals ?? 0})`, keywords: kws };
    case 'S': return { type: `zoned(${len}:${decimals ?? 0})`, keywords: kws };
    case 'B': if (bytes) { len = bytes === 2 ? 4 : 9; } return { type: `bindec(${len}:${decimals ?? 0})`, keywords: kws };
    case 'I': case 'U': {
      if (bytes) { len = ({ 1: 3, 2: 5, 4: 10, 8: 20 } as Record<number, number>)[bytes] ?? len; }
      return { type: `${t === 'I' ? 'int' : 'uns'}(${len})`, keywords: kws };
    }
    case 'F': return { type: `float(${bytes || len})`, keywords: kws };
    case 'N': return { type: 'ind', keywords: kws };
    case 'D': { const f = take('DATFMT'); return { type: f ? `date(${kwArg(f)})` : 'date', keywords: kws }; }
    case 'T': { const f = take('TIMFMT'); return { type: f ? `time(${kwArg(f)})` : 'time', keywords: kws }; }
    case 'Z': return { type: 'timestamp', keywords: kws };
    case '*': { const p = take('PROCPTR'); return { type: p ? 'pointer(*proc)' : 'pointer', keywords: kws }; }
    case 'O': {
      const c = take('CLASS');
      if (c) { return { type: `object(${kwArg(c)})`, keywords: kws }; }
      kws = keywords;
      return { type: 'object', keywords: kws, todo: 'object type without CLASS keyword' };
    }
    default: return { type: `char(${len})`, keywords: kws, todo: `unknown data type "${t}" – check the declaration` };
  }
}

function fileUsage(type: string, addition: boolean, device: string): string | undefined {
  const t = type.toUpperCase();
  const dev = device.toUpperCase();
  let parts: string[];
  if (t === 'I') { parts = ['*input']; }
  else if (t === 'U') { parts = ['*update', '*delete']; }
  else if (t === 'O') { parts = ['*output']; }
  else if (t === 'C') { parts = ['*input', '*output']; }
  else { return undefined; }
  if (addition && !parts.includes('*output')) { parts.push('*output'); }
  const joined = parts.join(':');
  // Free-form defaults: DISK = *input, PRINTER = *output, WORKSTN = *input:*output.
  if ((dev === 'DISK' || dev === '') && joined === '*input') { return undefined; }
  if (dev === 'PRINTER' && joined === '*output') { return undefined; }
  if (dev === 'WORKSTN' && joined === '*input:*output') { return undefined; }
  return `usage(${joined})`;
}

function comment(line: string, indent: string): string {
  const text = line.substring(7).replace(/^\*?/, '').trimEnd();
  return `${indent}//${text ? ' ' + text.trimStart() : ''}`;
}

/** Join keyword text continued on the next line, following the rules for continued literals. */
export function joinKeywords(prev: string, nextRaw: string): string {
  const open = ((prev.match(/'/g) ?? []).length % 2) === 1;
  if (open && /[-+]$/.test(prev)) {
    // '-' continues with position 44 of the next line (blanks kept); '+' with its first non-blank character.
    return prev.slice(0, -1) + (prev.endsWith('+') ? nextRaw.trimStart() : nextRaw).trimEnd();
  }
  return `${prev} ${nextRaw.trim()}`.trim();
}

interface Entry { line: string; kw?: string; }

function isKeywordContinuation(line: string): boolean {
  const spec = (line[5] ?? ' ').toUpperCase();
  if (!'DFP'.includes(spec) || spec === ' ' || line[6] === '*' || line[6] === '/') { return false; }
  const l = line.padEnd(80, ' ');
  if (l.substring(6, 42).trim() !== '') { return false; }
  return l.substring(43, 80).trim() !== '';
}

/** Merge keyword-only continuation lines into the spec they continue. */
function mergeContinuations(input: string[]): (Entry & { orphan?: boolean })[] {
  const out: (Entry & { orphan?: boolean })[] = [];
  for (const raw of input) {
    const line = raw.replace(/\s+$/, '');
    if (isKeywordContinuation(line)) {
      const prev = out[out.length - 1];
      const prevSpec = prev ? (prev.line[5] ?? ' ').toUpperCase() : '';
      if (prev && !prev.orphan && prevSpec === (line[5] ?? '').toUpperCase() && prev.line[6] !== '*' && prev.line[6] !== '/'
        && !/^\S+\.\.\.$/.test(prev.line.substring(6).trim())) {
        prev.kw = joinKeywords(prev.kw ?? col(prev.line.padEnd(80, ' '), 44, 80), line.padEnd(80, ' ').substring(43, 80));
        continue;
      }
      out.push({ line, orphan: true });
      continue;
    }
    out.push({ line });
  }
  return out;
}

/**
 * Convert a block of H/F/D/P specs (blank lines, comments and directives may be mixed in).
 * `base` is the prefix for each output line ('' for **FREE, 7 spaces for column-8 free form).
 */
export function convertDeclarations(input: string[], base = '       ', step = '  '): DeclResult {
  const out: string[] = [];
  let todo = 0;
  let open: { kind: 'ds' | 'pr' | 'pi'; name: string } | undefined;
  let pendingName = '';
  const ind = () => base + step.repeat(open ? 1 : 0);
  const emit = (text: string, trailing = '') => { out.push(ind() + text + (trailing ? ` // ${trailing}` : '')); };
  const flag = (text: string) => { todo++; out.push(`${ind()}// TODO: ${text}`); };
  const closeOpen = () => {
    if (!open) { return; }
    const kind = open.kind;
    open = undefined;
    emit(`end-${kind};`);
  };

  for (const entry of mergeContinuations(input)) {
    const line = entry.line;
    if (!line.trim()) { out.push(''); continue; }
    const spec = (line[5] ?? ' ').toUpperCase();
    const c7 = line[6] ?? ' ';
    if (c7 === '*' || line.substring(6).trimStart().startsWith('//')) {
      out.push(c7 === '*' ? comment(line, ind()) : ind() + line.substring(6).trim());
      continue;
    }
    if (c7 === '/') {
      if (!/^\/(free|end-free)\b/i.test(line.substring(6).trim())) { out.push(ind() + line.substring(6).trim()); }
      continue;
    }
    if (entry.orphan) { flag(`continuation line without a declaration: ${line.substring(43).trim()}`); continue; }

    if (spec === 'H') {
      const kws = line.substring(6, 80).trim();
      if (kws) { emit(`ctl-opt ${kws};`); }
      continue;
    }

    if (spec === 'F') {
      const l = line.padEnd(80, ' ');
      const name = col(l, 7, 16);
      const kws = entry.kw ?? col(l, 44, 80);
      closeOpen();
      const type = col(l, 17, 17);
      const addition = col(l, 20, 20).toUpperCase() === 'A';
      const format = col(l, 22, 22).toUpperCase();
      const recLen = col(l, 23, 27);
      const keyLen = col(l, 29, 33);
      const rat = col(l, 34, 34).toUpperCase();
      const org = col(l, 35, 35).toUpperCase();
      const device = col(l, 36, 42).toUpperCase() || 'DISK';
      const parts = [`dcl-f ${name}`];
      if (format === 'F') {
        parts.push(`${device.toLowerCase()}(${recLen || '*ext'})`);
        // Program-described indexed files: a key type in 34 (A, P, K…) or I in 35.
        if (rat || org === 'I') { parts.push(`keyed(${rat === 'P' ? '*packed' : rat === 'G' ? '*graph' : rat === 'U' ? '*ucs2' : '*char'}:${keyLen || '1'})`); }
      } else {
        if (device !== 'DISK') { parts.push(device === 'SEQ' ? 'seq' : device.toLowerCase()); }
        if (rat === 'K') { parts.push('keyed'); }
      }
      const usage = fileUsage(type, addition, device);
      if (usage) { parts.push(usage); }
      if (kws) { parts.push(kws); }
      emit(`${parts.join(' ')};`, col(line.padEnd(100, ' '), 81, 100));
      const designation = col(l, 18, 18).toUpperCase();
      if (designation === 'P' || designation === 'T' || designation === 'R') {
        flag(`file ${name} used designation "${designation}" (primary/table/record-address) – not available in free form`);
      }
      continue;
    }

    if (spec === 'P') {
      const cont = line.substring(6).trim().match(/^(\S+)\.\.\.$/);
      if (cont) { pendingName += cont[1]; continue; }
      const l = line.padEnd(80, ' ');
      const name = pendingName + col(l, 7, 21);
      pendingName = '';
      const be = col(l, 24, 24).toUpperCase();
      const kws = entry.kw ?? col(l, 44, 80);
      closeOpen();
      if (be === 'B') { emit(`dcl-proc ${name}${kws ? ' ' + kws : ''};`); }
      else if (be === 'E') { emit('end-proc;'); }
      else { flag(`P-spec without B or E: ${line.substring(6).trim()}`); }
      continue;
    }

    if (spec !== 'D') { out.push(line); continue; }

    // A long name continues over lines ending in "..." (the name may use columns 7-80).
    const cont = line.substring(6).trim().match(/^(\S+)\.\.\.$/);
    if (cont) { pendingName += cont[1]; continue; }
    const d = parseD(line);
    if (entry.kw !== undefined) { d.keywords = entry.kw; }
    const name = pendingName + d.name;
    pendingName = '';

    let keywords = splitKeywords(d.keywords);

    if (d.def === 'C') {
      closeOpen();
      const constKw = keywords.find(k => kwName(k) === 'CONST');
      const value = constKw ? kwArg(constKw) : d.keywords;
      emit(`dcl-c ${name} ${value};`, d.comment);
      continue;
    }

    if (d.def === 'DS' || d.def === 'PR' || d.def === 'PI') {
      closeOpen();
      const kind = d.def.toLowerCase() as 'ds' | 'pr' | 'pi';
      const head: string[] = [`dcl-${kind} ${name || '*n'}`];
      if (kind === 'ds') {
        // An externally described DS without EXTNAME is described by the file of the same name.
        if (d.ext === 'E' && !keywords.some(k => kwName(k) === 'EXTNAME')) { head.push(`extname('${name.toUpperCase()}')`); }
        if (d.dsType === 'S') { head.push('psds'); }
        if (d.dsType === 'U') { head.push('dtaara(*auto)'); }
        if (d.to && !d.from && !d.type && !/^[+-]/.test(d.to)) { head.push(`len(${Number(d.to)})`); }
      } else if (d.type || d.to) {
        const t = freeType({ ...d, def: 'S' }, keywords);
        keywords = t.keywords;
        if (t.type) { head.push(t.type); }
        if (t.todo) { flag(t.todo); }
      }
      head.push(...keywords);
      // Data structures defined with LIKEDS / LIKEREC have no subfields and no END-DS.
      const noBody = kind === 'ds' && keywords.some(k => /^(LIKEDS|LIKEREC)$/.test(kwName(k)));
      emit(`${head.join(' ')};`, d.comment);
      if (!noBody) { open = { kind, name: name || '*n' }; }
      continue;
    }

    if (d.def === 'S') {
      closeOpen();
      const t = freeType(d, keywords);
      if (t.todo) { flag(t.todo); }
      emit(`dcl-s ${name}${t.type ? ' ' + t.type : ''}${t.keywords.length ? ' ' + t.keywords.join(' ') : ''};`, d.comment);
      continue;
    }

    // Subfield or parameter.
    if (!open) { flag(`D-spec "${name}" outside a data structure or prototype: ${line.substring(6).trim()}`); continue; }
    if (open.kind === 'ds') {
      // OVERLAY(ds:pos) on the data structure itself is POS(pos) in free form; OVERLAY(ds:*NEXT) is simply the next position.
      const dsName = open.name.toUpperCase();
      keywords = keywords.flatMap(k => {
        if (kwName(k) !== 'OVERLAY') { return [k]; }
        const [target, pos] = (kwArg(k) ?? '').split(':').map(x => x.trim());
        if (target.toUpperCase() !== dsName) { return [k]; }
        if (pos && pos.toUpperCase() === '*NEXT') { return []; }
        return [`pos(${pos || '1'})`];
      });
      if (d.from && d.to) { keywords.unshift(`pos(${Number(d.from)})`); }
    }
    const t = freeType(d, keywords, open.kind === 'ds' ? 'S' : 'P');
    if (t.todo) { flag(t.todo); }
    const fname = name || '*n';
    const prefix = OPCODE_NAMES.has(fname.toUpperCase()) ? (open.kind === 'ds' ? 'dcl-subf ' : 'dcl-parm ') : '';
    // POS must come after the type in free form.
    const posKw = t.keywords.filter(k => kwName(k) === 'POS');
    const rest = t.keywords.filter(k => kwName(k) !== 'POS');
    const pieces = [prefix + fname, t.type, ...rest, ...posKw].filter(Boolean);
    emit(`${pieces.join(' ')};`, d.comment);
  }
  closeOpen();
  if (pendingName) { flag(`unfinished long name "${pendingName}..."`); }
  return { lines: out, todo };
}

/**
 * Column-8 free form ignores everything after column 80, so long statements are wrapped at blanks
 * outside literals, and trailing comments that would not fit move onto their own line.
 */
export function wrapAt80(lines: string[], width = 80): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= width || /^\s*(\/\/|\*\*)/.test(line)) { out.push(line); continue; }
    const indent = line.match(/^\s*/)![0];
    // Split off a trailing // comment (outside quotes).
    let code = line; let note = '';
    let q = false;
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i] === "'") { q = !q; }
      if (!q && line[i] === '/' && line[i + 1] === '/') { code = line.substring(0, i).trimEnd(); note = line.substring(i); break; }
    }
    if (note) { out.push(indent + note); }
    if (code.length <= width) { out.push(code); continue; }
    const words: string[] = [];
    let cur = ''; q = false;
    for (const ch of code.substring(indent.length)) {
      if (ch === "'") { q = !q; }
      if (ch === ' ' && !q) { if (cur) { words.push(cur); } cur = ''; continue; }
      cur += ch;
    }
    if (cur) { words.push(cur); }
    let row = indent;
    const contIndent = indent + '    ';
    for (const w of words) {
      const sep = row.trim() ? ' ' : '';
      if (row.trim() && (row + sep + w).length > width) { out.push(row); row = contIndent + w; }
      else { row += sep + w; }
    }
    if (row.trim()) { out.push(row); }
  }
  return out;
}
