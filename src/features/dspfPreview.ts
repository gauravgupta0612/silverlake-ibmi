import * as vscode from 'vscode';
import { errorMessage, logError } from '../core/log';
import { layoutScreen, parseDspf } from '../core/dspf';
import { escapeHtml, nonce } from './webviewUtil';

const COLORS: Record<string, string> = { GRN: '#3ad65c', WHT: '#f2f2f2', RED: '#ff5555', BLU: '#62a8ff', YLW: '#ffd84d', PNK: '#ff7ad1', TRQ: '#3fd9d0' };

class Preview {
  private panel: vscode.WebviewPanel | undefined;
  private doc: vscode.TextDocument | undefined;
  private record = '';
  private timer: NodeJS.Timeout | undefined;

  show(doc: vscode.TextDocument): void {
    this.doc = doc;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('vanthrex.dspf', vscode.l10n.t('Screen preview'), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
      this.panel.onDidDispose(() => { this.panel = undefined; });
      this.panel.webview.onDidReceiveMessage(m => {
        if (m?.type === 'record') { this.record = String(m.record); this.render(); }
        if (m?.type === 'goto' && this.doc && typeof m.line === 'number') {
          void vscode.window.showTextDocument(this.doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(m.line, 0, m.line, 0) });
        }
      });
    }
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.render();
  }

  onChange(doc: vscode.TextDocument): void {
    if (!this.panel || doc !== this.doc) { return; }
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => this.render(), 300);
  }

  onCursor(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.panel || e.textEditor.document !== this.doc) { return; }
    const line = e.selections[0].active.line;
    const d = parseDspf(this.doc.getText());
    const rec = [...d.records].reverse().find(r => r.srcLine <= line);
    if (rec && rec.name !== this.record) { this.record = rec.name; this.render(); }
  }

  private render(): void {
    if (!this.panel || !this.doc) { return; }
    const d = parseDspf(this.doc.getText());
    if (!d.records.length) { this.panel.webview.html = `<body style="font-family:var(--vscode-font-family);padding:16px">${escapeHtml(vscode.l10n.t('No record formats found. This preview is for display files (DSPF) in DDS.'))}</body>`; return; }
    if (!d.records.some(r => r.name === this.record)) { this.record = (d.records.find(r => !r.sfl) ?? d.records[0]).name; }
    const { grid, notes } = layoutScreen(d, this.record);
    const rec = d.records.find(r => r.name === this.record)!;
    const cells = grid.map((row, y) => `<div class="row"><span class="ln">${String(y + 1).padStart(2, ' ')}</span>` + row.map(c => {
      if (!c) { return ' '; }
      const cls = [c.input ? 'in' : '', ...(c.attrs ?? []).map(a => a.toLowerCase())].filter(Boolean).join(' ');
      const color = COLORS[c.color ?? 'GRN'] ?? COLORS.GRN;
      return `<span class="${cls}" style="color:${color}"${c.srcLine !== undefined ? ` data-l="${c.srcLine}"` : ''}${c.field ? ` title="${escapeHtml(c.field)}"` : ''}>${escapeHtml(c.ch)}</span>`;
    }).join('') + '</div>').join('');
    const n = nonce();
    const opts = d.records.map(r => `<option value="${escapeHtml(r.name)}"${r.name === this.record ? ' selected' : ''}>${escapeHtml(r.name)}${r.sfl ? ' (SFL)' : r.sflctl ? ' (SFLCTL)' : r.window ? ' (window)' : ''}</option>`).join('');
    const fields = rec.fields.filter(f => f.kind === 'field').map(f => `<tr data-l="${f.srcLine}"><td>${escapeHtml(f.name)}</td><td>${f.usage}</td><td>${f.length}${f.decimals !== undefined ? ',' + f.decimals : ''} ${escapeHtml(f.type)}</td><td>${f.line || ''}/${f.col || ''}</td><td>${escapeHtml(f.indicators ?? '')}</td><td>${escapeHtml(f.keywords)}</td></tr>`).join('');
    this.panel.title = vscode.l10n.t('Screen: {0}', this.record);
    this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
 body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 12px; }
 .bar { display:flex; gap:10px; align-items:center; margin-bottom:8px; flex-wrap: wrap; } select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 2px 6px; }
 .screen { background:#000; padding:8px 10px; border-radius:6px; display:inline-block; font-family: 'IBM Plex Mono', Consolas, 'Courier New', monospace; font-size: 13px; line-height: 1.25; white-space: pre; overflow:auto; max-width: 100%; }
 .ln { color:#555; margin-right:8px; user-select:none; }
 .in { text-decoration: underline; } .ul { text-decoration: underline; } .hi { font-weight: 700; filter: brightness(1.3); } .ri { background: currentColor; } .ri { color: #000 !important; background: #3ad65c; }
 .bl { animation: blink 1s steps(2) infinite; } @keyframes blink { 50% { opacity: .2; } }
 [data-l] { cursor: pointer; } [data-l]:hover { outline: 1px solid #fff6; }
 .dim { color: var(--vscode-descriptionForeground); } table { border-collapse: collapse; margin-top: 14px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
 th, td { border: 1px solid var(--vscode-editorWidget-border, #8883); padding: 2px 6px; text-align: left; } tr[data-l]:hover td { background: var(--vscode-list-hoverBackground); }
</style></head><body>
<div class="bar"><label>${escapeHtml(vscode.l10n.t('Record format'))} <select id="rec">${opts}</select></label><span class="dim">${d.rows}×${d.cols}${rec.overlay ? ' · OVERLAY' : ''} · ${escapeHtml(vscode.l10n.t('click a field to go to its source line'))}</span></div>
<div class="screen">${cells}</div>
${notes.length || d.errors.length ? `<p class="dim">${[...notes, ...d.errors].map(escapeHtml).join('<br>')}</p>` : ''}
<table><thead><tr><th>${escapeHtml(vscode.l10n.t('Field'))}</th><th>${escapeHtml(vscode.l10n.t('Use'))}</th><th>${escapeHtml(vscode.l10n.t('Length'))}</th><th>${escapeHtml(vscode.l10n.t('Line/col'))}</th><th>${escapeHtml(vscode.l10n.t('Indicators'))}</th><th>${escapeHtml(vscode.l10n.t('Keywords'))}</th></tr></thead><tbody>${fields}</tbody></table>
<p class="dim">${escapeHtml(vscode.l10n.t('Input fields are underlined, output fields show X or 9. Conditioned fields and keywords are all shown, as if every indicator were on. Reference fields (REFFLD) without a length are shown with length 10.'))}</p>
<script nonce="${n}">
 const vscode = acquireVsCodeApi();
 document.getElementById('rec').onchange = e => vscode.postMessage({ type: 'record', record: e.target.value });
 document.addEventListener('click', e => { const t = e.target.closest('[data-l]'); if (t) vscode.postMessage({ type: 'goto', line: Number(t.dataset.l) }); });
</script></body></html>`;
  }
}

export function registerDspfPreview(context: vscode.ExtensionContext): void {
  const p = new Preview();
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.previewDspf', () => {
      try {
        const ed = vscode.window.activeTextEditor;
        if (!ed) { throw new Error(vscode.l10n.t('Open a display file (DSPF) source first.')); }
        p.show(ed.document);
      } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
    }),
    vscode.workspace.onDidChangeTextDocument(e => p.onChange(e.document)),
    vscode.window.onDidChangeTextEditorSelection(e => p.onCursor(e)),
  );
}
