// Work with Active Jobs as on a green screen: jobs grouped by subsystem, an option field on every line
// (3 hold, 4 end, 5 work with, 6 release, 7 message, 8 spooled files, 10 job log, 11 call stack, L live log),
// F5 refresh, F11 other columns, F10 restart statistics, automatic refresh and filters.

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { sqlString } from '../core/util';
import { ACTJOB_OPTIONS, ActiveJob, ActiveJobFilter, activeJobsSql, formatCpuTime, jobCommand, parseJobOptions, toActiveJob } from '../core/activeJobs';
import { spoolUri } from './spool';
import { escapeHtml, loaderHtml, page } from './ui/kit';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

class ActiveJobs {
  static current?: ActiveJobs;
  private readonly panel: vscode.WebviewPanel;
  private filter: ActiveJobFilter = {};
  private jobs: ActiveJob[] = [];
  private statuses: Record<string, string> = {};
  private timer?: NodeJS.Timeout;
  private busy = false;

  static open(manager: ConnectionManager, f?: ActiveJobFilter): void {
    if (!ActiveJobs.current) { ActiveJobs.current = new ActiveJobs(manager); }
    const c = ActiveJobs.current;
    if (f && (f.subsystem || f.user || f.job || f.status)) { c.filter = { ...f }; }
    c.panel.reveal();
    void c.load();
  }

  private constructor(private readonly manager: ConnectionManager) {
    const conn = manager.require();
    this.panel = vscode.window.createWebviewPanel('vanthrex.wrkactjob', vscode.l10n.t('Active jobs — {0}', conn.profile.name), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => { ActiveJobs.current = undefined; if (this.timer) { clearInterval(this.timer); } });
    this.panel.webview.onDidReceiveMessage(m => { void this.onMessage(m).catch(e => { logError(e); this.post({ t: 'note', text: errorMessage(e).split('\n')[0] }); }); });
  }

  private post(m: unknown): void { void this.panel.webview.postMessage(m); }
  private get conn(): IbmiConnection { return this.manager.require(); }

  key(k: string): void { this.post({ t: 'key', key: k }); }

  async load(reset = false): Promise<void> {
    if (this.busy) { return; }
    this.busy = true; this.post({ t: 'busy', on: true });
    try {
      const rows = await this.conn.rows<Row>(activeJobsSql(this.filter, 5000, reset), 5000);
      this.jobs = rows.map(toActiveJob);
      this.post({ t: 'data', jobs: this.jobs.map(j => ({ ...j, cpuTime: formatCpuTime(j.cpuTimeMs) })), filter: this.filter, statuses: this.statuses, at: new Date().toLocaleTimeString(), system: this.conn.profile.name });
    } catch (e) {
      this.post({ t: 'note', text: errorMessage(e).split('\n')[0] });
    } finally { this.busy = false; this.post({ t: 'busy', on: false }); }
  }

  private async onMessage(m: { t: string; [k: string]: unknown }): Promise<void> {
    switch (m.t) {
      case 'ready': await this.load(); return;
      case 'refresh': await this.load(); return;
      case 'reset': await this.load(true); return;
      case 'filter': this.filter = m.filter as ActiveJobFilter; this.statuses = {}; await this.load(); return;
      case 'auto': {
        if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
        const sec = Number(m.seconds) || 0;
        if (sec >= 5) { this.timer = setInterval(() => { if (this.panel.visible) { void this.load(); } }, sec * 1000); }
        return;
      }
      case 'enter': await this.enter(m.entries as { job: string; option: string }[]); return;
      case 'open': await vscode.commands.executeCommand('vanthrex.jobDetails', String(m.job)); return;
    }
  }

  private async enter(entries: { job: string; option: string }[]): Promise<void> {
    const { ok, bad } = parseJobOptions(entries);
    for (const b of bad) { this.statuses[b.job] = vscode.l10n.t('✗ Option {0} is not valid here.', b.option); }
    const ends = ok.filter(e => e.option === '4');
    let how: '*CNTRLD' | '*IMMED' | undefined;
    if (ends.length) {
      const c = vscode.l10n.t('End (controlled)'); const i = vscode.l10n.t('End immediately');
      const pick = await vscode.window.showWarningMessage(ends.length === 1 ? vscode.l10n.t('End job {0}?', ends[0].job) : vscode.l10n.t('End {0} jobs?', ends.length),
        { modal: true, detail: ends.map(e => e.job).join('\n') }, c, i);
      how = pick === c ? '*CNTRLD' : pick === i ? '*IMMED' : undefined;
    }
    for (const e of ok) {
      try {
        switch (e.option) {
          case '3': case '6': case '4': {
            if (e.option === '4' && !how) { this.statuses[e.job] = vscode.l10n.t('Not ended.'); break; }
            const cmd = jobCommand(e.option, e.job, how);
            const r = await this.conn.runCL(cmd);
            this.statuses[e.job] = r.ok ? `✓ ${cmd.split(' ')[0]}` : `✗ ${(r.stderr || r.stdout).trim().split('\n').pop() ?? cmd}`;
            break;
          }
          case '5': await vscode.commands.executeCommand('vanthrex.jobDetails', e.job); this.statuses[e.job] = '✓'; break;
          case '11': await vscode.commands.executeCommand('vanthrex.jobDetails', e.job); this.statuses[e.job] = '✓'; break;
          case '10': await vscode.commands.executeCommand('vanthrex.jobLog', { job: e.job }); this.statuses[e.job] = '✓'; break;
          case 'L': await vscode.commands.executeCommand('vanthrex.jobLogLive', e.job); this.statuses[e.job] = '✓'; break;
          case '7': this.statuses[e.job] = await this.message(e.job); break;
          case '8': this.statuses[e.job] = await this.spooled(e.job); break;
        }
      } catch (err) { this.statuses[e.job] = `✗ ${errorMessage(err).split('\n')[0]}`; }
    }
    await this.load();
  }

  /** Option 7: the inquiry the job waits for (in QSYSOPR or the user's queue), answered with the usual reply prompt. */
  private async message(job: string): Promise<string> {
    const rows = await this.conn.rows<Row>(`SELECT M.MESSAGE_QUEUE_LIBRARY AS QL, M.MESSAGE_QUEUE_NAME AS Q, HEX(M.MESSAGE_KEY) AS K, COALESCE(M.MESSAGE_ID, '') AS ID, ` +
      `COALESCE(M.MESSAGE_TEXT, '') AS X, COALESCE(M.MESSAGE_SECOND_LEVEL_TEXT, '') AS H, COALESCE(M.SEVERITY, 0) AS SEV, VARCHAR(M.MESSAGE_TIMESTAMP) AS TS, COALESCE(M.FROM_USER, '') AS U ` +
      `FROM QSYS2.MESSAGE_QUEUE_INFO M WHERE M.FROM_JOB = ${sqlString(job)} AND M.MESSAGE_TYPE = 'INQUIRY' AND NOT EXISTS (SELECT 1 FROM QSYS2.MESSAGE_QUEUE_INFO R ` +
      `WHERE R.MESSAGE_QUEUE_LIBRARY = M.MESSAGE_QUEUE_LIBRARY AND R.MESSAGE_QUEUE_NAME = M.MESSAGE_QUEUE_NAME AND R.MESSAGE_TYPE = 'REPLY' AND R.ASSOCIATED_MESSAGE_KEY = M.MESSAGE_KEY) ` +
      `ORDER BY M.MESSAGE_TIMESTAMP DESC FETCH FIRST 1 ROW ONLY`, 1);
    const r = rows[0];
    if (!r) { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); return vscode.l10n.t('No message waiting for a reply: job log opened.'); }
    await vscode.commands.executeCommand('vanthrex.replyMessage', { kind: 'message', queueLib: s(r, 'QL'), queue: s(r, 'Q'), key: s(r, 'K'), id: s(r, 'ID'), type: 'INQUIRY',
      severity: Number(r.SEV ?? 0), text: s(r, 'X'), help: s(r, 'H'), time: s(r, 'TS'), fromUser: s(r, 'U'), fromJob: job });
    return '✓';
  }

  /** Option 8: the spooled files of the job. */
  private async spooled(job: string): Promise<string> {
    const all = await this.conn.rows<Row>(`SELECT SPOOLED_FILE_NAME AS F, FILE_NUMBER AS N, TOTAL_PAGES AS P, COALESCE(USER_DATA, '') AS UD, STATUS AS ST FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC ` +
      `WHERE JOB_NAME = ${sqlString(job)} ORDER BY FILE_NUMBER`, 500);
    if (!all.length) { return vscode.l10n.t('No spooled files.'); }
    const p = await vscode.window.showQuickPick(all.map(r => ({ r, label: s(r, 'F'), description: `#${s(r, 'N')} · ${s(r, 'P')} p · ${s(r, 'ST')} · ${s(r, 'UD')}` })), { title: job });
    if (p) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(spoolUri({ job, name: s(p.r, 'F'), number: Number(p.r.N) })), { preview: true }); }
    return '✓';
  }

  private html(): string {
    const L = {
      title: vscode.l10n.t('Work with Active Jobs'), sbs: vscode.l10n.t('Subsystem'), user: vscode.l10n.t('User'), job: vscode.l10n.t('Job'), status: vscode.l10n.t('Status'),
      type: vscode.l10n.t('Type'), cpu: 'CPU %', func: vscode.l10n.t('Function'), threads: vscode.l10n.t('Threads'), temp: vscode.l10n.t('Temp MB'), cpuTime: vscode.l10n.t('CPU time'),
      io: vscode.l10n.t('Disk I/O'), pool: vscode.l10n.t('Pool'), pty: vscode.l10n.t('Priority'), opt: vscode.l10n.t('Opt'), result: vscode.l10n.t('Result'),
      apply: vscode.l10n.t('Apply filter'), all: vscode.l10n.t('*ALL'), auto: vscode.l10n.t('Refresh every'), off: vscode.l10n.t('off'), enter: vscode.l10n.t('Enter'),
      refresh: vscode.l10n.t('F5 Refresh'), view: vscode.l10n.t('F11 Other columns'), reset: vscode.l10n.t('F10 Restart statistics'), position: vscode.l10n.t('Position to job'),
      updated: vscode.l10n.t('Updated'), count: vscode.l10n.t('{0} jobs', '%N'), empty: vscode.l10n.t('No active jobs match.'), more: vscode.l10n.t('Show more'),
    };
    const label: Record<string, string> = { '3': vscode.l10n.t('Hold'), '4': vscode.l10n.t('End'), '5': vscode.l10n.t('Work with'), '6': vscode.l10n.t('Release'),
      '7': vscode.l10n.t('Display message'), '8': vscode.l10n.t('Work with spooled files'), '10': vscode.l10n.t('Display job log'), '11': vscode.l10n.t('Call stack'), L: vscode.l10n.t('Live job log') };
    const options = ACTJOB_OPTIONS.map(o => ({ code: o.code, label: label[o.code] ?? o.label }));
    const css = `
      body { padding: 0 14px 20px; } header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 8px 0 6px; z-index: 2; border-bottom: 1px solid var(--vx-border); }
      h1 { font-size: 1.15em; margin: 0 0 6px; } .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; } .bar .vx-input { min-width: 110px; width: 110px; }
      .legend { margin: 6px 0 2px; color: var(--vx-muted); font-size: 0.95em; } .legend b { color: var(--vscode-foreground); }
      .vx-table td.o { width: 34px; padding: 1px 4px; } .vx-table td.o input { width: 28px; font-family: var(--vscode-editor-font-family); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #8884); }
      tr.sbs td { background: var(--vscode-editorWidget-background); font-weight: 600; } tr.msgw td { color: var(--vscode-errorForeground); } tr.lckw td { color: var(--vscode-editorWarning-foreground); }
      td.num { text-align: right; } .res.bad { color: var(--vscode-errorForeground); } .res.ok { color: var(--vscode-testing-iconPassed, #3a3); }`;
    const body = `<header><h1>${escapeHtml(L.title)} <span class="vx-muted" id="sys"></span></h1>
<div class="bar"><label>${escapeHtml(L.sbs)} <input class="vx-input" id="fSbs" placeholder="*ALL"></label><label>${escapeHtml(L.user)} <input class="vx-input" id="fUser" placeholder="*ALL"></label>
<label>${escapeHtml(L.job)} <input class="vx-input" id="fJob" placeholder="*ALL"></label><label>${escapeHtml(L.status)} <select class="vx-input" id="fSt"><option value="">*ALL</option><option>MSGW</option><option>LCKW</option><option>RUN</option><option>DSPW</option><option>HLD</option><option>DEQW</option><option>TIMW</option></select></label>
<button class="vx-btn secondary" id="apply">${escapeHtml(L.apply)}</button>
<label>${escapeHtml(L.auto)} <select class="vx-input" id="auto"><option value="0">${escapeHtml(L.off)}</option><option value="5">5 s</option><option value="10">10 s</option><option value="30">30 s</option><option value="60">60 s</option></select></label>
<input class="vx-input" id="pos" placeholder="${escapeHtml(L.position)}"></div>
<div class="legend" id="legend"></div>
<div class="bar"><button class="vx-btn" id="enter">${escapeHtml(L.enter)}</button><button class="vx-btn secondary" data-k="F5">${escapeHtml(L.refresh)}</button><button class="vx-btn secondary" data-k="F11">${escapeHtml(L.view)}</button><button class="vx-btn secondary" data-k="F10">${escapeHtml(L.reset)}</button><span class="vx-muted" id="msg"></span></div></header>
<table class="vx-table" id="grid"><thead id="head"></thead><tbody id="body"><tr><td>${loaderHtml(vscode.l10n.t('Reading from the IBM i…'), { rows: 12 })}</td></tr></tbody></table><div class="vx-more" id="more"></div>`;
    const script = `
const vscode = acquireVsCodeApi();
const L = ${JSON.stringify(L).replace(/</g, '\\u003c')}; const OPTS = ${JSON.stringify(options).replace(/</g, '\\u003c')};
const $ = id => document.getElementById(id);
let D = null; let view = 1; const opts = new Map(); let shown = 0; const PAGE = 400; let flat = [];
$('legend').innerHTML = OPTS.map(o => '<b>' + VX.esc(o.code) + '</b>=' + VX.esc(o.label)).join('&nbsp;&nbsp; ');
function cols() { return view === 1 ? [['job', L.job], ['user', L.user], ['type', L.type], ['cpu', L.cpu], ['function', L.func], ['status', L.status]]
  : [['job', L.job], ['threads', L.threads], ['tempMb', L.temp], ['cpuTime', L.cpuTime], ['io', L.io], ['pool', L.pool], ['priority', L.pty]]; }
function rowHtml(x) {
  if (x.sbs) return '<tr class="sbs"><td></td><td colspan="' + (cols().length + 1) + '">' + VX.esc(x.sbs) + ' <span class="vx-muted">· ' + x.n + ' · CPU ' + x.cpu + '%</span></td></tr>';
  const j = x.j, st = (D.statuses || {})[j.job] || '';
  return '<tr data-job="' + VX.esc(j.job) + '" class="' + (j.status === 'MSGW' ? 'msgw' : j.status === 'LCKW' ? 'lckw' : '') + '"><td class="o"><input maxlength="2" value="' + VX.esc(opts.get(j.job) || '') + '"></td>' +
    cols().map(([k]) => '<td' + (['cpu', 'threads', 'tempMb', 'io', 'priority'].includes(k) ? ' class="num"' : '') + '>' + VX.esc(j[k] ?? '') + '</td>').join('') +
    '<td class="res ' + (st.startsWith('✗') ? 'bad' : 'ok') + '">' + VX.esc(st) + '</td></tr>';
}
function render() {
  $('head').innerHTML = '<tr><th>' + VX.esc(L.opt) + '</th>' + cols().map(([, t]) => '<th>' + VX.esc(t) + '</th>').join('') + '<th>' + VX.esc(L.result) + '</th></tr>';
  flat = [];
  const groups = new Map(); D.jobs.forEach(j => { const k = j.subsystem || '(none)'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(j); });
  [...groups.keys()].sort().forEach(k => { const list = groups.get(k); flat.push({ sbs: k, n: list.length, cpu: Math.round(list.reduce((a, j) => a + j.cpu, 0) * 10) / 10 }); list.forEach(j => flat.push({ j })); });
  $('body').innerHTML = D.jobs.length ? '' : '<tr><td></td><td colspan="9" class="vx-muted">' + VX.esc(L.empty) + '</td></tr>'; shown = 0; more();
  $('msg').textContent = L.count.replace('%N', D.jobs.length) + ' · ' + L.updated + ' ' + D.at;
}
function more() {
  const next = flat.slice(shown, shown + PAGE); $('body').insertAdjacentHTML('beforeend', next.map(rowHtml).join('')); shown += next.length;
  $('more').innerHTML = shown < flat.length ? '<button class="vx-btn secondary" id="moreBtn">' + VX.esc(L.more) + ' (' + (flat.length - shown) + ')</button>' : '';
}
function enter() { const e = [...opts.entries()].filter(([, o]) => o.trim()).map(([job, option]) => ({ job, option })); if (!e.length) return; opts.clear(); vscode.postMessage({ t: 'enter', entries: e }); }
function filter() { vscode.postMessage({ t: 'filter', filter: { subsystem: $('fSbs').value.trim(), user: $('fUser').value.trim(), job: $('fJob').value.trim(), status: $('fSt').value } }); }
function key(k) { if (k === 'F5') vscode.postMessage({ t: 'refresh' }); else if (k === 'F10') vscode.postMessage({ t: 'reset' }); else if (k === 'F11') { view = view === 1 ? 2 : 1; if (D) render(); } }
function position() { const v = $('pos').value.trim().toUpperCase(); if (!v) return; let i = flat.findIndex(x => x.j && (x.j.job.split('/')[2] || '').startsWith(v)); if (i < 0) return; while (shown <= i) more(); const tr = $('body').children[i]; if (tr) { tr.scrollIntoView({ block: 'center' }); const inp = tr.querySelector('input'); if (inp) inp.focus(); } }
document.addEventListener('input', e => { const tr = e.target.closest('tr[data-job]'); if (tr && e.target.tagName === 'INPUT') opts.set(tr.dataset.job, e.target.value.toUpperCase()); });
document.addEventListener('keydown', e => {
  const cell = e.target.closest && e.target.closest('td.o');
  if (cell && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); let tr = cell.parentElement; do { tr = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling; } while (tr && !tr.dataset.job); if (tr) tr.querySelector('input').focus(); return; }
  if (/^F(5|10|11)$/.test(e.key)) { e.preventDefault(); key(e.key); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (['fSbs', 'fUser', 'fJob'].includes(e.target.id)) filter(); else if (e.target.id === 'pos') position(); else enter();
});
document.addEventListener('click', e => {
  const t = e.target;
  if (t.id === 'enter') enter(); else if (t.id === 'apply') filter(); else if (t.id === 'moreBtn') more(); else if (t.dataset.k) key(t.dataset.k);
});
document.addEventListener('dblclick', e => { const tr = e.target.closest('tr[data-job]'); if (tr && e.target.tagName !== 'INPUT') vscode.postMessage({ t: 'open', job: tr.dataset.job }); });
$('fSt').addEventListener('change', filter);
$('auto').addEventListener('change', () => vscode.postMessage({ t: 'auto', seconds: Number($('auto').value) }));
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.t === 'data') { D = m; $('sys').textContent = m.system; const f = m.filter || {}; $('fSbs').value = f.subsystem || ''; $('fUser').value = f.user || ''; $('fJob').value = f.job || ''; $('fSt').value = f.status || ''; render(); }
  else if (m.t === 'busy') VX.busy(m.on);
  else if (m.t === 'note') $('msg').textContent = m.text;
  else if (m.t === 'key') key(m.key);
});
vscode.postMessage({ t: 'ready' });
`;
    return page({ title: L.title, css, body, script });
  }
}

export function registerActiveJobs(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.wrkactjob', guard((f?: unknown) => { manager.require(); ActiveJobs.open(manager, (f && typeof f === 'object' ? f : undefined) as ActiveJobFilter | undefined); })),
    vscode.commands.registerCommand('vanthrex.wrkactjob.key', guard((k?: string) => { if (k) { ActiveJobs.current?.key(k); } })),
  );
}
