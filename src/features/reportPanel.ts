import * as vscode from 'vscode';
import { escapeHtml, nonce } from './webviewUtil';

/** A read-only report page: key/value cards, tables with clickable rows, and action buttons. */
export interface ReportAction { label: string; command: string; args?: unknown[] }
export interface ReportTable {
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  /** Optional per-row action (by row index) and CSS class. */
  rowActions?: (ReportAction | undefined)[];
  rowClass?: (string | undefined)[];
  filter?: boolean;
  empty?: string;
}
export interface Report {
  title: string;
  subtitle?: string;
  facts?: [string, string | number | null | undefined][];
  actions?: ReportAction[];
  tables?: ReportTable[];
  note?: string;
}

const panels = new Map<string, vscode.WebviewPanel>();

export function showReport(id: string, report: Report, allowed: Set<string>): void {
  let panel = panels.get(id);
  if (!panel) {
    panel = vscode.window.createWebviewPanel(`vanthrex.report.${id}`, report.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true });
    panels.set(id, panel);
    panel.onDidDispose(() => panels.delete(id));
  } else {
    panel.reveal();
  }
  panel.title = report.title;
  const actions: ReportAction[] = [];
  const ref = (a?: ReportAction) => { if (!a) { return -1; } actions.push(a); return actions.length - 1; };
  panel.webview.html = render(report, ref);
  // Replace the listener each time the content changes.
  (panel as unknown as { _sub?: vscode.Disposable })._sub?.dispose();
  (panel as unknown as { _sub?: vscode.Disposable })._sub = panel.webview.onDidReceiveMessage(m => {
    const a = actions[Number(m?.action)];
    if (a && allowed.has(a.command)) { vscode.commands.executeCommand(a.command, ...(a.args ?? [])); }
  });
}

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') { return '<span class="dim">—</span>'; }
  return escapeHtml(String(v));
}

/** Rows are sent as data and drawn a page at a time, so reports with thousands of rows open at once. */
const PAGE = 300;

function render(r: Report, ref: (a?: ReportAction) => number): string {
  const n = nonce();
  const facts = r.facts?.length
    ? `<dl>${r.facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${cell(v)}</dd>`).join('')}</dl>` : '';
  const buttons = r.actions?.length
    ? `<div class="actions">${r.actions.map(a => `<button data-a="${ref(a)}">${escapeHtml(a.label)}</button>`).join('')}</div>` : '';
  const data = (r.tables ?? []).map(t => ({
    rows: t.rows.map(row => row.map(v => (v === null || v === undefined ? '' : v))),
    cls: t.rows.map((_, i) => t.rowClass?.[i] ?? ''),
    act: t.rows.map((_, i) => ref(t.rowActions?.[i])),
    tip: t.rows.map((_, i) => t.rowActions?.[i]?.label ?? ''),
  }));
  const tables = (r.tables ?? []).map((t, ti) => {
    const empty = t.rows.length ? '' : `<tr><td colspan="${t.columns.length}" class="dim">${escapeHtml(t.empty ?? 'Nothing to show.')}</td></tr>`;
    return `<section><h2>${escapeHtml(t.title)} <span class="dim">(${t.rows.length})</span></h2>` +
      ((t.filter || t.rows.length > 50) && t.rows.length > 8 ? `<input class="filter" data-t="${ti}" placeholder="${escapeHtml(vscode.l10n.t('Filter…'))}">` : '') +
      `<table data-t="${ti}"><thead><tr>${t.columns.map((c, ci) => `<th data-c="${ci}" title="${escapeHtml(vscode.l10n.t('Sort'))}">${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${empty}</tbody></table>` +
      `<div class="more" data-t="${ti}"></div></section>`;
  }).join('');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const moreText = JSON.stringify(vscode.l10n.t('Show {0} more ({1} left)', '%N', '%L')).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 16px 24px; }
  h1 { font-size: 1.4em; margin: 4px 0 2px; } h2 { font-size: 1.1em; margin: 22px 0 8px; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 18px; margin: 8px 0; }
  dt { color: var(--vscode-descriptionForeground); } dd { margin: 0; font-family: var(--vscode-editor-font-family); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  button { padding: 5px 12px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  table { border-collapse: collapse; width: 100%; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { border: 1px solid var(--vscode-editorWidget-border, #8883); padding: 3px 8px; text-align: left; vertical-align: top; }
  th { background: var(--vscode-editorWidget-background); }
  tr.link { cursor: pointer; } tr.link:hover td { background: var(--vscode-list-hoverBackground); }
  .dim { color: var(--vscode-descriptionForeground); }
  tr.onlyA td:first-child { border-left: 3px solid var(--vscode-gitDecoration-addedResourceForeground, #4a4); }
  tr.onlyB td:first-child { border-left: 3px solid var(--vscode-gitDecoration-deletedResourceForeground, #c44); }
  tr.different td:first-child { border-left: 3px solid var(--vscode-gitDecoration-modifiedResourceForeground, #c93); }
  tr.bad td { color: var(--vscode-errorForeground); }
  .filter { padding: 4px 8px; margin-bottom: 6px; min-width: 240px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; }
  .note { margin-top: 18px; color: var(--vscode-descriptionForeground); }
  th { cursor: pointer; user-select: none; } th.up::after { content: ' ▲'; } th.down::after { content: ' ▼'; }
  .more { margin-top: 6px; }
</style></head><body>
<h1>${escapeHtml(r.title)}</h1>${r.subtitle ? `<div class="sub">${escapeHtml(r.subtitle)}</div>` : ''}
${buttons}${facts}${tables}${r.note ? `<p class="note">${escapeHtml(r.note)}</p>` : ''}
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const T = ${json};
  const PAGE = ${PAGE};
  const MORE = ${moreText};
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const state = T.map(t => ({ view: t.rows.map((_, i) => i), shown: 0, text: null, sort: -1, dir: 1 }));
  function rowHtml(t, i) {
    const a = t.act[i];
    return '<tr class="' + t.cls[i] + (a >= 0 ? ' link' : '') + '"' + (a >= 0 ? ' data-a="' + a + '" title="' + esc(t.tip[i]) + '"' : '') + '>' +
      t.rows[i].map(v => v === '' ? '<td><span class="dim">—</span></td>' : '<td>' + esc(v) + '</td>').join('') + '</tr>';
  }
  function more(ti) {
    const t = T[ti], s = state[ti], body = document.querySelector('table[data-t="' + ti + '"] tbody');
    const next = s.view.slice(s.shown, s.shown + PAGE);
    body.insertAdjacentHTML('beforeend', next.map(i => rowHtml(t, i)).join(''));
    s.shown += next.length;
    const left = s.view.length - s.shown;
    document.querySelector('.more[data-t="' + ti + '"]').innerHTML = left > 0 ? '<button data-more="' + ti + '">' + esc(MORE.replace('%N', Math.min(left, PAGE)).replace('%L', left)) + '</button>' : '';
  }
  function draw(ti) {
    if (!T[ti].rows.length) return;
    document.querySelector('table[data-t="' + ti + '"] tbody').innerHTML = '';
    state[ti].shown = 0; more(ti);
  }
  T.forEach((_, ti) => draw(ti));
  document.addEventListener('click', e => {
    const m = e.target.closest('[data-more]');
    if (m) { more(Number(m.dataset.more)); return; }
    const th = e.target.closest('th[data-c]');
    if (th) {
      const ti = Number(th.closest('table').dataset.t), c = Number(th.dataset.c), s = state[ti], rows = T[ti].rows;
      s.dir = s.sort === c ? -s.dir : 1; s.sort = c;
      const num = v => typeof v === 'number' ? v : (/^-?[\\d.,]+$/.test(String(v).trim()) ? Number(String(v).replace(/,/g, '')) : NaN);
      s.view.sort((x, y) => { const a = rows[x][c], b = rows[y][c]; const na = num(a), nb = num(b);
        return s.dir * (!isNaN(na) && !isNaN(nb) ? na - nb : String(a).localeCompare(String(b))); });
      th.closest('thead').querySelectorAll('th').forEach(h => h.classList.remove('up', 'down'));
      th.classList.add(s.dir > 0 ? 'up' : 'down');
      draw(ti); return;
    }
    const el = e.target.closest('[data-a]');
    if (el && Number(el.dataset.a) >= 0) { vscode.postMessage({ action: el.dataset.a }); }
  });
  document.querySelectorAll('.filter').forEach(inp => inp.addEventListener('input', () => {
    clearTimeout(inp._timer);
    inp._timer = setTimeout(() => {
      const ti = Number(inp.dataset.t), t = T[ti], s = state[ti], f = inp.value.toLowerCase().trim();
      if (!s.text) s.text = t.rows.map(r => r.join(' ').toLowerCase());
      s.view = t.rows.map((_, i) => i).filter(i => !f || s.text[i].includes(f));
      s.sort = -1;
      document.querySelectorAll('table[data-t="' + ti + '"] th').forEach(h => h.classList.remove('up', 'down'));
      draw(ti);
    }, 120);
  }));
</script></body></html>`;
}
