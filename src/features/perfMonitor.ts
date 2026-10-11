import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, log, logError } from '../core/log';
import { pushSample, sparkPoints } from '../core/codeTools';
import { escapeHtml, nonce } from './webviewUtil';

type Row = Record<string, unknown>;
const num = (r: Row | undefined, k: string) => { const v = Number(r?.[k]); return isFinite(v) ? v : 0; };
const str = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

const W = 300; const H = 70;
const CHARTS = [
  { key: 'cpu', title: 'CPU used', unit: '%', minMax: 100 },
  { key: 'asp', title: 'System ASP used', unit: '%', minMax: 100 },
  { key: 'jobs', title: 'Active jobs', unit: '', minMax: 10 },
  { key: 'temp', title: 'Temporary storage', unit: 'MB', minMax: 100 },
] as const;
type Key = typeof CHARTS[number]['key'];
const chartTitle = (k: Key): string => ({ cpu: vscode.l10n.t('CPU used'), asp: vscode.l10n.t('System ASP used'), jobs: vscode.l10n.t('Active jobs'), temp: vscode.l10n.t('Temporary storage') })[k];

const POOL_COLS = ['POOL_NAME', 'SYSTEM_POOL_IDENTIFIER', 'CURRENT_SIZE', 'DEFINED_SIZE', 'CURRENT_THREADS', 'INELIGIBLE_THREADS',
  'ELAPSED_DATABASE_FAULTS', 'ELAPSED_NON_DATABASE_FAULTS', 'ELAPSED_TOTAL_FAULTS', 'PAGING_OPTION'];

class Monitor implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private timer: NodeJS.Timeout | undefined;
  private series: Record<Key, number[]> = { cpu: [], asp: [], jobs: [], temp: [] };
  private times: string[] = [];
  private busy = false;
  private paused = false;

  constructor(private readonly manager: ConnectionManager) {}

  open(): void {
    if (this.panel) { this.panel.reveal(); return; }
    this.manager.require();
    this.panel = vscode.window.createWebviewPanel('vanthrex.perf', vscode.l10n.t('IBM i performance'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => { this.stop(); this.panel = undefined; this.series = { cpu: [], asp: [], jobs: [], temp: [] }; this.times = []; });
    this.panel.webview.onDidReceiveMessage(m => {
      if (m?.type === 'job' && typeof m.job === 'string') { void vscode.commands.executeCommand('vanthrex.jobLog', { job: m.job }); }
      if (m?.type === 'pause') { this.paused = !!m.paused; }
    });
    this.start();
  }

  private start(): void {
    const secs = Math.max(2, vscode.workspace.getConfiguration('vanthrex.performance').get<number>('intervalSeconds', 5));
    void this.sample(true);
    this.timer = setInterval(() => void this.sample(false), secs * 1000);
  }

  private stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }

  private async sample(first: boolean): Promise<void> {
    const conn = this.manager.connection;
    if (!conn || this.busy || this.paused || !this.panel) { return; }
    this.busy = true;
    try {
      const [st, pools, jobs] = await Promise.all([
        conn.rows<Row>(`SELECT * FROM TABLE(QSYS2.SYSTEM_STATUS(RESET_STATISTICS => 'YES', DETAILED_INFO => 'ALL')) X`, 1),
        conn.rows<Row>(`SELECT * FROM QSYS2.MEMORY_POOL_INFO ORDER BY SYSTEM_POOL_IDENTIFIER`, 100).catch(() => []),
        conn.rows<Row>(`SELECT JOB_NAME, COALESCE(SUBSYSTEM, '') AS SBS, COALESCE(AUTHORIZATION_NAME, '') AS USR, JOB_STATUS, COALESCE(FUNCTION, '') AS FN, ` +
          `COALESCE(ELAPSED_CPU_PERCENTAGE, 0) AS CPU, COALESCE(ELAPSED_TOTAL_DISK_IO_COUNT, 0) AS IO, COALESCE(TEMPORARY_STORAGE, 0) AS TMP ` +
          `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(RESET_STATISTICS => 'YES', DETAILED_INFO => 'NONE')) A ` +
          `WHERE ELAPSED_CPU_PERCENTAGE > 0 OR ELAPSED_TOTAL_DISK_IO_COUNT > 0 ORDER BY ELAPSED_CPU_PERCENTAGE DESC FETCH FIRST 200 ROWS ONLY`, 200).catch(() => []),
      ]);
      const s = st[0];
      if (!first) {
        this.series.cpu = pushSample(this.series.cpu, num(s, 'ELAPSED_CPU_USED'));
        this.series.asp = pushSample(this.series.asp, num(s, 'SYSTEM_ASP_USED'));
        this.series.jobs = pushSample(this.series.jobs, num(s, 'ACTIVE_JOBS_IN_SYSTEM'));
        this.series.temp = pushSample(this.series.temp, num(s, 'CURRENT_TEMPORARY_STORAGE'));
        this.times = [...this.times, new Date().toLocaleTimeString()].slice(-120);
      }
      const charts = CHARTS.map(c => {
        const v = this.series[c.key];
        return { key: c.key, points: sparkPoints(v, W, H, c.minMax), values: v, last: v.length ? v[v.length - 1] : undefined,
          max: v.length ? Math.max(...v) : undefined, max0: Math.max(c.minMax, ...v) };
      });
      const poolCols = POOL_COLS.filter(k => pools[0] && k in pools[0]);
      const topCpu = jobs.slice(0, 10);
      const topIo = [...jobs].sort((a, b) => num(b, 'IO') - num(a, 'IO')).slice(0, 10);
      const jobRow = (r: Row) => ({ job: str(r, 'JOB_NAME'), sbs: str(r, 'SBS'), user: str(r, 'USR'), status: str(r, 'JOB_STATUS'), fn: str(r, 'FN'), cpu: num(r, 'CPU'), io: num(r, 'IO'), tmp: num(r, 'TMP') });
      await this.panel.webview.postMessage({
        type: 'data', first, times: this.times, charts,
        facts: { cpus: str(s, 'CONFIGURED_CPUS') || str(s, 'CURRENT_PROCESSING_CAPACITY'), mem: num(s, 'MAIN_STORAGE_SIZE'), jobsTotal: num(s, 'TOTAL_JOBS_IN_SYSTEM'), asp: num(s, 'SYSTEM_ASP_STORAGE') },
        pools: { cols: poolCols, rows: pools.map(p => poolCols.map(k => str(p, k))) },
        topCpu: topCpu.map(jobRow), topIo: topIo.map(jobRow),
      });
    } catch (e) {
      log(`Performance monitor: ${errorMessage(e)}`);
      void this.panel?.webview.postMessage({ type: 'error', text: errorMessage(e) });
    } finally { this.busy = false; }
  }

  private html(): string {
    const n = nonce();
    const charts = CHARTS.map(c => `<figure class="chart" data-k="${c.key}"><figcaption><span class="ct">${escapeHtml(chartTitle(c.key))}</span> <span class="now" id="now-${c.key}">—</span><span class="unit">${c.unit}</span></figcaption>` +
      `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(chartTitle(c.key))}"><line class="grid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/><line class="base" x1="0" y1="${H}" x2="${W}" y2="${H}"/>` +
      `<polyline id="line-${c.key}" points=""/><line class="cross" id="x-${c.key}" x1="0" y1="0" x2="0" y2="${H}" visibility="hidden"/><circle id="dot-${c.key}" r="4" visibility="hidden"/></svg>` +
      `<div class="axis"><span id="max-${c.key}"></span><span class="dim" id="peak-${c.key}"></span></div><div class="tip" id="tip-${c.key}"></div></figure>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 16px 24px; }
  h1 { font-size: 1.4em; margin: 4px 0; } h2 { font-size: 1.05em; margin: 20px 0 8px; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; color: var(--vscode-descriptionForeground); }
  button { padding: 4px 12px; border: none; border-radius: 3px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .grid4 { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; margin-top: 12px; }
  .chart { margin: 0; padding: 10px 12px; border: 1px solid var(--vscode-editorWidget-border, #8883); border-radius: 6px; position: relative; }
  figcaption { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; }
  .ct { color: var(--vscode-descriptionForeground); flex: 1; } .now { font-size: 1.5em; font-variant-numeric: tabular-nums; } .unit { color: var(--vscode-descriptionForeground); }
  svg { width: 100%; height: 70px; display: block; overflow: visible; }
  polyline { fill: none; stroke: var(--vscode-charts-blue, #3794ff); stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; stroke-linecap: round; }
  .grid { stroke: var(--vscode-editorWidget-border, #8883); stroke-dasharray: 2 3; vector-effect: non-scaling-stroke; }
  .base { stroke: var(--vscode-editorWidget-border, #8886); vector-effect: non-scaling-stroke; }
  .cross { stroke: var(--vscode-descriptionForeground); stroke-width: 1; vector-effect: non-scaling-stroke; }
  circle { fill: var(--vscode-charts-blue, #3794ff); stroke: var(--vscode-editor-background); stroke-width: 2; vector-effect: non-scaling-stroke; }
  .axis { display: flex; justify-content: space-between; font-size: .85em; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .tip { position: absolute; top: 34px; padding: 3px 7px; border-radius: 3px; font-size: .9em; pointer-events: none; display: none;
    background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); }
  .dim { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { border: 1px solid var(--vscode-editorWidget-border, #8883); padding: 3px 8px; text-align: left; } td.n { text-align: right; font-variant-numeric: tabular-nums; }
  th { background: var(--vscode-editorWidget-background); } tr.link { cursor: pointer; } tr.link:hover td { background: var(--vscode-list-hoverBackground); }
  .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
  .err { color: var(--vscode-errorForeground); }
</style></head><body>
<h1>${escapeHtml(vscode.l10n.t('IBM i performance'))}</h1>
<div class="bar"><span id="status">${escapeHtml(vscode.l10n.t('Collecting the first sample…'))}</span><span id="facts"></span><button id="pause">${escapeHtml(vscode.l10n.t('Pause'))}</button></div>
<div class="grid4">${charts}</div>
<div class="two">
<section><h2>${escapeHtml(vscode.l10n.t('Top jobs by CPU'))}</h2><table id="cpu"></table></section>
<section><h2>${escapeHtml(vscode.l10n.t('Top jobs by disk I/O'))}</h2><table id="io"></table></section>
</div>
<section><h2>${escapeHtml(vscode.l10n.t('Memory pools'))}</h2><table id="pools"></table></section>
<p class="dim">${escapeHtml(vscode.l10n.t('Values are measured between two samples (QSYS2.SYSTEM_STATUS and ACTIVE_JOB_INFO with RESET_STATISTICS). Click a job for its job log. Interval: setting vanthrex.performance.intervalSeconds.'))}</p>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = v => v === undefined ? '—' : (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : (+v).toFixed(1));
let state = { times: [], charts: [] }; let paused = false;
document.getElementById('pause').onclick = e => { paused = !paused; e.target.textContent = paused ? ${JSON.stringify(vscode.l10n.t('Resume'))} : ${JSON.stringify(vscode.l10n.t('Pause'))}; vscode.postMessage({ type: 'pause', paused }); };
function jobs(id, rows) {
  const t = document.getElementById(id);
  t.innerHTML = '<thead><tr><th>Job</th><th>User</th><th>Subsystem</th><th>Status</th><th>CPU %</th><th>Disk I/O</th></tr></thead><tbody>' +
    (rows.length ? rows.map(r => '<tr class="link" data-job="' + esc(r.job) + '"><td>' + esc(r.job) + '</td><td>' + esc(r.user) + '</td><td>' + esc(r.sbs) + '</td><td>' + esc(r.status) + '</td><td class="n">' + fmt(r.cpu) + '</td><td class="n">' + r.io.toLocaleString() + '</td></tr>').join('')
      : '<tr><td colspan="6" class="dim">—</td></tr>') + '</tbody>';
}
document.addEventListener('click', e => { const tr = e.target.closest('tr[data-job]'); if (tr) vscode.postMessage({ type: 'job', job: tr.dataset.job }); });
document.querySelectorAll('.chart').forEach(fig => {
  const k = fig.dataset.k; const svg = fig.querySelector('svg'); const tip = fig.querySelector('.tip');
  svg.addEventListener('mousemove', ev => {
    const c = state.charts.find(x => x.key === k); if (!c || !c.values.length) return;
    const r = svg.getBoundingClientRect(); const x = (ev.clientX - r.left) / r.width;
    const i = Math.max(0, Math.min(c.values.length - 1, Math.round(x * (c.values.length - 1))));
    const px = c.values.length > 1 ? i * ${W} / (c.values.length - 1) : 0; const py = ${H} - (Math.max(0, c.values[i]) / c.max0) * ${H};
    const cross = document.getElementById('x-' + k), dot = document.getElementById('dot-' + k);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
    tip.style.display = 'block'; tip.style.left = Math.min(r.width - 90, Math.max(0, ev.clientX - r.left + 10)) + 'px';
    tip.textContent = (state.times[i] || '') + '  ' + fmt(c.values[i]);
  });
  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; document.getElementById('x-' + k).setAttribute('visibility', 'hidden'); document.getElementById('dot-' + k).setAttribute('visibility', 'hidden'); });
});
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.type === 'error') { document.getElementById('status').innerHTML = '<span class="err">' + esc(m.text) + '</span>'; return; }
  if (m.type !== 'data') return;
  state = m;
  document.getElementById('status').textContent = m.first ? ${JSON.stringify(vscode.l10n.t('Measuring…'))} : (${JSON.stringify(vscode.l10n.t('Updated'))} + ' ' + (m.times[m.times.length - 1] || ''));
  document.getElementById('facts').textContent = [m.facts.cpus ? 'CPU: ' + m.facts.cpus : '', m.facts.mem ? 'Memory: ' + Math.round(m.facts.mem / 1024 / 1024) + ' GB' : '', m.facts.jobsTotal ? 'Jobs in system: ' + m.facts.jobsTotal.toLocaleString() : ''].filter(Boolean).join(' · ');
  for (const c of m.charts) {
    document.getElementById('line-' + c.key).setAttribute('points', c.points);
    document.getElementById('now-' + c.key).textContent = fmt(c.last);
    document.getElementById('max-' + c.key).textContent = c.values.length ? 'max ' + fmt(c.max) : '';
    document.getElementById('peak-' + c.key).textContent = c.values.length ? c.values.length + ' samples' : '';
  }
  jobs('cpu', m.topCpu); jobs('io', m.topIo);
  const p = document.getElementById('pools');
  p.innerHTML = '<thead><tr>' + m.pools.cols.map(c => '<th>' + esc(c.replace(/_/g, ' ').toLowerCase()) + '</th>').join('') + '</tr></thead><tbody>' +
    m.pools.rows.map(r => '<tr>' + r.map((v, i) => '<td' + (i > 0 && /^-?[\\d.]+$/.test(v) ? ' class="n"' : '') + '>' + esc(v) + '</td>').join('') + '</tr>').join('') + '</tbody>';
});
</script></body></html>`;
  }

  dispose(): void { this.stop(); this.panel?.dispose(); }
}

export function registerPerfMonitor(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const mon = new Monitor(manager);
  context.subscriptions.push(mon, vscode.commands.registerCommand('vanthrex.performanceMonitor', () => {
    try { mon.open(); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  }));
}
