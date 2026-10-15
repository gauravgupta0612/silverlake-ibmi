// Pure helpers for the System Tracker: one page for the whole system (overview and alerts, libraries,
// jobs, storage, messages, users, PTFs, my work). No vscode import, unit tested.

export type Row = Record<string, unknown>;

export function pick(r: Row | undefined, ...keys: string[]): string {
  for (const k of keys) {
    const v = r?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') { return String(v).trim(); }
  }
  return '';
}

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || String(v).trim() === '') { return undefined; }
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

/** 1536 → "1.5 KB"; sizes in bytes. */
export function bytes(n: number | undefined): string {
  if (n === undefined) { return ''; }
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

/** Green below warn, orange from warn, red from bad. */
export function tone(value: number | undefined, warn: number, bad: number): Tone {
  if (value === undefined) { return 'info'; }
  return value >= bad ? 'bad' : value >= warn ? 'warn' : 'ok';
}

const IBM_LIB = /^(Q|SYS|#)/;
export function isIbmLibrary(name: string): boolean { return IBM_LIB.test(name.trim().toUpperCase()); }

export interface Attention { tone: Tone; text: string; key: string; vals: (string | number)[]; command?: string; args?: unknown[]; action?: string }

/** The things that need someone, most urgent first. */
export function attention(i: {
  aspUsed?: number; cpu?: number; msgwJobs: number; lckwJobs: number; inquiries: number; brokenCompiles: number;
  disabledProfiles?: number; expiredPasswords?: number; libraryListMissing: string[];
}): Attention[] {
  const out: Attention[] = [];
  if (i.aspUsed !== undefined && i.aspUsed >= 90) { out.push({ tone: 'bad', text: `System ASP is ${i.aspUsed.toFixed(1)}% full.`, key: 'asp', vals: [i.aspUsed.toFixed(1)], command: 'vanthrex.tracker.tab', args: ['storage'], action: 'Storage' }); }
  else if (i.aspUsed !== undefined && i.aspUsed >= 80) { out.push({ tone: 'warn', text: `System ASP is ${i.aspUsed.toFixed(1)}% full.`, key: 'asp', vals: [i.aspUsed.toFixed(1)], command: 'vanthrex.tracker.tab', args: ['storage'], action: 'Storage' }); }
  if (i.inquiries) { out.push({ tone: 'bad', text: `${i.inquiries} message(s) in QSYSOPR wait for a reply.`, key: 'inq', vals: [i.inquiries], command: 'vanthrex.messageQueue', args: ['QSYS/QSYSOPR'], action: 'Reply' }); }
  if (i.msgwJobs) { out.push({ tone: 'bad', text: `${i.msgwJobs} job(s) wait for a message reply (MSGW).`, key: 'msgw', vals: [i.msgwJobs], command: 'vanthrex.tracker.tab', args: ['jobs'], action: 'Jobs' }); }
  if (i.lckwJobs) { out.push({ tone: 'warn', text: `${i.lckwJobs} job(s) wait for a lock (LCKW).`, key: 'lckw', vals: [i.lckwJobs], command: 'vanthrex.tracker.tab', args: ['jobs'], action: 'Jobs' }); }
  if (i.cpu !== undefined && i.cpu >= 90) { out.push({ tone: 'warn', text: `CPU is at ${i.cpu.toFixed(0)}%.`, key: 'cpu', vals: [i.cpu.toFixed(0)], command: 'vanthrex.performanceMonitor', action: 'Monitor' }); }
  if (i.brokenCompiles) { out.push({ tone: 'warn', text: `${i.brokenCompiles} of your source(s) did not compile the last time.`, key: 'broken', vals: [i.brokenCompiles], command: 'vanthrex.compileHistory', action: 'History' }); }
  if (i.libraryListMissing.length) { out.push({ tone: 'warn', text: `Library list entries that do not exist: ${i.libraryListMissing.join(', ')}.`, key: 'libl', vals: [i.libraryListMissing.join(', ')], command: 'vanthrex.editConnection', action: 'Fix' }); }
  if (i.expiredPasswords) { out.push({ tone: 'info', text: `${i.expiredPasswords} enabled profile(s) have an expired password.`, key: 'pwd', vals: [i.expiredPasswords], command: 'vanthrex.tracker.tab', args: ['users'], action: 'Users' }); }
  const rank: Record<Tone, number> = { bad: 0, warn: 1, info: 2, ok: 3 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

export interface LibraryRow { name: string; type: string; text: string; owner: string; created: string; lastUsed: string; changed: string; inList: number; size?: number; objects?: number }

export function libraryRows(rows: Row[], libl: string[]): LibraryRow[] {
  const order = libl.map(l => l.toUpperCase());
  return rows.map(r => {
    const name = pick(r, 'OBJNAME', 'N');
    return { name, type: pick(r, 'OBJATTRIBUTE', 'A') || 'PROD', text: pick(r, 'OBJTEXT', 'X'), owner: pick(r, 'OBJOWNER', 'O'),
      created: pick(r, 'OBJCREATED', 'C').slice(0, 10), lastUsed: pick(r, 'LAST_USED_TIMESTAMP', 'U').slice(0, 10), changed: pick(r, 'CHANGE_TIMESTAMP', 'H').slice(0, 10),
      inList: order.indexOf(name.toUpperCase()) + 1 };
  });
}

/** SQL for the size of one library (LIBRARY_INFO; IGNORE_ERRORS so a damaged object does not stop it). */
export function librarySizeSql(lib: string): string {
  if (!/^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/i.test(lib.trim())) { throw new Error(`"${lib}" is not a library name.`); }
  return `SELECT OBJECT_COUNT AS N, LIBRARY_SIZE AS S FROM TABLE(QSYS2.LIBRARY_INFO(LIBRARY_NAME => '${lib.trim().toUpperCase()}', IGNORE_ERRORS => 'YES')) X`;
}

/** "2 d 4 h" from a start timestamp to now. */
export function since(ts: string, now = Date.now()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[-T ](\d{2})[.:](\d{2})/.exec(ts.trim());
  if (!m) { return ''; }
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  const min = Math.max(0, Math.floor((now - t) / 60000));
  const d = Math.floor(min / 1440); const h = Math.floor((min % 1440) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${min % 60} min` : `${min} min`;
}

// ---------------------------------------------------------------- libraries, reliably

const inList = (names?: string[]) => (names?.length ? names.map(n => `'${n.toUpperCase().replace(/'/g, "''")}'`).join(', ') : '');

/**
 * Two ways to list libraries. OBJECT_STATISTICS('*ALL', '*LIB') has the most detail (last used, size);
 * the SQL catalog (SYSSCHEMAS) is the safety net. Note: OBJECT_STATISTICS('QSYS', '*LIB') returns only QSYS itself.
 */
export function libraryListSql(names?: string[]): { stats: string; catalog: string } {
  const w = names?.length ? ` WHERE OBJNAME IN (${inList(names)})` : '';
  const wc = names?.length ? ` WHERE SYSTEM_SCHEMA_NAME IN (${inList(names)})` : '';
  return {
    stats: `SELECT OBJNAME, COALESCE(OBJATTRIBUTE, '') AS OBJATTRIBUTE, COALESCE(OBJTEXT, '') AS OBJTEXT, OBJOWNER, VARCHAR(OBJCREATED) AS OBJCREATED, ` +
      `VARCHAR(LAST_USED_TIMESTAMP) AS LAST_USED_TIMESTAMP, VARCHAR(CHANGE_TIMESTAMP) AS CHANGE_TIMESTAMP FROM TABLE(QSYS2.OBJECT_STATISTICS('*ALL', '*LIB')) X${w} ORDER BY OBJNAME`,
    catalog: `SELECT SYSTEM_SCHEMA_NAME AS OBJNAME, COALESCE(SCHEMA_TEXT, '') AS OBJTEXT, COALESCE(SCHEMA_OWNER, '') AS OBJOWNER, VARCHAR(CREATION_TIMESTAMP) AS OBJCREATED ` +
      `FROM QSYS2.SYSSCHEMAS${wc} ORDER BY 1`,
  };
}

/** One row per library: detail from OBJECT_STATISTICS where available, the catalog fills the gaps. */
export function mergeLibraries(stats: Row[], catalog: Row[]): Row[] {
  const by = new Map<string, Row>();
  for (const r of catalog) { by.set(pick(r, 'OBJNAME'), { ...r }); }
  for (const r of stats) {
    const k = pick(r, 'OBJNAME');
    const old = by.get(k) ?? {};
    const merged: Row = { ...old };
    for (const [key, v] of Object.entries(r)) { if (v !== null && v !== undefined && String(v).trim() !== '') { merged[key] = v; } }
    by.set(k, merged);
  }
  return [...by.values()].filter(r => pick(r, 'OBJNAME')).sort((a, b) => pick(a, 'OBJNAME').localeCompare(pick(b, 'OBJNAME')));
}

/** Libraries not touched for a long time (by last-used date, else creation date). */
export function unusedSince(rows: LibraryRow[], days: number, now = Date.now()): LibraryRow[] {
  const limit = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  return rows.filter(l => !isIbmLibrary(l.name) && (l.lastUsed || l.created) && (l.lastUsed || l.created) < limit);
}

export function csv(columns: string[], rows: (string | number)[][]): string {
  const c = (v: unknown) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(c).join(','), ...rows.map(r => r.map(c).join(','))].join('\n') + '\n';
}

// ---------------------------------------------------------------- health score

export interface HealthInput { aspUsed?: number; cpu?: number; msgwJobs: number; lckwJobs: number; inquiries: number; brokenCompiles: number; missingLibraries: number; qsecurity?: number; expiredPasswords?: number; badSettings: number }

/** 0–100, 100 = nothing to do. Each problem costs points; the reasons explain the score. */
export function healthScore(i: HealthInput): { score: number; label: 'healthy' | 'watch' | 'action'; reasons: string[] } {
  let s = 100; const why: string[] = [];
  const cost = (n: number, r: string) => { if (n > 0) { s -= n; why.push(`−${n} ${r}`); } };
  if (i.aspUsed !== undefined) { cost(i.aspUsed >= 95 ? 40 : i.aspUsed >= 90 ? 30 : i.aspUsed >= 80 ? 15 : 0, 'disk'); }
  cost(i.inquiries ? Math.min(25, 10 + 3 * i.inquiries) : 0, 'messages waiting');
  cost(i.msgwJobs ? Math.min(25, 10 + 2 * i.msgwJobs) : 0, 'MSGW jobs');
  cost(i.lckwJobs ? Math.min(10, 3 + i.lckwJobs) : 0, 'LCKW jobs');
  if (i.cpu !== undefined) { cost(i.cpu >= 95 ? 15 : i.cpu >= 90 ? 10 : 0, 'CPU'); }
  cost(i.qsecurity !== undefined && i.qsecurity < 40 ? 10 : 0, 'QSECURITY');
  cost(Math.min(10, i.badSettings * 3), 'security settings');
  cost(i.brokenCompiles ? 5 : 0, 'compiles');
  cost(i.missingLibraries ? 5 : 0, 'library list');
  cost(i.expiredPasswords ? 3 : 0, 'passwords');
  const score = Math.max(0, Math.min(100, s));
  return { score, label: score >= 85 ? 'healthy' : score >= 60 ? 'watch' : 'action', reasons: why };
}

// ---------------------------------------------------------------- trend between refreshes

export interface Snapshot { at: string; cpu?: number; asp?: number; jobs?: number; msgw?: number; score?: number }
export const SNAPSHOTS = 288;

/** Keep one snapshot per refresh (at most one a minute), newest last. */
export function addSnapshot(list: Snapshot[], s: Snapshot): Snapshot[] {
  const last = list[list.length - 1];
  const out = last && Date.parse(s.at) - Date.parse(last.at) < 60_000 ? [...list.slice(0, -1), s] : [...list, s];
  return out.slice(-SNAPSHOTS);
}

/** Points of an SVG polyline for a sparkline (width × height, newest on the right). */
export function sparkPoints(values: (number | undefined)[], width = 120, height = 28): string {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (v.length < 2) { return ''; }
  const min = Math.min(...v); const max = Math.max(...v); const span = max - min || 1;
  return v.map((x, i) => `${(i * width / (v.length - 1)).toFixed(1)},${(height - 2 - (x - min) / span * (height - 4)).toFixed(1)}`).join(' ');
}

// ---------------------------------------------------------------- security system values

export interface SettingAdvice { name: string; value: string; tone: Tone; advice: string }

export function adviseSystemValue(name: string, value: string): SettingAdvice {
  const v = value.trim().toUpperCase(); const n = Number(v);
  const r = (tone: Tone, advice: string): SettingAdvice => ({ name, value, tone, advice });
  switch (name) {
    case 'QSECURITY': return n >= 40 ? r('ok', 'Level 40 or 50: object and system integrity protected.') : n === 30 ? r('warn', 'Level 30: move to 40 so programs cannot bypass security.') : r('bad', 'Below 30: passwords or resource security not enforced.');
    case 'QMAXSIGN': return v === '*NOMAX' ? r('bad', 'Unlimited sign-on attempts: set 3–5.') : n > 5 ? r('warn', 'More than 5 attempts allowed: 3–5 is usual.') : r('ok', 'Sign-on attempts limited.');
    case 'QPWDEXPITV': return v === '*NOMAX' ? r('warn', 'Passwords never expire.') : r('ok', `Passwords expire after ${v} days.`);
    case 'QPWDMINLEN': return n && n < 8 ? r('warn', 'Minimum password length below 8.') : r('ok', 'Minimum password length is reasonable.');
    case 'QAUDCTL': return v === '*NONE' || v === '' ? r('warn', 'Security auditing is off.') : r('ok', 'Auditing is on.');
    case 'QCRTAUT': return v === '*ALL' ? r('bad', 'New objects give *ALL to *PUBLIC.') : v === '*CHANGE' ? r('warn', 'New objects give *CHANGE to *PUBLIC (default): *USE or *EXCLUDE is stricter.') : r('ok', 'Public authority on new objects is restricted.');
    case 'QINACTITV': return v === '*NONE' ? r('warn', 'Inactive interactive jobs are never ended.') : r('ok', `Inactive jobs are handled after ${v} minutes.`);
    case 'QALWOBJRST': return /\*ALL/.test(v) ? r('warn', 'Any object can be restored, including security-sensitive ones.') : r('ok', 'Restoring sensitive objects is limited.');
    case 'QPWDLVL': return n >= 2 ? r('ok', 'Long, case-sensitive passwords.') : r('warn', 'Level 0/1: passwords up to 10 characters, not case-sensitive.');
    default: return r('info', '');
  }
}
export const SECURITY_VALUES = ['QSECURITY', 'QPWDLVL', 'QMAXSIGN', 'QPWDEXPITV', 'QPWDMINLEN', 'QAUDCTL', 'QCRTAUT', 'QINACTITV', 'QALWOBJRST'];

// ---------------------------------------------------------------- network

const PORTS: Record<number, string> = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet (5250)', 25: 'SMTP', 80: 'HTTP', 443: 'HTTPS', 389: 'LDAP', 446: 'DRDA / DDM', 448: 'DDM (SSL)', 449: 'Host server mapper',
  992: 'Telnet SSL', 2001: 'HTTP admin', 2010: 'HTTP admin (SSL)', 3000: 'Node.js (usual)', 5544: 'Service tools', 8005: 'Debug service', 8076: 'Mapepire (SQL)',
  8470: 'Central server', 8471: 'Database server', 8472: 'Data queue server', 8473: 'File server', 8474: 'Network print server', 8475: 'Remote command server', 8476: 'Sign-on server',
  9470: 'Central server (SSL)', 9471: 'Database server (SSL)', 9472: 'Data queue (SSL)', 9473: 'File server (SSL)', 9474: 'Network print (SSL)', 9475: 'Remote command (SSL)', 9476: 'Sign-on (SSL)',
};
export function portName(p: number): string { return PORTS[p] ?? ''; }

/** Plain-text servers that also have an encrypted variant. */
export function unencrypted(p: number): boolean { return [21, 23, 80, 446, 8470, 8471, 8472, 8473, 8474, 8475, 8476].includes(p); }

// ---------------------------------------------------------------- queue commands

const QNAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;
export function queueCommand(kind: 'jobq' | 'outq', action: 'hold' | 'release', lib: string, name: string): string {
  const l = lib.trim().toUpperCase(); const n = name.trim().toUpperCase();
  if (!QNAME.test(l) || !QNAME.test(n)) { throw new Error('Invalid queue name.'); }
  const verb = action === 'hold' ? 'HLD' : 'RLS';
  return kind === 'jobq' ? `${verb}JOBQ JOBQ(${l}/${n})` : `${verb}OUTQ OUTQ(${l}/${n})`;
}

/** A short Markdown summary to paste into a chat or ticket. */
export function summaryMarkdown(system: string, at: string, score: { score: number; label: string; reasons: string[] }, tiles: { label: string; value: string }[], att: { text: string }[]): string {
  return [`**${system}** — health ${score.score}/100 (${score.label}) — ${at}`, '',
    ...tiles.map(t => `- ${t.label}: ${t.value}`), '',
    att.length ? '**Needs attention**' : '**Nothing needs attention.**', ...att.map(a => `- ${a.text}`)].join('\n') + '\n';
}

// ---------------------------------------------------------------- scheduled jobs, journals, object scan

export function scheduleCommand(action: 'hold' | 'release', job: string, entry: number): string {
  const j = job.trim().toUpperCase();
  if (!QNAME.test(j) || !Number.isInteger(entry) || entry < 1 || entry > 999999) { throw new Error('Invalid job schedule entry.'); }
  return `${action === 'hold' ? 'HLD' : 'RLS'}JOBSCDE JOB(${j}) ENTRYNBR(${String(entry).padStart(6, '0')})`;
}

/** Journals worth a look: many receivers kept, or very large. Sizes in bytes. */
export function journalTone(receivers: number | undefined, bytes: number | undefined): Tone | undefined {
  if ((receivers ?? 0) >= 200 || (bytes ?? 0) >= 50 * 1024 ** 3) { return 'bad'; }
  if ((receivers ?? 0) >= 50 || (bytes ?? 0) >= 10 * 1024 ** 3) { return 'warn'; }
  return undefined;
}

/** Objects changed in the last days, in some libraries or all user libraries. */
export function objectScanSql(days: number, libs: string[], order: 'changed' | 'size'): string {
  const d = Math.max(1, Math.min(90, Math.floor(days)));
  const ok = libs.filter(l => QNAME.test(l.toUpperCase()));
  const from = ok.length ? `(${ok.map(l => `SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS('${l.toUpperCase()}', '*ALL')) X`).join(' UNION ALL ')})` : `TABLE(QSYS2.OBJECT_STATISTICS('*ALLUSR', '*ALL'))`;
  return `SELECT OBJLIB AS L, OBJNAME AS N, OBJTYPE AS T, COALESCE(OBJATTRIBUTE, '') AS A, OBJSIZE AS Z, VARCHAR(CHANGE_TIMESTAMP) AS C, COALESCE(OBJOWNER, '') AS O, COALESCE(OBJTEXT, '') AS X ` +
    `FROM ${from} S ` + (order === 'changed' ? `WHERE CHANGE_TIMESTAMP > CURRENT TIMESTAMP - ${d} DAYS ORDER BY CHANGE_TIMESTAMP DESC` : `ORDER BY OBJSIZE DESC`) + ' FETCH FIRST 500 ROWS ONLY';
}
