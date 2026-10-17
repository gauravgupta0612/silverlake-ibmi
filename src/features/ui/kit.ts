// Shared look and behaviour for every Vanthrex web page (reports, System Tracker, PDM, dashboards…): one set of
// styles built on the VS Code theme colours, one loader, one busy bar and one paged / filtered / sortable table.
// Pages include UI_CSS and UI_JS, and use the vx-* classes and the VX client helpers.

import * as vscode from 'vscode';
import { escapeHtml, nonce } from '../webviewUtil';

export { escapeHtml, nonce };

/** Styles shared by all pages. Colours come from the VS Code theme, so light, dark and high-contrast themes work. */
export const UI_CSS = `
:root { --vx-gap: 8px; --vx-radius: 4px; --vx-border: var(--vscode-editorWidget-border, #8883); --vx-muted: var(--vscode-descriptionForeground);
  --vx-accent: var(--vscode-progressBar-background, #0e70c0); --vx-skeleton: var(--vscode-editorWidget-background, #8881); }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
.vx-muted, .dim { color: var(--vx-muted); }
.vx-btn { padding: 4px 12px; border: none; border-radius: 3px; cursor: pointer; font: inherit;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.vx-btn:hover { background: var(--vscode-button-hoverBackground); }
.vx-btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.vx-input { padding: 4px 8px; min-width: 220px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; font: inherit; }
.vx-table { border-collapse: collapse; width: 100%; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
.vx-table th, .vx-table td { border: 1px solid var(--vx-border); padding: 3px 8px; text-align: left; vertical-align: top; }
.vx-table th { background: var(--vscode-editorWidget-background); cursor: pointer; user-select: none; position: sticky; top: 0; }
.vx-table th.up::after { content: ' ▲'; } .vx-table th.down::after { content: ' ▼'; }
.vx-table tr.link { cursor: pointer; } .vx-table tr.link:hover td { background: var(--vscode-list-hoverBackground); }
.vx-table tr.bad td { color: var(--vscode-errorForeground); }
.vx-table tr.different td:first-child { border-left: 3px solid var(--vscode-gitDecoration-modifiedResourceForeground, #c93); }
.vx-table tr.onlyA td:first-child { border-left: 3px solid var(--vscode-gitDecoration-addedResourceForeground, #4a4); }
.vx-table tr.onlyB td:first-child { border-left: 3px solid var(--vscode-gitDecoration-deletedResourceForeground, #c44); }
.vx-more { margin-top: 6px; }
/* Busy bar: a thin moving line at the top of the page, like VS Code's own progress. */
.vx-progress { position: fixed; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; z-index: 99; display: none; }
.vx-progress::before { content: ''; position: absolute; height: 100%; width: 30%; background: var(--vx-accent); animation: vx-slide 1.1s ease-in-out infinite; }
body.busy .vx-progress { display: block; }
@keyframes vx-slide { 0% { left: -30%; } 100% { left: 100%; } }
/* Loader: spinner, what is being read, seconds elapsed, and a skeleton of the page to come. */
.vx-loader { padding: 18px 4px; }
.vx-loader .head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.vx-spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--vx-border); border-top-color: var(--vx-accent); animation: vx-spin .8s linear infinite; flex: none; }
@keyframes vx-spin { to { transform: rotate(360deg); } }
.vx-skel { background: var(--vx-skeleton); border-radius: var(--vx-radius); height: 12px; margin: 8px 0; position: relative; overflow: hidden; }
.vx-skel::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--vscode-foreground) 8%, transparent), transparent); animation: vx-shine 1.4s infinite; }
@keyframes vx-shine { to { transform: translateX(100%); } }
.vx-skel.tile { display: inline-block; width: 150px; height: 54px; margin-right: 10px; }
@media (prefers-reduced-motion: reduce) { .vx-spinner, .vx-skel::after, .vx-progress::before { animation: none; } }
`;

/** The loader shown while a page waits for its data. */
export function loaderHtml(text: string, opts: { tiles?: number; rows?: number } = {}): string {
  const tiles = Array.from({ length: opts.tiles ?? 0 }, () => '<span class="vx-skel tile"></span>').join('');
  const rows = Array.from({ length: opts.rows ?? 6 }, (_, i) => `<div class="vx-skel" style="width:${92 - (i % 3) * 14}%"></div>`).join('');
  return `<div class="vx-loader" role="status" aria-live="polite"><div class="head"><span class="vx-spinner"></span>` +
    `<span>${escapeHtml(text)}</span> <span class="vx-muted" data-vx-elapsed></span></div>${tiles ? `<div>${tiles}</div>` : ''}${rows}</div>`;
}

/** Texts used by UI_JS, in the user's language. */
export function uiTexts(): Record<string, string> {
  return { more: vscode.l10n.t('Show {0} more ({1} left)', '%N', '%L'), seconds: vscode.l10n.t('{0} s', '%S') };
}

/**
 * Client helpers (plain browser JavaScript). Exposes VX with:
 * - VX.esc(text), VX.debounce(fn, ms)
 * - VX.busy(on): the busy bar
 * - VX.table(tableEl, moreEl, data, rowHtml): a table drawn a page at a time, with filter(text) and sorting by header click
 * Loaders count the seconds they have been shown on their own.
 */
export function uiScript(): string {
  return `
const VX = (() => {
  const T = ${JSON.stringify(uiTexts()).replace(/</g, '\\u003c')};
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const busy = on => document.body.classList.toggle('busy', !!on);
  const started = Date.now();
  const tick = setInterval(() => {
    const els = document.querySelectorAll('[data-vx-elapsed]');
    if (!els.length) { clearInterval(tick); return; }
    const s = Math.round((Date.now() - started) / 1000);
    els.forEach(el => { el.textContent = s >= 2 ? T.seconds.replace('%S', s) : ''; });
  }, 1000);
  const num = v => typeof v === 'number' ? v : (/^-?[\\d.,]+$/.test(String(v).trim()) ? Number(String(v).replace(/,/g, '')) : NaN);
  function table(tableEl, moreEl, rows, rowHtml, page = 300) {
    const st = { view: rows.map((_, i) => i), shown: 0, sort: -1, dir: 1, text: null };
    const body = tableEl.tBodies[0];
    function more() {
      const next = st.view.slice(st.shown, st.shown + page);
      body.insertAdjacentHTML('beforeend', next.map(i => rowHtml(i)).join(''));
      st.shown += next.length;
      const left = st.view.length - st.shown;
      moreEl.innerHTML = left > 0 ? '<button class="vx-btn secondary">' + esc(T.more.replace('%N', Math.min(left, page)).replace('%L', left)) + '</button>' : '';
    }
    function draw() { body.innerHTML = ''; st.shown = 0; more(); }
    moreEl.addEventListener('click', e => { if (e.target.closest('button')) more(); });
    tableEl.tHead && tableEl.tHead.addEventListener('click', e => {
      const th = e.target.closest('th'); if (!th) return;
      const c = [...th.parentElement.children].indexOf(th);
      st.dir = st.sort === c ? -st.dir : 1; st.sort = c;
      st.view.sort((x, y) => { const a = rows[x][c], b = rows[y][c]; const na = num(a), nb = num(b);
        return st.dir * (!isNaN(na) && !isNaN(nb) ? na - nb : String(a ?? '').localeCompare(String(b ?? ''))); });
      [...th.parentElement.children].forEach(h => h.classList.remove('up', 'down'));
      th.classList.add(st.dir > 0 ? 'up' : 'down');
      draw();
    });
    return {
      draw,
      filter(text) {
        const f = String(text || '').toLowerCase().trim();
        if (!st.text) st.text = rows.map(r => r.join(' ').toLowerCase());
        st.view = rows.map((_, i) => i).filter(i => !f || st.text[i].includes(f));
        st.sort = -1; tableEl.tHead && [...tableEl.tHead.querySelectorAll('th')].forEach(h => h.classList.remove('up', 'down'));
        draw();
      },
    };
  }
  return { esc, debounce, busy, table };
})();
`;
}

/** A complete page with the shared styles and helpers, under a strict content security policy. */
export function page(opts: { title?: string; css?: string; body: string; script?: string; nonce?: string; extraCsp?: string }): string {
  const n = opts.nonce ?? nonce();
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';${opts.extraCsp ?? ''}">
${opts.title ? `<title>${escapeHtml(opts.title)}</title>` : ''}<style>${UI_CSS}${opts.css ?? ''}</style></head><body>
<div class="vx-progress"></div>
${opts.body}
<script nonce="${n}">${uiScript()}${opts.script ?? ''}</script></body></html>`;
}
