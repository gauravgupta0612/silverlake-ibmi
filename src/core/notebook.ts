// IBM i notebooks (.vxnb): SQL, CL, PASE shell and Markdown cells in one file, results as tables or charts.
// Pure functions (no vscode import), unit tested.

export type CellKind = 'sql' | 'cl' | 'shell' | 'markdown';
export interface NotebookCellJson { kind: CellKind; source: string }
export interface NotebookJson { vanthrexNotebook: 1; cells: NotebookCellJson[] }

/** VS Code language ids of each cell kind. */
export const CELL_LANGUAGE: Record<CellKind, string> = { sql: 'sql', cl: 'cl', shell: 'shellscript', markdown: 'markdown' };

export function kindOfLanguage(language: string): CellKind {
  const l = language.toLowerCase();
  if (l === 'markdown') { return 'markdown'; }
  if (l === 'cl' || l === 'clle' || l === 'clp') { return 'cl'; }
  if (l === 'shellscript' || l === 'sh' || l === 'bash') { return 'shell'; }
  return 'sql';
}

export function parseNotebook(text: string): NotebookJson {
  if (!text.trim()) { return { vanthrexNotebook: 1, cells: [] }; }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('This notebook file is not valid JSON.'); }
  const cells = (data as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) { throw new Error('This notebook file has no cells.'); }
  return {
    vanthrexNotebook: 1,
    cells: cells.map(c => {
      const o = (c ?? {}) as Record<string, unknown>;
      const kind = (['sql', 'cl', 'shell', 'markdown'].includes(String(o.kind)) ? o.kind : 'sql') as CellKind;
      return { kind, source: Array.isArray(o.source) ? o.source.join('\n') : String(o.source ?? '') };
    }),
  };
}

export function serializeNotebook(cells: NotebookCellJson[]): string {
  return JSON.stringify({ vanthrexNotebook: 1, cells: cells.map(c => ({ kind: c.kind, source: c.source.split('\n') })) }, null, 2) + '\n';
}

/** A starter notebook that shows what each cell can do. */
export function sampleNotebook(user: string): NotebookCellJson[] {
  return [
    { kind: 'markdown', source: '# IBM i notebook\nRun a cell with **Shift+Enter**. SQL, CL and PASE shell cells run on the connected system; results stay in this window (they are not saved in the file).' },
    { kind: 'sql', source: `-- chart: bar Jobs per subsystem\nSELECT SUBSYSTEM, COUNT(*) AS JOBS\n  FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X\n WHERE SUBSYSTEM IS NOT NULL\n GROUP BY SUBSYSTEM ORDER BY 2 DESC FETCH FIRST 10 ROWS ONLY` },
    { kind: 'cl', source: 'DSPLIBL' },
    { kind: 'sql', source: `SELECT OBJNAME, OBJTYPE, OBJSIZE, LAST_USED_TIMESTAMP\n  FROM TABLE(QSYS2.OBJECT_STATISTICS('QGPL', '*ALL')) X\n ORDER BY OBJSIZE DESC FETCH FIRST 20 ROWS ONLY` },
    { kind: 'shell', source: `ls -la ~ | head -20 # runs as ${user.toLowerCase()}` },
  ];
}

export type ChartKind = 'bar' | 'line' | 'pie';
export interface CellOptions { chart?: ChartKind; title?: string; rows?: number }

/** Directives in leading comment lines: `-- chart: bar|line|pie [title]` and `-- rows: 500`. */
export function cellOptions(source: string): CellOptions {
  const o: CellOptions = {};
  for (const line of source.split('\n')) {
    const t = line.trim();
    if (!t) { continue; }
    if (!t.startsWith('--')) { break; }
    let m = t.match(/^--\s*chart\s*:\s*(bar|line|pie)\b\s*(.*)$/i);
    if (m) { o.chart = m[1].toLowerCase() as ChartKind; if (m[2].trim()) { o.title = m[2].trim(); } continue; }
    m = t.match(/^--\s*rows\s*:\s*(\d+)/i);
    if (m) { o.rows = Math.min(100000, Math.max(1, Number(m[1]))); }
  }
  return o;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim()) && v.trim() !== '');
const show = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Result table as HTML (rendered by the notebook's own HTML renderer). */
export function resultTableHtml(columns: string[], rows: Record<string, unknown>[], note?: string): string {
  const numeric = columns.map(c => rows.length > 0 && rows.slice(0, 50).every(r => r[c] === null || r[c] === undefined || isNum(r[c])));
  const head = columns.map((c, i) => `<th style="text-align:${numeric[i] ? 'right' : 'left'}">${esc(c)}</th>`).join('');
  const body = rows.map(r => '<tr>' + columns.map((c, i) => {
    const v = r[c];
    const cell = v === null || v === undefined ? '<i style="opacity:.5">null</i>' : esc(show(v).replace(/\s+$/, ''));
    return `<td style="text-align:${numeric[i] ? 'right' : 'left'}">${cell}</td>`;
  }).join('') + '</tr>').join('');
  const style = 'border-collapse:collapse;font-family:var(--vscode-editor-font-family);font-size:12px';
  const cellCss = '<style>.vxnb td,.vxnb th{border:1px solid rgba(128,128,128,.35);padding:2px 8px;white-space:pre}.vxnb th{position:sticky;top:0;background:var(--vscode-editor-background)}</style>';
  return `${cellCss}<div style="max-height:420px;overflow:auto"><table class="vxnb" style="${style}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    (note ? `<div style="opacity:.7;font-size:11px;margin-top:4px">${esc(note)}</div>` : '');
}

const PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

/** Chart of a result: labels from the first column, one series per numeric column (up to 4). SVG, no scripts. */
export function chartSvg(kind: ChartKind, columns: string[], rows: Record<string, unknown>[], title = ''): string {
  if (!rows.length || columns.length < 2) { throw new Error('A chart needs a label column and at least one number column.'); }
  const labelCol = columns[0];
  const series = columns.slice(1).filter(c => rows.every(r => r[c] === null || r[c] === undefined || isNum(r[c]))).slice(0, kind === 'pie' ? 1 : 4);
  if (!series.length) { throw new Error('A chart needs at least one column with numbers after the label column.'); }
  const data = rows.slice(0, kind === 'pie' ? 12 : 60);
  const labels = data.map(r => show(r[labelCol]).trim() || '—');
  const val = (r: Record<string, unknown>, c: string) => Number(r[c] ?? 0) || 0;
  const W = 640, H = 300;
  const titleSvg = title ? `<text x="${W / 2}" y="16" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">${esc(title)}</text>` : '';
  const legend = series.map((s, i) => `<g transform="translate(${70 + i * 140},${H - 8})"><rect width="10" height="10" y="-9" fill="${PALETTE[i]}"/><text x="14" font-size="11" fill="currentColor">${esc(s)}</text></g>`).join('');
  if (kind === 'pie') {
    const total = data.reduce((a, r) => a + Math.max(0, val(r, series[0])), 0) || 1;
    let angle = -Math.PI / 2; const cx = 160, cy = 155, rad = 110;
    const slices = data.map((r, i) => {
      const v = Math.max(0, val(r, series[0])); const a = (v / total) * Math.PI * 2;
      const x1 = cx + rad * Math.cos(angle), y1 = cy + rad * Math.sin(angle); angle += a;
      const x2 = cx + rad * Math.cos(angle), y2 = cy + rad * Math.sin(angle);
      const path = a >= Math.PI * 2 - 1e-9 ? `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${PALETTE[i % PALETTE.length]}"/>`
        : `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${rad},${rad} 0 ${a > Math.PI ? 1 : 0} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}" stroke="var(--vscode-editor-background,#fff)" stroke-width="1"><title>${esc(labels[i])}: ${v}</title></path>`;
      return path;
    }).join('');
    const keys = data.map((r, i) => `<g transform="translate(300,${44 + i * 19})"><rect width="11" height="11" y="-10" fill="${PALETTE[i % PALETTE.length]}"/><text x="16" font-size="11" fill="currentColor">${esc(labels[i].slice(0, 30))} — ${val(r, series[0])} (${Math.round(Math.max(0, val(r, series[0])) / total * 1000) / 10}%)</text></g>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="color:var(--vscode-foreground,#333)">${titleSvg}${slices}${keys}</svg>`;
  }
  const values = data.flatMap(r => series.map(s => val(r, s)));
  const max = Math.max(0, ...values), min = Math.min(0, ...values);
  const span = max - min || 1;
  const left = 56, right = 12, top = title ? 28 : 12, bottom = 64;
  const pw = W - left - right, ph = H - top - bottom;
  const y = (v: number) => top + ph - ((v - min) / span) * ph;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => min + f * span);
  const grid = ticks.map(t => `<line x1="${left}" x2="${W - right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="currentColor" stroke-opacity=".15"/><text x="${left - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor">${fmt(t)}</text>`).join('');
  const step = pw / data.length;
  const every = Math.max(1, Math.ceil(data.length / 15));
  const xLabels = labels.map((l, i) => (i % every ? '' : `<text transform="translate(${(left + step * i + step / 2).toFixed(1)},${H - bottom + 12}) rotate(30)" font-size="10" fill="currentColor">${esc(l.slice(0, 16))}</text>`)).join('');
  let marks = '';
  if (kind === 'bar') {
    const bw = Math.max(1, (step * 0.8) / series.length);
    marks = data.map((r, i) => series.map((s, j) => {
      const v = val(r, s); const x = left + step * i + step * 0.1 + bw * j;
      return `<rect x="${x.toFixed(1)}" y="${Math.min(y(v), y(0)).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${Math.abs(y(v) - y(0)).toFixed(1)}" fill="${PALETTE[j]}"><title>${esc(labels[i])} · ${esc(s)}: ${v}</title></rect>`;
    }).join('')).join('');
  } else {
    marks = series.map((s, j) => {
      const pts = data.map((r, i) => `${(left + step * i + step / 2).toFixed(1)},${y(val(r, s)).toFixed(1)}`);
      return `<polyline fill="none" stroke="${PALETTE[j]}" stroke-width="2" points="${pts.join(' ')}"/>` +
        data.map((r, i) => `<circle cx="${(left + step * i + step / 2).toFixed(1)}" cy="${y(val(r, s)).toFixed(1)}" r="2.5" fill="${PALETTE[j]}"><title>${esc(labels[i])} · ${esc(s)}: ${val(r, s)}</title></circle>`).join('');
    }).join('');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="color:var(--vscode-foreground,#333)">${titleSvg}${grid}` +
    `<line x1="${left}" x2="${W - right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="currentColor" stroke-opacity=".5"/>${marks}${xLabels}${series.length > 1 ? legend : ''}</svg>`;
}

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) { return (n / 1e9).toFixed(1) + 'G'; }
  if (a >= 1e6) { return (n / 1e6).toFixed(1) + 'M'; }
  if (a >= 1e4) { return (n / 1e3).toFixed(0) + 'k'; }
  return String(Math.round(n * 100) / 100);
}

/** Markdown export of a notebook: Markdown cells as they are, code cells fenced, with their last text result. */
export function notebookMarkdown(cells: { kind: CellKind; source: string; result?: { columns: string[]; rows: Record<string, unknown>[] } | string }[]): string {
  const out: string[] = [];
  for (const c of cells) {
    if (c.kind === 'markdown') { out.push(c.source.trim(), ''); continue; }
    out.push('```' + (c.kind === 'shell' ? 'sh' : c.kind), c.source.trim(), '```', '');
    if (typeof c.result === 'string' && c.result.trim()) { out.push('```text', c.result.trim().slice(0, 20000), '```', ''); }
    else if (c.result && typeof c.result === 'object' && c.result.columns.length) {
      const cols = c.result.columns;
      const cell = (v: unknown) => show(v).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
      out.push('| ' + cols.map(cell).join(' | ') + ' |', '|' + cols.map(() => ' --- ').join('|') + '|');
      for (const r of c.result.rows.slice(0, 200)) { out.push('| ' + cols.map(k => cell(r[k])).join(' | ') + ' |'); }
      if (c.result.rows.length > 200) { out.push('', `_${c.result.rows.length - 200} more row(s) not shown._`); }
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
