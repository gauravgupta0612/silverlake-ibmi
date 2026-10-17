import * as vscode from 'vscode';
import { escapeHtml, loaderHtml, page } from './ui/kit';

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
const subs = new Map<vscode.WebviewPanel, vscode.Disposable>();

/** A page opened with a loader while a report is being read; the report that follows takes it over. */
let pending: { panel: vscode.WebviewPanel; closeTimer?: NodeJS.Timeout } | undefined;

function createPanel(title: string): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel('vanthrex.report', title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: true });
}

function loadingPage(title: string): string {
  return page({ title, body: `<h1>${escapeHtml(title)}</h1>${loaderHtml(vscode.l10n.t('Reading from the IBM i…'), { rows: 8 })}`, css: REPORT_CSS });
}

/** Show the loader for a report: in its own page when it is already open, otherwise in a new page the report will use. */
function showLoading(title: string, id?: string): void {
  const open = id ? panels.get(id) : undefined;
  if (open) { void open.webview.postMessage({ t: 'busy', on: true }); return; }
  if (pending) {
    if (pending.closeTimer) { clearTimeout(pending.closeTimer); pending.closeTimer = undefined; }
    pending.panel.title = title; pending.panel.webview.html = loadingPage(title); pending.panel.reveal(); return;
  }
  const panel = createPanel(title);
  panel.webview.html = loadingPage(title);
  pending = { panel };
  panel.onDidDispose(() => { if (pending?.panel === panel) { pending = undefined; } });
}

function stopLoading(id: string | undefined, delayMs: number): void {
  const open = id ? panels.get(id) : undefined;
  if (open) { void open.webview.postMessage({ t: 'busy', on: false }); }
  if (!pending) { return; }
  const p = pending;
  if (p.closeTimer) { clearTimeout(p.closeTimer); }
  // When no report took the page over (nothing found, a question asked first, an error), close it.
  p.closeTimer = setTimeout(() => { if (pending === p) { pending = undefined; p.panel.dispose(); } }, delayMs);
}

/**
 * Run the reading part of a report: progress in the status bar and, when it takes more than a moment, a loader in the
 * editor right away (or the busy bar on the report already open), so the user sees the page coming instead of waiting.
 */
export async function reportProgress<T>(id: string | undefined, title: string, fn: () => Promise<T>): Promise<T> {
  const timer = setTimeout(() => showLoading(title, id), 200);
  try {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn);
    clearTimeout(timer); stopLoading(id, 1500);
    return r;
  } catch (e) {
    clearTimeout(timer); stopLoading(id, 0);
    throw e;
  }
}

export function showReport(id: string, report: Report, allowed: Set<string>): void {
  let panel = panels.get(id);
  if (!panel && pending) {
    panel = pending.panel;
    if (pending.closeTimer) { clearTimeout(pending.closeTimer); }
    pending = undefined;
  }
  if (!panel) { panel = createPanel(report.title); }
  if (!panels.has(id)) {
    panels.set(id, panel);
    const p = panel;
    panel.onDidDispose(() => { if (panels.get(id) === p) { panels.delete(id); } subs.get(p)?.dispose(); subs.delete(p); });
  }
  panel.reveal();
  panel.title = report.title;
  const actions: ReportAction[] = [];
  const ref = (a?: ReportAction) => { if (!a) { return -1; } actions.push(a); return actions.length - 1; };
  panel.webview.html = render(report, ref);
  // Replace the listener each time the content changes.
  subs.get(panel)?.dispose();
  subs.set(panel, panel.webview.onDidReceiveMessage(m => {
    const a = actions[Number(m?.action)];
    if (a && allowed.has(a.command)) { vscode.commands.executeCommand(a.command, ...(a.args ?? [])); }
  }));
}

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') { return '<span class="dim">—</span>'; }
  return escapeHtml(String(v));
}

/** Rows are sent as data and drawn a page at a time, so reports with thousands of rows open at once. */
const PAGE = 300;

const REPORT_CSS = `
  body { padding: 8px 16px 24px; }
  h1 { font-size: 1.4em; margin: 4px 0 2px; } h2 { font-size: 1.1em; margin: 22px 0 8px; }
  .sub { color: var(--vx-muted); margin-bottom: 12px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 18px; margin: 8px 0; }
  dt { color: var(--vx-muted); } dd { margin: 0; font-family: var(--vscode-editor-font-family); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  .filter { margin-bottom: 6px; }
  .note { margin-top: 18px; color: var(--vx-muted); }
`;

function render(r: Report, ref: (a?: ReportAction) => number): string {
  const facts = r.facts?.length
    ? `<dl>${r.facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${cell(v)}</dd>`).join('')}</dl>` : '';
  const buttons = r.actions?.length
    ? `<div class="actions">${r.actions.map(a => `<button class="vx-btn" data-a="${ref(a)}">${escapeHtml(a.label)}</button>`).join('')}</div>` : '';
  const data = (r.tables ?? []).map(t => ({
    rows: t.rows.map(row => row.map(v => (v === null || v === undefined ? '' : v))),
    cls: t.rows.map((_, i) => t.rowClass?.[i] ?? ''),
    act: t.rows.map((_, i) => ref(t.rowActions?.[i])),
    tip: t.rows.map((_, i) => t.rowActions?.[i]?.label ?? ''),
  }));
  const tables = (r.tables ?? []).map((t, ti) => {
    const empty = t.rows.length ? '' : `<tr><td colspan="${t.columns.length}" class="dim">${escapeHtml(t.empty ?? vscode.l10n.t('Nothing to show.'))}</td></tr>`;
    return `<section><h2>${escapeHtml(t.title)} <span class="dim">(${t.rows.length})</span></h2>` +
      ((t.filter || t.rows.length > 50) && t.rows.length > 8 ? `<input class="vx-input filter" data-t="${ti}" placeholder="${escapeHtml(vscode.l10n.t('Filter…'))}">` : '') +
      `<table class="vx-table" data-t="${ti}"><thead><tr>${t.columns.map(c => `<th title="${escapeHtml(vscode.l10n.t('Sort'))}">${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${empty}</tbody></table>` +
      `<div class="vx-more" data-t="${ti}"></div></section>`;
  }).join('');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const body = `<h1>${escapeHtml(r.title)}</h1>${r.subtitle ? `<div class="sub">${escapeHtml(r.subtitle)}</div>` : ''}
${buttons}${facts}${tables}${r.note ? `<p class="note">${escapeHtml(r.note)}</p>` : ''}`;
  const script = `
  const vscode = acquireVsCodeApi();
  const T = ${json};
  const views = T.map((t, ti) => {
    if (!t.rows.length) return null;
    const v = VX.table(document.querySelector('table[data-t="' + ti + '"]'), document.querySelector('.vx-more[data-t="' + ti + '"]'), t.rows, i => {
      const a = t.act[i];
      return '<tr class="' + t.cls[i] + (a >= 0 ? ' link' : '') + '"' + (a >= 0 ? ' data-a="' + a + '" title="' + VX.esc(t.tip[i]) + '"' : '') + '>' +
        t.rows[i].map(c => c === '' ? '<td><span class="dim">—</span></td>' : '<td>' + VX.esc(c) + '</td>').join('') + '</tr>';
    }, ${PAGE});
    v.draw();
    return v;
  });
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-a]');
    if (el && Number(el.dataset.a) >= 0) { vscode.postMessage({ action: el.dataset.a }); }
  });
  document.querySelectorAll('.filter').forEach(inp => {
    const run = VX.debounce(() => views[Number(inp.dataset.t)] && views[Number(inp.dataset.t)].filter(inp.value), 120);
    inp.addEventListener('input', run);
  });
  window.addEventListener('message', ev => { if (ev.data && ev.data.t === 'busy') VX.busy(ev.data.on); });
`;
  return page({ title: r.title, css: REPORT_CSS, body, script });
}
