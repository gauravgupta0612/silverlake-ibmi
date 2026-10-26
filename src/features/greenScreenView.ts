// Green-screen tools: open a real 5250 session for the active system, and a 5250-style command line that runs any
// command with its full messages, shows printed output, and opens the matching Vanthrex screen for interactive commands.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { sqlString } from '../core/util';
import { Client5250, CmdMessage, commandMessages, interactiveEquivalent, launchPlan, needsDisplay, withPrintOutput, worstSeverity } from '../core/greenScreen';
import { promptCommandText } from './prompter';
import { escapeHtml, page } from './ui/kit';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const CL_HISTORY_KEY = 'vanthrex.clHistory';

// ================================================================ 5250 session

function onPath(exe: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return dirs.some(d => exts.some(e => { try { return fs.statSync(path.join(d, exe + e)).isFile(); } catch { return false; } }));
}

async function open5250(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const cfg = vscode.workspace.getConfiguration('vanthrex');
  const plan = launchPlan({
    client: cfg.get<Client5250>('5250.client', 'auto'), host: conn.profile.host, user: conn.user,
    device: cfg.get<string>('5250.deviceName', '').trim() || undefined, ssl: cfg.get<boolean>('5250.ssl', false),
    port: cfg.get<number>('5250.port', 0) || undefined, acsPath: cfg.get<string>('5250.acsPath', ''), command: cfg.get<string>('5250.command', ''),
    platform: process.platform, home: os.homedir(), exists: p => fs.existsSync(p), onPath,
  });
  if ('error' in plan) {
    const settings = vscode.l10n.t('Settings'); const acs = vscode.l10n.t('Get ACS');
    const c = await vscode.window.showErrorMessage(plan.error, settings, acs);
    if (c === settings) { await vscode.commands.executeCommand('workbench.action.openSettings', 'vanthrex.5250'); }
    if (c === acs) { await vscode.env.openExternal(vscode.Uri.parse('https://www.ibm.com/support/pages/ibm-i-access-client-solutions')); }
    return;
  }
  log(`5250 session: ${plan.command} ${plan.args.join(' ')}`);
  if (plan.kind === 'terminal') {
    const t = vscode.window.createTerminal({ name: `5250 · ${conn.profile.name}`, shellPath: plan.command, shellArgs: plan.args });
    t.show();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', e => reject(new Error(vscode.l10n.t('{0} could not be started: {1}', plan.label, errorMessage(e)))));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  vscode.window.setStatusBarMessage(vscode.l10n.t('$(terminal) Opening a 5250 session on {0} with {1}…', conn.profile.name, plan.label), 6000);
}

// ================================================================ command line

export interface RunResult { ok: boolean; messages: CmdMessage[]; spool?: { name: string; text: string }; opened?: string; error?: string; ran?: string; display?: boolean }

async function runOnSqlJob(conn: IbmiConnection, cmd: string, printed: boolean): Promise<RunResult> {
  const mark = (await conn.rows<Row>(`SELECT COALESCE((SELECT MAX(ORDINAL_POSITION) FROM TABLE(QSYS2.JOBLOG_INFO('*')) X), 0) AS N, ` +
    `VARCHAR(CURRENT TIMESTAMP) AS TS, QSYS2.JOB_NAME AS J FROM SYSIBM.SYSDUMMY1`, 1))[0];
  const from = Number(mark?.N ?? 0); const job = s(mark, 'J');
  let error: string | undefined;
  try { await conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(cmd)})`, 1); } catch (e) { error = errorMessage(e).split('\n')[0]; }
  const msgs = commandMessages((await conn.rows<Row>(`SELECT COALESCE(MESSAGE_ID, '') AS ID, COALESCE(MESSAGE_TYPE, '') AS T, COALESCE(SEVERITY, 0) AS SEV, ` +
    `COALESCE(MESSAGE_TEXT, '') AS X, COALESCE(MESSAGE_SECOND_LEVEL_TEXT, '') AS H FROM TABLE(QSYS2.JOBLOG_INFO('*')) X WHERE ORDINAL_POSITION > ${from} ORDER BY ORDINAL_POSITION`, 200)
    .catch(() => [] as Row[])).map(r => ({ id: s(r, 'ID'), type: s(r, 'T'), severity: Number(r.SEV ?? 0), text: s(r, 'X'), help: s(r, 'H') })));
  const ok = !error && worstSeverity(msgs.filter(m => /ESCAPE/i.test(m.type))) < 30;
  let spool: RunResult['spool'];
  if (ok && job) {
    const sp = (await conn.rows<Row>(`SELECT SPOOLED_FILE_NAME AS F, FILE_NUMBER AS N FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE JOB_NAME = ${sqlString(job)} ` +
      `AND CREATE_TIMESTAMP >= TIMESTAMP(${sqlString(s(mark, 'TS'))}) ORDER BY CREATE_TIMESTAMP DESC, FILE_NUMBER DESC FETCH FIRST 1 ROW ONLY`, 1).catch(() => [] as Row[]))[0];
    if (sp) {
      const name = s(sp, 'F'); const n = Number(sp.N);
      const lines = await conn.rows<Row>(`SELECT SPOOLED_DATA AS D FROM TABLE(SYSTOOLS.SPOOLED_FILE_DATA(JOB_NAME => ${sqlString(job)}, SPOOLED_FILE_NAME => ${sqlString(name)}, ` +
        `SPOOLED_FILE_NUMBER => ${n})) ORDER BY ORDINAL_POSITION`, 20000).catch(() => [] as Row[]);
      spool = { name, text: lines.map(r => String(r.D ?? '').replace(/\s+$/, '')).join('\n') };
      // Output printed only to be shown here is removed again, so it does not pile up in the output queue.
      if (printed && (conn.profile.protection ?? 'none') === 'none') {
        await conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(`DLTSPLF FILE(${name}) JOB(${job}) SPLNBR(${n})`)})`, 1).catch(() => undefined);
      }
    }
  }
  // The job log already says why a command failed; the SQL error around it is only shown when there is nothing else.
  return { ok, messages: msgs, spool, error: ok ? undefined : msgs.find(m => /ESCAPE/i.test(m.type))?.text ?? error, ran: cmd };
}

export async function runCommand(manager: ConnectionManager, text: string): Promise<RunResult> {
  const conn = manager.require();
  const eq = interactiveEquivalent(text, conn.user);
  if (eq) { await vscode.commands.executeCommand(eq.command, ...eq.args); return { ok: true, messages: [], opened: eq.screen }; }
  if (needsDisplay(text)) { return { ok: false, messages: [], display: true, error: vscode.l10n.t('This command needs a 5250 display.') }; }
  const { text: cmd, added } = withPrintOutput(text);
  if (conn.sqlKeepsJob) { return runOnSqlJob(conn, cmd, added); }
  const r = await conn.runCL(cmd);
  const lines = `${r.stdout}\n${r.stderr}`.split('\n').map(l => l.trim()).filter(Boolean);
  return { ok: r.ok, messages: lines.map(l => ({ id: /\b([A-Z]{3}[0-9A-F]{4})\b/.exec(l)?.[1] ?? '', type: r.ok ? 'COMPLETION' : 'ESCAPE', severity: r.ok ? 0 : 40, text: l })), ran: cmd };
}

class CommandLine {
  static current?: CommandLine;
  private readonly panel: vscode.WebviewPanel;
  private busy = false;

  static open(manager: ConnectionManager, state: vscode.Memento, preset?: string): void {
    if (!CommandLine.current) { CommandLine.current = new CommandLine(manager, state); }
    CommandLine.current.panel.reveal();
    if (preset) { void CommandLine.current.post({ t: 'set', text: preset }); }
  }

  private constructor(private readonly manager: ConnectionManager, private readonly state: vscode.Memento) {
    const conn = manager.require();
    this.panel = vscode.window.createWebviewPanel('vanthrex.cmdline', vscode.l10n.t('Command line — {0}', conn.profile.name), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = this.html(conn);
    this.panel.onDidDispose(() => { CommandLine.current = undefined; });
    this.panel.webview.onDidReceiveMessage(m => { void this.onMessage(m).catch(e => { logError(e); this.post({ t: 'note', text: errorMessage(e) }); }); });
  }

  post(m: unknown): Thenable<boolean> { return this.panel.webview.postMessage(m); }

  key(key: string): void { void this.post({ t: 'key', key }); }

  private history(): string[] { return this.state.get<string[]>(CL_HISTORY_KEY, []); }

  private async onMessage(m: { t: string; text?: string; id?: string; body?: string }): Promise<void> {
    if (m.t === 'ready') { await this.post({ t: 'history', items: this.history() }); return; }
    if (m.t === 'prompt') {
      const text = (m.text ?? '').trim() || (await vscode.window.showInputBox({ title: vscode.l10n.t('Prompt which command?'), placeHolder: 'CRTSRCPF' }))?.trim();
      if (!text) { return; }
      const full = await promptCommandText(this.manager, text);
      if (full) { await this.post({ t: 'set', text: full, run: true }); }
      return;
    }
    if (m.t === 'help' && m.id) { await vscode.commands.executeCommand('vanthrex.explainMessage', m.id); return; }
    if (m.t === 'open5250') { await open5250(this.manager); return; }
    if (m.t === 'show' && m.body !== undefined) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: m.body, language: 'plaintext' }), { preview: false }); return; }
    if (m.t !== 'run' || !m.text?.trim()) { return; }
    if (this.busy) { await this.post({ t: 'note', text: vscode.l10n.t('Still running the previous command…') }); return; }
    const text = m.text.trim();
    this.busy = true;
    await this.post({ t: 'start', cmd: text });
    try {
      const r = await runCommand(this.manager, text);
      await this.state.update(CL_HISTORY_KEY, [text, ...this.history().filter(h => h !== text)].slice(0, 100));
      await this.post({ t: 'result', cmd: text, ...r, history: this.history() });
    } catch (e) {
      await this.post({ t: 'result', cmd: text, ok: false, messages: [], error: errorMessage(e).split('\n')[0] });
    } finally { this.busy = false; }
  }

  private html(conn: IbmiConnection): string {
    const L = {
      title: vscode.l10n.t('Command line'), hint: vscode.l10n.t('Type a command and press Enter. F4 prompt · F9 or ↑ retrieve · F12 clear · click a message ID for help.'),
      run: vscode.l10n.t('Run'), prompt: vscode.l10n.t('F4 Prompt'), retrieve: vscode.l10n.t('F9 Retrieve'), clear: vscode.l10n.t('F12 Clear'),
      open5250: vscode.l10n.t('Open 5250 session'), opened: vscode.l10n.t('Opened: {0}', '%S'), running: vscode.l10n.t('Running…'),
      ok: vscode.l10n.t('Command ended normally.'), printed: vscode.l10n.t('Printed output ({0})', '%S'), showAll: vscode.l10n.t('Open in an editor'),
      display: vscode.l10n.t('This command needs a 5250 display — open a 5250 session for it.'), ran: vscode.l10n.t('Ran as {0}', '%S'),
    };
    const css = `
      body { margin: 0; padding: 0 14px; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
      header { display: flex; align-items: baseline; gap: 12px; padding: 10px 0 6px; border-bottom: 1px solid var(--vx-border); }
      header h1 { font-size: 1.15em; margin: 0; flex: 1; }
      #log { flex: 1; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); padding: 8px 0; }
      .cmd { margin-top: 10px; color: var(--vscode-textLink-foreground); }
      .msg { padding-left: 14px; white-space: pre-wrap; } .msg a { cursor: pointer; text-decoration: underline; margin-right: 6px; }
      .sev40 { color: var(--vscode-errorForeground); } .sev20, .sev30 { color: var(--vscode-editorWarning-foreground); } .ok { color: var(--vscode-testing-iconPassed, #3a3); }
      pre.out { margin: 6px 0 0 14px; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 4px; max-height: 50vh; overflow: auto; }
      footer { border-top: 1px solid var(--vx-border); padding: 8px 0 12px; }
      .line { display: flex; gap: 8px; align-items: center; font-family: var(--vscode-editor-font-family); }
      .line input { flex: 1; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
      .keys { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }`;
    const body = `<header><h1>${escapeHtml(L.title)} <span class="vx-muted">${escapeHtml(conn.profile.name)} · ${escapeHtml(conn.user)}${conn.profile.currentLibrary ? ` · ${escapeHtml(conn.profile.currentLibrary)}` : ''}</span></h1>
<button class="vx-btn secondary" id="s5250">${escapeHtml(L.open5250)}</button></header>
<div id="log"><div class="vx-muted">${escapeHtml(L.hint)}</div></div>
<footer><div class="line"><span>===&gt;</span><input id="in" class="vx-input" spellcheck="false" autocomplete="off" autofocus><button class="vx-btn" id="run">${escapeHtml(L.run)}</button></div>
<div class="keys"><button class="vx-btn secondary" data-k="F4">${escapeHtml(L.prompt)}</button><button class="vx-btn secondary" data-k="F9">${escapeHtml(L.retrieve)}</button><button class="vx-btn secondary" data-k="F12">${escapeHtml(L.clear)}</button></div></footer>`;
    const script = `
const vscode = acquireVsCodeApi();
const L = ${JSON.stringify(L).replace(/</g, '\\u003c')};
const $ = id => document.getElementById(id);
let hist = []; let hi = -1; let last = null;
const log = $('log'), inp = $('in');
function add(html) { log.insertAdjacentHTML('beforeend', html); log.scrollTop = log.scrollHeight; }
function run() { const t = inp.value.trim(); if (!t) return; vscode.postMessage({ t: 'run', text: t }); inp.value = ''; hi = -1; }
function key(k) {
  if (k === 'F4') vscode.postMessage({ t: 'prompt', text: inp.value });
  else if (k === 'F9') { if (hist.length) { hi = Math.min(hi + 1, hist.length - 1); inp.value = hist[hi]; } }
  else if (k === 'F12') { inp.value = ''; hi = -1; }
  inp.focus();
}
inp.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); run(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); key('F9'); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.max(hi - 1, -1); inp.value = hi >= 0 ? hist[hi] : ''; }
  else if (e.key === 'Escape') { key('F12'); }
  else if (/^F(4|9|12)$/.test(e.key)) { e.preventDefault(); key(e.key); }
});
document.addEventListener('click', e => {
  const t = e.target;
  if (t.id === 'run') run();
  else if (t.id === 's5250' || t.dataset.open5250 !== undefined) vscode.postMessage({ t: 'open5250' });
  else if (t.dataset.k) key(t.dataset.k);
  else if (t.dataset.help) vscode.postMessage({ t: 'help', id: t.dataset.help });
  else if (t.dataset.show !== undefined && last && last.spool) vscode.postMessage({ t: 'show', body: last.spool.text });
});
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.t === 'history') hist = m.items || [];
  else if (m.t === 'key') key(m.key);
  else if (m.t === 'set') { inp.value = m.text; inp.focus(); if (m.run) run(); }
  else if (m.t === 'note') add('<div class="msg sev30">' + VX.esc(m.text) + '</div>');
  else if (m.t === 'start') { VX.busy(true); add('<div class="cmd">&gt; ' + VX.esc(m.cmd) + ' <span class="vx-muted" id="running">' + VX.esc(L.running) + '</span></div>'); }
  else if (m.t === 'result') {
    VX.busy(false); last = m; const r = $('running'); if (r) r.remove(); if (m.history) hist = m.history;
    let h = '';
    if (m.ran && m.ran !== m.cmd) h += '<div class="msg vx-muted">' + VX.esc(L.ran.replace('%S', m.ran)) + '</div>';
    if (m.opened) h += '<div class="msg ok">' + VX.esc(L.opened.replace('%S', m.opened)) + '</div>';
    (m.messages || []).forEach(x => { h += '<div class="msg sev' + (x.severity >= 40 ? 40 : x.severity >= 30 ? 30 : x.severity >= 20 ? 20 : 0) + '" title="' + VX.esc(x.help || '') + '">' + (x.id ? '<a data-help="' + VX.esc(x.id) + '">' + VX.esc(x.id) + '</a>' : '') + VX.esc(x.text) + '</div>'; });
    if (m.display) h += '<div class="msg sev30">' + VX.esc(L.display) + ' <button class="vx-btn secondary" data-open5250>' + VX.esc(L.open5250) + '</button></div>';
    else if (!m.ok && m.error && !(m.messages || []).some(x => x.text === m.error)) h += '<div class="msg sev40">' + VX.esc(m.error) + '</div>';
    if (m.ok && !m.opened && !(m.messages || []).length && !m.spool) h += '<div class="msg ok">' + VX.esc(L.ok) + '</div>';
    if (m.spool) { const lines = m.spool.text.split('\\n'); h += '<div class="msg vx-muted">' + VX.esc(L.printed.replace('%S', m.spool.name)) + ' <button class="vx-btn secondary" data-show>' + VX.esc(L.showAll) + '</button></div><pre class="out">' + VX.esc(lines.slice(0, 3000).join('\\n')) + '</pre>'; }
    add(h); inp.focus();
  }
});
vscode.postMessage({ t: 'ready' });
inp.focus();
`;
    return page({ title: L.title, css, body, script });
  }
}

export function registerGreenScreen(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.open5250', guard(() => open5250(manager))),
    vscode.commands.registerCommand('vanthrex.commandLine', guard((preset?: unknown) => { manager.require(); CommandLine.open(manager, context.globalState, typeof preset === 'string' ? preset : undefined); })),
    vscode.commands.registerCommand('vanthrex.commandLine.key', guard((key?: string) => { if (key) { CommandLine.current?.key(key); } })),
  );
}
