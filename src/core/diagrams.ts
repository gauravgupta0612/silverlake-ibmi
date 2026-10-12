// Pure helpers for 1.3: database diagram (ERD) layout and Mermaid export, text → PDF, the
// SNDSMTPEMM e-mail command, and row compare across two systems. No vscode import.

// ---------------------------------------------------------------- ERD

export interface ErdColumn { name: string; type: string; pk: boolean; fk?: boolean; nullable?: boolean }
export interface ErdTable { name: string; text?: string; columns: ErdColumn[]; rows?: number }
export interface ErdLink { from: string; fromCols: string[]; to: string; toCols: string[]; inferred: boolean; name?: string }

/** Relationships nobody declared: a column named like another table's one-column primary key. */
export function inferLinks(tables: ErdTable[], declared: ErdLink[]): ErdLink[] {
  const pkOf = new Map<string, string>();
  for (const t of tables) { const pk = t.columns.filter(c => c.pk); if (pk.length === 1) { pkOf.set(pk[0].name.toUpperCase(), t.name); } }
  const have = new Set(declared.map(l => `${l.from}|${l.to}|${l.fromCols.join()}`));
  const out: ErdLink[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      const target = pkOf.get(c.name.toUpperCase());
      if (!target || target === t.name || c.pk && t.columns.filter(x => x.pk).length === 1) { continue; }
      const key = `${t.name}|${target}|${c.name}`;
      if (!have.has(key)) { have.add(key); out.push({ from: t.name, fromCols: [c.name], to: target, toCols: [c.name], inferred: true }); }
    }
  }
  return out;
}

export interface Box { name: string; x: number; y: number; w: number; h: number }

/** Grid layout, most-connected tables in the middle rows; box height follows the columns shown. */
export function layoutErd(tables: ErdTable[], links: ErdLink[], maxCols = 12, colWidth = 230, rowH = 18, header = 26, gap = 60): { boxes: Box[]; width: number; height: number } {
  const degree = new Map(tables.map(t => [t.name, 0]));
  for (const l of links) { degree.set(l.from, (degree.get(l.from) ?? 0) + 1); degree.set(l.to, (degree.get(l.to) ?? 0) + 1); }
  const order = [...tables].sort((a, b) => (degree.get(b.name)! - degree.get(a.name)!) || a.name.localeCompare(b.name));
  const perRow = Math.max(1, Math.ceil(Math.sqrt(order.length * 1.6)));
  const boxes: Box[] = []; let y = 20; let width = 0;
  for (let r = 0; r * perRow < order.length; r++) {
    const row = order.slice(r * perRow, (r + 1) * perRow);
    let x = 20; let rowHeight = 0;
    for (const t of row) {
      const h = header + Math.min(t.columns.length, maxCols) * rowH + (t.columns.length > maxCols ? rowH : 0) + 6;
      boxes.push({ name: t.name, x, y, w: colWidth, h });
      x += colWidth + gap; rowHeight = Math.max(rowHeight, h);
    }
    width = Math.max(width, x); y += rowHeight + gap;
  }
  return { boxes, width: width + 20 - gap, height: y + 20 - gap };
}

const mid = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

/** Mermaid erDiagram text. */
export function toMermaid(tables: ErdTable[], links: ErdLink[]): string {
  const out = ['erDiagram'];
  for (const t of tables) {
    out.push(`  ${mid(t.name)} {`);
    for (const c of t.columns) { out.push(`    ${mid(c.type.split('(')[0]).toLowerCase() || 'col'} ${mid(c.name)}${c.pk ? ' PK' : c.fk ? ' FK' : ''}`); }
    out.push('  }');
  }
  for (const l of links) { out.push(`  ${mid(l.to)} ||--o{ ${mid(l.from)} : "${l.fromCols.join(', ')}${l.inferred ? ' (inferred)' : ''}"`); }
  return out.join('\n');
}

// ---------------------------------------------------------------- text → PDF

/** A plain monospaced PDF (Courier), one page per `linesPerPage` lines or per form feed. */
export function textToPdf(text: string, opts: { linesPerPage?: number; title?: string } = {}): Uint8Array {
  const raw = text.replace(/\r/g, '').split('\n');
  const width = Math.max(80, ...raw.map(l => l.length));
  const landscape = width > 100;
  const pw = landscape ? 842 : 595; const ph = landscape ? 595 : 842; const margin = 30;
  const lpp = Math.max(10, opts.linesPerPage ?? 66);
  const pages: string[][] = [[]];
  for (const l of raw) {
    const parts = l.split('\f');
    parts.forEach((p, i) => { if (i > 0 || pages[pages.length - 1].length >= lpp) { pages.push([]); } pages[pages.length - 1].push(p); });
  }
  while (pages.length > 1 && pages[pages.length - 1].every(l => !l.trim())) { pages.pop(); }
  const fontSize = Math.min(10, ((pw - 2 * margin) / Math.min(width, 198)) / 0.6);
  const leading = Math.min(fontSize * 1.15, (ph - 2 * margin) / lpp);
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7e]/g, c => {
    const code = c.charCodeAt(0); return code < 256 ? '\\' + code.toString(8).padStart(3, '0') : '?';
  });
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const p of pages) {
    const body = ['BT', `/F1 ${fontSize.toFixed(2)} Tf`, `${leading.toFixed(2)} TL`, `${margin} ${(ph - margin - fontSize).toFixed(2)} Td`,
      ...p.map((l, i) => `${i ? 'T* ' : ''}(${esc(l)}) Tj`), 'ET'].join('\n');
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(opts.title ?? 'Spooled file')}) /Producer (Vanthrex for IBM i) >>`);
  let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, c => c.charCodeAt(0) & 0xff);
}

// ---------------------------------------------------------------- e-mail

const EMAIL = /^[^\s@'()]+@[^\s@'()]+\.[^\s@'()]+$/;

export function parseRecipients(input: string): string[] {
  const list = input.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  if (!list.length) { throw new Error('Enter at least one e-mail address.'); }
  const bad = list.filter(x => !EMAIL.test(x));
  if (bad.length) { throw new Error(`Not an e-mail address: ${bad.join(', ')}`); }
  return list;
}

/** SNDSMTPEMM with one attachment from the IFS. */
export function emailCommand(to: string[], subject: string, note: string, attachment?: { path: string; type: '*PDF' | '*PLAIN' | '*OCTET' | '*HTML' }): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const rcp = to.map(a => `(${q(a)} *PRI)`).join(' ');
  return `SNDSMTPEMM RCP(${rcp}) SUBJECT(${q(subject.slice(0, 255) || ' ')}) NOTE(${q(note.slice(0, 2000) || ' ')})` +
    (attachment ? ` ATTACH((${q(attachment.path)} ${attachment.type} *BIN))` : '');
}

// ---------------------------------------------------------------- compare rows across systems

export type Row = Record<string, unknown>;

/** Compare two row sets by key columns (trailing blanks ignored). */
export function compareRows(keys: string[], a: Row[], b: Row[], columns: string[]): { onlyA: Row[]; onlyB: Row[]; changed: { key: string; diffs: { col: string; a: string; b: string }[] }[]; same: number } {
  const v = (x: unknown) => (x === null || x === undefined ? '∅' : String(x).trimEnd());
  const k = (r: Row) => keys.map(c => v(r[c])).join(' · ');
  const mb = new Map(b.map(r => [k(r), r]));
  const onlyA: Row[] = []; const changed: { key: string; diffs: { col: string; a: string; b: string }[] }[] = []; let same = 0;
  for (const r of a) {
    const key = k(r); const o = mb.get(key);
    if (!o) { onlyA.push(r); continue; }
    mb.delete(key);
    const diffs = columns.filter(c => !keys.includes(c) && v(r[c]) !== v(o[c])).map(c => ({ col: c, a: v(r[c]), b: v(o[c]) }));
    if (diffs.length) { changed.push({ key, diffs }); } else { same++; }
  }
  return { onlyA, onlyB: [...mb.values()], changed, same };
}
