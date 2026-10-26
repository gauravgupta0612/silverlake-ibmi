// Text tools for sources and reports: fixed-width spooled reports to CSV, characters that break compiles or CCSID
// conversions, and TODO / FIXME notes in source comments. Pure (no vscode import), unit tested.

// ---------------------------------------------------------------- report → CSV

export interface ReportTable { header: string[]; rows: string[][]; starts: number[] }

/**
 * Columns of a fixed-width report: blank character positions shared by (almost) all data lines split the columns.
 * Header, footer and page-break lines (few fields, different shape) are left out.
 */
export function reportToTable(text: string, minShare = 0.9): ReportTable {
  const all = text.split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
  const isRule = (l: string) => /^[\s\-=_*.]+$/.test(l) && /[-=_]{3,}/.test(l);
  const isNoise = (l: string) => !l.trim() || /^\s*(\*\s*){3,}|^\s*\*\s*(end|fin)|\bpage\s+\d+\s*$|\bpagina\s+\d+|\bseite\s+\d+/i.test(l);
  // The header is the line above the first underline (----- -----); without one, the first line with no digits.
  const rule = all.findIndex(isRule);
  let headerLine = -1;
  if (rule > 0) { for (let i = rule - 1; i >= 0; i--) { if (all[i].trim()) { headerLine = i; break; } } }
  const fields = (l: string) => l.trim().split(/\s{2,}/).length;
  const body = all.map((l, i) => ({ l, i })).filter(x => x.i > Math.max(rule, headerLine) && x.l.trim() && !isRule(x.l) && !isNoise(x.l) && (headerLine >= 0 || /\d/.test(x.l) || fields(x.l) >= 2));
  if (headerLine < 0) {
    const first = body.find(x => !/\d/.test(x.l) && fields(x.l) >= 2);
    if (first && body.indexOf(first) <= 2) { headerLine = first.i; body.splice(0, body.indexOf(first) + 1); }
  }
  if (!body.length) { return { header: [], rows: [], starts: [] }; }
  const counts = new Map<number, number>();
  for (const x of body) { counts.set(fields(x.l), (counts.get(fields(x.l)) ?? 0) + 1); }
  const typical = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const data = body.filter(x => Math.abs(fields(x.l) - typical) <= 1).map(x => x.l);
  const shape = [...data, ...(headerLine >= 0 ? [all[headerLine]] : [])];
  const width = Math.max(...shape.map(l => l.length));
  const blank = Array.from({ length: width }, (_, i) => data.filter(l => i >= l.length || l[i] === ' ').length / data.length >= minShare && (headerLine < 0 || i >= all[headerLine].length || all[headerLine][i] === ' ' || data.every(l => i >= l.length || l[i] === ' ')));
  // A column starts after a run of at least two blank positions (single blanks are spaces inside a value).
  const starts: number[] = [];
  let run = 2;
  for (let i = 0; i < width; i++) {
    if (blank[i]) { run++; continue; }
    if (run >= 2) { starts.push(i); }
    run = 0;
  }
  const split = (l: string) => starts.map((st, k) => l.substring(st, k + 1 < starts.length ? starts[k + 1] : undefined).trim());
  const header = headerLine >= 0 ? split(all[headerLine]).map((x, k) => x || `COL${k + 1}`) : starts.map((_, k) => `COL${k + 1}`);
  return { header, rows: data.map(split), starts };
}

export function toCsvText(header: string[], rows: string[][], sep = ','): string {
  const q = (s: string) => (s.includes(sep) || /["\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  // Numbers in IBM i edit formats (1.234,50- or 1,234.50-) become plain numbers so a spreadsheet can add them up.
  const num = (s: string) => {
    const m = /^(-)?([\d.,\s]+?)(-|CR)?$/.exec(s.trim());
    if (!m || !/\d/.test(m[2])) { return s; }
    let n = m[2].replace(/\s/g, '');
    if (/,\d{1,2}$/.test(n) && n.includes('.')) { n = n.replace(/\./g, '').replace(',', '.'); }
    else if (/,\d{1,2}$/.test(n) && !n.includes('.')) { n = n.replace(',', '.'); }
    else { n = n.replace(/,/g, ''); }
    return /^\d+(\.\d+)?$/.test(n) ? `${m[1] || m[3] ? '-' : ''}${n}` : s;
  };
  return [header.map(q).join(sep), ...rows.map(r => r.map(c => q(num(c))).join(sep))].join('\n') + '\n';
}

// ---------------------------------------------------------------- bad characters

export interface BadChar { line: number; column: number; code: number; what: string }

const NAMES: Record<number, string> = { 0x09: 'tab', 0x00: 'NUL', 0xa0: 'no-break space', 0xad: 'soft hyphen', 0xfffd: 'replacement character (lost in a CCSID conversion)', 0x200b: 'zero-width space', 0xfeff: 'byte order mark', 0x2018: 'curly quote', 0x2019: 'curly quote', 0x201c: 'curly double quote', 0x201d: 'curly double quote', 0x2013: 'en dash', 0x2014: 'em dash' };

/** Characters that break a compile or a CCSID conversion: control characters, tabs, invisible and "smart" characters. */
export function badCharacters(text: string, opts: { tabs?: boolean; smart?: boolean } = {}): BadChar[] {
  const out: BadChar[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    for (let c = 0; c < l.length; c++) {
      const code = l.charCodeAt(c);
      const ctrl = code < 0x20 && (code !== 0x09 || opts.tabs !== false);
      const special = [0xa0, 0xad, 0xfffd, 0x200b, 0xfeff].includes(code) || (code >= 0x7f && code < 0xa0);
      const smart = opts.smart !== false && [0x2018, 0x2019, 0x201c, 0x201d, 0x2013, 0x2014].includes(code);
      if (ctrl || special || smart) { out.push({ line: i, column: c, code, what: NAMES[code] ?? (code < 0x20 || (code >= 0x7f && code < 0xa0) ? `control character x'${code.toString(16).padStart(2, '0').toUpperCase()}'` : `U+${code.toString(16).toUpperCase().padStart(4, '0')}`) }); }
    }
  });
  return out;
}

/** The fixed text: tabs to spaces (to the next multiple of `tab`), smart quotes and dashes to plain ones, the rest to a blank. */
export function fixCharacters(text: string, tab = 2): string {
  return text.split(/(\r?\n)/).map(part => {
    if (/^\r?\n$/.test(part)) { return part; }
    let out = '';
    for (const ch of part) {
      const code = ch.charCodeAt(0);
      if (code === 0x09) { out += ' '.repeat(tab - (out.length % tab)); continue; }
      if (code === 0x2018 || code === 0x2019) { out += "'"; continue; }
      if (code === 0x201c || code === 0x201d) { out += '"'; continue; }
      if (code === 0x2013 || code === 0x2014) { out += '-'; continue; }
      if (code === 0xfeff || code === 0x200b || code === 0xad) { continue; }
      if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0xa0 || code === 0xfffd) { out += ' '; continue; }
      out += ch;
    }
    return out;
  }).join('');
}

// ---------------------------------------------------------------- TODO notes

export interface Note { line: number; tag: string; text: string }

/** TODO / FIXME / HACK / XXX / BUG notes in comments of RPG (// and * in column 7), CL (/* *\/), SQL (--) and DDS (A*). */
export function notesIn(text: string, tags = ['TODO', 'FIXME', 'HACK', 'XXX', 'BUG']): Note[] {
  const out: Note[] = [];
  const re = new RegExp(`\\b(${tags.map(t => t.replace(/[^A-Za-z0-9]/g, '')).join('|')})\\b[:\\s-]*(.*)$`, 'i');
  text.split(/\r?\n/).forEach((l, i) => {
    let comment = '';
    const fixedComment = /^.{5}[ A-Za-z]\*/.exec(l) || /^\s*\*/.exec(l.slice(0, 7)) ? l.slice(6) : '';
    const slash = l.indexOf('//'); const dash = l.indexOf('--'); const block = l.indexOf('/*');
    if (fixedComment) { comment = fixedComment; }
    else if (slash >= 0 && !inString(l, slash)) { comment = l.slice(slash + 2); }
    else if (block >= 0 && !inString(l, block)) { comment = l.slice(block + 2).replace(/\*\/.*$/, ''); }
    else if (dash >= 0 && !inString(l, dash)) { comment = l.slice(dash + 2); }
    if (!comment) { return; }
    const m = re.exec(comment);
    if (m) { out.push({ line: i, tag: m[1].toUpperCase(), text: m[2].replace(/\*\/\s*$/, '').trim() }); }
  });
  return out;
}

function inString(line: string, pos: number): boolean {
  let q = false;
  for (let i = 0; i < pos; i++) { if (line[i] === "'") { q = !q; } }
  return q;
}
