// System Tracker: one page for the whole system — overview with what needs attention, every library,
// jobs, storage, messages, users, PTFs and my own work — with actions on every row.

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { sqlString } from '../core/util';
import { Attention, Row, SECURITY_VALUES, Snapshot, Tone, addSnapshot, adviseSystemValue, attention, journalTone, objectScanSql, scheduleCommand, bytes, csv, healthScore, isIbmLibrary, libraryRows, librarySizeSql, num, pick, portName, queueCommand, since, sparkPoints, summaryMarkdown, tone, unencrypted, unusedSince } from '../core/tracker';
import { readLibraries } from './libraryLookup';
import { CompileRecord, latestPerSource } from '../core/compileHistory';
import { Pin, pinDescription, pinLabel } from '../core/pins';
import { memberUri } from './fileSystems';
import { escapeHtml, nonce } from './webviewUtil';

interface Act { label: string; command: string; args?: unknown[] }
interface Tile { label: string; value: string; sub?: string; tone?: Tone; act?: Act; spark?: string; sparkTitle?: string; meter?: number }
interface Hero { score: number; label: string; tone: Tone; reasons: string[]; spark?: string; sparkTitle?: string }
interface Table { title: string; columns: string[]; rows: (string | number)[][]; acts?: Act[][]; tones?: (Tone | undefined)[]; filter?: boolean; numeric?: number[]; empty?: string; id?: string }
interface Tab { hero?: Hero; id: string; title: string; badge?: number; badgeTone?: Tone; tiles?: Tile[]; attention?: Attention[]; buttons?: Act[]; tables: Table[]; note?: string; error?: string }

const ALLOWED = new Set([
  'vanthrex.tracker.tab', 'vanthrex.pdm', 'vanthrex.jobDetails', 'vanthrex.jobLog', 'vanthrex.jobLogLive', 'vanthrex.messageQueue', 'vanthrex.explainMessage',
  'vanthrex.performanceMonitor', 'vanthrex.compileHistory', 'vanthrex.compileHistory.open', 'vanthrex.editConnection', 'vanthrex.storageAdvisor', 'vanthrex.installedSoftware',
  'vanthrex.ptfLookup', 'vanthrex.securityCenter', 'vanthrex.tracker.cl', 'vanthrex.tracker.copySummary', 'vanthrex.tracker.switch', 'vanthrex.journals', 'vanthrex.objectInfo', 'vanthrex.createLibrary', 'vanthrex.createIfs', 'vanthrex.signedOn', 'vanthrex.failedJobs', 'vanthrex.publicAuthorityScan', 'vanthrex.compareSystemValues', 'vanthrex.libraryListFromJobd', 'vanthrex.spool.focus', 'vanthrex.secadm.inactive', 'vanthrex.secadm.powerful', 'vanthrex.findMember', 'vanthrex.pin', 'vanthrex.pin.open',
  'vanthrex.historyLog', 'vanthrex.activeSql', 'vanthrex.journals', 'vanthrex.openDashboard', 'vanthrex.tracker.addLibrary', 'vanthrex.objectLocks', 'vanthrex.exitPoints',
]);


async function q(conn: IbmiConnection, sql: string, n = 1000): Promise<Row[]> {
  return conn.rows<Row>(sql, n);
}
/** Run a query; an error becomes part of the result instead of breaking the page. */
async function safe(conn: IbmiConnection, sql: string, n = 1000): Promise<{ rows: Row[]; error?: string }> {
  try { return { rows: await q(conn, sql, n) }; } catch (e) { logError(e); return { rows: [], error: errorMessage(e).split('\n')[0] }; }
}

class Tracker {
  static current?: Tracker;
  /** The last full page per system, shown at once while the next refresh runs. */
  private static readonly last = new Map<string, { tabs: unknown[]; at: string; sizes: unknown; acts: [number, Act][] }>();
  private shownData = false;
  private readonly panel: vscode.WebviewPanel;
  /** Actions of the page by number; numbers are never reused, so a click on an older page cannot run another action. */
  private acts = new Map<number, Act>();
  private static nextAct = 0;
  private keepFrom = 0;
  private loading = false;
  private gen = 0;
  lastSummary?: () => string;
  private sizing = false;

  static open(manager: ConnectionManager, state: vscode.Memento, tab?: string): void {
    if (Tracker.current) { Tracker.current.panel.reveal(); if (tab) { Tracker.current.post({ t: 'tab', id: tab }); } else { void Tracker.current.load(); } return; }
    Tracker.current = new Tracker(manager, state, tab);
  }

  private constructor(private readonly manager: ConnectionManager, private readonly state: vscode.Memento, private readonly firstTab?: string) {
    const conn = manager.require();
    this.panel = vscode.window.createWebviewPanel('vanthrex.tracker', vscode.l10n.t('System Tracker — {0}', conn.profile.name), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => { Tracker.current = undefined; this.sizing = false; });
    this.panel.webview.onDidReceiveMessage(m => { void this.onMessage(m); });
    const shown = conn.profile.id;
    const sub = manager.onDidChange(c => { if (!c || c.profile.id !== shown) { this.panel.dispose(); sub.dispose(); } });
  }

  private post(m: unknown): void { void this.panel.webview.postMessage(m); }
  private ref(a: Act): number { const i = Tracker.nextAct++; this.acts.set(i, a); return i; }

  private async onMessage(m: { t: string; [k: string]: unknown }): Promise<void> {
    try {
      if (m.t === 'refresh') { this.manager.connection?.invalidateCache(); }
      if (m.t === 'ready' || m.t === 'refresh') { await this.load(); }
      if (m.t === 'act') {
        const a = this.acts.get(Number(m.i));
        if (a?.command === 'vanthrex.tracker.tab') { this.post({ t: 'tab', id: a.args?.[0] }); return; }
        if (a?.command === 'vanthrex.tracker.scan') { await this.runScan(Number(a.args?.[0]), String(a.args?.[1]), a.args?.[2] === 'size' ? 'size' : 'changed'); return; }
        if (a && ALLOWED.has(a.command)) { await vscode.commands.executeCommand(a.command, ...(a.args ?? [])); }
      }
      if (m.t === 'sizes') { await this.sizes((m.names as string[]).slice(0, 5000)); }
      if (m.t === 'report') { await this.saveReport(String(m.html)); }
      if (m.t === 'csv') { await this.saveCsv(String(m.name), m.columns as string[], m.rows as (string | number)[][]); }
      if (m.t === 'stopSizes') { this.sizing = false; }
    } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  }

  // ------------------------------------------------------------ data

  async load(): Promise<void> {
    if (this.loading) { return; }
    this.loading = true;
    this.post({ t: 'busy', on: true });
    try {
      const conn = this.manager.require();
      const gen = ++this.gen;
      const cached = Tracker.last.get(conn.profile.id);
      if (cached && !this.shownData) {
        for (const [i, a] of cached.acts) { this.acts.set(i, a); }
        this.post({ t: 'data', tabs: cached.tabs, at: cached.at, sizes: cached.sizes, first: this.firstTab, cached: true });
      }
      this.shownData = true;
      const me = conn.user;
      const libl = [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean).map(l => String(l).toUpperCase()))];
      const build = async (R: Record<keyof typeof started, { rows: Row[]; error?: string }>, partial: boolean): Promise<void> => {
        const buildFrom = Tracker.nextAct;
        const { scheds, sbsInfo, journals, failedSignon, jobqs, outqs, listen, remotes, estab, sysvals, env, st, scpf, subs, waiting, top, asp, waitCount, myAuth, libs, qsysopr, users, powerful, ptf, myJobs, mySpool, myMembers } = R;

        const s0 = st.rows[0]; const e0 = env.rows[0];
        const cpu = num(pick(s0, 'AVERAGE_CPU_UTILIZATION', 'AVERAGE_CPU_RATE'));
        const aspUsed = num(pick(s0, 'SYSTEM_ASP_USED'));
        const aspMb = num(pick(s0, 'SYSTEM_ASP_STORAGE'));
        const activeJobs = num(pick(s0, 'ACTIVE_JOBS_IN_SYSTEM'));
        const totalJobs = num(pick(s0, 'TOTAL_JOBS_IN_SYSTEM'));
        const msgw = num(pick(waitCount.rows[0], 'W')) ?? waiting.rows.filter(r => pick(r, 'ST') === 'MSGW').length;
        const lckw = num(pick(waitCount.rows[0], 'L')) ?? waiting.rows.filter(r => pick(r, 'ST') === 'LCKW').length;
        const auth = pick(myAuth.rows[0], 'A');
        const allObj = /\*ALLOBJ/.test(auth);
        const sizeCache = this.state.get<Record<string, { objects?: number; size?: number; text: string; at: string }>>(`vanthrex.tracker.sizes.${conn.profile.name}`, {});
        const inquiries = qsysopr.rows.filter(r => /INQUIRY/i.test(pick(r, 'Y'))).length;
        const history = this.state.get<CompileRecord[]>('vanthrex.compileHistory', []).filter(r => r.system === conn.profile.name);
        const broken = latestPerSource(history).filter(r => !r.ok);
        const libRows = libraryRows(libs.rows, libl);
        const existing = new Set(libRows.map(l => l.name));
        const missing = libs.rows.length ? libl.filter(l => !existing.has(l)) : [];
        const u0 = users.rows[0];
        const pins = this.state.get<Pin[]>(`vanthrex.pins.${conn.profile.name}`, []);
        const release = [pick(e0, 'OS_NAME'), pick(e0, 'OS_VERSION') && `V${pick(e0, 'OS_VERSION')}R${pick(e0, 'OS_RELEASE')}`].filter(Boolean).join(' ');
        const cum = ptf.rows.find(r => /CUMULATIVE/i.test(pick(r, 'D')));
        const tr = ptf.rows.find(r => /TECHNOLOGY REFRESH/i.test(pick(r, 'D')));
        const jobActs = (j: string): Act[] => [{ label: vscode.l10n.t('Details'), command: 'vanthrex.jobDetails', args: [j] }, { label: vscode.l10n.t('Job log'), command: 'vanthrex.jobLog', args: [{ job: j }] }, { label: vscode.l10n.t('Live'), command: 'vanthrex.jobLogLive', args: [j] }];

        const tabs: Tab[] = [];
        // ---- overview
        const say: Record<string, (v: (string | number)[]) => string> = {
          asp: v => vscode.l10n.t('System ASP is {0}% full.', v[0]), inq: v => vscode.l10n.t('{0} message(s) in QSYSOPR wait for a reply.', v[0]),
          msgw: v => vscode.l10n.t('{0} job(s) wait for a message reply (MSGW).', v[0]), lckw: v => vscode.l10n.t('{0} job(s) wait for a lock (LCKW).', v[0]),
          cpu: v => vscode.l10n.t('CPU is at {0}%.', v[0]), broken: v => vscode.l10n.t('{0} of your source(s) did not compile the last time.', v[0]),
          libl: v => vscode.l10n.t('Library list entries that do not exist: {0}.', v[0]), pwd: v => vscode.l10n.t('{0} enabled profile(s) have an expired password.', v[0]),
        };
        const actionName: Record<string, string> = { Storage: vscode.l10n.t('Storage'), Reply: vscode.l10n.t('Reply'), Jobs: vscode.l10n.t('Jobs'), Monitor: vscode.l10n.t('Monitor'),
          History: vscode.l10n.t('History'), Fix: vscode.l10n.t('Fix'), Users: vscode.l10n.t('Users') };
        const att = attention({ aspUsed, cpu, msgwJobs: msgw, lckwJobs: lckw, inquiries, brokenCompiles: broken.length,
          expiredPasswords: num(pick(u0, 'X')), libraryListMissing: missing });
        for (const a of att) { a.text = say[a.key]?.(a.vals) ?? a.text; a.action = a.action ? actionName[a.action] ?? a.action : a.action; }
        const advice = sysvals.rows.map(r => adviseSystemValue(pick(r, 'N'), pick(r, 'V'))).sort((a, b) => SECURITY_VALUES.indexOf(a.name) - SECURITY_VALUES.indexOf(b.name));
        const adviceText: Record<string, string> = {
          'Any object can be restored, including security-sensitive ones.': vscode.l10n.t('Any object can be restored, including security-sensitive ones.'),
          'Auditing is on.': vscode.l10n.t('Auditing is on.'),
          'Below 30: passwords or resource security not enforced.': vscode.l10n.t('Below 30: passwords or resource security not enforced.'),
          'Inactive interactive jobs are never ended.': vscode.l10n.t('Inactive interactive jobs are never ended.'),
          'Level 0/1: passwords up to 10 characters, not case-sensitive.': vscode.l10n.t('Level 0/1: passwords up to 10 characters, not case-sensitive.'),
          'Level 30: move to 40 so programs cannot bypass security.': vscode.l10n.t('Level 30: move to 40 so programs cannot bypass security.'),
          'Level 40 or 50: object and system integrity protected.': vscode.l10n.t('Level 40 or 50: object and system integrity protected.'),
          'Long, case-sensitive passwords.': vscode.l10n.t('Long, case-sensitive passwords.'),
          'Minimum password length below 8.': vscode.l10n.t('Minimum password length below 8.'),
          'Minimum password length is reasonable.': vscode.l10n.t('Minimum password length is reasonable.'),
          'More than 5 attempts allowed: 3–5 is usual.': vscode.l10n.t('More than 5 attempts allowed: 3–5 is usual.'),
          'New objects give *ALL to *PUBLIC.': vscode.l10n.t('New objects give *ALL to *PUBLIC.'),
          'New objects give *CHANGE to *PUBLIC (default): *USE or *EXCLUDE is stricter.': vscode.l10n.t('New objects give *CHANGE to *PUBLIC (default): *USE or *EXCLUDE is stricter.'),
          'Passwords never expire.': vscode.l10n.t('Passwords never expire.'),
          'Public authority on new objects is restricted.': vscode.l10n.t('Public authority on new objects is restricted.'),
          'Restoring sensitive objects is limited.': vscode.l10n.t('Restoring sensitive objects is limited.'),
          'Security auditing is off.': vscode.l10n.t('Security auditing is off.'),
          'Sign-on attempts limited.': vscode.l10n.t('Sign-on attempts limited.'),
          'Unlimited sign-on attempts: set 3–5.': vscode.l10n.t('Unlimited sign-on attempts: set 3–5.'),
        };
        for (const a of advice) {
          const d = /^Passwords expire after (\S+) days\.$/.exec(a.advice); const m = /^Inactive jobs are handled after (\S+) minutes\.$/.exec(a.advice);
          a.advice = d ? vscode.l10n.t('Passwords expire after {0} days.', d[1]) : m ? vscode.l10n.t('Inactive jobs are handled after {0} minutes.', m[1]) : adviceText[a.advice] ?? a.advice;
        }
        const qsec = num(advice.find(a => a.name === 'QSECURITY')?.value);
        const health = healthScore({ aspUsed, cpu, msgwJobs: msgw, lckwJobs: lckw, inquiries, brokenCompiles: broken.length, missingLibraries: missing.length,
          qsecurity: qsec, expiredPasswords: num(pick(u0, 'X')), badSettings: advice.filter(a => a.tone === 'bad').length });
        const snapKey = `vanthrex.tracker.trend.${conn.profile.name}`;
        const snaps = addSnapshot(this.state.get<Snapshot[]>(snapKey, []), { at: new Date().toISOString(), cpu, asp: aspUsed, jobs: activeJobs, msgw, score: health.score });
        if (!partial) { await this.state.update(snapKey, snaps); }
        const recent = snaps.slice(-24);
        const span = recent.length > 1 ? vscode.l10n.t('trend over the last {0} refreshes (since {1})', recent.length, new Date(recent[0].at).toLocaleString()) : '';
        const sp = (k: keyof Snapshot) => sparkPoints(recent.map(x => x[k] as number | undefined));
        const reasonText: Record<string, string> = { disk: vscode.l10n.t('disk'), 'messages waiting': vscode.l10n.t('messages waiting'), 'MSGW jobs': vscode.l10n.t('MSGW jobs'), 'LCKW jobs': vscode.l10n.t('LCKW jobs'),
          CPU: 'CPU', QSECURITY: 'QSECURITY', 'security settings': vscode.l10n.t('security settings'), compiles: vscode.l10n.t('compiles'), 'library list': vscode.l10n.t('library list'), passwords: vscode.l10n.t('passwords') };
        health.reasons = health.reasons.map(r => r.replace(/^(−\d+) (.+)$/, (_, n: string, w: string) => `${n} ${reasonText[w] ?? w}`));
        const healthLabel = { healthy: vscode.l10n.t('Healthy'), watch: vscode.l10n.t('Keep an eye on it'), action: vscode.l10n.t('Action needed') }[health.label];
        this.lastSummary = () => summaryMarkdown(conn.profile.name, new Date().toLocaleString(), { ...health, label: healthLabel },
          [{ label: 'CPU', value: cpu !== undefined ? `${cpu.toFixed(1)}%` : '—' }, { label: vscode.l10n.t('System ASP'), value: aspUsed !== undefined ? `${aspUsed.toFixed(1)}%` : '—' },
            { label: vscode.l10n.t('Active jobs'), value: String(activeJobs ?? '—') }, { label: 'MSGW / LCKW', value: `${msgw} / ${lckw}` }, { label: vscode.l10n.t('QSYSOPR replies'), value: String(inquiries) },
            { label: vscode.l10n.t('PTF level'), value: cum ? `CUM ${pick(cum, 'L')}` : '—' }], att);
        tabs.push({
          hero: { score: health.score, label: healthLabel, tone: health.label === 'healthy' ? 'ok' : health.label === 'watch' ? 'warn' : 'bad', reasons: health.reasons, spark: sp('score'), sparkTitle: span },
          id: 'overview', title: vscode.l10n.t('Overview'), badge: att.filter(a => a.tone === 'bad' || a.tone === 'warn').length || undefined, badgeTone: att.some(a => a.tone === 'bad') ? 'bad' : 'warn',
          tiles: [
            { label: vscode.l10n.t('System'), value: pick(e0, 'HOST_NAME') || conn.profile.name, sub: release },
            { label: vscode.l10n.t('CPU'), value: cpu !== undefined ? `${cpu.toFixed(1)}%` : '—', sub: pick(s0, 'CONFIGURED_CPUS') ? vscode.l10n.t('{0} CPU(s)', pick(s0, 'CONFIGURED_CPUS')) : '', tone: tone(cpu, 70, 90), act: { label: '', command: 'vanthrex.performanceMonitor' }, meter: cpu, spark: sp('cpu'), sparkTitle: span },
            { label: vscode.l10n.t('System ASP used'), value: aspUsed !== undefined ? `${aspUsed.toFixed(1)}%` : '—', sub: aspMb ? bytes(aspMb * 1024 * 1024) : '', tone: tone(aspUsed, 80, 90), act: { label: '', command: 'vanthrex.tracker.tab', args: ['storage'] }, meter: aspUsed, spark: sp('asp'), sparkTitle: span },
            { label: vscode.l10n.t('Jobs'), value: activeJobs !== undefined ? String(activeJobs) : '—', sub: totalJobs ? vscode.l10n.t('{0} in the system', totalJobs) : '', act: { label: '', command: 'vanthrex.tracker.tab', args: ['jobs'] }, spark: sp('jobs'), sparkTitle: span },
            { label: vscode.l10n.t('Waiting jobs'), value: String(msgw + lckw), sub: `MSGW ${msgw} · LCKW ${lckw}`, tone: msgw ? 'bad' : lckw ? 'warn' : 'ok', act: { label: '', command: 'vanthrex.tracker.tab', args: ['jobs'] } },
            { label: vscode.l10n.t('QSYSOPR replies'), value: String(inquiries), tone: inquiries ? 'bad' : 'ok', act: { label: '', command: 'vanthrex.tracker.tab', args: ['messages'] } },
            { label: vscode.l10n.t('Up since IPL'), value: scpf.rows[0] ? since(pick(scpf.rows[0], 'T')) || '—' : '—', sub: pick(scpf.rows[0], 'T').slice(0, 16) },
            { label: vscode.l10n.t('PTF level'), value: cum ? `CUM ${pick(cum, 'L')}` : '—', sub: tr ? `TR ${pick(tr, 'L')}` : '', act: { label: '', command: 'vanthrex.tracker.tab', args: ['ptf'] } },
            { label: vscode.l10n.t('Libraries'), value: String(libRows.length || '—'), sub: vscode.l10n.t('{0} user libraries', libRows.filter(l => !isIbmLibrary(l.name)).length), act: { label: '', command: 'vanthrex.tracker.tab', args: ['libraries'] } },
            { label: vscode.l10n.t('My compiles'), value: history.length ? `${history.length - history.filter(h => !h.ok).length} / ${history.length}` : '—', sub: broken.length ? vscode.l10n.t('{0} broken now', broken.length) : history.length ? vscode.l10n.t('successful') : '', tone: broken.length ? 'warn' : 'ok', act: { label: '', command: 'vanthrex.compileHistory' } },
          ],
          attention: att,
          buttons: [
            { label: vscode.l10n.t('PDM'), command: 'vanthrex.pdm' }, { label: vscode.l10n.t('Find member'), command: 'vanthrex.findMember' }, { label: vscode.l10n.t('Performance monitor'), command: 'vanthrex.performanceMonitor' },
            { label: vscode.l10n.t('Running SQL'), command: 'vanthrex.activeSql' }, { label: vscode.l10n.t('History log (QHST)'), command: 'vanthrex.historyLog' }, { label: vscode.l10n.t('Exit points'), command: 'vanthrex.exitPoints' },
            { label: vscode.l10n.t('Create library'), command: 'vanthrex.createLibrary' }, { label: vscode.l10n.t('Create IFS folder or file'), command: 'vanthrex.createIfs' },
            { label: vscode.l10n.t('Who is signed on'), command: 'vanthrex.signedOn' },
            { label: vscode.l10n.t('Failed jobs'), command: 'vanthrex.failedJobs' },
            { label: vscode.l10n.t('Copy summary'), command: 'vanthrex.tracker.copySummary' },
          ],
          tables: [],
          error: st.error,
        });
        // ---- libraries
        const userLibs = libRows.filter(l => !isIbmLibrary(l.name));
        const unused = unusedSince(libRows, 365).filter(l => !l.inList);
        const knownSizes = Object.values(sizeCache).filter(z => z.size !== undefined);
        tabs.push({
          id: 'libraries', title: vscode.l10n.t('Libraries'), badge: libRows.length, badgeTone: 'info',
          tiles: [
            { label: vscode.l10n.t('Libraries you can see'), value: String(libRows.length), sub: allObj ? vscode.l10n.t('all of them (*ALLOBJ)') : vscode.l10n.t('those you are authorized to') },
            { label: vscode.l10n.t('User libraries'), value: String(userLibs.length), sub: vscode.l10n.t('{0} TEST', userLibs.filter(l => /TEST/i.test(l.type)).length) },
            { label: vscode.l10n.t('In your library list'), value: String(libRows.filter(l => l.inList).length), sub: missing.length ? vscode.l10n.t('{0} missing', missing.length) : '', tone: missing.length ? 'warn' : 'ok' },
            { label: vscode.l10n.t('Not used for a year'), value: String(unused.length), sub: vscode.l10n.t('cleanup candidates'), tone: unused.length ? 'warn' : 'ok' },
            { label: vscode.l10n.t('Size known'), value: knownSizes.length ? bytes(knownSizes.reduce((a, z) => a + (z.size ?? 0), 0)) : '—', sub: vscode.l10n.t('{0} libraries measured', knownSizes.length) },
            { label: vscode.l10n.t('Your special authorities'), value: auth.split(/\s+/).filter(x => /^\*(ALLOBJ|SECADM|AUDIT|SERVICE|IOSYSCFG|JOBCTL|SPLCTL|SAVSYS)$/.test(x)).filter((x, k, a) => a.indexOf(x) === k).join(' ') || '*NONE', tone: allObj ? 'info' : undefined },
          ],
          buttons: [{ label: vscode.l10n.t('Create library'), command: 'vanthrex.createLibrary' }, { label: vscode.l10n.t('Library list from a job description'), command: 'vanthrex.libraryListFromJobd' }],
          tables: [{
            id: 'libs', title: vscode.l10n.t('Every library on the system'), filter: true, numeric: [6, 7],
            columns: [vscode.l10n.t('Library'), vscode.l10n.t('Type'), vscode.l10n.t('Text'), vscode.l10n.t('Owner'), vscode.l10n.t('Created'), vscode.l10n.t('Last used'), vscode.l10n.t('Objects'), vscode.l10n.t('Size'), vscode.l10n.t('Library list')],
            rows: libRows.map(l => [l.name, l.type, l.text, l.owner, l.created, l.lastUsed, '', '', l.inList ? `★ ${l.inList}` : '']),
            acts: libRows.map(l => [
              { label: vscode.l10n.t('PDM'), command: 'vanthrex.pdm', args: [{ level: 'objects', library: l.name }] },
              ...(l.inList ? [] : [{ label: vscode.l10n.t('+ list'), command: 'vanthrex.tracker.addLibrary', args: [l.name] }]),
              { label: vscode.l10n.t('Pin'), command: 'vanthrex.pin', args: [{ kind: 'library', library: l.name }] },
              { label: vscode.l10n.t('Storage'), command: 'vanthrex.storageAdvisor', args: [l.name] },
              { label: '*PUBLIC', command: 'vanthrex.publicAuthorityScan', args: [l.name] },
            ]),
            tones: libRows.map(l => (l.inList ? 'info' : unused.includes(l) ? 'warn' : undefined)),
            empty: libs.error ?? vscode.l10n.t('No libraries.'),
          }],
          note: allObj ? vscode.l10n.t('You have *ALLOBJ, so every library is listed. Objects and size are calculated on request and remembered.')
            : vscode.l10n.t('You see the libraries you are authorized to; a profile with *ALLOBJ sees them all (*SECADM manages profiles, not objects). Objects and size are calculated on request and remembered.'),
        });
        // ---- jobs
        const subStats = new Map(subs.rows.map(r => [pick(r, 'S'), { jobs: num(pick(r, 'N')) ?? 0, cpu: num(pick(r, 'C')) ?? 0, msgw: num(pick(r, 'W')) ?? 0 }]));
        const sbsRows = (sbsInfo.rows.length ? sbsInfo.rows.map(r => {
          const name = pick(r, 'SUBSYSTEM_DESCRIPTION', 'SUBSYSTEM_NAME'); const st = subStats.get(name);
          const jobs = num(pick(r, 'CURRENT_ACTIVE_JOBS')) ?? st?.jobs ?? 0; const max = pick(r, 'MAXIMUM_ACTIVE_JOBS');
          return { name, lib: pick(r, 'SUBSYSTEM_DESCRIPTION_LIBRARY'), status: pick(r, 'STATUS'), jobs, max: max === '0' ? '*NOMAX' : max, cpu: st?.cpu ?? 0, msgw: st?.msgw ?? 0,
            full: !!num(max) && jobs >= (num(max) ?? 0) };
        }) : subs.rows.map(r => ({ name: pick(r, 'S'), lib: '', status: 'ACTIVE', jobs: num(pick(r, 'N')) ?? 0, max: '', cpu: num(pick(r, 'C')) ?? 0, msgw: num(pick(r, 'W')) ?? 0, full: false })))
          .sort((a, b) => (a.status === b.status ? b.jobs - a.jobs : a.status === 'ACTIVE' ? -1 : 1));
        tabs.push({
          id: 'jobs', title: vscode.l10n.t('Jobs'), badge: msgw || undefined, badgeTone: 'bad',
          tiles: [
            { label: vscode.l10n.t('Active jobs'), value: activeJobs !== undefined ? String(activeJobs) : '—' }, { label: vscode.l10n.t('Waiting for a reply'), value: String(msgw), tone: msgw ? 'bad' : 'ok' },
            { label: vscode.l10n.t('Waiting for a lock'), value: String(lckw), tone: lckw ? 'warn' : 'ok' }, { label: vscode.l10n.t('Subsystems'), value: String(subs.rows.length) },
          ],
          buttons: [{ label: vscode.l10n.t('Running SQL'), command: 'vanthrex.activeSql' }, { label: vscode.l10n.t('Performance monitor'), command: 'vanthrex.performanceMonitor' }],
          tables: [
            { title: vscode.l10n.t('Waiting jobs (MSGW, and LCKW for batch and interactive jobs)'), columns: [vscode.l10n.t('Job'), vscode.l10n.t('User'), vscode.l10n.t('Subsystem'), vscode.l10n.t('Status'), vscode.l10n.t('Function')],
              rows: waiting.rows.map(r => [pick(r, 'J'), pick(r, 'U'), pick(r, 'S'), pick(r, 'ST'), pick(r, 'F')]), tones: waiting.rows.map(r => (pick(r, 'ST') === 'MSGW' ? 'bad' : 'warn')),
              acts: waiting.rows.map(r => jobActs(pick(r, 'J'))), empty: waiting.error ?? vscode.l10n.t('No job is waiting. 👍') },
            { title: vscode.l10n.t('Top jobs by CPU'), filter: true, numeric: [5, 6], columns: [vscode.l10n.t('Job'), vscode.l10n.t('User'), vscode.l10n.t('Subsystem'), vscode.l10n.t('Status'), vscode.l10n.t('Function'), vscode.l10n.t('CPU %'), vscode.l10n.t('Temp storage (MB)')],
              rows: top.rows.map(r => [pick(r, 'J'), pick(r, 'U'), pick(r, 'S'), pick(r, 'ST'), pick(r, 'F'), num(pick(r, 'C')) ?? '', num(pick(r, 'M')) ?? '']),
              acts: top.rows.map(r => jobActs(pick(r, 'J'))), empty: top.error },
            { title: vscode.l10n.t('Subsystems'), filter: true, numeric: [3, 4, 5, 6], columns: [vscode.l10n.t('Subsystem'), vscode.l10n.t('Library'), vscode.l10n.t('Status'), vscode.l10n.t('Jobs'), vscode.l10n.t('Maximum'), vscode.l10n.t('CPU %'), 'MSGW'],
              rows: sbsRows.map(x => [x.name, x.lib, x.status, x.jobs, x.max, x.cpu, x.msgw]), tones: sbsRows.map(x => (x.msgw ? 'bad' : x.full ? 'warn' : x.status === 'INACTIVE' ? 'info' : undefined)),
              empty: sbsInfo.error ?? subs.error },
          ],
        });
        // ---- storage
        tabs.push({
          id: 'storage', title: vscode.l10n.t('Storage'), badge: aspUsed !== undefined && aspUsed >= 80 ? 1 : undefined, badgeTone: tone(aspUsed, 80, 90),
          tiles: [
            { label: vscode.l10n.t('System ASP used'), value: aspUsed !== undefined ? `${aspUsed.toFixed(1)}%` : '—', tone: tone(aspUsed, 80, 90) },
            { label: vscode.l10n.t('System ASP size'), value: aspMb ? bytes(aspMb * 1024 * 1024) : '—' },
            { label: vscode.l10n.t('Free'), value: aspMb && aspUsed !== undefined ? bytes(aspMb * (100 - aspUsed) / 100 * 1024 * 1024) : '—' },
          ],
          buttons: [{ label: vscode.l10n.t('Library sizes'), command: 'vanthrex.tracker.tab', args: ['libraries'] }],
          tables: [{ id: 'largest', title: vscode.l10n.t('Largest libraries (measured)'), numeric: [1, 2], columns: [vscode.l10n.t('Library'), vscode.l10n.t('Objects'), vscode.l10n.t('Size')], rows: [],
            empty: vscode.l10n.t('Calculate library sizes in the Libraries tab first.') }, { title: vscode.l10n.t('Auxiliary storage pools'), columns: asp.rows[0] ? Object.keys(asp.rows[0]).slice(0, 10) : ['ASP'],
            rows: asp.rows.map(r => Object.keys(asp.rows[0]).slice(0, 10).map(k => pick(r, k))), empty: asp.error ?? vscode.l10n.t('No ASP information.') }],
        });
        // ---- messages
        tabs.push({
          id: 'messages', title: 'QSYSOPR', badge: inquiries || undefined, badgeTone: 'bad',
          buttons: [{ label: vscode.l10n.t('Work with QSYSOPR (reply, remove)'), command: 'vanthrex.messageQueue', args: ['QSYS/QSYSOPR'] }, { label: vscode.l10n.t('History log (QHST)'), command: 'vanthrex.historyLog' }],
          tables: [{ title: vscode.l10n.t('Latest QSYSOPR messages'), filter: true, columns: [vscode.l10n.t('Time'), vscode.l10n.t('Message'), vscode.l10n.t('Type'), vscode.l10n.t('Sev'), vscode.l10n.t('Text'), vscode.l10n.t('From job')],
            rows: qsysopr.rows.map(r => [pick(r, 'T'), pick(r, 'I'), pick(r, 'Y'), num(pick(r, 'S')) ?? 0, pick(r, 'X'), pick(r, 'J')]),
            tones: qsysopr.rows.map(r => (/INQUIRY/i.test(pick(r, 'Y')) ? 'bad' : (num(pick(r, 'S')) ?? 0) >= 30 ? 'warn' : undefined)),
            acts: qsysopr.rows.map(r => [...(pick(r, 'I') ? [{ label: vscode.l10n.t('Explain'), command: 'vanthrex.explainMessage', args: [pick(r, 'I')] }] : []),
              ...(pick(r, 'J') ? [{ label: vscode.l10n.t('Job log'), command: 'vanthrex.jobLog', args: [{ job: pick(r, 'J') }] }] : [])]),
            empty: qsysopr.error ?? vscode.l10n.t('No messages.') }],
        });
        // ---- users
        tabs.push({
          id: 'users', title: vscode.l10n.t('Users'), badge: advice.filter(a => a.tone === 'bad').length || undefined, badgeTone: 'bad',
          tiles: [
            { label: vscode.l10n.t('User profiles'), value: pick(u0, 'N') || '—' }, { label: vscode.l10n.t('Enabled'), value: pick(u0, 'E') || '—', tone: 'ok' }, { label: vscode.l10n.t('Disabled'), value: pick(u0, 'D') || '—' },
            { label: vscode.l10n.t('Not signed on for 90 days'), value: pick(u0, 'O') || '—', tone: (num(pick(u0, 'O')) ?? 0) > 0 ? 'warn' : 'ok', act: { label: '', command: 'vanthrex.secadm.inactive' } },
            { label: vscode.l10n.t('Expired passwords'), value: pick(u0, 'X') || '—', tone: (num(pick(u0, 'X')) ?? 0) > 0 ? 'warn' : 'ok' },
            { label: vscode.l10n.t('*ALLOBJ / *SECADM'), value: String(powerful.rows.length), act: { label: '', command: 'vanthrex.secadm.powerful' } },
          ],
          buttons: [{ label: vscode.l10n.t('Security Admin (*SECADM)'), command: 'vanthrex.securityCenter' }],
          tables: [{ title: vscode.l10n.t('Security settings (system values)'), columns: [vscode.l10n.t('System value'), vscode.l10n.t('Value'), vscode.l10n.t('Assessment')],
            rows: advice.map(a => [a.name, a.value, `${a.tone === 'ok' ? '✓' : a.tone === 'bad' ? '✗' : a.tone === 'warn' ? '⚠' : ''} ${a.advice}`.trim()]),
            tones: advice.map(a => (a.tone === 'ok' || a.tone === 'info' ? undefined : a.tone)), empty: sysvals.error ?? vscode.l10n.t('Not available.') },
            { title: vscode.l10n.t('Failed sign-on attempts'), numeric: [2], columns: [vscode.l10n.t('User'), vscode.l10n.t('Status'), vscode.l10n.t('Invalid attempts'), vscode.l10n.t('Last sign-on')],
              rows: failedSignon.rows.map(r => [pick(r, 'U'), pick(r, 'S'), num(pick(r, 'F')) ?? 0, pick(r, 'P').slice(0, 16)]),
              tones: failedSignon.rows.map(r => (pick(r, 'S') === '*DISABLED' ? 'bad' : (num(pick(r, 'F')) ?? 0) >= 2 ? 'warn' : undefined)), empty: failedSignon.error ?? vscode.l10n.t('No failed sign-on attempts. 👍') },
            { title: vscode.l10n.t('Powerful profiles'), filter: true, columns: [vscode.l10n.t('User'), vscode.l10n.t('Status'), vscode.l10n.t('Class'), vscode.l10n.t('Special authorities'), vscode.l10n.t('Last sign-on')],
            rows: powerful.rows.map(r => [pick(r, 'U'), pick(r, 'S'), pick(r, 'C'), pick(r, 'A'), pick(r, 'P').slice(0, 16)]),
            tones: powerful.rows.map(r => (pick(r, 'S') === '*ENABLED' ? 'warn' : undefined)),
            empty: powerful.error ?? vscode.l10n.t('None you are allowed to see.') }],
          note: vscode.l10n.t('You only see the profiles you are authorized to; with *SECADM you see them all.'),
          error: users.error,
        });
        // ---- queues
        const jq = jobqs.rows.map(r => ({ lib: pick(r, 'JOB_QUEUE_LIBRARY'), name: pick(r, 'JOB_QUEUE_NAME'), status: pick(r, 'JOB_QUEUE_STATUS'), jobs: num(pick(r, 'NUMBER_OF_JOBS')) ?? 0,
          sbs: pick(r, 'SUBSYSTEM_NAME'), held: num(pick(r, 'HELD_JOB_COUNT')), sched: num(pick(r, 'SCHEDULED_JOB_COUNT')), text: pick(r, 'TEXT_DESCRIPTION') }));
        const stuckJq = jq.filter(q => q.jobs > 0 && (q.status === 'HELD' || !q.sbs));
        const oq = outqs.rows.map(r => ({ lib: pick(r, 'OUTPUT_QUEUE_LIBRARY_NAME', 'OUTPUT_QUEUE_LIBRARY'), name: pick(r, 'OUTPUT_QUEUE_NAME'), files: num(pick(r, 'NUMBER_OF_FILES')) ?? 0,
          status: pick(r, 'OUTPUT_QUEUE_STATUS'), writer: pick(r, 'WRITER_JOB_NAME'), wstatus: pick(r, 'WRITER_JOB_STATUS', 'WRITER_STATUS'), text: pick(r, 'TEXT_DESCRIPTION') }));
        const qAct = (kind: 'jobq' | 'outq', lib: string, name: string, held: boolean): Act[] => {
          try {
            const cmd = queueCommand(kind, held ? 'release' : 'hold', lib, name);
            return [{ label: held ? vscode.l10n.t('Release') : vscode.l10n.t('Hold'), command: 'vanthrex.tracker.cl', args: [cmd] }];
          } catch { return []; }
        };
        tabs.push({
          id: 'queues', title: vscode.l10n.t('Queues'), badge: stuckJq.length || undefined, badgeTone: 'warn',
          tiles: [
            { label: vscode.l10n.t('Jobs waiting in job queues'), value: String(jq.reduce((a, q) => a + q.jobs, 0)), sub: vscode.l10n.t('{0} job queue(s)', jq.length) },
            { label: vscode.l10n.t('Stuck job queues'), value: String(stuckJq.length), sub: vscode.l10n.t('held, or not attached to a subsystem, with jobs'), tone: stuckJq.length ? 'warn' : 'ok' },
            { label: vscode.l10n.t('Spooled files in output queues'), value: oq.reduce((a, q) => a + q.files, 0).toLocaleString(), sub: vscode.l10n.t('{0} output queue(s)', oq.length) },
            { label: vscode.l10n.t('Held output queues'), value: String(oq.filter(q => /HELD/i.test(q.status)).length) },
          ],
          buttons: [{ label: vscode.l10n.t('Spooled files'), command: 'vanthrex.spool.focus' }],
          tables: [
            { title: vscode.l10n.t('Job queues'), filter: true, numeric: [4, 5, 6], columns: [vscode.l10n.t('Library'), vscode.l10n.t('Job queue'), vscode.l10n.t('Status'), vscode.l10n.t('Subsystem'), vscode.l10n.t('Jobs'), vscode.l10n.t('Held'), vscode.l10n.t('Scheduled'), vscode.l10n.t('Text')],
              rows: jq.map(q => [q.lib, q.name, q.status, q.sbs || '—', q.jobs, q.held ?? '', q.sched ?? '', q.text]),
              tones: jq.map(q => (stuckJq.includes(q) ? 'warn' : undefined)), acts: jq.map(q => qAct('jobq', q.lib, q.name, q.status === 'HELD')), empty: jobqs.error },
            { title: vscode.l10n.t('Output queues (most spooled files first)'), filter: true, numeric: [2], columns: [vscode.l10n.t('Library'), vscode.l10n.t('Output queue'), vscode.l10n.t('Files'), vscode.l10n.t('Status'), vscode.l10n.t('Writer'), vscode.l10n.t('Text')],
              rows: oq.map(q => [q.lib, q.name, q.files, q.status, [q.writer, q.wstatus].filter(Boolean).join(' '), q.text]),
              tones: oq.map(q => (q.files > 5000 ? 'warn' : undefined)), acts: oq.map(q => qAct('outq', q.lib, q.name, /HELD/i.test(q.status))), empty: outqs.error },
          ],
          note: vscode.l10n.t('Hold and release ask before they run, and respect the protection of this connection.'),
        });
        // ---- network
        const estBy = new Map(estab.rows.map(r => [num(pick(r, 'P')) ?? 0, num(pick(r, 'N')) ?? 0]));
        const ports = listen.rows.map(r => num(pick(r, 'P')) ?? 0).filter((p, i, a) => p && a.indexOf(p) === i);
        const plain = ports.filter(p => unencrypted(p));
        tabs.push({
          id: 'network', title: vscode.l10n.t('Network'),
          tiles: [
            { label: vscode.l10n.t('Listening ports'), value: String(ports.length) },
            { label: vscode.l10n.t('Open connections'), value: [...estBy.values()].reduce((a, b) => a + b, 0).toLocaleString() },
            { label: vscode.l10n.t('Unencrypted services'), value: String(plain.length), sub: plain.slice(0, 6).map(p => portName(p) || p).join(', '), tone: plain.length ? 'warn' : 'ok' },
          ],
          tables: [
            { title: vscode.l10n.t('Servers listening'), filter: true, numeric: [2], columns: [vscode.l10n.t('Port'), vscode.l10n.t('Service'), vscode.l10n.t('Connections'), vscode.l10n.t('Encrypted')],
              rows: ports.map(p => [String(p), portName(p), estBy.get(p) ?? 0, unencrypted(p) ? vscode.l10n.t('no') : '']), tones: ports.map(p => (unencrypted(p) && (estBy.get(p) ?? 0) > 0 ? 'warn' : undefined)), empty: listen.error },
            { title: vscode.l10n.t('Who is connected (top 25 addresses)'), numeric: [1, 2], columns: [vscode.l10n.t('Remote address'), vscode.l10n.t('Connections'), vscode.l10n.t('Port')],
              rows: remotes.rows.map(r => [pick(r, 'R'), num(pick(r, 'N')) ?? 0, `${pick(r, 'P')} ${portName(num(pick(r, 'P')) ?? 0)}`.trim()]), empty: remotes.error },
          ],
        });
        // ---- scheduled jobs
        const sch = scheds.rows.map(r => ({ entry: num(pick(r, 'SCHEDULED_JOB_ENTRY_NUMBER')) ?? 0, name: pick(r, 'SCHEDULED_JOB_NAME'), status: pick(r, 'STATUS'), freq: pick(r, 'FREQUENCY'),
          when: [pick(r, 'SCHEDULED_DATE_VALUE', 'SCHEDULED_DATE'), pick(r, 'SCHEDULED_TIME'), pick(r, 'SCHEDULED_DAYS')].filter(Boolean).join(' '),
          next: pick(r, 'NEXT_SUBMISSION_DATE').slice(0, 10), cmd: pick(r, 'COMMAND_STRING'), by: pick(r, 'SCHEDULED_BY'), jobq: pick(r, 'JOB_QUEUE_NAME'), text: pick(r, 'DESCRIPTION', 'TEXT_DESCRIPTION') }))
          .sort((a, b) => (a.next || '9').localeCompare(b.next || '9'));
        const heldSch = sch.filter(x => /HELD|HLD/i.test(x.status));
        const schAct = (x: typeof sch[number]): Act[] => { try { return [{ label: /HELD|HLD/i.test(x.status) ? vscode.l10n.t('Release') : vscode.l10n.t('Hold'), command: 'vanthrex.tracker.cl', args: [scheduleCommand(/HELD|HLD/i.test(x.status) ? 'release' : 'hold', x.name, x.entry)] }]; } catch { return []; } };
        const today = new Date().toISOString().slice(0, 10);
        tabs.push({
          id: 'schedule', title: vscode.l10n.t('Scheduled jobs'), badge: heldSch.length || undefined, badgeTone: 'warn',
          tiles: [
            { label: vscode.l10n.t('Schedule entries'), value: String(sch.length) }, { label: vscode.l10n.t('Running today'), value: String(sch.filter(x => x.next === today).length) },
            { label: vscode.l10n.t('Held'), value: String(heldSch.length), tone: heldSch.length ? 'warn' : 'ok' },
          ],
          tables: [{ title: vscode.l10n.t('Job schedule (next run first)'), filter: true, numeric: [0],
            columns: [vscode.l10n.t('Entry'), vscode.l10n.t('Job'), vscode.l10n.t('Status'), vscode.l10n.t('Frequency'), vscode.l10n.t('When'), vscode.l10n.t('Next run'), vscode.l10n.t('Command'), vscode.l10n.t('Job queue'), vscode.l10n.t('Added by')],
            rows: sch.map(x => [String(x.entry).padStart(6, '0'), x.name, x.status, x.freq, x.when, x.next, x.cmd.slice(0, 120), x.jobq, x.by]),
            tones: sch.map(x => (/HELD|HLD/i.test(x.status) ? 'warn' : x.next === today ? 'info' : undefined)), acts: sch.map(schAct), empty: scheds.error ?? vscode.l10n.t('No scheduled jobs.') }],
          note: vscode.l10n.t('Hold and release ask before they run, and respect the protection of this connection.'),
        });
        // ---- journals
        const jr = journals.rows.map(r => {
          const kb = num(pick(r, 'TOTAL_SIZE_JOURNAL_RECEIVERS')); const bytesTotal = kb !== undefined ? kb * 1024 : undefined;
          const n = num(pick(r, 'NUMBER_JOURNAL_RECEIVERS'));
          return { lib: pick(r, 'JOURNAL_LIBRARY'), name: pick(r, 'JOURNAL_NAME'), rcv: [pick(r, 'ATTACHED_JOURNAL_RECEIVER_LIBRARY'), pick(r, 'ATTACHED_JOURNAL_RECEIVER_NAME')].filter(Boolean).join('/'),
            n, bytes: bytesTotal, objects: num(pick(r, 'NUMBER_JOURNALED_OBJECTS', 'JOURNALED_OBJECTS')), state: pick(r, 'JOURNAL_STATE'), tone: journalTone(n, bytesTotal) };
        }).sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
        tabs.push({
          id: 'journals', title: vscode.l10n.t('Journals'), badge: jr.filter(j => j.tone).length || undefined, badgeTone: jr.some(j => j.tone === 'bad') ? 'bad' : 'warn',
          tiles: [
            { label: vscode.l10n.t('Journals (user libraries)'), value: String(jr.length) },
            { label: vscode.l10n.t('Receivers kept'), value: jr.reduce((a, j) => a + (j.n ?? 0), 0).toLocaleString(), sub: bytes(jr.reduce((a, j) => a + (j.bytes ?? 0), 0)) },
            { label: vscode.l10n.t('Need cleanup'), value: String(jr.filter(j => j.tone).length), sub: vscode.l10n.t('50+ receivers or 10 GB+'), tone: jr.some(j => j.tone === 'bad') ? 'bad' : jr.some(j => j.tone) ? 'warn' : 'ok' },
          ],
          tables: [{ title: vscode.l10n.t('Journals (largest first)'), filter: true, numeric: [3, 4, 5], columns: [vscode.l10n.t('Library'), vscode.l10n.t('Journal'), vscode.l10n.t('Attached receiver'), vscode.l10n.t('Receivers'), vscode.l10n.t('Size'), vscode.l10n.t('Objects'), vscode.l10n.t('State')],
            rows: jr.map(j => [j.lib, j.name, j.rcv, j.n ?? '', bytes(j.bytes), j.objects ?? '', j.state]), tones: jr.map(j => j.tone),
            acts: jr.map(j => [{ label: vscode.l10n.t('Work with'), command: 'vanthrex.journals', args: [{ kind: 'library', library: j.lib }] }]), empty: journals.error ?? vscode.l10n.t('No journals in user libraries.') }],
        });
        // ---- what changed (scan on request)
        tabs.push({
          id: 'objects', title: vscode.l10n.t('What changed'),
          buttons: [
            { label: vscode.l10n.t('Changed today (library list)'), command: 'vanthrex.tracker.scan', args: [1, 'libl', 'changed'] },
            { label: vscode.l10n.t('Changed in 7 days (library list)'), command: 'vanthrex.tracker.scan', args: [7, 'libl', 'changed'] },
            { label: vscode.l10n.t('Changed today (all user libraries — slow)'), command: 'vanthrex.tracker.scan', args: [1, 'all', 'changed'] },
            { label: vscode.l10n.t('Largest objects (library list)'), command: 'vanthrex.tracker.scan', args: [1, 'libl', 'size'] },
            { label: vscode.l10n.t('Largest objects (all user libraries — slow)'), command: 'vanthrex.tracker.scan', args: [1, 'all', 'size'] },
          ],
          tables: this.scan ? [this.scan] : [],
          note: vscode.l10n.t('Pick a scan above. Scanning every user library reads every object description and can take minutes on a big system.'),
        });
        // ---- all connected systems
        const others = this.manager.openConnections;
        tabs.push({
          id: 'systems', title: vscode.l10n.t('All systems'), buttons: others.length > 1 ? [{ label: vscode.l10n.t('Compare system values'), command: 'vanthrex.compareSystemValues' }] : [], badge: others.length > 1 ? others.length : undefined, badgeTone: 'info',
          tables: [{ title: vscode.l10n.t('Connected systems'), numeric: [1, 2, 3, 4, 5], columns: [vscode.l10n.t('System'), vscode.l10n.t('Health'), 'CPU %', 'ASP %', 'MSGW', vscode.l10n.t('QSYSOPR replies')],
            rows: [], id: 'systems', empty: vscode.l10n.t('Loading the other systems…') }],
          note: others.length > 1 ? vscode.l10n.t('Every system you are connected to, read in parallel.') : vscode.l10n.t('Connect to more systems (Connections view) to compare them here.'),
        });
        // ---- PTFs
        tabs.push({
          id: 'ptf', title: vscode.l10n.t('PTFs & software'),
          tiles: [{ label: vscode.l10n.t('Release'), value: release || '—' }, { label: vscode.l10n.t('Cumulative PTF'), value: cum ? pick(cum, 'L') : '—', sub: cum ? pick(cum, 'G') : '' },
            { label: vscode.l10n.t('Technology Refresh'), value: tr ? pick(tr, 'L') : '—' }],
          buttons: [{ label: vscode.l10n.t('Installed software & license keys'), command: 'vanthrex.installedSoftware' }, { label: vscode.l10n.t('Is this PTF installed?'), command: 'vanthrex.ptfLookup' }],
          tables: [{ title: vscode.l10n.t('Installed PTF groups'), filter: true, columns: [vscode.l10n.t('Group'), vscode.l10n.t('Description'), vscode.l10n.t('Level')], rows: ptf.rows.map(r => [pick(r, 'G'), pick(r, 'D'), pick(r, 'L')]), empty: ptf.error }],
        });
        // ---- my work
        tabs.push({
          id: 'mine', title: vscode.l10n.t('My work'), badge: broken.length || undefined, badgeTone: 'warn',
          tiles: [
            { label: vscode.l10n.t('My active jobs'), value: String(myJobs.rows.length) }, { label: vscode.l10n.t('My spooled files'), value: pick(mySpool.rows[0], 'N') || '—' },
            { label: vscode.l10n.t('Members I changed (7 days)'), value: String(myMembers.rows.length) }, { label: vscode.l10n.t('Broken compiles'), value: String(broken.length), tone: broken.length ? 'warn' : 'ok', act: { label: '', command: 'vanthrex.compileHistory' } },
            { label: vscode.l10n.t('Pinned'), value: String(pins.length) },
          ],
          buttons: [{ label: vscode.l10n.t('Compile history'), command: 'vanthrex.compileHistory' }, { label: vscode.l10n.t('Find member'), command: 'vanthrex.findMember' }],
          tables: [
            { title: vscode.l10n.t('Broken right now'), columns: [vscode.l10n.t('Source'), vscode.l10n.t('Object'), vscode.l10n.t('Errors'), vscode.l10n.t('When')], rows: broken.map(b => [b.name, b.object, b.errors, new Date(b.at).toLocaleString()]),
              tones: broken.map(() => 'bad'), acts: broken.map(b => [{ label: vscode.l10n.t('Open'), command: 'vanthrex.compileHistory.open', args: [b.uri] }]), empty: vscode.l10n.t('Nothing broken. 👍') },
            { title: vscode.l10n.t('Source changed in your library list (last 7 days)'), filter: true, columns: [vscode.l10n.t('Member'), vscode.l10n.t('Type'), vscode.l10n.t('Text'), vscode.l10n.t('Changed')],
              rows: myMembers.rows.map(r => [`${pick(r, 'L')}/${pick(r, 'F')}(${pick(r, 'M')})`, pick(r, 'Y'), pick(r, 'X'), pick(r, 'C').slice(0, 16)]),
              acts: myMembers.rows.map(r => [{ label: vscode.l10n.t('Open'), command: 'vanthrex.compileHistory.open', args: [memberUri(pick(r, 'L'), pick(r, 'F'), pick(r, 'M'), pick(r, 'Y')).toString()] },
                { label: vscode.l10n.t('PDM'), command: 'vanthrex.pdm', args: [{ level: 'members', library: pick(r, 'L'), file: pick(r, 'F'), name: pick(r, 'M') }] }]), empty: myMembers.error ?? vscode.l10n.t('No changes in the last 7 days.') },
            { title: vscode.l10n.t('My jobs'), columns: [vscode.l10n.t('Job'), vscode.l10n.t('Subsystem'), vscode.l10n.t('Status'), vscode.l10n.t('Function'), vscode.l10n.t('CPU %')], rows: myJobs.rows.map(r => [pick(r, 'J'), pick(r, 'S'), pick(r, 'ST'), pick(r, 'F'), num(pick(r, 'C')) ?? '']),
              acts: myJobs.rows.map(r => jobActs(pick(r, 'J'))), empty: myJobs.error },
            { title: vscode.l10n.t('Pinned'), columns: [vscode.l10n.t('Item'), vscode.l10n.t('Where')], rows: pins.map(p => [pinLabel(p), pinDescription(p)]), acts: pins.map(p => [{ label: vscode.l10n.t('Open'), command: 'vanthrex.pin.open', args: [p] }]),
              empty: vscode.l10n.t('Right-click a member, library, object or IFS file → Pin.') },
          ],
        });

        // Turn actions into indexes for the page.
        const enc = (a?: Act) => (a ? this.ref(a) : -1);
        if (!partial) { void this.loadSystems(conn.profile.id, gen); }
        const out = tabs.map(tb => ({
          ...tb, buttons: (tb.buttons ?? []).map(b => ({ label: b.label, i: enc(b) })),
          tiles: (tb.tiles ?? []).map(x => ({ ...x, act: enc(x.act) })),
          attention: tb.attention?.map(a => ({ ...a, i: a.command ? enc({ label: a.action ?? '', command: a.command, args: a.args }) : -1 })),
          tables: tb.tables.map(x => ({ ...x, acts: (x.acts ?? []).map(r => r.map(a => ({ label: a.label, i: enc(a) }))) })),
        }));
        this.post({ t: 'data', tabs: out, at: new Date().toLocaleTimeString(), first: this.firstTab, sizes: sizeCache, partial });
        if (!partial) {
        Tracker.last.set(conn.profile.id, { tabs: out, at: new Date().toLocaleTimeString(), sizes: sizeCache, acts: [...this.acts].filter(([i]) => i >= buildFrom) });
        // Forget the actions of pages older than the previous one.
        for (const i of [...this.acts.keys()]) { if (i < this.keepFrom) { this.acts.delete(i); } }
        this.keepFrom = buildFrom;
      }
      };
      // Queries run one after the other in the SQL job: start the ones the Overview needs first, show the page as soon as
      // they are back, then fill in the rest (libraries, network, journals…) when it arrives.
      const started = {
        st: safe(conn, 'SELECT * FROM QSYS2.SYSTEM_STATUS_INFO', 1),
        env: safe(conn, 'SELECT * FROM SYSIBMADM.ENV_SYS_INFO', 1),
        waitCount: safe(conn, `SELECT SUM(CASE WHEN JOB_STATUS = 'MSGW' THEN 1 ELSE 0 END) AS W, SUM(CASE WHEN JOB_STATUS = 'LCKW' AND JOB_TYPE IN ('BCH', 'BCI', 'INT', 'ASJ') THEN 1 ELSE 0 END) AS L ` +
          `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X`, 1),
        asp: safe(conn, 'SELECT * FROM QSYS2.ASP_INFO', 50),
        myAuth: safe(conn, `SELECT COALESCE(U.SPECIAL_AUTHORITIES, '') || ' ' || COALESCE((SELECT G.SPECIAL_AUTHORITIES FROM QSYS2.USER_INFO G WHERE G.AUTHORIZATION_NAME = U.GROUP_PROFILE_NAME), '') AS A ` +
          `FROM QSYS2.USER_INFO U WHERE U.AUTHORIZATION_NAME = ${sqlString(me)}`, 1),
        qsysopr: safe(conn, `SELECT VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS T, COALESCE(MESSAGE_ID, '') AS I, MESSAGE_TYPE AS Y, COALESCE(SEVERITY, 0) AS S, ` +
          `COALESCE(MESSAGE_TEXT, '') AS X, COALESCE(FROM_JOB, '') AS J FROM QSYS2.MESSAGE_QUEUE_INFO WHERE MESSAGE_QUEUE_LIBRARY = 'QSYS' AND MESSAGE_QUEUE_NAME = 'QSYSOPR' ` +
          `ORDER BY MESSAGE_TIMESTAMP DESC FETCH FIRST 60 ROWS ONLY`, 60),
        users: safe(conn, `SELECT COUNT(*) AS N, SUM(CASE WHEN STATUS = '*ENABLED' THEN 1 ELSE 0 END) AS E, SUM(CASE WHEN STATUS = '*DISABLED' THEN 1 ELSE 0 END) AS D, ` +
          `SUM(CASE WHEN STATUS = '*ENABLED' AND DATE_PASSWORD_EXPIRES < CURRENT TIMESTAMP THEN 1 ELSE 0 END) AS X, ` +
          `SUM(CASE WHEN STATUS = '*ENABLED' AND (PREVIOUS_SIGNON IS NULL OR PREVIOUS_SIGNON < CURRENT TIMESTAMP - 90 DAYS) THEN 1 ELSE 0 END) AS O ` +
          `FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME NOT LIKE 'Q%'`, 1),
        sysvals: safe(conn, `SELECT SYSTEM_VALUE_NAME AS N, COALESCE(VARCHAR(CURRENT_NUMERIC_VALUE), CURRENT_CHARACTER_VALUE, '') AS V FROM QSYS2.SYSTEM_VALUE_INFO ` +
          `WHERE SYSTEM_VALUE_NAME IN (${SECURITY_VALUES.map(sqlString).join(', ')})`, 50),
        scpf: safe(conn, `SELECT VARCHAR(JOB_ACTIVE_TIME) AS T FROM TABLE(QSYS2.ACTIVE_JOB_INFO(JOB_NAME_FILTER => 'SCPF', DETAILED_INFO => 'ALL')) X`, 1),
        ptf: safe(conn, `SELECT PTF_GROUP_NAME AS G, MAX(PTF_GROUP_DESCRIPTION) AS D, MAX(PTF_GROUP_LEVEL) AS L FROM QSYS2.GROUP_PTF_INFO WHERE PTF_GROUP_STATUS = 'INSTALLED' GROUP BY PTF_GROUP_NAME ORDER BY 1`, 300),
        waiting: safe(conn, `SELECT JOB_NAME AS J, AUTHORIZATION_NAME AS U, SUBSYSTEM AS S, JOB_STATUS AS ST, COALESCE(FUNCTION, '') AS F FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X ` +
          `WHERE JOB_STATUS = 'MSGW' OR (JOB_STATUS = 'LCKW' AND JOB_TYPE IN ('BCH', 'BCI', 'INT', 'ASJ')) ORDER BY JOB_STATUS DESC, JOB_NAME FETCH FIRST 300 ROWS ONLY`, 300),
        myJobs: safe(conn, `SELECT JOB_NAME AS J, SUBSYSTEM AS S, JOB_STATUS AS ST, COALESCE(FUNCTION, '') AS F, ELAPSED_CPU_PERCENTAGE AS C FROM TABLE(QSYS2.ACTIVE_JOB_INFO(CURRENT_USER_LIST_FILTER => ${sqlString(me)}, DETAILED_INFO => 'NONE')) X ORDER BY JOB_NAME`, 100),
        mySpool: safe(conn, `SELECT COUNT(*) AS N FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE USER_NAME = ${sqlString(me)}`, 1),
        top: safe(conn, `SELECT JOB_NAME AS J, AUTHORIZATION_NAME AS U, SUBSYSTEM AS S, JOB_STATUS AS ST, COALESCE(FUNCTION, '') AS F, ELAPSED_CPU_PERCENTAGE AS C, TEMPORARY_STORAGE AS M ` +
          `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X WHERE JOB_TYPE <> 'SYS' ORDER BY ELAPSED_CPU_PERCENTAGE DESC FETCH FIRST 25 ROWS ONLY`, 25),
        scheds: safe(conn, 'SELECT * FROM QSYS2.SCHEDULED_JOB_INFO', 2000),
        sbsInfo: safe(conn, 'SELECT * FROM QSYS2.SUBSYSTEM_INFO', 500),
        journals: safe(conn, `SELECT * FROM QSYS2.JOURNAL_INFO WHERE JOURNAL_LIBRARY NOT LIKE 'Q%'`, 3000),
        failedSignon: safe(conn, `SELECT AUTHORIZATION_NAME AS U, STATUS AS S, SIGN_ON_ATTEMPTS_NOT_VALID AS F, VARCHAR(PREVIOUS_SIGNON) AS P FROM QSYS2.USER_INFO WHERE SIGN_ON_ATTEMPTS_NOT_VALID > 0 ORDER BY 3 DESC FETCH FIRST 100 ROWS ONLY`, 100),
        jobqs: safe(conn, 'SELECT * FROM QSYS2.JOB_QUEUE_INFO ORDER BY NUMBER_OF_JOBS DESC FETCH FIRST 300 ROWS ONLY', 300),
        outqs: safe(conn, 'SELECT * FROM QSYS2.OUTPUT_QUEUE_INFO ORDER BY NUMBER_OF_FILES DESC FETCH FIRST 200 ROWS ONLY', 200),
        listen: safe(conn, `SELECT LOCAL_PORT AS P, COUNT(*) AS N FROM QSYS2.NETSTAT_INFO WHERE TCP_STATE = 'LISTEN' GROUP BY LOCAL_PORT ORDER BY 1`, 500),
        remotes: safe(conn, `SELECT REMOTE_ADDRESS AS R, COUNT(*) AS N, MIN(LOCAL_PORT) AS P FROM QSYS2.NETSTAT_INFO WHERE TCP_STATE = 'ESTABLISHED' GROUP BY REMOTE_ADDRESS ORDER BY 2 DESC FETCH FIRST 25 ROWS ONLY`, 25),
        estab: safe(conn, `SELECT LOCAL_PORT AS P, COUNT(*) AS N FROM QSYS2.NETSTAT_INFO WHERE TCP_STATE = 'ESTABLISHED' GROUP BY LOCAL_PORT`, 2000),
        subs: safe(conn, `SELECT COALESCE(SUBSYSTEM, '(none)') AS S, COUNT(*) AS N, DEC(SUM(COALESCE(ELAPSED_CPU_PERCENTAGE, 0)), 7, 1) AS C, SUM(CASE WHEN JOB_STATUS = 'MSGW' THEN 1 ELSE 0 END) AS W ` +
          `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X WHERE JOB_TYPE <> 'SYS' GROUP BY SUBSYSTEM ORDER BY 2 DESC`, 200),
        libs: readLibraries(conn),
        powerful: safe(conn, `SELECT AUTHORIZATION_NAME AS U, STATUS AS S, USER_CLASS_NAME AS C, COALESCE(SPECIAL_AUTHORITIES, '') AS A, VARCHAR(PREVIOUS_SIGNON) AS P FROM QSYS2.USER_INFO ` +
          `WHERE AUTHORIZATION_NAME NOT LIKE 'Q%' AND (SPECIAL_AUTHORITIES LIKE '%*ALLOBJ%' OR SPECIAL_AUTHORITIES LIKE '%*SECADM%') ORDER BY 1`, 500),
        myMembers: libl.length ? safe(conn, `SELECT SYSTEM_TABLE_SCHEMA AS L, SYSTEM_TABLE_NAME AS F, SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS Y, COALESCE(PARTITION_TEXT, '') AS X, ` +
          `VARCHAR(LAST_SOURCE_UPDATE_TIMESTAMP) AS C FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA IN (${libl.map(sqlString).join(', ')}) AND SOURCE_TYPE IS NOT NULL ` +
          `AND LAST_SOURCE_UPDATE_TIMESTAMP > CURRENT TIMESTAMP - 7 DAYS ORDER BY LAST_SOURCE_UPDATE_TIMESTAMP DESC FETCH FIRST 60 ROWS ONLY`, 60) : Promise.resolve({ rows: [] as Row[], error: undefined as string | undefined }),
      };
      type Res = { rows: Row[]; error?: string };
      const pending: Res = { rows: [], error: vscode.l10n.t('Loading…') };
      const settled: Partial<Record<keyof typeof started, Res>> = {};
      for (const [k, pr] of Object.entries(started) as [keyof typeof started, Promise<Res>][]) { void pr.then(r => { settled[k] = r; }); }
      const snapshot = () => Object.fromEntries(Object.keys(started).map(k => [k, settled[k as keyof typeof started] ?? pending])) as Record<keyof typeof started, Res>;
      await Promise.all([started.st, started.env, started.waitCount, started.asp, started.myAuth, started.qsysopr, started.users, started.sysvals, started.scpf, started.ptf, started.waiting, started.myJobs, started.mySpool, started.top]);
      if (gen !== this.gen) { return; }
      await build(snapshot(), true);
      await Promise.all(Object.values(started));
      if (gen !== this.gen) { return; }
      await build(snapshot(), false);
    } catch (e) {
      logError(e);
      this.post({ t: 'error', text: errorMessage(e).split('\n')[0] });
    } finally {
      this.loading = false;
      this.post({ t: 'busy', on: false });
    }
  }

  private scan?: Table;

  async runScan(days: number, scope: string, order: 'changed' | 'size'): Promise<void> {
    const conn = this.manager.require();
    const libs = scope === 'all' ? [] : [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean).map(l => String(l).toUpperCase()))];
    if (scope !== 'all' && !libs.length) { throw new Error(vscode.l10n.t('Your library list is empty.')); }
    const title = order === 'size' ? vscode.l10n.t('Largest objects ({0})', scope === 'all' ? vscode.l10n.t('all user libraries') : vscode.l10n.t('library list'))
      : vscode.l10n.t('Objects changed in the last {0} day(s) ({1})', days, scope === 'all' ? vscode.l10n.t('all user libraries') : vscode.l10n.t('library list'));
    const rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Scanning objects…') }, () => q(conn, objectScanSql(days, libs, order), 500));
    const acts: Act[][] = rows.map(r => [{ label: vscode.l10n.t('Info'), command: 'vanthrex.objectInfo', args: [{ library: pick(r, 'L'), name: pick(r, 'N'), type: pick(r, 'T') }] },
      ...(pick(r, 'T') === '*FILE' ? [{ label: vscode.l10n.t('PDM'), command: 'vanthrex.pdm', args: [{ level: 'members', library: pick(r, 'L'), file: pick(r, 'N') }] }] : []),
      { label: vscode.l10n.t('Locks'), command: 'vanthrex.objectLocks', args: [{ library: pick(r, 'L'), name: pick(r, 'N'), type: pick(r, 'T') }] }]);
    this.scan = { title, filter: true, numeric: [4], columns: [vscode.l10n.t('Library'), vscode.l10n.t('Object'), vscode.l10n.t('Type'), vscode.l10n.t('Attribute'), vscode.l10n.t('Size'), vscode.l10n.t('Changed'), vscode.l10n.t('Owner'), vscode.l10n.t('Text')],
      rows: rows.map(r => [pick(r, 'L'), pick(r, 'N'), pick(r, 'T'), pick(r, 'A'), bytes(num(pick(r, 'Z'))), pick(r, 'C').slice(0, 16), pick(r, 'O'), pick(r, 'X')]), acts, empty: vscode.l10n.t('Nothing found.') };
    this.post({ t: 'tabTables', id: 'objects', tables: [{ ...this.scan, acts: acts.map(a => a.map(x => ({ label: x.label, i: this.ref(x) }))) }] });
  }

  private async loadSystems(activeId: string, gen: number): Promise<void> {
    const list = this.manager.openConnections;
    const rows = await Promise.all(list.map(async c => {
      const [st, w, inq] = await Promise.all([
        safe(c, 'SELECT * FROM QSYS2.SYSTEM_STATUS_INFO', 1),
        safe(c, `SELECT COUNT(*) AS N FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X WHERE JOB_STATUS = 'MSGW'`, 1),
        safe(c, `SELECT COUNT(*) AS N FROM QSYS2.MESSAGE_QUEUE_INFO WHERE MESSAGE_QUEUE_LIBRARY = 'QSYS' AND MESSAGE_QUEUE_NAME = 'QSYSOPR' AND MESSAGE_TYPE = 'INQUIRY'`, 1),
      ]);
      const cpu = num(pick(st.rows[0], 'AVERAGE_CPU_UTILIZATION', 'AVERAGE_CPU_RATE')); const asp = num(pick(st.rows[0], 'SYSTEM_ASP_USED'));
      const msgw = num(pick(w.rows[0], 'N')) ?? 0; const inquiries = num(pick(inq.rows[0], 'N')) ?? 0;
      const h = healthScore({ aspUsed: asp, cpu, msgwJobs: msgw, lckwJobs: 0, inquiries, brokenCompiles: 0, missingLibraries: 0, badSettings: 0 });
      return { id: c.profile.id, name: c.profile.name + (c.profile.id === activeId ? ' ★' : ''), score: h.score, tone: (h.label === 'healthy' ? undefined : h.label === 'watch' ? 'warn' : 'bad') as Tone | undefined, cpu, asp, msgw, inquiries, error: st.error };
    }));
    if (gen !== this.gen) { return; }
    const acts = rows.map(r => (r.id === activeId ? [] : [{ label: vscode.l10n.t('Open'), i: this.ref({ label: '', command: 'vanthrex.tracker.switch', args: [r.id] }) }]));
    this.post({ t: 'tabTables', id: 'systems', tables: [{ id: 'systems', title: vscode.l10n.t('Connected systems'), numeric: [1, 2, 3, 4, 5],
      columns: [vscode.l10n.t('System'), vscode.l10n.t('Health'), 'CPU %', 'ASP %', 'MSGW', vscode.l10n.t('QSYSOPR replies')],
      rows: rows.map(r => [r.name, r.score, r.cpu ?? '', r.asp ?? '', r.msgw, r.inquiries]), tones: rows.map(r => r.tone), acts, empty: vscode.l10n.t('Not connected.') }] });
  }

  private async saveCsv(name: string, columns: string[], rows: (string | number)[][]): Promise<void> {
    const target = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, defaultUri: vscode.Uri.file(`${name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'tracker'}.csv`) });
    if (!target) { return; }
    await vscode.workspace.fs.writeFile(target, Buffer.from(csv(columns, rows), 'utf8'));
    vscode.window.setStatusBarMessage(vscode.l10n.t('{0} row(s) saved to {1}', rows.length, target.fsPath), 4000);
  }

  private async saveReport(html: string): Promise<void> {
    const conn = this.manager.require();
    const target = await vscode.window.showSaveDialog({ filters: { HTML: ['html'] }, defaultUri: vscode.Uri.file(`${conn.profile.name}-system-report-${new Date().toISOString().slice(0, 10)}.html`) });
    if (!target) { return; }
    await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
    const open = vscode.l10n.t('Open');
    if (await vscode.window.showInformationMessage(vscode.l10n.t('Report saved: {0}', target.fsPath), open) === open) { await vscode.env.openExternal(target); }
  }

  /** Objects and size of the libraries shown, four at a time, streamed into the page. */
  private async sizes(names: string[]): Promise<void> {
    if (this.sizing) { return; }
    this.sizing = true;
    const conn = this.manager.require();
    let i = 0; let done = 0;
    const key = `vanthrex.tracker.sizes.${conn.profile.name}`;
    const cache = { ...this.state.get<Record<string, unknown>>(key, {}) } as Record<string, unknown>;
    const worker = async () => {
      while (this.sizing && i < names.length) {
        const lib = names[i++];
        try {
          const r = (await q(conn, librarySizeSql(lib), 1))[0];
          const z = { objects: num(pick(r, 'N')), size: num(pick(r, 'S')), text: bytes(num(pick(r, 'S'))), at: new Date().toISOString().slice(0, 10) };
          cache[lib] = z;
          this.post({ t: 'size', name: lib, ...z });
        } catch (e) { this.post({ t: 'size', name: lib, text: '✗', error: errorMessage(e).split('\n')[0] }); }
        this.post({ t: 'sizeProgress', done: ++done, total: names.length });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    await this.state.update(key, cache);
    this.sizing = false;
    this.post({ t: 'sizeProgress', done, total: names.length, finished: true });
  }

  private html(): string {
    const n = nonce();
    const L = {
      refresh: vscode.l10n.t('Refresh'), updated: vscode.l10n.t('Updated'), refreshing: vscode.l10n.t('refreshing…'), loadingRest: vscode.l10n.t('loading the rest…'), loading: vscode.l10n.t('Loading the whole system…'), attention: vscode.l10n.t('Needs attention'), allGood: vscode.l10n.t('Nothing needs attention. 👍'),
      filter: vscode.l10n.t('Filter…'), hideIbm: vscode.l10n.t('Hide IBM libraries (Q*, SYS*)'), onlyList: vscode.l10n.t('Only my library list'), sizes: vscode.l10n.t('Calculate objects and size of the libraries shown'),
      stop: vscode.l10n.t('Stop'), rows: vscode.l10n.t('rows'), more: vscode.l10n.t('Show more'), empty: vscode.l10n.t('Nothing to show.'),
      report: vscode.l10n.t('Save report'), reportTitle: vscode.l10n.t('System report'), generated: vscode.l10n.t('Generated'),
      unused: vscode.l10n.t('Not used for a year'), auto: vscode.l10n.t('Refresh every minute'), csv: vscode.l10n.t('Export CSV'), measured: vscode.l10n.t('measured'),
    };
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  :root { --ok: var(--vscode-testing-iconPassed, #2e7d32); --warn: var(--vscode-editorWarning-foreground, #b26a00); --bad: var(--vscode-errorForeground, #c62828); --info: var(--vscode-textLink-foreground, #1565c0); }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px 24px; margin: 0; }
  header { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); padding: 10px 0 0; border-bottom: 1px solid var(--vscode-editorWidget-border, #8884); }
  .top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; } h1 { font-size: 1.3em; margin: 0; font-weight: 600; flex: 1; }
  .muted { color: var(--vscode-descriptionForeground); }
  nav { display: flex; gap: 2px; flex-wrap: wrap; margin-top: 8px; }
  nav button { background: transparent; color: var(--vscode-foreground); border: none; border-bottom: 2px solid transparent; padding: 6px 12px; cursor: pointer; font: inherit; }
  nav button.on { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
  .badge { display: inline-block; min-width: 1.4em; padding: 0 5px; margin-left: 5px; border-radius: 9px; font-size: .8em; text-align: center; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge.bad { background: var(--bad); color: #fff; } .badge.warn { background: var(--warn); color: #fff; }
  button.b { padding: 4px 11px; border: none; border-radius: 3px; cursor: pointer; background: var(--vscode-button-secondaryBackground, #8883); color: var(--vscode-button-secondaryForeground, inherit); font: inherit; }
  button.p { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; margin: 14px 0; }
  .tile { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, #8883); border-left: 4px solid var(--vscode-widget-border, #8883); border-radius: 6px; padding: 9px 12px; }
  .tile.ok { border-left-color: var(--ok); } .tile.warn { border-left-color: var(--warn); } .tile.bad { border-left-color: var(--bad); }
  .tile.click { cursor: pointer; } .tile.click:hover { background: var(--vscode-list-hoverBackground); }
  .tile .l { color: var(--vscode-descriptionForeground); font-size: .85em; } .tile .v { font-size: 1.45em; font-weight: 600; margin: 2px 0; overflow-wrap: anywhere; } .tile .s { color: var(--vscode-descriptionForeground); font-size: .82em; }
  .att { margin: 6px 0 14px; } .att div { display: flex; gap: 10px; align-items: center; padding: 6px 10px; margin: 4px 0; border-radius: 4px; background: var(--vscode-editorWidget-background); border-left: 4px solid var(--info); }
  .att .bad { border-left-color: var(--bad); } .att .warn { border-left-color: var(--warn); } .att span { flex: 1; }
  .btns { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
  h2 { font-size: 1.05em; margin: 18px 0 6px; } .tools { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 4px 0 6px; }
  input.f { padding: 3px 8px; min-width: 220px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; font-size: .95em; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-editorWidget-border, #8882); vertical-align: top; }
  th { cursor: pointer; user-select: none; color: var(--vscode-descriptionForeground); font-weight: 600; position: sticky; top: 92px; background: var(--vscode-editor-background); }
  td.n { text-align: right; font-variant-numeric: tabular-nums; } td.a { white-space: nowrap; }
  td.a a { cursor: pointer; color: var(--vscode-textLink-foreground); margin-right: 10px; }
  tr.bad td:first-child { box-shadow: inset 3px 0 var(--bad); } tr.warn td:first-child { box-shadow: inset 3px 0 var(--warn); } tr.info td:first-child { box-shadow: inset 3px 0 var(--info); }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  .err { color: var(--bad); margin: 8px 0; } .note { margin-top: 12px; color: var(--vscode-descriptionForeground); }
  #busy { visibility: hidden; } body.busy #busy { visibility: visible; }
  .hero { display: grid; grid-template-columns: auto 1fr auto; gap: 6px 24px; align-items: center; margin: 14px 0 4px; padding: 14px 18px; border-radius: 8px;
    background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, #8883); }
  .hero .num { font-size: 56px; line-height: 1; font-weight: 600; font-variant-numeric: proportional-nums; }
  .hero .num small { font-size: 18px; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .hero .state { font-size: 1.15em; font-weight: 600; } .hero .why { color: var(--vscode-descriptionForeground); font-size: .9em; margin-top: 4px; }
  .meter { height: 6px; border-radius: 3px; margin: 6px 0 2px; background: color-mix(in srgb, var(--m) 22%, transparent); overflow: hidden; }
  .meter > i { display: block; height: 100%; border-radius: 3px; background: var(--m); }
  .ok { --m: var(--ok); } .warn { --m: var(--warn); } .bad { --m: var(--bad); } .info { --m: var(--info); }
  .tile .meter { --m: var(--info); } .tile.ok .meter { --m: var(--ok); } .tile.warn .meter { --m: var(--warn); } .tile.bad .meter { --m: var(--bad); }
  svg.spark { display: block; margin-top: 4px; overflow: visible; } svg.spark polyline { fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; opacity: .7; }
  svg.spark circle { fill: var(--vscode-focusBorder); stroke: var(--vscode-editorWidget-background); stroke-width: 2; }
  .icon { margin-right: 4px; }
</style></head><body>
<header><div class="top"><h1>${escapeHtml(vscode.l10n.t('System Tracker'))} <span id="sysname" class="muted">${escapeHtml(this.manager.connection?.profile.name ?? '')}</span></h1><span id="busy" class="muted">⏳ ${escapeHtml(L.loading)}</span><span id="at" class="muted"></span>
<button class="b" id="report">${escapeHtml(L.report)}</button> <label class="muted"><input type="checkbox" id="auto"> ${escapeHtml(L.auto)}</label> <button class="b p" id="refresh">${escapeHtml(L.refresh)}</button></div><nav id="nav"></nav></header>
<main id="main"><p class="muted">${escapeHtml(L.loading)}</p></main>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const L = ${JSON.stringify(L).replace(/</g, '\\u003c')};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let D = null, cur = 'overview', hideIbm = true, onlyList = false, unusedOnly = false, autoTimer = null;
const sorts = {}, filters = {}, sizes = {}, limits = {};
const st0 = vscode.getState() || {}; cur = st0.cur || cur; hideIbm = st0.hideIbm ?? true;
function save() { vscode.setState({ cur, hideIbm }); }
function nav() {
  document.getElementById('nav').innerHTML = D.tabs.map(t => '<button data-tab="' + t.id + '" class="' + (t.id === cur ? 'on' : '') + '">' + esc(t.title) +
    (t.badge ? '<span class="badge ' + (t.badgeTone || '') + '">' + t.badge + '</span>' : '') + '</button>').join('');
}
function libVisible(r, i, tb) { return (!hideIbm || !/^(Q|SYS|#)/.test(r[0])) && (!onlyList || r[8]) && (!unusedOnly || (tb.tones || [])[i] === 'warn'); }
function largest(tb) {
  tb.rows = Object.entries(sizes).filter(([, z]) => z.size != null).sort((a, b) => b[1].size - a[1].size).slice(0, 25).map(([n, z]) => [n, z.objects ?? '', z.text]);
}
function visibleIdx(tb, key) {
  if (tb.id === 'largest') largest(tb);
  let idx = tb.rows.map((r, i) => i);
  if (tb.id === 'libs') { idx = idx.filter(i => libVisible(tb.rows[i], i, tb)); idx.forEach(i => { const z = sizes[tb.rows[i][0]]; if (z) { tb.rows[i][6] = z.objects ?? ''; tb.rows[i][7] = z.text; tb.rows[i]._s = z.size ?? -1; } }); }
  const f = (filters[key] || '').toLowerCase();
  if (f) idx = idx.filter(i => tb.rows[i].join(' ').toLowerCase().includes(f));
  const s = sorts[key];
  if (s) idx.sort((a, b) => { const x = tb.rows[a], y = tb.rows[b]; const c = s.c;
    const vx = tb.id === 'libs' && c === 7 ? (x._s ?? -1) : x[c], vy = tb.id === 'libs' && c === 7 ? (y._s ?? -1) : y[c];
    return (typeof vx === 'number' && typeof vy === 'number' ? vx - vy : String(vx).localeCompare(String(vy), undefined, { numeric: true })) * s.d; });
  return idx;
}
function tableHtml(tb, ti) {
  const key = cur + ':' + ti;
  const idx = visibleIdx(tb, key); const s = sorts[key];
  const lim = limits[key] || 300; const shown = idx.slice(0, lim);
  const acts = (tb.acts || []).length > 0;
  let h = '<h2>' + esc(tb.title) + ' <span class="muted">(' + idx.length + (idx.length !== tb.rows.length ? ' / ' + tb.rows.length : '') + ')</span>' +
    (tb.rows.length ? ' <button class="b" data-csv="' + ti + '">' + esc(L.csv) + '</button>' : '') + '</h2><div class="tools">';
  if (tb.filter) h += '<input class="f" data-filter="' + key + '" placeholder="' + esc(L.filter) + '" value="' + esc(filters[key] || '') + '">';
  if (tb.id === 'libs') h += '<label><input type="checkbox" id="hideIbm"' + (hideIbm ? ' checked' : '') + '> ' + esc(L.hideIbm) + '</label><label><input type="checkbox" id="onlyList"' + (onlyList ? ' checked' : '') + '> ' + esc(L.onlyList) + '</label>' +
    '<label><input type="checkbox" id="unusedOnly"' + (unusedOnly ? ' checked' : '') + '> ' + esc(L.unused) + '</label>' +
    '<button class="b" id="sizes">' + esc(L.sizes) + '</button><span id="sizeProg" class="muted"></span>';
  h += '</div>';
  if (!shown.length) return h + '<p class="muted">' + esc(tb.empty || L.empty) + '</p>';
  h += '<table><thead><tr>' + tb.columns.map((c, i) => '<th data-sort="' + key + '" data-c="' + i + '">' + esc(c) + (s && s.c === i ? (s.d > 0 ? ' ▲' : ' ▼') : '') + '</th>').join('') + (acts ? '<th></th>' : '') + '</tr></thead><tbody>';
  for (const i of shown) {
    const r = tb.rows[i];
    h += '<tr class="' + ((tb.tones || [])[i] || '') + '"' + (tb.id === 'libs' ? ' data-lib="' + esc(r[0]) + '"' : '') + '>' + r.map((v, c) => '<td class="' + ((tb.numeric || []).includes(c) ? 'n' : '') + '"' + (tb.id === 'libs' && (c === 6 || c === 7) ? ' data-col="' + c + '"' : '') + '>' + esc(typeof v === 'number' ? v.toLocaleString() : v) + '</td>').join('') +
      (acts ? '<td class="a">' + ((tb.acts[i] || []).map(a => '<a data-i="' + a.i + '">' + esc(a.label) + '</a>').join('')) + '</td>' : '') + '</tr>';
  }
  h += '</tbody></table>';
  if (idx.length > lim) h += '<p><button class="b" data-more="' + key + '">' + esc(L.more) + ' (' + (idx.length - lim) + ')</button></p>';
  return h;
}
function spark(points, title, w, hgt) {
  if (!points) return '';
  const pts = points.split(' '); const last = pts[pts.length - 1].split(',');
  const sx = w / 120, sy = hgt / 28;
  const scaled = pts.map(p => { const [a, b] = p.split(','); return (Number(a) * sx).toFixed(1) + ',' + (Number(b) * sy).toFixed(1); }).join(' ');
  return '<svg class="spark" width="' + w + '" height="' + hgt + '" viewBox="0 0 ' + w + ' ' + hgt + '" role="img" aria-label="' + esc(title || '') + '"><title>' + esc(title || '') + '</title>' +
    '<polyline points="' + scaled + '"/><circle cx="' + (Number(last[0]) * sx).toFixed(1) + '" cy="' + (Number(last[1]) * sy).toFixed(1) + '" r="3.5"/></svg>';
}
function heroTiles(tb) {
  let h = '';
  if (tb.hero) {
    const hz = tb.hero, ic = { ok: '✓', warn: '⚠', bad: '✗' }[hz.tone] || '';
    h += '<div class="hero ' + hz.tone + '"><div class="num">' + hz.score + '<small> / 100</small></div><div><div class="state"><span class="icon">' + ic + '</span>' + esc(hz.label) + '</div>' +
      '<div class="meter" title="' + hz.score + ' / 100"><i style="width:' + hz.score + '%"></i></div>' +
      '<div class="why">' + esc(hz.reasons.length ? hz.reasons.join(' · ') : '') + '</div></div>' + spark(hz.spark, hz.sparkTitle, 160, 40) + '</div>';
  }
  if (tb.tiles && tb.tiles.length) h += '<div class="tiles">' + tb.tiles.map(x => '<div class="tile ' + (x.tone || '') + (x.act >= 0 ? ' click" data-i="' + x.act : '') + '"><div class="l">' +
    (x.tone === 'bad' ? '<span class="icon">✗</span>' : x.tone === 'warn' ? '<span class="icon">⚠</span>' : '') + esc(x.label) + '</div><div class="v">' + esc(x.value) + '</div>' +
    (typeof x.meter === 'number' ? '<div class="meter" title="' + esc(x.value) + '"><i style="width:' + Math.max(0, Math.min(100, x.meter)).toFixed(1) + '%"></i></div>' : '') +
    '<div class="s">' + esc(x.sub || '') + '</div>' + spark(x.spark, x.sparkTitle, 120, 26) + '</div>').join('') + '</div>';
  return h;
}
function tabHtml(tb) {
  const prev = cur; cur = tb.id; let h = '';
  if (tb.error) h += '<div class="err">✗ ' + esc(tb.error) + '</div>';
  h += heroTiles(tb);
  if (tb.attention) h += '<h2>' + esc(L.attention) + '</h2><div class="att">' + (tb.attention.length ? tb.attention.map(a => '<div class="' + a.tone + '"><span>' + esc(a.text) + '</span>' + (a.i >= 0 ? '<button class="b" data-i="' + a.i + '">' + esc(a.action) + '</button>' : '') + '</div>').join('') : '<div class="ok"><span>' + esc(L.allGood) + '</span></div>') + '</div>';
  if (tb.buttons && tb.buttons.length) h += '<div class="btns">' + tb.buttons.map(b => '<button class="b" data-i="' + b.i + '">' + esc(b.label) + '</button>').join('') + '</div>';
  h += tb.tables.map((x, i) => tableHtml(x, i)).join('');
  if (tb.note) h += '<p class="note">' + esc(tb.note) + '</p>';
  cur = prev; return h;
}
function report() {
  const box = document.createElement('div');
  box.innerHTML = D.tabs.map(tb => '<section><h1 class="sec">' + esc(tb.title) + '</h1>' + tabHtml(tb) + '</section>').join('');
  box.querySelectorAll('button, input, label, .tools input, td.a, th:empty, svg title').forEach(e => e.remove());
  box.querySelectorAll('.click').forEach(e => e.classList.remove('click'));
  const css = [...document.querySelectorAll('style')].map(x => x.textContent).join(' ');
  const light = ':root{--vscode-font-family:Segoe UI,-apple-system,sans-serif;--vscode-editor-font-family:Consolas,monospace;--vscode-foreground:#1f2328;--vscode-descriptionForeground:#59636e;--vscode-editor-background:#fff;--vscode-editorWidget-background:#f6f8fa;--vscode-widget-border:#d1d9e0;--vscode-editorWidget-border:#d1d9e0;--vscode-focusBorder:#0969da;--vscode-badge-background:#59636e;--vscode-badge-foreground:#fff;--vscode-textLink-foreground:#0969da;--vscode-list-hoverBackground:#f6f8fa;--vscode-errorForeground:#cf222e;--vscode-editorWarning-foreground:#9a6700;--vscode-testing-iconPassed:#1a7f37}body{background:#fff;max-width:1200px;margin:auto}h1.sec{font-size:1.25em;margin:28px 0 4px;padding-top:12px;border-top:2px solid #d1d9e0}th{position:static}@media print{section{break-inside:avoid-page}}';
  const title = document.getElementById('sysname').textContent;
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + esc(L.reportTitle + ' — ' + title) + '</title><style>' + css + light + '</style></head><body><h1>' + esc(L.reportTitle + ' — ' + title) + '</h1><p class="muted">' + esc(L.generated + ' ' + new Date().toLocaleString()) + '</p>' + box.innerHTML + '</body></html>';
}
function render() {
  if (!D) return;
  if (!D.tabs.some(t => t.id === cur)) cur = 'overview';
  nav();
  const tb = D.tabs.find(t => t.id === cur);
  const h = tabHtml(tb);
  const y = window.scrollY;
  document.getElementById('main').innerHTML = h;
  window.scrollTo(0, y);
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-i],[data-tab],[data-sort],[data-more],[data-csv],#report,#refresh,#sizes,#hideIbm,#onlyList,#unusedOnly,#auto');
  if (!el) return;
  if (el.id === 'refresh') { vscode.postMessage({ t: 'refresh' }); return; }
  if (el.id === 'report') { if (D) vscode.postMessage({ t: 'report', html: report() }); return; }
  if (el.id === 'hideIbm') { hideIbm = el.checked; save(); render(); return; }
  if (el.id === 'onlyList') { onlyList = el.checked; render(); return; }
  if (el.id === 'unusedOnly') { unusedOnly = el.checked; render(); return; }
  if (el.id === 'auto') { if (autoTimer) clearInterval(autoTimer); autoTimer = el.checked ? setInterval(() => vscode.postMessage({ t: 'refresh' }), 60000) : null; return; }
  if (el.dataset.csv !== undefined) {
    const tb = D.tabs.find(t => t.id === cur).tables[Number(el.dataset.csv)]; const idx = visibleIdx(tb, cur + ':' + el.dataset.csv);
    vscode.postMessage({ t: 'csv', name: tb.title, columns: tb.columns, rows: idx.map(i => tb.rows[i].map(v => v)) }); return;
  }
  if (el.id === 'sizes') {
    // Every library that passes the filters, not only the rows on screen.
    const tb = D.tabs.find(t => t.id === 'libraries').tables[0];
    const libs = visibleIdx(tb, 'libraries:0').map(i => tb.rows[i][0]);
    if (libs.length) vscode.postMessage({ t: 'sizes', names: libs }); return;
  }
  if (el.dataset.tab) { cur = el.dataset.tab; save(); window.scrollTo(0, 0); render(); return; }
  if (el.dataset.more) { limits[el.dataset.more] = (limits[el.dataset.more] || 300) + 500; render(); return; }
  if (el.dataset.sort) { const k = el.dataset.sort, c = Number(el.dataset.c); sorts[k] = sorts[k] && sorts[k].c === c ? { c, d: -sorts[k].d } : { c, d: 1 }; render(); return; }
  if (el.dataset.i !== undefined && Number(el.dataset.i) >= 0) vscode.postMessage({ t: 'act', i: Number(el.dataset.i) });
});
document.addEventListener('input', e => {
  if (e.target.dataset && e.target.dataset.filter) { filters[e.target.dataset.filter] = e.target.value; const k = e.target.dataset.filter; render();
    const inp = document.querySelector('[data-filter="' + k + '"]'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
});
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.t === 'data') { D = m; Object.assign(sizes, m.sizes || {}); if (m.first && !st0.cur) cur = m.first; document.getElementById('at').textContent = L.updated + ' ' + m.at + (m.cached ? ' · ' + L.refreshing : m.partial ? ' · ' + L.loadingRest : ''); render(); }
  else if (m.t === 'busy') document.body.classList.toggle('busy', !!m.on);
  else if (m.t === 'tabTables') { const tb = D && D.tabs.find(t => t.id === m.id); if (tb) { tb.tables = m.tables; if (cur === m.id) { render(); } else if (m.id === 'objects') { cur = 'objects'; save(); render(); } } }
  else if (m.t === 'tab') { cur = m.id; save(); window.scrollTo(0, 0); render(); }
  else if (m.t === 'error') { document.getElementById('main').innerHTML = '<div class="err">✗ ' + esc(m.text) + '</div>'; }
  else if (m.t === 'size') {
    sizes[m.name] = { objects: m.objects, size: m.size, text: m.text, at: m.at };
    const tr = document.querySelector('tr[data-lib="' + CSS.escape(m.name) + '"]');
    if (tr) { const o = tr.querySelector('[data-col="6"]'), z = tr.querySelector('[data-col="7"]'); if (o) o.textContent = m.objects == null ? '' : Number(m.objects).toLocaleString(); if (z) { z.textContent = m.text; if (m.error) z.title = m.error; } }
  } else if (m.t === 'sizeProgress') { const p = document.getElementById('sizeProg'); if (p) p.textContent = m.finished ? '✓ ' + m.done : m.done + ' / ' + m.total; }
});
vscode.postMessage({ t: 'ready' });
</script></body></html>`;
  }
}

export function registerTracker(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.systemTracker', async (tab?: unknown) => {
      try { Tracker.open(manager, context.globalState, typeof tab === 'string' ? tab : undefined); }
      catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
    }),
    vscode.commands.registerCommand('vanthrex.tracker.copySummary', async () => {
      const text = Tracker.current?.lastSummary?.();
      if (!text) { vscode.window.showInformationMessage(vscode.l10n.t('Open the System Tracker first.')); return; }
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage(vscode.l10n.t('System summary copied — paste it into a chat or a ticket.'), 4000);
    }),
    vscode.commands.registerCommand('vanthrex.tracker.cl', async (cmd: string) => {
      try {
        if (!/^(HLD|RLS)(JOBQ|OUTQ) (JOBQ|OUTQ)\([A-Z0-9$#@_.]+\/[A-Z0-9$#@_.]+\)$/.test(cmd) && !/^(HLD|RLS)JOBSCDE JOB\([A-Z0-9$#@_.]+\) ENTRYNBR\(\d{6}\)$/.test(cmd)) { throw new Error(vscode.l10n.t('Not allowed here: {0}', cmd)); }
        const yes = vscode.l10n.t('Run');
        if (await vscode.window.showWarningMessage(vscode.l10n.t('Run {0}?', cmd), { modal: true }, yes) !== yes) { return; }
        const r = await manager.require().runCL(cmd);
        if (!r.ok) { throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || vscode.l10n.t('The command failed.')); }
        vscode.window.setStatusBarMessage(`✓ ${cmd}`, 4000);
        if (Tracker.current) { await Tracker.current.load(); }
      } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
    }),
    vscode.commands.registerCommand('vanthrex.tracker.switch', async (id: string) => {
      try { await manager.switchTo(id); Tracker.open(manager, context.globalState); } catch (e) { vscode.window.showErrorMessage(errorMessage(e)); }
    }),
    vscode.commands.registerCommand('vanthrex.tracker.addLibrary', async (lib: string) => {
      try {
        await manager.updateActiveProfile(p => { if (!p.libraries.map(x => x.toUpperCase()).includes(lib)) { p.libraries = [...p.libraries, lib]; } });
        vscode.window.setStatusBarMessage(vscode.l10n.t('{0} added to your library list', lib), 3000);
      } catch (e) { vscode.window.showErrorMessage(errorMessage(e)); }
    }),
  );
}
