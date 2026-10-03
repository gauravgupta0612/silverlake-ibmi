import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, logError } from '../core/log';
import { nonce } from './webviewUtil';

type Section = { rows?: Record<string, unknown>[]; error?: string };

const QUERIES: Record<string, string> = {
  system: `SELECT * FROM SYSIBMADM.ENV_SYS_INFO`,
  status: `SELECT * FROM QSYS2.SYSTEM_STATUS_INFO`,
  topJobs: `SELECT JOB_NAME, AUTHORIZATION_NAME, SUBSYSTEM, JOB_STATUS, FUNCTION, ELAPSED_CPU_PERCENTAGE, ` +
    `TEMPORARY_STORAGE FROM TABLE(QSYS2.ACTIVE_JOB_INFO(RESET_STATISTICS => 'NO', DETAILED_INFO => 'NONE')) ` +
    `WHERE JOB_TYPE <> 'SYS' ORDER BY ELAPSED_CPU_PERCENTAGE DESC FETCH FIRST 10 ROWS ONLY`,
  qsysopr: `SELECT VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS TIME, MESSAGE_ID, MESSAGE_TYPE, SEVERITY, ` +
    `MESSAGE_TEXT FROM QSYS2.MESSAGE_QUEUE_INFO WHERE MESSAGE_QUEUE_LIBRARY = 'QSYS' AND MESSAGE_QUEUE_NAME = 'QSYSOPR' ` +
    `ORDER BY MESSAGE_TIMESTAMP DESC FETCH FIRST 12 ROWS ONLY`,
  ptf: `SELECT PTF_GROUP_NAME, MAX(PTF_GROUP_DESCRIPTION) AS DESCRIPTION, MAX(PTF_GROUP_LEVEL) AS LEVEL ` +
    `FROM QSYS2.GROUP_PTF_INFO WHERE PTF_GROUP_STATUS = 'INSTALLED' AND (UPPER(PTF_GROUP_DESCRIPTION) LIKE '%CUMULATIVE%' ` +
    `OR UPPER(PTF_GROUP_DESCRIPTION) LIKE '%TECHNOLOGY REFRESH%' OR UPPER(PTF_GROUP_DESCRIPTION) LIKE '%DB2 FOR IBM I%' ` +
    `OR UPPER(PTF_GROUP_DESCRIPTION) LIKE '%HIPER%' OR UPPER(PTF_GROUP_DESCRIPTION) LIKE '%SECURITY%') ` +
    `GROUP BY PTF_GROUP_NAME ORDER BY PTF_GROUP_NAME`,
};

export class Dashboard {
  private static current?: Dashboard;
  private readonly panel: vscode.WebviewPanel;
  private timer?: NodeJS.Timeout;
  private auto = true;
  private busy = false;
  private disposed = false;

  static open(manager: ConnectionManager): void {
    if (Dashboard.current) { Dashboard.current.panel.reveal(); Dashboard.current.refresh(); return; }
    Dashboard.current = new Dashboard(manager);
  }

  private constructor(private readonly manager: ConnectionManager) {
    const conn = manager.require();
    this.panel = vscode.window.createWebviewPanel('vanthrex.dashboard', `IBM i Dashboard — ${conn.profile.name}`,
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => { this.disposed = true; this.stop(); Dashboard.current = undefined; });
    this.panel.onDidChangeViewState(e => { if (e.webviewPanel.visible) { this.schedule(); } else { this.stop(); } });
    this.panel.webview.onDidReceiveMessage(m => {
      if (m.type === 'refresh') { this.refresh(); }
      if (m.type === 'auto') { this.auto = !!m.on; this.schedule(); }
      if (m.type === 'command') { vscode.commands.executeCommand(m.command); }
    });
    const sub = manager.onDidChange(c => { if (!c) { this.panel.dispose(); sub.dispose(); } });
    this.refresh();
  }

  private interval(): number {
    return Math.max(0, vscode.workspace.getConfiguration('vanthrex').get<number>('dashboard.refreshSeconds', 30));
  }

  private schedule(): void {
    this.stop();
    if (this.disposed || !this.panel.visible) { return; }
    const s = this.interval();
    if (this.auto && s > 0) { this.timer = setInterval(() => this.refresh(), s * 1000); }
  }

  private stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  async refresh(): Promise<void> {
    const conn = this.manager.connection;
    if (!conn || this.busy || this.disposed) { return; }
    this.busy = true;
    const data: Record<string, Section> = {};
    try {
      this.panel.webview.postMessage({ type: 'loading' });
      // Sequential on purpose: works with every SQL engine and keeps the load on the system tiny.
      for (const [key, sql] of Object.entries(QUERIES)) {
        if (this.disposed) { return; }
        try { data[key] = { rows: (await conn.sql(sql, 50)).rows }; }
        catch (e) { data[key] = { error: errorMessage(e).split('\n')[0] }; logError(e); }
      }
      if (this.disposed) { return; }
      this.panel.webview.postMessage({
        type: 'data', data, at: new Date().toLocaleTimeString(), interval: this.interval(), auto: this.auto,
        system: `${conn.profile.name} (${conn.profile.host})`,
      });
    } catch (e) {
      logError(e);
    } finally {
      this.busy = false;
      if (!this.timer && !this.disposed && this.panel.visible) { this.schedule(); }
    }
  }

  private html(): string {
    const n = nonce();
    return /* html */ `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  :root { --gap: 14px; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 20px 30px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  h1 { font-size: 1.35em; font-weight: 600; margin: 0; margin-right: auto; }
  .muted { color: var(--vscode-descriptionForeground); font-size: .9em; }
  button { padding: 4px 12px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--gap); margin-bottom: var(--gap); }
  .tile, .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, #8883); border-radius: 8px; padding: 12px 14px; }
  .tile .label { font-size: .85em; color: var(--vscode-descriptionForeground); }
  .tile .value { font-size: 1.8em; font-weight: 600; margin: 4px 0; font-variant-numeric: tabular-nums; }
  .bar { height: 6px; border-radius: 3px; background: var(--vscode-progressBar-background, #0e70c0); opacity: .25; position: relative; overflow: hidden; }
  .bar > span { position: absolute; inset: 0 auto 0 0; background: var(--vscode-progressBar-background, #0e70c0); opacity: 1; }
  .bar.warn > span { background: var(--vscode-editorWarning-foreground, #cca700); }
  .bar.crit > span { background: var(--vscode-editorError-foreground, #f14c4c); }
  .bar-wrap { height: 6px; border-radius: 3px; background: var(--vscode-input-background); overflow: hidden; }
  .bar-wrap > span { display: block; height: 100%; background: var(--vscode-progressBar-background, #0e70c0); }
  .bar-wrap.warn > span { background: var(--vscode-editorWarning-foreground, #cca700); }
  .bar-wrap.crit > span { background: var(--vscode-editorError-foreground, #f14c4c); }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: var(--gap); }
  .card h2 { font-size: 1em; margin: 0 0 8px; display: flex; justify-content: space-between; align-items: center; }
  table { width: 100%; border-collapse: collapse; font-size: .92em; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--vscode-widget-border, #8882); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 500; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .err { color: var(--vscode-errorForeground); font-size: .9em; }
  .sev { display: inline-block; min-width: 2em; text-align: center; border-radius: 3px; padding: 0 4px; }
  .sev.hi { background: var(--vscode-inputValidation-errorBackground, #be110033); }
  details { margin-top: var(--gap); }
  .loading { opacity: .6; }
</style></head><body>
<header>
  <h1>IBM i Dashboard</h1>
  <span class="muted" id="sys"></span>
  <span class="muted" id="at">Loading…</span>
  <label class="muted"><input type="checkbox" id="auto" checked> auto-refresh</label>
  <button id="refresh">Refresh</button>
</header>
<section class="tiles" id="tiles"></section>
<section class="grid2">
  <div class="card"><h2>Top jobs by CPU <button data-cmd="vanthrex.jobs.focus">Open Jobs</button></h2><div id="topJobs"></div></div>
  <div class="card"><h2>QSYSOPR messages <button data-cmd="vanthrex.messages.focus">Open Messages</button></h2><div id="qsysopr"></div></div>
  <div class="card"><h2>PTF groups</h2><div id="ptf"></div></div>
  <div class="card"><h2>System</h2><div id="system"></div></div>
</section>
<details><summary class="muted">All system status values</summary><div class="card" id="status"></div></details>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const pick = (row, ...keys) => { for (const k of keys) if (row && row[k] !== undefined && row[k] !== null) return row[k]; return undefined; };
  const num = v => v === undefined || v === null || v === '' ? undefined : Number(v);
  const fmt = (v, d = 0) => v === undefined || isNaN(v) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  function level(p) { return p >= 90 ? 'crit' : p >= 75 ? 'warn' : ''; }
  function tile(label, value, sub, pct) {
    const bar = pct === undefined ? '' : '<div class="bar-wrap ' + level(pct) + '"><span style="width:' + Math.min(100, Math.max(0, pct)) + '%"></span></div>';
    return '<div class="tile"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div>' + bar +
      (sub ? '<div class="muted" style="margin-top:6px">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function table(section, cols, opts = {}) {
    if (!section) return '';
    if (section.error) return '<div class="err">Not available: ' + esc(section.error) + '</div>';
    const rows = section.rows || [];
    if (!rows.length) return '<div class="muted">Nothing to show.</div>';
    const keys = cols || Object.keys(rows[0]);
    return '<table><tr>' + keys.map(k => '<th>' + esc(k.replace(/_/g, ' ').toLowerCase()) + '</th>').join('') + '</tr>' +
      rows.map(r => '<tr>' + keys.map(k => {
        const v = r[k];
        if (k === 'SEVERITY') return '<td class="num"><span class="sev ' + (Number(v) >= 80 ? 'hi' : '') + '">' + esc(v) + '</span></td>';
        return '<td' + (typeof v === 'number' ? ' class="num"' : '') + '>' + esc(v) + '</td>';
      }).join('') + '</tr>').join('') + '</table>';
  }
  function kv(section) {
    if (!section) return '';
    if (section.error) return '<div class="err">Not available: ' + esc(section.error) + '</div>';
    const r = (section.rows || [])[0] || {};
    return '<table>' + Object.entries(r).map(([k, v]) => '<tr><th>' + esc(k.replace(/_/g, ' ').toLowerCase()) + '</th><td>' + esc(v) + '</td></tr>').join('') + '</table>';
  }
  function render(m) {
    const d = m.data;
    const st = (d.status && d.status.rows && d.status.rows[0]) || {};
    const cpu = num(pick(st, 'AVERAGE_CPU_UTILIZATION', 'AVERAGE_CPU_RATE'));
    const asp = num(pick(st, 'SYSTEM_ASP_USED'));
    const aspSize = num(pick(st, 'SYSTEM_ASP_STORAGE'));
    const jobs = num(pick(st, 'TOTAL_JOBS_IN_SYSTEM'));
    const maxJobs = num(pick(st, 'MAXIMUM_JOBS_IN_SYSTEM'));
    const active = num(pick(st, 'ACTIVE_JOBS_IN_SYSTEM'));
    const mem = num(pick(st, 'MAIN_STORAGE_SIZE'));
    const temp = num(pick(st, 'CURRENT_TEMPORARY_STORAGE'));
    const cpus = num(pick(st, 'CONFIGURED_CPUS'));
    const jobsPct = jobs !== undefined && maxJobs ? jobs * 100 / maxJobs : undefined;
    $('tiles').innerHTML = d.status && d.status.error
      ? '<div class="tile err">System status not available: ' + esc(d.status.error) + '</div>'
      : [
        tile('CPU utilization', fmt(cpu, 1) + '%', cpus ? cpus + ' configured CPU(s)' : '', cpu),
        tile('System ASP used', fmt(asp, 2) + '%', aspSize ? fmt(aspSize / 1024 / 1024, 2) + ' TB total' : '', asp),
        tile('Jobs in system', fmt(jobs), maxJobs ? 'max ' + fmt(maxJobs) : '', jobsPct),
        tile('Active jobs', fmt(active), ''),
        tile('Main storage', mem ? fmt(mem / 1024 / 1024, 1) + ' GB' : '—', temp ? fmt(temp) + ' MB temporary storage' : ''),
      ].join('');
    $('topJobs').innerHTML = table(d.topJobs, ['JOB_NAME', 'AUTHORIZATION_NAME', 'JOB_STATUS', 'FUNCTION', 'ELAPSED_CPU_PERCENTAGE']);
    $('qsysopr').innerHTML = table(d.qsysopr, ['TIME', 'MESSAGE_ID', 'SEVERITY', 'MESSAGE_TEXT']);
    $('ptf').innerHTML = table(d.ptf, ['PTF_GROUP_NAME', 'DESCRIPTION', 'LEVEL']);
    $('system').innerHTML = kv(d.system);
    $('status').innerHTML = kv(d.status);
    $('sys').textContent = m.system;
    $('at').textContent = 'Updated ' + m.at + (m.auto && m.interval ? ' · every ' + m.interval + 's' : '');
    document.body.classList.remove('loading');
  }
  window.addEventListener('message', e => {
    if (e.data.type === 'loading') document.body.classList.add('loading');
    if (e.data.type === 'data') render(e.data);
  });
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('auto').addEventListener('change', e => vscode.postMessage({ type: 'auto', on: e.target.checked }));
  document.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'command', command: b.dataset.cmd })));
</script></body></html>`;
  }
}

export function registerDashboard(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  context.subscriptions.push(vscode.commands.registerCommand('vanthrex.openDashboard', () => {
    try { Dashboard.open(manager); } catch (e) { vscode.window.showErrorMessage(errorMessage(e)); }
  }));
}
