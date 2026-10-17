// Printer file (PRTF) layout for the preview. Pure functions (no vscode import), unit tested.

export interface PrtfItem { record: string; name: string; text: string; col: number; line: number; srcLine: number; field: boolean }

/** Lay out every record format of a PRTF once, in source order, as if printed one after the other. */
export function layoutPrtf(text: string, pageLines = 66, pageCols = 132): { lines: string[]; items: PrtfItem[]; records: string[] } {
  const src = text.split(/\r?\n/);
  type Entry = { kind: 'rec' | 'field' | 'const'; name: string; len: number; type: string; dec?: number; pos: string; kw: string; line: number; edit?: string };
  const entries: Entry[] = []; let cur: Entry | undefined;
  src.forEach((raw, i) => {
    const l = raw.padEnd(80);
    if (!/^.{5}A/i.test(l) || l[6] === '*') { return; }
    const nameType = l[16].toUpperCase(); const name = l.substring(18, 28).trim(); const kw = l.substring(44, 80);
    const posS = l.substring(41, 44).trim(); const lenS = l.substring(29, 34).trim();
    if (cur && !name && !posS && !lenS && nameType === ' ' && !/^\s*'/.test(kw)) { cur.kw += ' ' + kw.trim(); return; }
    if (cur && /[-+]\s*$/.test(cur.kw) && !name && !posS) { cur.kw = cur.kw.replace(/[-+]\s*$/, '') + kw.trim(); return; }
    if (nameType === 'R') { cur = { kind: 'rec', name, len: 0, type: '', pos: '', kw: kw.trim(), line: i }; entries.push(cur); return; }
    if (!entries.some(e => e.kind === 'rec')) { return; } // file-level keywords
    cur = { kind: name ? 'field' : 'const', name, len: Number(lenS) || 0, type: l[34].trim().toUpperCase() || 'A', dec: l.substring(35, 37).trim() ? Number(l.substring(35, 37)) : undefined, pos: posS, kw: kw.trim(), line: i };
    entries.push(cur);
  });
  const page: string[] = Array.from({ length: pageLines }, () => '');
  const items: PrtfItem[] = []; const records: string[] = [];
  let line = 0; let lastEnd = 0; let record = '';
  const num = (kw: string, k: string) => { const m = new RegExp(`\\b${k}\\s*\\(\\s*(\\d+)\\s*\\)`, 'i').exec(kw); return m ? Number(m[1]) : undefined; };
  const move = (kw: string, before: boolean) => {
    const skip = num(kw, before ? 'SKIPB' : 'SKIPA'); const space = num(kw, before ? 'SPACEB' : 'SPACEA');
    if (skip !== undefined) { line = skip; lastEnd = 0; } else if (space !== undefined) { line += space; lastEnd = 0; }
  };
  const write = (col: number, s: string) => {
    if (line < 1 || line > pageLines) { return; }
    const row = page[line - 1].padEnd(col - 1 + s.length);
    page[line - 1] = (row.slice(0, col - 1) + s + row.slice(col - 1 + s.length)).slice(0, pageCols);
  };
  for (const e of entries) {
    if (e.kind === 'rec') {
      if (record) { /* SPACEA/SKIPA of the previous record's last item already applied */ }
      record = e.name; records.push(e.name);
      if (!line) { line = 1; }
      move(e.kw, true);
      continue;
    }
    move(e.kw, true);
    if (!line) { line = 1; }
    let text = '';
    if (e.kind === 'const') {
      const m = /^'((?:[^']|'')*)'/.exec(e.kw); text = m ? m[1].replace(/''/g, "'") : /^DATE\b/i.test(e.kw) ? 'MM/DD/YY' : /^TIME\b/i.test(e.kw) ? 'HH:MM:SS' : /^PAGNBR\b/i.test(e.kw) ? '9999' : '';
    } else {
      text = e.dec !== undefined || /[SPY]/.test(e.type)
        ? `${'9'.repeat(Math.max(1, e.len - (e.dec ?? 0)))}${e.dec ? '.' + '9'.repeat(e.dec) : ''}`
        : 'X'.repeat(e.len);
    }
    const col = e.pos.startsWith('+') ? lastEnd + 1 + Number(e.pos.slice(1)) : Number(e.pos) || lastEnd + 2;
    write(col, text);
    items.push({ record, name: e.name, text, col, line, srcLine: e.line, field: e.kind === 'field' });
    lastEnd = col + text.length - 1;
    move(e.kw, false);
  }
  let last = page.length; while (last > 0 && !page[last - 1].trim()) { last--; }
  return { lines: page.slice(0, Math.max(last, 1)), items, records };
}
