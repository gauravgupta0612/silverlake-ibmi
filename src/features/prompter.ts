import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, log, logError } from '../core/log';
import { isValidSystemName } from '../core/util';
import { ClCommandDef, currentValues, decodeIbmText, formatClCommand, joinClLines, parseClCommand, parseCommandXml, qlgPathHex } from '../core/clCommand';
import { LAYOUTS, SpecLayout, buildSpec, layoutFor, splitSpec } from '../rpg/specLayout';
import { escapeHtml, nonce } from './webviewUtil';

interface FormField {
  id: string;
  label: string;
  sub?: string;
  hint?: string;
  value: string;
  values?: string[];
  maxLength?: number;
  required?: boolean;
  wide?: boolean;
}

type FormResult = { values: Record<string, string>; next?: boolean } | undefined;

/** A small reusable form (webview) used by the F4 prompters. Resolves with the values, or undefined on cancel. */
function showForm(title: string, subtitle: string, fields: FormField[], options: { nextButton?: boolean } = {}): Promise<FormResult> {
  const panel = vscode.window.createWebviewPanel('vanthrex.prompter', title,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true });
  const n = nonce();
  const rows = fields.map((f, i) => `
    <div class="row">
      <label for="f${i}">${escapeHtml(f.label)}${f.required ? ' <span class="req">*</span>' : ''}<small>${escapeHtml(f.sub ?? '')}</small></label>
      <div>
        <input id="f${i}" data-id="${escapeHtml(f.id)}" value="${escapeHtml(f.value)}" ${f.maxLength ? `maxlength="${f.maxLength}"` : ''}
          ${f.values?.length ? `list="l${i}"` : ''} spellcheck="false" class="${f.wide ? 'wide' : ''}"
          style="${f.maxLength && f.maxLength <= 15 && !f.wide ? `width:${Math.max(4, f.maxLength + 3)}ch` : ''}">
        ${f.values?.length ? `<datalist id="l${i}">${f.values.map(v => `<option value="${escapeHtml(v)}">`).join('')}</datalist>` : ''}
        ${f.hint ? `<div class="hint">${escapeHtml(f.hint)}</div>` : ''}
      </div>
    </div>`).join('');
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px 18px 24px; }
  h1 { font-size: 1.15em; margin: 4px 0 2px; } .sub { color: var(--vscode-descriptionForeground); margin: 0 0 14px; font-size: .9em; }
  .row { display: grid; grid-template-columns: minmax(150px, 34%) 1fr; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--vscode-widget-border, #8882); align-items: start; }
  label { padding-top: 5px; } label small { display: block; color: var(--vscode-descriptionForeground); font-size: .8em; }
  .req { color: var(--vscode-errorForeground); }
  input { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); padding: 4px 6px; box-sizing: border-box;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; width: 100%; }
  input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .hint { color: var(--vscode-descriptionForeground); font-size: .82em; margin-top: 3px; }
  .bar { position: sticky; bottom: 0; background: var(--vscode-editor-background); display: flex; gap: 8px; padding: 12px 0 4px; margin-top: 8px; }
  button { padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; font: inherit; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .keys { color: var(--vscode-descriptionForeground); font-size: .85em; align-self: center; margin-left: auto; }
</style></head><body>
<h1>${escapeHtml(title)}</h1><p class="sub">${escapeHtml(subtitle)}</p>
<form id="form">${rows}
<div class="bar"><button class="primary" type="submit">Apply</button>
${options.nextButton ? '<button type="button" id="next">Apply &amp; next line</button>' : ''}
<button type="button" id="cancel">Cancel</button><span class="keys">Enter = apply · Esc = cancel</span></div></form>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const collect = () => { const v = {}; document.querySelectorAll('input[data-id]').forEach(i => v[i.dataset.id] = i.value); return v; };
  document.getElementById('form').addEventListener('submit', e => { e.preventDefault(); vscode.postMessage({ type: 'apply', values: collect() }); });
  document.getElementById('next')?.addEventListener('click', () => vscode.postMessage({ type: 'apply', values: collect(), next: true }));
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') vscode.postMessage({ type: 'cancel' }); });
  const first = document.querySelector('input[data-id]'); if (first) { first.focus(); first.select(); }
</script></body></html>`;
  return new Promise(resolve => {
    let done = false;
    panel.webview.onDidReceiveMessage(m => {
      done = true;
      resolve(m.type === 'apply' ? { values: m.values, next: m.next } : undefined);
      panel.dispose();
    });
    panel.onDidDispose(() => { if (!done) { resolve(undefined); } });
  });
}

// ------------------------------------------------------------------ F4 for fixed-format RPG / DDS

async function promptSpec(editor: vscode.TextEditor): Promise<void> {
  const doc = editor.document;
  const language = doc.languageId === 'dds' ? 'dds' : 'rpgle';
  let lineNo = editor.selection.active.line;
  for (;;) {
    const text = doc.lineAt(lineNo).text;
    if (language === 'rpgle' && /^\s*\*\*free/i.test(doc.lineAt(0).text)) {
      vscode.window.showInformationMessage('This source is **FREE — the F4 prompter works on fixed-format specs.');
      return;
    }
    let layout: SpecLayout | undefined = text.trim() ? layoutFor(text, language) : undefined;
    if (!layout && text.trim()) {
      vscode.window.showInformationMessage('This line is not a fixed-format spec (free-format code or a comment).');
      return;
    }
    if (!layout) {
      const options = language === 'dds' ? ['A'] : ['C', 'CX', 'D', 'F', 'H', 'P'];
      const pick = await vscode.window.showQuickPick(options.map(k => ({ label: LAYOUTS[k].title, k })), { title: 'Create which spec on this blank line?' });
      if (!pick) { return; }
      layout = LAYOUTS[pick.k];
    }
    const values = splitSpec(text, layout);
    const result = await showForm(`Prompt: ${layout.title}`, `Line ${lineNo + 1} of ${doc.fileName.split(/[\\/]/).pop()}`,
      layout.fields.map(f => ({
        id: f.id, label: f.label, sub: `columns ${f.from}${f.to > f.from ? `-${f.to}` : ''}`, hint: f.hint,
        value: values[f.id] ?? '', values: f.values?.filter(Boolean), maxLength: f.to - f.from + 1, wide: f.to - f.from > 20,
      })), { nextButton: true });
    if (!result) { return; }
    let newLine: string;
    try { newLine = buildSpec(result.values, layout, text); }
    catch (e) { vscode.window.showErrorMessage(errorMessage(e)); return; }
    const target = await vscode.window.showTextDocument(doc, editor.viewColumn);
    await target.edit(e => e.replace(doc.lineAt(lineNo).range, newLine));
    if (!result.next) { return; }
    if (lineNo + 1 >= doc.lineCount) { await target.edit(e => e.insert(doc.lineAt(lineNo).range.end, '\n')); }
    lineNo++;
    const pos = new vscode.Position(lineNo, 0);
    target.selection = new vscode.Selection(pos, pos);
    editor = target;
  }
}

// ------------------------------------------------------------------ F4 for CL commands

const definitions = new Map<string, ClCommandDef>();

async function commandDefinition(manager: ConnectionManager, command: string): Promise<ClCommandDef> {
  const [lib, name] = command.includes('/') ? command.split('/') : ['*LIBL', command];
  if (!isValidSystemName(name) || (lib !== '*LIBL' && !isValidSystemName(lib))) { throw new Error(`"${command}" is not a valid command name.`); }
  const key = `${lib}/${name}`.toUpperCase();
  const cached = definitions.get(key);
  if (cached) { return cached; }
  const conn = manager.require();
  const path = conn.tempPath('.xml');
  const qualified = `${name.toUpperCase().padEnd(10)}${lib.toUpperCase().padEnd(10)}`;
  try {
    const r = await conn.runCL(`CALL PGM(QCDRCMDD) PARM('${qualified}' X'${qlgPathHex(path)}' 'DEST0200' ' ' 'CDML0100' X'00000000')`);
    if (!r.ok) { throw new Error(`Could not read the definition of ${name}: ${(r.stderr || r.stdout).trim()}`); }
    const xml = decodeIbmText(await conn.readStreamFile(path));
    const def = parseCommandXml(xml);
    if (!def.parms.length && !def.name) { throw new Error(`${name} returned an empty definition.`); }
    definitions.set(key, def);
    return def;
  } finally {
    conn.exec(`rm -f '${path}'`).catch(() => undefined);
  }
}

function fieldsFor(def: ClCommandDef, values: Record<string, string>): FormField[] {
  return def.parms.map(p => ({
    id: p.kwd,
    label: p.prompt,
    sub: p.kwd,
    required: p.min > 0,
    value: values[p.kwd] ?? '',
    values: p.values,
    wide: true,
    hint: [
      p.parts.length > 1 ? `${p.parts.join(' / ')}${p.type === 'QUAL' ? ' (e.g. LIB/NAME)' : ''}` : '',
      p.max > 1 ? `up to ${p.max} values, separated by blanks` : '',
      p.dft ? `default ${p.dft}` : '',
    ].filter(Boolean).join(' · '),
  }));
}

/** Prompt the CL command at the cursor (CL sources) and rewrite it in source layout. */
async function promptClInEditor(manager: ConnectionManager, editor: vscode.TextEditor): Promise<void> {
  const doc = editor.document;
  let start = editor.selection.active.line;
  while (start > 0 && /[+-]\s*$/.test(doc.lineAt(start - 1).text.replace(/\/\*.*?\*\/\s*$/, ''))) { start--; }
  let end = start;
  while (end < doc.lineCount - 1 && /[+-]\s*$/.test(doc.lineAt(end).text.replace(/\/\*.*?\*\/\s*$/, ''))) { end++; }
  const lines: string[] = [];
  for (let i = start; i <= end; i++) { lines.push(doc.lineAt(i).text); }
  const parsed = parseClCommand(joinClLines(lines));
  let command = parsed.command;
  if (!command) {
    command = (await vscode.window.showInputBox({ title: 'Prompt which command?', placeHolder: 'e.g. SNDPGMMSG' }))?.trim().toUpperCase() ?? '';
    if (!command) { return; }
  }
  const def = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Reading ${command} definition…` },
    () => commandDefinition(manager, command));
  const result = await showForm(`${def.name || command} — ${def.prompt}`, `Fill in the parameters. Leave a field empty to use its default.`,
    fieldsFor(def, currentValues(parsed, def)));
  if (!result) { return; }
  const ordered = def.parms.map(p => ({ kwd: p.kwd, value: result.values[p.kwd] ?? '' }));
  const text = formatClCommand(command, ordered, 'source', parsed.label);
  const target = await vscode.window.showTextDocument(doc, editor.viewColumn);
  await target.edit(e => e.replace(new vscode.Range(start, 0, end, doc.lineAt(end).text.length), text));
}

/** Prompt a command, then run it (like F4 on a 5250 command line). */
async function promptAndRun(manager: ConnectionManager, preset?: string): Promise<void> {
  const input = preset ?? await vscode.window.showInputBox({ title: 'Prompt and run a CL command', placeHolder: 'Command name, e.g. CRTSRCPF or SNDMSG', ignoreFocusOut: true });
  if (!input?.trim()) { return; }
  const parsed = parseClCommand(input.trim());
  const def = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Reading ${parsed.command} definition…` },
    () => commandDefinition(manager, parsed.command));
  const result = await showForm(`${def.name || parsed.command} — ${def.prompt}`, 'Fill in the parameters, then Apply to run the command.',
    fieldsFor(def, currentValues(parsed, def)));
  if (!result) { return; }
  const cmd = formatClCommand(parsed.command, def.parms.map(p => ({ kwd: p.kwd, value: result.values[p.kwd] ?? '' })), 'line');
  log(`Prompted command: ${cmd}`);
  await vscode.commands.executeCommand('vanthrex.runCl', cmd);
}

export function registerPrompters(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.prompt', guard(async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }
      if (editor.document.languageId === 'cl') { return promptClInEditor(manager, editor); }
      if (editor.document.languageId === 'rpgle' || editor.document.languageId === 'dds') { return promptSpec(editor); }
      vscode.window.showInformationMessage('F4 prompting works in RPG (fixed format), DDS and CL sources.');
    })),
    vscode.commands.registerCommand('vanthrex.promptCl', guard((preset?: string) => promptAndRun(manager, typeof preset === 'string' ? preset : undefined))),
    manager.onDidChange(() => definitions.clear()),
  );
}
