// Program parameters read from the source (RPG free/fixed, *ENTRY PLIST, CL) and CALL literals that match them. Pure
// functions (no vscode import), unit tested.


export type ParmKind = 'char' | 'packed' | 'zoned' | 'int' | 'uns' | 'ind' | 'other';

export interface Parm { name: string; kind: ParmKind; length: number; decimals: number; raw: string; constant?: boolean }

const num = (s: string | undefined) => Number((s ?? '').trim() || 0);

function freeType(spec: string): Pick<Parm, 'kind' | 'length' | 'decimals'> {
  const t = spec.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^(?:char|varchar)\(\s*(\d+)\s*\)/.exec(t))) { return { kind: t.startsWith('var') ? 'other' : 'char', length: num(m[1]), decimals: 0 }; }
  if ((m = /^packed\(\s*(\d+)\s*(?::\s*(\d+))?\s*\)/.exec(t))) { return { kind: 'packed', length: num(m[1]), decimals: num(m[2]) }; }
  if ((m = /^zoned\(\s*(\d+)\s*(?::\s*(\d+))?\s*\)/.exec(t))) { return { kind: 'zoned', length: num(m[1]), decimals: num(m[2]) }; }
  if ((m = /^(int|uns)\(\s*(3|5|10|20)\s*\)/.exec(t))) { return { kind: m[1] as 'int' | 'uns', length: num(m[2]), decimals: 0 }; }
  if (/^ind\b/.test(t)) { return { kind: 'ind', length: 1, decimals: 0 }; }
  return { kind: 'other', length: 0, decimals: 0 };
}

/** The parameters of the program's main entry (free dcl-pi, fixed D … PI, *ENTRY PLIST, or CL PGM PARM). */
export function programParameters(source: string, sourceType: string): Parm[] {
  const lines = source.split(/\r?\n/);
  if (/^CL/i.test(sourceType)) { return clParameters(lines); }
  // Free-form: the dcl-pi that is not inside a dcl-proc.
  let inProc = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\/\/.*$/, '');
    if (/\bdcl-proc\b/i.test(l)) { inProc++; }
    if (/\bend-proc\b/i.test(l)) { inProc = Math.max(0, inProc - 1); }
    if (!inProc && /\bdcl-pi\s+(\*n|[\w$#@]+)/i.test(l)) {
      const out: Parm[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const p = lines[j].replace(/\/\/.*$/, '').trim();
        if (!p) { continue; }
        if (/^end-pi\b/i.test(p)) { return out; }
        const m = /^(?:dcl-parm\s+)?([\w$#@]+)\s+(.+?);?\s*$/i.exec(p);
        if (m) { out.push({ name: m[1].toUpperCase(), ...freeType(m[2]), raw: p, constant: /\bconst\b/i.test(m[2]) }); }
      }
      return out;
    }
  }
  // Fixed-form D … PI (not inside P specs).
  let inP = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.length > 6 && /p/i.test(l[5]) && l[6] !== '*') { inP = /\bB\b/i.test(l.substring(23, 25)) ? true : /\bE\b/i.test(l.substring(23, 25)) ? false : inP; }
    if (!inP && l.length > 25 && /d/i.test(l[5]) && l[6] !== '*' && /^PI$/i.test(l.substring(23, 25).trim())) {
      const out: Parm[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const d = lines[j];
        if (d.length <= 6 || d[6] === '*') { continue; }
        if (!/d/i.test(d[5]) || d.substring(23, 25).trim()) { break; }
        const name = d.substring(6, 21).trim();
        if (!name) { continue; }
        out.push({ name: name.toUpperCase(), ...fixedType(d), raw: d.trim(), constant: /\bCONST\b/i.test(d.substring(43)) });
      }
      return out;
    }
  }
  return entryPlist(lines);
}

function fixedType(d: string): Pick<Parm, 'kind' | 'length' | 'decimals'> {
  const len = num(d.substring(32, 39)); const type = d.substring(39, 40).toUpperCase(); const decTxt = d.substring(40, 42).trim(); const dec = num(decTxt);
  if (type === 'P' || (type === ' ' && decTxt !== '')) { return { kind: 'packed', length: len, decimals: dec }; }
  if (type === 'S') { return { kind: 'zoned', length: len, decimals: dec }; }
  if (type === 'I' || type === 'U') { return { kind: type === 'I' ? 'int' : 'uns', length: len, decimals: 0 }; }
  if (type === 'N') { return { kind: 'ind', length: 1, decimals: 0 }; }
  if ((type === 'A' || type === ' ') && len) { return { kind: 'char', length: len, decimals: 0 }; }
  return { kind: 'other', length: len, decimals: dec };
}

function entryPlist(lines: string[]): Parm[] {
  const i = lines.findIndex(l => /^.{5}C.{5}\*ENTRY\s+PLIST/i.test(l));
  if (i < 0) { return []; }
  const defs = new Map<string, Pick<Parm, 'kind' | 'length' | 'decimals'>>();
  for (const d of lines) {
    if (d.length > 25 && /d/i.test(d[5]) && d[6] !== '*' && /^S$/i.test(d.substring(23, 25).trim())) { defs.set(d.substring(6, 21).trim().toUpperCase(), fixedType(d)); }
  }
  const out: Parm[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const c = lines[j];
    if (!/^.{5}C/i.test(c) || c[6] === '*') { if (c.trim()) { break; } continue; }
    if (!/^PARM$/i.test(c.substring(25, 35).trim())) { break; }
    const name = c.substring(49, 63).trim().toUpperCase();
    const len = num(c.substring(63, 68)); const dec = c.substring(68, 70).trim();
    const t = defs.get(name) ?? (len ? { kind: (dec !== '' ? 'zoned' : 'char') as ParmKind, length: len, decimals: num(dec) } : { kind: 'other' as ParmKind, length: 0, decimals: 0 });
    out.push({ name, ...t, raw: c.trim() });
  }
  return out;
}

function clParameters(lines: string[]): Parm[] {
  const text = lines.join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\+\s*\n\s*/g, ' ');
  const pgm = /^\s*(?:\w+:\s*)?PGM\s+(?:PARM\()?\s*\(?([^)\n]*)\)?/im.exec(text);
  if (!pgm) { return []; }
  const names = (pgm[1].match(/&[\w$#@]+/g) ?? []).map(n => n.toUpperCase());
  return names.map(n => {
    const dcl = new RegExp(`DCL\\s+(?:VAR\\()?\\s*${n.replace('&', '&')}\\s*\\)?\\s+(?:TYPE\\()?\\s*(\\*\\w+)\\s*\\)?(?:\\s+(?:LEN\\()?\\s*(\\d+)(?:\\s+(\\d+))?\\s*\\)?)?`, 'i').exec(text);
    const t = (dcl?.[1] ?? '').toUpperCase(); const len = num(dcl?.[2]); const dec = num(dcl?.[3]);
    const kind: ParmKind = t === '*CHAR' ? 'char' : t === '*DEC' ? 'packed' : t === '*INT' ? 'int' : t === '*UINT' ? 'uns' : t === '*LGL' ? 'ind' : 'other';
    const length = kind === 'char' ? (len || 32) : kind === 'packed' ? (len || 15) : kind === 'int' || kind === 'uns' ? ((len || 4) === 2 ? 5 : (len || 4) === 8 ? 20 : 10) : 1;
    return { name: n, kind, length, decimals: kind === 'packed' ? (dcl?.[2] ? dec : 5) : 0, raw: dcl?.[0] ?? n };
  });
}

export function describeParm(p: Parm): string {
  switch (p.kind) {
    case 'char': return `char(${p.length})`;
    case 'packed': return `packed(${p.length}:${p.decimals})`;
    case 'zoned': return `zoned(${p.length}:${p.decimals})`;
    case 'int': case 'uns': return `${p.kind}(${p.length})`;
    case 'ind': return 'ind';
    default: return 'other';
  }
}

function digitsFor(value: string, length: number, decimals: number): { digits: string; negative: boolean } {
  const v = value.trim().replace(',', '.');
  if (!/^[+-]?\d*(\.\d*)?$/.test(v) || !/\d/.test(v)) { throw new Error(`"${value}" is not a number.`); }
  const negative = v.startsWith('-');
  const [ip, fp = ''] = v.replace(/^[+-]/, '').split('.');
  if (fp.replace(/0+$/, '').length > decimals) { throw new Error(`At most ${decimals} decimal(s).`); }
  const digits = ((ip.replace(/^0+/, '') || '') + fp.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '') || '0';
  if (digits.length > length) { throw new Error(`Too many digits for ${length},${decimals}.`); }
  return { digits: digits.padStart(length, '0'), negative: negative && /[1-9]/.test(digits) };
}

/** A CALL parameter literal the program receives exactly as declared. */
export function callLiteral(p: Parm, value: string): string {
  switch (p.kind) {
    case 'char': {
      if (value.length > p.length) { throw new Error(`At most ${p.length} characters.`); }
      // CALL passes at least 32 bytes; longer parameters must be padded or the program reads past the value.
      const v = p.length > 32 ? value.padEnd(p.length, ' ') : value;
      return `'${v.replace(/'/g, "''")}'`;
    }
    case 'packed': {
      const { digits, negative } = digitsFor(value, p.length, p.decimals);
      if (p.length === 15 && p.decimals === 5) { return `${negative ? '-' : ''}${Number(`${digits.slice(0, 10)}.${digits.slice(10)}`)}`; }
      const nib = (p.length % 2 === 0 ? '0' : '') + digits + (negative ? 'D' : 'F');
      return `X'${nib}'`;
    }
    case 'zoned': {
      const { digits, negative } = digitsFor(value, p.length, p.decimals);
      if (!negative) { return `'${digits}'`; }
      const last = '}JKLMNOPQR'[Number(digits.slice(-1))];
      return `'${digits.slice(0, -1)}${last}'`;
    }
    case 'int': case 'uns': {
      if (!/^[+-]?\d+$/.test(value.trim())) { throw new Error(`"${value}" is not a whole number.`); }
      const bytes = p.length === 3 ? 1 : p.length === 5 ? 2 : p.length === 20 ? 8 : 4;
      let n = BigInt(value.trim());
      const bits = BigInt(bytes * 8);
      const min = p.kind === 'uns' ? 0n : -(1n << (bits - 1n)); const max = p.kind === 'uns' ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
      if (n < min || n > max) { throw new Error(`Out of range for ${p.kind}(${p.length}).`); }
      if (n < 0n) { n += 1n << bits; }
      return `X'${n.toString(16).toUpperCase().padStart(bytes * 2, '0')}'`;
    }
    case 'ind': {
      const v = value.trim().toUpperCase();
      if (!/^(0|1|\*ON|\*OFF|Y|N)$/.test(v)) { throw new Error('Use 1 or 0.'); }
      return `'${/^(1|\*ON|Y)$/.test(v) ? '1' : '0'}'`;
    }
    default: return value.trim();     // typed as a raw CL literal by the user
  }
}

export function callCommand(lib: string, pgm: string, literals: string[]): string {
  const ok = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;
  const l = lib.trim().toUpperCase(); const p = pgm.trim().toUpperCase();
  if (!ok.test(p) || (l !== '*LIBL' && !ok.test(l))) { throw new Error('Invalid program name.'); }
  return `CALL PGM(${l}/${p})${literals.length ? ` PARM(${literals.join(' ')})` : ''}`;
}
