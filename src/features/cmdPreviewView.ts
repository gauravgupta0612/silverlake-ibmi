// Command definition sources (.cmd): problems underlined as you type (what CRTCMD would reject) and a preview of the
// F4 prompt screen, where values can be tried and the resulting command copied — before compiling anything.
import * as vscode from 'vscode';
import { previewCommand } from '../core/cmdSource';
import { formatClCommand } from '../core/clCommand';
import { ConnectionManager } from '../core/manager';
import { escapeHtml, page } from './ui/kit';

const isCmdSource = (doc: vscode.TextDocument) => doc.languageId === 'cl' && /\.cmd$/i.test(doc.uri.path);
const nameOf = (doc: vscode.TextDocument) => (doc.uri.path.split('/').pop() ?? 'COMMAND').replace(/\.[^.]*$/, '').toUpperCase();
let panel: vscode.WebviewPanel | undefined;
let panelDoc: vscode.Uri | undefined;

function render(doc: vscode.TextDocument): void {
  const p = previewCommand(doc.getText(), nameOf(doc));
  const rows = p.def.parms.map(x => {
    const req = x.min > 0;
    const hint = [x.parts.length > 1 ? x.parts.join(' / ') : '', x.max > 1 ? vscode.l10n.t('up to {0} values', x.max) : '', x.values.length ? x.values.slice(0, 10).join(', ') : ''].filter(Boolean).join(' · ');
    return `<tr><td class="${req ? 'req' : ''}">${escapeHtml(x.prompt)}</td><td class="kw">${escapeHtml(x.kwd)}</td>` +
      `<td><input data-kwd="${escapeHtml(x.kwd)}" value="${escapeHtml(x.dft ?? '')}" placeholder="${escapeHtml(x.type)}${x.len ? ' (' + escapeHtml(x.len) + ')' : ''}"></td><td class="hint">${escapeHtml(hint)}</td></tr>`;
  }).join('');
  const problems = p.problems.map(x => `<li class="${x.severity}"><a href="#" data-line="${x.line}">${vscode.l10n.t('Line {0}', x.line + 1)}</a> ${escapeHtml(x.message)}</li>`).join('');
  const css = `.req{font-weight:600}.req:after{content:' *';color:var(--vscode-errorForeground)}.kw{opacity:.7;font-family:var(--vscode-editor-font-family)}.hint{opacity:.7;font-size:11px}
  td{padding:3px 8px}input{width:100%;min-width:180px}li.error{color:var(--vscode-errorForeground)}li.warning{color:var(--vscode-editorWarning-foreground)}
  #out{font-family:var(--vscode-editor-font-family);white-space:pre-wrap;padding:8px;border:1px solid var(--vscode-panel-border);margin-top:8px}`;
  const body = `<h1>${escapeHtml(p.def.name)} — ${escapeHtml(p.def.prompt || vscode.l10n.t('(no prompt text)'))}</h1>
  <p class="muted">${vscode.l10n.t('Preview of the F4 prompt from the source, before CRTCMD. Type values to see the command it builds.')}</p>
  ${problems ? `<h2>${vscode.l10n.t('Problems')}</h2><ul>${problems}</ul>` : `<p>✔ ${vscode.l10n.t('No problems found.')}</p>`}
  <table>${rows}</table>
  <p><button id="build">${vscode.l10n.t('Show the command')}</button> <button id="copy">${vscode.l10n.t('Copy')}</button></p><div id="out"></div>`;
  const script = `const api=acquireVsCodeApi();
  document.querySelectorAll('[data-line]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();api.postMessage({t:'line',line:Number(a.dataset.line)});}));
  const values=()=>[...document.querySelectorAll('input[data-kwd]')].map(i=>({kwd:i.dataset.kwd,value:i.value}));
  document.getElementById('build').addEventListener('click',()=>api.postMessage({t:'build',values:values()}));
  document.getElementById('copy').addEventListener('click',()=>api.postMessage({t:'copy',values:values()}));
  window.addEventListener('message',e=>{if(e.data.t==='cmd'){document.getElementById('out').textContent=e.data.text;}});`;
  if (!panel) {
    panel = vscode.window.createWebviewPanel('vanthrex.cmdPreview', '', vscode.ViewColumn.Beside, { enableScripts: true });
    panel.onDidDispose(() => { panel = undefined; panelDoc = undefined; });
    panel.webview.onDidReceiveMessage(async (m: { t: string; line?: number; values?: { kwd: string; value: string }[] }) => {
      const d = vscode.workspace.textDocuments.find(x => x.uri.toString() === panelDoc?.toString());
      if (!d) { return; }
      if (m.t === 'line' && typeof m.line === 'number') {
        const ed = await vscode.window.showTextDocument(d, vscode.ViewColumn.One);
        const pos = new vscode.Position(m.line, 0); ed.selection = new vscode.Selection(pos, pos); ed.revealRange(new vscode.Range(pos, pos));
      }
      if ((m.t === 'build' || m.t === 'copy') && m.values) {
        const pv = previewCommand(d.getText(), nameOf(d));
        const vals = m.values.filter(v => v.value.trim() && v.value.trim() !== (pv.def.parms.find(x => x.kwd === v.kwd)?.dft ?? ''));
        const text = formatClCommand(pv.def.name, vals.map(v => ({ kwd: v.kwd, value: v.value.trim() })), 'line');
        void panel?.webview.postMessage({ t: 'cmd', text });
        if (m.t === 'copy') { await vscode.env.clipboard.writeText(text); vscode.window.setStatusBarMessage(vscode.l10n.t('Command copied.'), 3000); }
      }
    });
  }
  panelDoc = doc.uri;
  panel.title = vscode.l10n.t('F4 preview: {0}', p.def.name);
  panel.webview.html = page({ title: p.def.name, css, body, script });
}

export function registerCmdPreview(context: vscode.ExtensionContext, _manager: ConnectionManager): void {
  const diags = vscode.languages.createDiagnosticCollection('Vanthrex command source');
  const timers = new Map<string, NodeJS.Timeout>();
  const check = (doc: vscode.TextDocument) => {
    if (!isCmdSource(doc)) { return; }
    const p = previewCommand(doc.getText(), nameOf(doc));
    diags.set(doc.uri, p.problems.filter(x => x.line < doc.lineCount).map(x => {
      const d = new vscode.Diagnostic(doc.lineAt(x.line).range, x.message, x.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'CRTCMD (Vanthrex)';
      return d;
    }));
    if (panel && panelDoc?.toString() === doc.uri.toString()) { render(doc); }
  };
  context.subscriptions.push(
    diags,
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument(e => {
      const k = e.document.uri.toString();
      clearTimeout(timers.get(k));
      timers.set(k, setTimeout(() => check(e.document), 400));
    }),
    vscode.workspace.onDidCloseTextDocument(d => diags.delete(d.uri)),
    vscode.commands.registerCommand('vanthrex.previewCommandSource', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || !isCmdSource(doc)) { vscode.window.showInformationMessage(vscode.l10n.t('Open a command definition source (.cmd) first.')); return; }
      render(doc);
    }),
  );
  vscode.workspace.textDocuments.forEach(check);
}
