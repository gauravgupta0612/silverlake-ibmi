// Pure DDS display file (DSPF) parser and 5250 screen layout for the preview. No vscode import.

export interface DspfField {
  kind: 'field' | 'constant';
  name: string;
  line: number; col: number; length: number;
  usage: string;            // I, O, B, H, P, M (fields) or '' (constants)
  type: string;             // A, S, Y, … (fields)
  decimals?: number;
  text?: string;            // constant text, or edit-word sample for numeric output
  color?: string;           // WHT, RED, BLU, GRN, YLW, PNK, TRQ
  attrs: string[];          // HI, RI, UL, BL, ND, PC, CS
  indicators?: string;      // conditioning, e.g. "N03 40"
  keywords: string;
  srcLine: number;
}

export interface DspfRecord {
  name: string; srcLine: number; keywords: string;
  sfl?: boolean; sflctl?: string; sflpag?: number; window?: { line: number; col: number; lines: number; cols: number };
  overlay: boolean; fields: DspfField[];
}

export interface Dspf { rows: number; cols: number; records: DspfRecord[]; fileKeywords: string; errors: string[] }

const col = (l: string, from: number, to: number) => l.substring(from - 1, to);

/** Join the keyword area of a line with its continuation lines ('-' or '+' at the end). */
function joinKeywords(parts: string[]): string {
  let out = '';
  for (const p of parts) {
    const t = p.replace(/\s+$/, '');
    if (/[-+]$/.test(t)) {
      const plus = t.endsWith('+');
      out += plus ? t.slice(0, -1) : t.slice(0, -1).replace(/\s+$/, '') + ' ';
    } else { out += t + ' '; }
  }
  return out.trim();
}

export function parseDspf(text: string): Dspf {
  const lines = text.split(/\r?\n/);
  const d: Dspf = { rows: 24, cols: 80, records: [], fileKeywords: '', errors: [] };
  let rec: DspfRecord | undefined;
  let cur: { field?: DspfField; parts: string[]; isRecord?: boolean; isFile?: boolean } | undefined;
  let lastLine = 0; let lastCol = 0; let lastLen = 0;
  const fileKw: string[] = [];

  const finish = () => {
    if (!cur) { return; }
    const kw = joinKeywords(cur.parts);
    if (cur.isFile) { fileKw.push(kw); }
    else if (cur.isRecord && rec) { rec.keywords = `${rec.keywords} ${kw}`.trim(); applyRecordKeywords(rec, rec.keywords); }
    else if (cur.field) { applyFieldKeywords(cur.field, kw); if (rec) { rec.fields.push(cur.field); } }
    cur = undefined;
  };

  lines.forEach((raw, i) => {
    const l = raw.padEnd(80);
    if (!/^.{5}A/i.test(l) || l[6] === '*') { return; }
    const nameType = col(l, 17, 17).toUpperCase();
    const name = col(l, 19, 28).trim();
    const kwArea = col(l, 45, 80);
    const isContinuation = !name && !col(l, 30, 44).trim() && nameType === ' ';
    const prevKw = cur ? cur.parts[cur.parts.length - 1] ?? '' : '';
    if (cur && isContinuation && (/[-+]\s*$/.test(prevKw) || !col(l, 39, 44).trim())) {
      // Keyword continuation or a new keyword line for the same item (unless it starts a constant).
      if (/[-+]\s*$/.test(prevKw) || !/^\s*'/.test(kwArea)) { cur.parts.push(kwArea); return; }
    }
    finish();
    if (nameType === 'R') {
      rec = { name, srcLine: i, keywords: '', overlay: false, fields: [] };
      d.records.push(rec);
      cur = { parts: [kwArea], isRecord: true };
      return;
    }
    if (!rec) { cur = { parts: [kwArea], isFile: true }; return; }
    const lineS = col(l, 39, 41).trim(); const posS = col(l, 42, 44).trim();
    const ind = col(l, 8, 16).trim();
    const line = lineS ? (lineS.startsWith('+') ? lastLine + Number(lineS.slice(1)) : Number(lineS)) : lastLine;
    const pos = posS.startsWith('+') ? lastCol + lastLen + Number(posS.slice(1)) : Number(posS) || 0;
    if (!line && !pos && !name && !/^\s*'/.test(kwArea)) { cur = { parts: [kwArea], isRecord: true }; return; }
    if (name) {
      const len = Number(col(l, 30, 34).trim()) || 0;
      const usage = col(l, 38, 38).trim().toUpperCase() || 'O';
      const f: DspfField = { kind: 'field', name, line, col: pos, length: len, usage, type: col(l, 35, 35).trim().toUpperCase() || 'A',
        decimals: col(l, 36, 37).trim() ? Number(col(l, 36, 37)) : undefined, attrs: [], indicators: ind || undefined, keywords: '', srcLine: i };
      cur = { field: f, parts: [kwArea] };
      if (usage !== 'H' && usage !== 'P') { lastLine = line; lastCol = pos; lastLen = len; }
    } else {
      const f: DspfField = { kind: 'constant', name: '', line, col: pos, length: 0, usage: '', type: '', attrs: [], indicators: ind || undefined, keywords: '', srcLine: i };
      cur = { field: f, parts: [kwArea] };
    }
  });
  finish();
  d.fileKeywords = fileKw.join(' ');
  const size = /DSPSIZ\s*\(\s*(\d+)\s+(\d+)/i.exec(d.fileKeywords);
  if (size && Number(size[1]) === 27) { d.rows = 27; d.cols = 132; }
  // Fix constants: their length is the text length; fields after a constant with +n positions.
  for (const r of d.records) {
    for (const f of r.fields) {
      if (f.kind === 'constant') { f.length = (f.text ?? '').length; }
      if (!f.length && f.kind === 'field') { d.errors.push(`${r.name}.${f.name}: no length (reference fields are shown with length 10)`); f.length = 10; }
    }
  }
  return d;
}

function applyRecordKeywords(r: DspfRecord, kw: string): void {
  if (/\bSFL\b(?!\w)/i.test(kw) && !/SFLCTL/i.test(kw)) { r.sfl = true; }
  const ctl = /SFLCTL\s*\(\s*([\w$#@]+)\s*\)/i.exec(kw); if (ctl) { r.sflctl = ctl[1].toUpperCase(); }
  const pag = /SFLPAG\s*\(\s*(\d+)\s*\)/i.exec(kw); if (pag) { r.sflpag = Number(pag[1]); }
  if (/\bOVERLAY\b/i.test(kw)) { r.overlay = true; }
  const win = /WINDOW\s*\(\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/i.exec(kw);
  if (win) { r.window = { line: Number(win[1]), col: Number(win[2]), lines: Number(win[3]), cols: Number(win[4]) }; }
}

function applyFieldKeywords(f: DspfField, kw: string): void {
  f.keywords = kw;
  if (f.kind === 'constant') {
    const m = /^'((?:[^']|'')*)'/.exec(kw.trim());
    if (m) { f.text = m[1].replace(/''/g, "'"); }
    else {
      const dt = /^(DATE|TIME|SYSNAME|USER)\b/i.exec(kw.trim());
      f.text = dt ? ({ DATE: 'MM/DD/YY', TIME: 'HH:MM:SS', SYSNAME: 'SYSNAME', USER: 'USERNAME' } as Record<string, string>)[dt[1].toUpperCase()] : '';
    }
  }
  for (const c of kw.matchAll(/COLOR\s*\(\s*(\w+)\s*\)/gi)) { f.color = c[1].toUpperCase(); }
  for (const a of kw.matchAll(/DSPATR\s*\(([^)]*)\)/gi)) { f.attrs.push(...a[1].trim().toUpperCase().split(/\s+/).filter(x => /^(HI|RI|UL|BL|ND|PC|CS|PR|MDT)$/.test(x))); }
}

export interface Cell { ch: string; color?: string; attrs?: string[]; input?: boolean; field?: string; srcLine?: number }

/** Render one record (or a subfile control with its subfile) onto a rows×cols grid. */
export function layoutScreen(d: Dspf, recordName: string, opts: { showIndicatorFields?: boolean } = {}): { grid: (Cell | undefined)[][]; notes: string[] } {
  const grid: (Cell | undefined)[][] = Array.from({ length: d.rows }, () => Array<Cell | undefined>(d.cols).fill(undefined));
  const notes: string[] = [];
  const rec = d.records.find(r => r.name.toUpperCase() === recordName.toUpperCase());
  if (!rec) { return { grid, notes: [`Record ${recordName} not found.`] }; }
  const put = (r: DspfRecord, f: DspfField, lineOffset = 0) => {
    if (f.usage === 'H' || f.usage === 'P' || !f.line) { return; }
    if (f.indicators && !opts.showIndicatorFields && /^N/.test(f.indicators)) { /* shown: off-conditioned fields show by default */ }
    const base = r.window && r !== rec ? r.window : rec.window;
    const line = f.line + lineOffset + (base ? base.line : 0); const c0 = f.col + (base ? base.col : 0);
    const input = f.usage === 'I' || f.usage === 'B';
    const sample = f.kind === 'constant' ? f.text ?? ''
      : input ? ''.padEnd(f.length, '_')
      : /[SPYBFL]/.test(f.type) || f.decimals !== undefined ? ''.padEnd(Math.max(0, f.length - (f.decimals ? f.decimals + 1 : 0)), '9') + (f.decimals ? '.' + ''.padEnd(f.decimals, '9') : '')
      : ''.padEnd(f.length, 'X');
    if (line < 1 || line > d.rows) { notes.push(`${f.name || 'constant'} on line ${line} is outside the ${d.rows}-line screen.`); return; }
    for (let k = 0; k < sample.length; k++) {
      const x = c0 - 1 + k; if (x < 0 || x >= d.cols) { continue; }
      grid[line - 1][x] = { ch: f.attrs.includes('ND') ? ' ' : sample[k], color: f.color ?? (input ? 'GRN' : f.kind === 'constant' ? 'BLU' : 'GRN'), attrs: f.attrs, input, field: f.name || undefined, srcLine: f.srcLine };
    }
  };
  // A subfile control shows its subfile rows (SFLPAG of them) under it.
  const sfl = rec.sflctl ? d.records.find(r => r.name.toUpperCase() === rec.sflctl) : undefined;
  if (sfl) {
    const first = Math.min(...sfl.fields.filter(f => f.line).map(f => f.line));
    const pag = rec.sflpag ?? 1;
    for (let n = 0; n < pag; n++) { for (const f of sfl.fields) { put(sfl, f, n); } }
    if (!isFinite(first)) { notes.push('The subfile has no fields with a position.'); }
  }
  for (const f of rec.fields) { put(rec, f); }
  if (rec.window) { notes.push(`Window at line ${rec.window.line}, column ${rec.window.col}, ${rec.window.lines}×${rec.window.cols}.`); }
  return { grid, notes };
}
