// Pure helpers for table import / export: CSV parsing, SQL INSERT building, and a small
// dependency-free .xlsx writer / reader core. No vscode import, unit tested.

// ---------------------------------------------------------------- CSV

/** Guess the delimiter from the first line: ; , tab or |. */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t', '|'].map(d => ({ d, n: first.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

/** RFC 4180 CSV (quotes, doubled quotes, newlines in quotes). Returns rows of cells. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else { q = false; } } else { cell += c; }
    } else if (c === '"' && cell === '') { q = true; }
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') { i++; }
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else { cell += c; }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

export function toJson(columns: string[], rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows.map(r => Object.fromEntries(columns.map(c => [c, r[c] ?? null]))), null, 2);
}

// ---------------------------------------------------------------- import mapping & SQL

export interface Column { name: string; type: string; length: number; scale: number; nullable: boolean }

const norm = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Map file headers to table columns by name (ignoring case, blanks and punctuation). -1 = not imported. */
export function mapColumns(headers: string[], columns: Column[]): number[] {
  return columns.map(c => headers.findIndex(h => norm(h) === norm(c.name)));
}

const NUMERIC = /^(DECIMAL|NUMERIC|INTEGER|SMALLINT|BIGINT|REAL|DOUBLE|FLOAT|DECFLOAT)/i;

/** An SQL literal for one value of a column; throws with a readable message when it does not fit. */
export function sqlValue(raw: string | number | null | undefined, c: Column): string {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    if (c.nullable) { return 'NULL'; }
    return NUMERIC.test(c.type) ? '0' : /DATE|TIME/i.test(c.type) ? 'DEFAULT' : "''";
  }
  const v = String(raw);
  if (NUMERIC.test(c.type)) {
    const n = v.trim().replace(/\s/g, '').replace(/,(\d+)$/, '.$1');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(E[-+]?\d+)?$/i.test(n)) { throw new Error(`${c.name}: "${v}" is not a number`); }
    if (/DECIMAL|NUMERIC/i.test(c.type)) {
      const [i = '', d = ''] = n.replace(/^[-+]/, '').split('.');
      if (i.replace(/^0+/, '').length > c.length - c.scale) { throw new Error(`${c.name}: ${v} is too large for (${c.length},${c.scale})`); }
      if (d.length > c.scale) { throw new Error(`${c.name}: ${v} has more than ${c.scale} decimal(s)`); }
    }
    return n;
  }
  if (/^DATE$/i.test(c.type)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim()) ?? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
    if (!m) { throw new Error(`${c.name}: "${v}" is not a date (YYYY-MM-DD)`); }
    const iso = m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`;
    return `DATE('${iso}')`;
  }
  if (/^TIMESTAMP/i.test(c.type)) { return `TIMESTAMP('${v.trim().replace('T', ' ').replace(/'/g, '')}')`; }
  if (/^TIME$/i.test(c.type)) { return `TIME('${v.trim().replace(/'/g, '')}')`; }
  if (/CHAR|GRAPHIC|CLOB/i.test(c.type) && v.length > c.length) { throw new Error(`${c.name}: "${v.slice(0, 20)}…" is longer than ${c.length}`); }
  return `'${v.replace(/'/g, "''")}'`;
}

/** Multi-row INSERT statements (WITH NC, so files that are not journaled can be loaded). */
export function insertStatements(library: string, table: string, columns: Column[], mapping: number[], rows: (string | number | null)[][], batch = 100): { sql: string[]; errors: string[] } {
  const used = columns.map((c, i) => ({ c, i: mapping[i] })).filter(x => x.i >= 0);
  if (!used.length) { throw new Error('No column of the file matches a column of the table.'); }
  const sql: string[] = []; const errors: string[] = []; let values: string[] = [];
  const flush = () => {
    if (values.length) { sql.push(`INSERT INTO ${library}/${table} (${used.map(u => `"${u.c.name.replace(/"/g, '""')}"`).join(', ')}) VALUES ${values.join(', ')} WITH NC`); }
    values = [];
  };
  rows.forEach((r, n) => {
    try { values.push(`(${used.map(u => sqlValue(r[u.i], u.c)).join(', ')})`); } catch (e) { errors.push(`Row ${n + 2}: ${(e as Error).message}`); }
    if (values.length >= batch) { flush(); }
  });
  flush();
  return { sql, errors };
}

// ---------------------------------------------------------------- minimal ZIP (store) + XLSX

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } t[n] = c >>> 0; }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) { c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8); }
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP archive with uncompressed (stored) entries — enough for .xlsx files. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name); const crc = crc32(f.data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

export function columnLetter(i: number): string {
  let s = ''; let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** A one-sheet .xlsx workbook; numbers stay numbers, the header row is bold and frozen. */
export function buildXlsx(sheetName: string, columns: string[], rows: Record<string, unknown>[], numeric: boolean[] = []): Uint8Array {
  const enc = new TextEncoder();
  const cell = (r: number, c: number, v: unknown, header = false) => {
    const ref = `${columnLetter(c)}${r}`;
    if (v === null || v === undefined || v === '') { return ''; }
    if (!header && (typeof v === 'number' || (numeric[c] && /^-?\d+(\.\d+)?$/.test(String(v).trim())))) { return `<c r="${ref}"><v>${String(v).trim()}</v></c>`; }
    return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(String(v))}</t></is></c>`;
  };
  const sheetRows = [`<row r="1">${columns.map((c, i) => cell(1, i, c, true)).join('')}</row>`,
    ...rows.map((r, n) => `<row r="${n + 2}">${columns.map((c, i) => cell(n + 2, i, r[c])).join('')}</row>`)];
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetData>${sheetRows.join('')}</sheetData></worksheet>`;
  const name = xmlEsc(sheetName.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet1');
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ];
  return zipStore(files.map(f => ({ name: f.name, data: enc.encode(f.data) })));
}

/** Entries of a ZIP file (local headers), for reading .xlsx. `inflate` decompresses method-8 entries. */
export function unzip(buf: Uint8Array, inflate: (d: Uint8Array) => Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Use the central directory: local headers may defer sizes to a data descriptor.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) { if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) { throw new Error('Not a valid .xlsx (zip) file.'); }
  const count = v.getUint16(eocd + 10, true); let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) { break; }
    const method = v.getUint16(p + 10, true); const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true); const xlen = v.getUint16(p + 30, true); const clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    const lnlen = v.getUint16(local + 26, true); const lxlen = v.getUint16(local + 28, true);
    const start = local + 30 + lnlen + lxlen;
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 0 ? data : inflate(data));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const xmlUnesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  return [...letters].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

/** Rows of the first worksheet, given the XML of the sheet and of sharedStrings (may be empty). */
export function readSheet(sheetXml: string, sharedXml = ''): string[][] {
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => xmlUnesc(t[1])).join(''));
  const rows: string[][] = [];
  for (const r of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1].matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]; const body = c[2] ?? '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? columnLetter(row.length);
      const t = /t="(\w+)"/.exec(attrs)?.[1];
      let val = '';
      if (t === 's') { val = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? -1)] ?? ''; }
      else if (t === 'inlineStr') { val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => xmlUnesc(x[1])).join(''); }
      else { val = xmlUnesc(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''); }
      row[colIndex(ref)] = val;
    }
    rows.push(Array.from(row, x => x ?? ''));
  }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
