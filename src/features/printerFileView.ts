// Printer file (PRTF) preview that follows the source as you type.
import * as vscode from 'vscode';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { layoutPrtf } from '../core/printerFile';
import { escapeHtml, nonce } from './webviewUtil';

function previewPrtf(doc: vscode.TextDocument, panelRef: { p?: vscode.WebviewPanel }): void {
  const { lines, items, records } = layoutPrtf(doc.getText());
  if (!panelRef.p) {
    panelRef.p = vscode.window.createWebviewPanel('vanthrex.prtf', vscode.l10n.t('Print preview'), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
    panelRef.p.onDidDispose(() => { panelRef.p = undefined; });
    panelRef.p.webview.onDidReceiveMessage(m => { if (typeof m?.line === 'number') { void vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(m.line, 0, m.line, 0) }); } });
  }
  const n = nonce();
  const ruler = Array.from({ length: 13 }, (_, i) => String((i + 1) % 10).padStart(10, '.')).join('').slice(0, 132);
  const rows = lines.map((l, i) => `<div><span class="ln">${String(i + 1).padStart(2)}</span>${escapeHtml(l)}</div>`).join('');
  const table = items.map(it => `<tr data-l="${it.srcLine}"><td>${escapeHtml(it.record)}</td><td>${escapeHtml(it.name || '(constant)')}</td><td>${it.line}</td><td>${it.col}</td><td>${escapeHtml(it.text.slice(0, 40))}</td></tr>`).join('');
  panelRef.p.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px 12px}.page{background:#fffef7;color:#222;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:1.3;white-space:pre;padding:10px;overflow:auto;border-radius:4px;box-shadow:0 1px 4px #0004}
.ruler{color:#999}.ln{color:#aaa;margin-right:8px}.dim{color:var(--vscode-descriptionForeground)}table{border-collapse:collapse;margin-top:12px;font-size:12px}th,td{border:1px solid var(--vscode-editorWidget-border,#8883);padding:2px 6px}tr[data-l]{cursor:pointer}tr[data-l]:hover td{background:var(--vscode-list-hoverBackground)}</style></head><body>
<p class="dim">${escapeHtml(vscode.l10n.t('Record formats printed once each, in source order: {0}. SKIPB / SPACEB / SKIPA / SPACEA move the line; numeric fields show 9s.', records.join(', ')))}</p>
<div class="page"><div class="ruler"><span class="ln">  </span>${ruler}</div>${rows}</div>
<table><thead><tr><th>Record</th><th>Field</th><th>Line</th><th>Col</th><th>Sample</th></tr></thead><tbody>${table}</tbody></table>
<script nonce="${n}">const vscode=acquireVsCodeApi();document.addEventListener('click',e=>{const t=e.target.closest('[data-l]');if(t)vscode.postMessage({line:Number(t.dataset.l)});});</script></body></html>`;
  panelRef.p.reveal(vscode.ViewColumn.Beside, true);
}

// ================================================================ registration

export function registerPrinterFile(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const prtf: { p?: vscode.WebviewPanel; doc?: vscode.TextDocument } = {};
  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.previewPrtf', guard(() => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) { throw new Error(vscode.l10n.t('Open a printer file (PRTF) source first.')); }
      prtf.doc = ed.document; previewPrtf(ed.document, prtf);
    })),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (prtf.p && e.document === prtf.doc) { if (timer) { clearTimeout(timer); } timer = setTimeout(() => previewPrtf(e.document, prtf), 400); }
    }),
  );
}
