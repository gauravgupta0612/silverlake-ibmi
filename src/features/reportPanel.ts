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

function render(r: Report, ref: (a?: ReportAction) => number): string {
  const n = nonce();
  const facts = r.facts?.length
    ? `<dl>${r.facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${cell(v)}</dd>`).join('')}</dl>` : '';
  const buttons = r.actions?.length
    ? `<div class="actions">${r.actions.map(a => `<button data-a="${ref(a)}">${escapeHtml(a.label)}</button>`).join('')}</div>` : '';
  const tables = (r.tables ?? []).map((t, ti) => {
    const body = t.rows.length ? t.rows.map((row, i) => {
      const a = ref(t.rowActions?.[i]);
      return `<tr class="${t.rowClass?.[i] ?? ''}${a >= 0 ? ' link' : ''}"${a >= 0 ? ` data-a="${a}" title="${escapeHtml(t.rowActions![i]!.label)}"` : ''}>` +
        row.map(v => `<td>${cell(v)}</td>`).join('') + '</tr>';
    }).join('') : `<tr><td colspan="${t.columns.length}" class="dim">${escapeHtml(t.empty ?? 'Nothing to show.')}</td></tr>`;
    return `<section><h2>${escapeHtml(t.title)} <span class="dim">(${t.rows.length})</span></h2>` +
      (t.filter && t.rows.length > 8 ? `<input class="filter" data-t="${ti}" placeholder="Filter…">` : '') +
      `<table data-t="${ti}"><thead><tr>${t.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></section>`;
  }).join('');
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
</style></head><body>
<h1>${escapeHtml(r.title)}</h1>${r.subtitle ? `<div class="sub">${escapeHtml(r.subtitle)}</div>` : ''}
${buttons}${facts}${tables}${r.note ? `<p class="note">${escapeHtml(r.note)}</p>` : ''}
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-a]');
    if (el && Number(el.dataset.a) >= 0) { vscode.postMessage({ action: el.dataset.a }); }
  });
  document.querySelectorAll('.filter').forEach(inp => inp.addEventListener('input', () => {
    const f = inp.value.toLowerCase();
    document.querySelectorAll('table[data-t="' + inp.dataset.t + '"] tbody tr').forEach(tr => {
      tr.style.display = !f || tr.textContent.toLowerCase().includes(f) ? '' : 'none';
    });
  }));
</script></body></html>`;
}
