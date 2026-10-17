// Data structure layout: positions and lengths of RPG data structure subfields. Pure functions (no vscode import), unit
// tested.


export interface DsField {
  name: string; type: string; line: number;
  /** 1-based positions; undefined when an earlier length is unknown. */
  from?: number; to?: number;
  /** Bytes (for an array: all elements). Undefined when unknown. */
  length?: number;
  dim?: number; overlay?: string; note?: string;
}

export interface DsLayout { name: string; line: number; endLine: number; qualified: boolean; length?: number; fields: DsField[]; problems: string[]; external?: string; dim?: number }

/** A column of an externally described file (from QSYS2.SYSCOLUMNS). */
export interface ExtColumn { name: string; dataType: string; length: number; scale?: number }

interface Stmt { text: string; line: number; fixed?: FixedD }

interface FixedD { name: string; ext: string; decl: string; from: string; to: string; type: string; dec: string; kw: string }

const isFullyFree = (lines: string[]) => /^\s*\*\*FREE/i.test(lines[0] ?? '');

function stripComment(s: string): string {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "'") { q = !q; }
    if (!q && s[i] === '/' && s[i + 1] === '/') { return s.slice(0, i); }
  }
  return s;
}

/** Statements of the source: free-form text up to ';', and one statement per fixed-form D spec (keyword continuation lines joined). */
function statements(text: string): Stmt[] {
  const lines = text.split(/\r?\n/); const free = isFullyFree(lines);
  const out: Stmt[] = []; let buf = ''; let start = -1;
  for (let i = free ? 1 : 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!free) {
      const spec = (raw[5] ?? ' ').toUpperCase();
      if (raw[6] === '*' || /^\s*\/(COPY|INCLUDE|IF|ELSE|ENDIF|DEFINE|UNDEFINE|EOF|FREE|END-FREE|SPACE|EJECT|TITLE)\b/i.test(raw.slice(6))) { continue; }
      if (spec !== ' ') {
        if (spec === 'D') {
          const d: FixedD = { name: raw.substring(6, 21).trim(), ext: (raw[21] ?? ' ').toUpperCase(), decl: raw.substring(23, 25).trim().toUpperCase(), from: raw.substring(25, 32).trim(), to: raw.substring(32, 39).trim(), type: (raw[39] ?? ' ').toUpperCase().trim(), dec: raw.substring(40, 42).trim(), kw: raw.substring(43, 80).trim() };
          const prev = out[out.length - 1];
          if (!d.name && !d.decl && !d.from && !d.to && !d.type && d.kw && prev?.fixed) { prev.fixed.kw += ' ' + d.kw; continue; }
          // A long name ends with '...' and the rest of the definition is on the next line.
          if (/\.\.\.$/.test(d.name)) { const nx = lines[i + 1] ?? ''; d.name = d.name.replace(/\.\.\.$/, ''); i++; Object.assign(d, { decl: nx.substring(23, 25).trim().toUpperCase(), from: nx.substring(25, 32).trim(), to: nx.substring(32, 39).trim(), type: (nx[39] ?? ' ').toUpperCase().trim(), dec: nx.substring(40, 42).trim(), kw: nx.substring(43, 80).trim(), ext: (nx[21] ?? ' ').toUpperCase() }); }
          out.push({ text: '', line: i, fixed: d });
        } else { out.push({ text: `*SPEC ${spec}`, line: i }); }
        continue;
      }
    }
    const code = stripComment(free ? raw : raw.slice(7, 80));
    let rest = code;
    while (rest.length) {
      const k = indexOutsideQuotes(rest, ';');
      if (start < 0 && rest.trim()) { start = i; }
      if (k < 0) { buf += ' ' + rest; break; }
      buf += ' ' + rest.slice(0, k);
      if (buf.trim()) { out.push({ text: buf.trim().replace(/\s+/g, ' '), line: start < 0 ? i : start }); }
      buf = ''; start = -1; rest = rest.slice(k + 1);
    }
  }
  if (buf.trim()) { out.push({ text: buf.trim(), line: start }); }
  return out;
}

function indexOutsideQuotes(s: string, ch: string): number {
  let q = false;
  for (let i = 0; i < s.length; i++) { if (s[i] === "'") { q = !q; } else if (!q && s[i] === ch) { return i; } }
  return -1;
}

/** Keyword arguments: kw('DIM', 'x dim(5) inz') → '5'. */
function kw(text: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*\\(`, 'i').exec(text);
  if (!m) { return undefined; }
  let depth = 1; let i = m.index + m[0].length; const s = i;
  for (; i < text.length && depth; i++) { if (text[i] === '(') { depth++; } else if (text[i] === ')') { depth--; } }
  return text.slice(s, i - 1).trim();
}

const hasKw = (text: string, name: string) => new RegExp(`(^|\\s)${name}(\\s|$|\\()`, 'i').test(text);

const num = (s: string | undefined) => { const n = Number((s ?? '').trim()); return Number.isFinite(n) && (s ?? '').trim() !== '' ? n : undefined; };

const DATE_LEN: Record<string, number> = { '*MDY': 8, '*DMY': 8, '*YMD': 8, '*JUL': 6, '*ISO': 10, '*USA': 10, '*EUR': 10, '*JIS': 10, '*LONGJUL': 8 };

export function bindecBytes(p: number): number { return p <= 4 ? 2 : p <= 9 ? 4 : 8; }

export function intBytes(digits: number): number { return digits <= 3 ? 1 : digits <= 5 ? 2 : digits <= 10 ? 4 : 8; }

/** Bytes of a free-form type like packed(9:2), varchar(50), int(10), timestamp(3). Undefined for LIKE / LIKEDS. */
export function freeTypeBytes(type: string, args: string): number | undefined {
  const a = args.split(':').map(x => x.trim()); const n = num(a[0]);
  switch (type.toUpperCase()) {
    case 'CHAR': return n;
    case 'VARCHAR': return n === undefined ? undefined : n + (num(a[1]) === 4 || n > 65535 ? 4 : 2);
    case 'GRAPH': case 'UCS2': return n === undefined ? undefined : 2 * n;
    case 'VARGRAPH': case 'VARUCS2': return n === undefined ? undefined : 2 * n + (num(a[1]) === 4 ? 4 : 2);
    case 'PACKED': return n === undefined ? undefined : Math.floor(n / 2) + 1;
    case 'ZONED': return n;
    case 'BINDEC': return n === undefined ? undefined : bindecBytes(n);
    case 'INT': case 'UNS': return n === undefined ? undefined : intBytes(n);
    case 'FLOAT': return n;
    case 'IND': return 1;
    case 'DATE': return DATE_LEN[(a[0] || '*ISO').toUpperCase()] ?? 10;
    case 'TIME': return 8;
    case 'TIMESTAMP': return n === undefined ? 26 : n === 0 ? 19 : 20 + n;
    case 'POINTER': case 'OBJECT': return 16;
  }
  return undefined;
}

const FREE_TYPES = /^(CHAR|VARCHAR|GRAPH|VARGRAPH|UCS2|VARUCS2|PACKED|ZONED|BINDEC|INT|UNS|FLOAT|IND|DATE|TIME|TIMESTAMP|POINTER|OBJECT|LIKE|LIKEDS|LIKEREC)\b\s*(\(([^)]*)\))?/i;

/** Bytes of a fixed-form subfield or standalone without from-position. */
export function fixedBytes(type: string, len: number | undefined, dec: number | undefined, inDs: boolean): { bytes?: number; desc: string } {
  const t = type || (dec !== undefined ? (inDs ? 'S' : 'P') : 'A');
  switch (t) {
    case 'A': return { bytes: len, desc: `char(${len ?? '?'})` };
    case 'P': return { bytes: len === undefined ? undefined : Math.floor(len / 2) + 1, desc: `packed(${len}:${dec ?? 0})` };
    case 'S': return { bytes: len, desc: `zoned(${len}:${dec ?? 0})` };
    case 'B': return { bytes: len === undefined ? undefined : bindecBytes(len), desc: `bindec(${len}:${dec ?? 0})` };
    case 'I': return { bytes: len === undefined ? undefined : intBytes(len), desc: `int(${len})` };
    case 'U': return { bytes: len === undefined ? undefined : intBytes(len), desc: `uns(${len})` };
    case 'F': return { bytes: len, desc: `float(${len})` };
    case 'N': return { bytes: 1, desc: 'ind' };
    case 'D': return { bytes: len ?? 10, desc: 'date' };
    case 'T': return { bytes: len ?? 8, desc: 'time' };
    case 'Z': return { bytes: len ?? 26, desc: 'timestamp' };
    case '*': return { bytes: 16, desc: 'pointer' };
    case 'G': return { bytes: len === undefined ? undefined : 2 * len, desc: `graph(${len})` };
    case 'C': return { bytes: len === undefined ? undefined : 2 * len, desc: `ucs2(${len})` };
    case 'O': return { bytes: 16, desc: 'object' };
  }
  return { bytes: len, desc: t };
}

/** RPG view of a database column (what EXTNAME brings into a data structure). */
export function columnField(c: ExtColumn): { bytes?: number; desc: string } {
  const t = c.dataType.toUpperCase().trim(); const l = c.length; const s = c.scale ?? 0;
  if (t === 'CHAR' || t === 'CHARACTER') { return { bytes: l, desc: `char(${l})` }; }
  if (t === 'VARCHAR' || t === 'CHARACTER VARYING') { return { bytes: l + 2, desc: `varchar(${l})` }; }
  if (t === 'GRAPHIC') { return { bytes: 2 * l, desc: `graph(${l})` }; }
  if (t === 'VARGRAPHIC' || t === 'VARG') { return { bytes: 2 * l + 2, desc: `vargraph(${l})` }; }
  if (t === 'DECIMAL') { return { bytes: Math.floor(l / 2) + 1, desc: `packed(${l}:${s})` }; }
  if (t === 'NUMERIC') { return { bytes: l, desc: `zoned(${l}:${s})` }; }
  if (t === 'SMALLINT') { return { bytes: 2, desc: 'int(5)' }; }
  if (t === 'INTEGER') { return { bytes: 4, desc: 'int(10)' }; }
  if (t === 'BIGINT') { return { bytes: 8, desc: 'int(20)' }; }
  if (t === 'REAL') { return { bytes: 4, desc: 'float(4)' }; }
  if (t === 'FLOAT' || t === 'DOUBLE') { return { bytes: 8, desc: 'float(8)' }; }
  if (t === 'DATE') { return { bytes: 10, desc: 'date' }; }
  if (t === 'TIME') { return { bytes: 8, desc: 'time' }; }
  if (t === 'TIMESTMP' || t === 'TIMESTAMP') { return { bytes: 26, desc: 'timestamp' }; }
  if (t === 'BINARY') { return { bytes: l, desc: `char(${l}) ccsid(*hex)` }; }
  if (t === 'VARBINARY' || t === 'VARBIN') { return { bytes: l + 2, desc: `varchar(${l}) ccsid(*hex)` }; }
  return { bytes: undefined, desc: t.toLowerCase() };
}

/** Type text for a fixed-form subfield given with from and to positions (the length is in bytes). */
export function fromToType(type: string, bytes: number | undefined, dec: string): string {
  const d = dec ? `:${dec}` : '';
  if (bytes === undefined) { return type || 'char'; }
  switch (type) {
    case 'P': return `packed(${2 * bytes - 1}${d || ':0'})`;
    case 'B': return `bindec(${bytes <= 2 ? 4 : 9}${d || ':0'})`;
    case 'I': return `int(${bytes === 1 ? 3 : bytes === 2 ? 5 : bytes === 4 ? 10 : 20})`;
    case 'U': return `uns(${bytes === 1 ? 3 : bytes === 2 ? 5 : bytes === 4 ? 10 : 20})`;
    case 'S': return `zoned(${bytes}${d || ':0'})`;
    case '': case 'A': return dec ? `zoned(${bytes}${d})` : `char(${bytes})`;
  }
  return fixedBytes(type, bytes, num(dec), true).desc;
}

interface RawDs { name: string; line: number; endLine: number; head: string; fixed?: FixedD; subs: Stmt[] }

function rawStructures(text: string): { ds: RawDs[]; standalone: Map<string, { bytes?: number; desc: string }> } {
  const st = statements(text); const ds: RawDs[] = []; const standalone = new Map<string, { bytes?: number; desc: string }>();
  for (let i = 0; i < st.length; i++) {
    const s = st[i];
    if (s.fixed) {
      const d = s.fixed;
      if (d.decl === 'S' && d.name) {
        standalone.set(d.name.toUpperCase(), d.from ? { bytes: (num(d.to) ?? 0) - (num(d.from) ?? 0) + 1, desc: d.type || 'A' } : fixedBytes(d.type, num(d.to), num(d.dec), false));
      }
      if (d.decl === 'DS') {
        const subs: Stmt[] = []; let j = i + 1;
        for (; j < st.length && st[j].fixed && !st[j].fixed!.decl; j++) { subs.push(st[j]); }
        ds.push({ name: d.name || '*N', line: s.line, endLine: (st[j - 1] ?? s).line, head: d.kw, fixed: d, subs });
        i = j - 1;
      }
      continue;
    }
    const m = /^DCL-DS\s+(\S+)\s*(.*)$/i.exec(s.text);
    if (m) {
      const head = m[2]; const subs: Stmt[] = [];
      // One-statement forms: LIKEDS / LIKEREC, or "dcl-ds x ... end-ds" on one line.
      if (/\bLIKEDS\s*\(|\bLIKEREC\s*\(/i.test(head) || /\bEND-DS\b/i.test(head)) {
        ds.push({ name: m[1], line: s.line, endLine: s.line, head: head.replace(/\bEND-DS\b.*$/i, ''), subs }); continue;
      }
      let j = i + 1;
      for (; j < st.length && !/^END-DS\b/i.test(st[j].text) && !st[j].fixed && !/^DCL-(DS|S|C|PR|PI|PROC|F)\b/i.test(st[j].text); j++) { subs.push(st[j]); }
      ds.push({ name: m[1], line: s.line, endLine: (st[j] ?? st[j - 1] ?? s).line, head, subs });
      i = j; continue;
    }
    const sa = /^DCL-S\s+(\S+)\s+(.*)$/i.exec(s.text);
    if (sa) { const t = FREE_TYPES.exec(sa[2]); if (t && !/^LIKE/i.test(t[1])) { standalone.set(sa[1].toUpperCase(), { bytes: freeTypeBytes(t[1], t[3] ?? ''), desc: t[0].toLowerCase().replace(/\s+/g, '') }); } }
  }
  return { ds, standalone };
}

/** Layout of every data structure in the source. External column lists (EXTNAME / E in column 22) are looked up in ext by file name. */
export function dataStructures(text: string, ext: Record<string, ExtColumn[]> = {}): DsLayout[] {
  const { ds, standalone } = rawStructures(text);
  const byName = new Map(ds.map(d => [d.name.toUpperCase(), d]));
  const done = new Map<string, DsLayout>();
  const build = (d: RawDs, depth: number): DsLayout => {
    const key = `${d.name.toUpperCase()}@${d.line}`;
    if (done.has(key)) { return done.get(key)!; }
    const lay: DsLayout = { name: d.name, line: d.line, endLine: d.endLine, qualified: hasKw(d.head, 'QUALIFIED') || !!kw(d.head, 'LIKEDS'), fields: [], problems: [] };
    const dsDim = num(kw(d.head, 'DIM')); if (dsDim) { lay.dim = dsDim; }
    const likeds = kw(d.head, 'LIKEDS');
    if (likeds) {
      const base = byName.get(likeds.toUpperCase());
      if (base && depth < 8) { const b = build(base, depth + 1); lay.fields = b.fields.map(f => ({ ...f })); lay.length = b.length; lay.problems = [...b.problems]; }
      else { lay.problems.push(`LIKEDS(${likeds}): that data structure is not in this source.`); }
      done.set(key, lay); return lay;
    }
    let next = 1; let unknown = false; let maxEnd = 0;
    const place = (f: DsField, bytes: number | undefined, explicit?: number) => {
      if (explicit !== undefined) { f.from = explicit; }
      else if (!unknown) { f.from = next; }
      if (f.from !== undefined && bytes !== undefined) { f.to = f.from + bytes - 1; maxEnd = Math.max(maxEnd, f.to); }
      f.length = bytes;
      if (explicit === undefined && !f.overlay) { if (bytes === undefined || f.from === undefined) { unknown = true; } else { next = f.to! + 1; } }
      else if (f.to !== undefined && !f.overlay) { next = Math.max(next, f.to + 1); }
      lay.fields.push(f);
    };
    let extMissing = false;
    const extFile = d.fixed ? (d.fixed.ext === 'E' ? (kw(d.head, 'EXTNAME') ?? d.name) : kw(d.head, 'EXTNAME')) : kw(d.head, 'EXTNAME');
    if (extFile) {
      const file = extFile.replace(/^['"]|['"]$/g, '').split(':')[0].split('/').pop()!.toUpperCase();
      lay.external = file;
      const cols = ext[file];
      if (cols) { for (const c of cols) { const r = columnField(c); place({ name: c.name, type: r.desc, line: d.line, note: 'external' }, r.bytes); } }
      else { lay.problems.push(`The fields of ${file} come from the database: connect to see them.`); unknown = true; extMissing = true; }
    }
    const nextOverlay = new Map<string, number>();
    for (const s of d.subs) {
      let name: string; let type: string; let bytes: number | undefined; let keywords: string; let explicit: number | undefined;
      if (s.fixed) {
        const f = s.fixed; name = f.name || '*N'; keywords = f.kw;
        if (f.from && num(f.from) !== undefined) {
          explicit = num(f.from); const to = num(f.to); bytes = to !== undefined && explicit !== undefined ? to - explicit + 1 : undefined;
          type = fromToType(f.type, bytes, f.dec);
        } else if (kw(keywords, 'LIKEDS') || kw(keywords, 'LIKE')) {
          ({ bytes, type } = likeBytes(keywords));
        } else {
          const r = fixedBytes(f.type, num(f.to), num(f.dec), true); bytes = r.bytes; type = r.desc;
        }
      } else {
        const t = s.text.replace(/^DCL-SUBF\s+/i, '');
        const m = /^(\S+)\s*(.*)$/.exec(t)!; name = m[1]; keywords = m[2];
        const tm = FREE_TYPES.exec(keywords);
        if (!tm) { lay.problems.push(`${name}: type not recognised.`); bytes = undefined; type = '?'; }
        else if (/^LIKE/i.test(tm[1])) { ({ bytes, type } = likeBytes(keywords)); }
        else { bytes = freeTypeBytes(tm[1], tm[3] ?? ''); type = tm[0].toLowerCase().replace(/\s+/g, ''); }
        const pos = num(kw(keywords, 'POS')); if (pos !== undefined) { explicit = pos; }
      }
      const dim = num(kw(keywords, 'DIM'));
      const field: DsField = { name, type, line: s.line };
      if (dim) { field.dim = dim; if (bytes !== undefined) { bytes *= dim; } }
      const ov = kw(keywords, 'OVERLAY');
      if (ov) {
        const [base, p] = ov.split(':').map(x => x.trim());
        const target = lay.fields.find(x => x.name.toUpperCase() === base.toUpperCase());
        if (base.toUpperCase() === d.name.toUpperCase()) { explicit = !p ? 1 : /\*NEXT/i.test(p) ? next : num(p); }
        else if (target) {
          field.overlay = target.name;
          const off = !p ? 1 : /\*NEXT/i.test(p) ? (nextOverlay.get(target.name) ?? 1) : (num(p) ?? 1);
          explicit = target.from === undefined ? undefined : target.from + off - 1;
          if (explicit === undefined) { unknown = true; }
          if (bytes !== undefined) { nextOverlay.set(target.name, off + (dim ? bytes / dim : bytes)); }
          if (target.dim) { field.note = 'overlays an array'; }
        } else { lay.problems.push(`${name}: OVERLAY(${base}) — ${base} is not an earlier subfield.`); }
      }
      if (bytes === undefined) { field.note = field.note ?? 'length unknown'; }
      place(field, bytes, explicit);
    }
    const len = num(kw(d.head, 'LEN')) ?? (d.fixed && !d.fixed.from && d.fixed.to ? num(d.fixed.to) : undefined);
    lay.length = len ?? (unknown ? undefined : maxEnd);
    if (len !== undefined && maxEnd > len) { lay.problems.push(`The subfields end at ${maxEnd} but the data structure is ${len} long.`); }
    if (unknown && !extMissing) { lay.problems.push('Some lengths are not known (LIKE / LIKEDS of something outside this source), so later positions are not shown.'); }
    done.set(key, lay); return lay;

    function likeBytes(k: string): { bytes?: number; type: string } {
      const lds = kw(k, 'LIKEDS');
      if (lds) {
        const b = byName.get(lds.toUpperCase());
        if (b && depth < 8) { const l = build(b, depth + 1); return { bytes: l.length, type: `likeds(${lds})` }; }
        return { bytes: undefined, type: `likeds(${lds})` };
      }
      const lk = kw(k, 'LIKE') ?? '';
      const [ref, adj] = lk.split(':').map(x => x.trim());
      const sa = standalone.get(ref.toUpperCase());
      if (sa?.bytes !== undefined && !adj) { return { bytes: sa.bytes, type: `like(${ref}) ${sa.desc}` }; }
      const other = [...done.values(), lay].flatMap(l => l.fields).find(f => f.name.toUpperCase() === ref.toUpperCase().split('.').pop());
      if (other?.length !== undefined && !adj) { return { bytes: other.length / (other.dim ?? 1), type: `like(${ref}) ${other.type}` }; }
      return { bytes: undefined, type: `like(${lk})` };
    }
  };
  return ds.map(d => build(d, 0));
}

/** The data structure that contains the line (or starts on it). */
export function dataStructureAt(text: string, line: number, ext: Record<string, ExtColumn[]> = {}): DsLayout | undefined {
  return dataStructures(text, ext).find(d => line >= d.line && line <= d.endLine);
}

/** Files named by EXTNAME / externally described DS, so their columns can be fetched first. */
export function externalFiles(text: string): string[] {
  const { ds } = rawStructures(text);
  return [...new Set(ds.map(d => (d.fixed?.ext === 'E' ? (kw(d.head, 'EXTNAME') ?? d.name) : kw(d.head, 'EXTNAME')))
    .filter((x): x is string => !!x).map(x => x.replace(/^['"]|['"]$/g, '').split(':')[0].split('/').pop()!.toUpperCase()))];
}

/** Library of an EXTNAME('LIB/FILE'), when given. */
export function externalLibrary(text: string, file: string): string | undefined {
  const m = new RegExp(`EXTNAME\\s*\\(\\s*'?([A-Z0-9$#@_]+)/${file}`, 'i').exec(text);
  return m?.[1].toUpperCase();
}
