// Pure helpers for the 0.9 "system tools": journal explorer, authority checker, data queues &
// data areas, and the PTF & system health report. No vscode import, unit tested.

// ---------------------------------------------------------------- journal explorer

/** Readable names for the record-level journal entry types (journal code R). */
export const JOURNAL_ENTRY_TYPES: Record<string, string> = {
  PT: 'Row added', PX: 'Row added (by RRN)', UB: 'Before update', UP: 'After update',
  DL: 'Row deleted', DR: 'Row deleted (rollback)', BR: 'Before rollback', UR: 'After rollback',
};

export interface JournalEntry {
  seq: string; time: string; type: string; rrn: string;
  user: string; job: string; program: string; data?: string;
}

export interface JournalChange {
  time: string; action: 'added' | 'updated' | 'deleted' | 'other'; rrn: string;
  user: string; job: string; program: string; before?: string; after?: string; seq: string;
}

/** Pair each UB (before image) with the UP (after image) that follows it for the same row. */
export function pairJournalEntries(entries: JournalEntry[]): JournalChange[] {
  const out: JournalChange[] = [];
  const pendingBefore = new Map<string, JournalEntry>();
  for (const e of entries) {
    const base = { time: e.time, rrn: e.rrn, user: e.user, job: e.job, program: e.program, seq: e.seq };
    switch (e.type) {
      case 'UB': pendingBefore.set(`${e.job}|${e.rrn}`, e); break;
      case 'UP': {
        const key = `${e.job}|${e.rrn}`;
        const b = pendingBefore.get(key); pendingBefore.delete(key);
        out.push({ ...base, action: 'updated', before: b?.data, after: e.data });
        break;
      }
      case 'PT': case 'PX': out.push({ ...base, action: 'added', after: e.data }); break;
      case 'DL': case 'DR': out.push({ ...base, action: 'deleted', before: e.data }); break;
      default: out.push({ ...base, action: 'other', after: e.data });
    }
  }
  // A before image without its after image (journal with IMAGES(*BOTH) cut by the time range).
  for (const b of pendingBefore.values()) {
    out.push({ time: b.time, rrn: b.rrn, user: b.user, job: b.job, program: b.program, seq: b.seq, action: 'updated', before: b.data });
  }
  return out.sort((a, b) => Number(a.seq) - Number(b.seq));
}

/** Who changed the table, and from which program: counts per user + program. */
export function summarizeChanges(changes: JournalChange[]): { user: string; program: string; added: number; updated: number; deleted: number; last: string }[] {
  const m = new Map<string, { user: string; program: string; added: number; updated: number; deleted: number; last: string }>();
  for (const c of changes) {
    const k = `${c.user}|${c.program}`;
    const r = m.get(k) ?? { user: c.user, program: c.program, added: 0, updated: 0, deleted: 0, last: '' };
    if (c.action === 'added') { r.added++; } else if (c.action === 'updated') { r.updated++; } else if (c.action === 'deleted') { r.deleted++; }
    if (c.time > r.last) { r.last = c.time; }
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => (b.added + b.updated + b.deleted) - (a.added + a.updated + a.deleted));
}

/** Show where two record images differ: returns the changed slices as "pos: before → after". */
export function diffImages(before = '', after = '', context = 0): string[] {
  const out: string[] = [];
  const n = Math.max(before.length, after.length);
  let i = 0;
  while (i < n) {
    if (before[i] === after[i]) { i++; continue; }
    const start = i;
    while (i < n && before[i] !== after[i]) { i++; }
    const s = Math.max(0, start - context); const e = Math.min(n, i + context);
    out.push(`pos ${start + 1}: "${before.slice(s, e).trimEnd()}" → "${after.slice(s, e).trimEnd()}"`);
  }
  return out;
}

export interface JournalQuery {
  journalLibrary: string; journal: string; library: string; table: string;
  hours: number; user?: string; rrn?: number; withData?: boolean; limit?: number;
}

/** QSYS2.DISPLAY_JOURNAL query for the row changes of one table. */
export function journalSql(q: JournalQuery): string {
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const where = [
    q.user ? `JOB_USER = ${lit(q.user.toUpperCase())} OR "CURRENT_USER" = ${lit(q.user.toUpperCase())}` : '',
    q.rrn ? `COUNT_OR_RRN = ${Math.trunc(q.rrn)}` : '',
  ].filter(Boolean).map(w => `(${w})`);
  const data = q.withData ? `, CAST(CAST(SUBSTR(ENTRY_DATA, 1, 2000) AS VARBINARY(2000)) AS VARCHAR(2000) CCSID 37) AS DATA` : '';
  return `SELECT SEQUENCE_NUMBER AS SEQ, VARCHAR_FORMAT(ENTRY_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TIME, JOURNAL_ENTRY_TYPE AS TYPE, ` +
    `COUNT_OR_RRN AS RRN, JOB_USER AS USR, JOB_NUMBER || '/' || TRIM(JOB_USER) || '/' || TRIM(JOB_NAME) AS JOB, ` +
    `TRIM(COALESCE(PROGRAM_LIBRARY, '')) || CASE WHEN PROGRAM_LIBRARY IS NULL THEN '' ELSE '/' END || TRIM(PROGRAM_NAME) AS PGM${data} ` +
    `FROM TABLE(QSYS2.DISPLAY_JOURNAL(${lit(q.journalLibrary)}, ${lit(q.journal)}, ` +
    `STARTING_RECEIVER_NAME => '*CURCHAIN', STARTING_TIMESTAMP => CURRENT TIMESTAMP - ${Math.max(1, Math.trunc(q.hours))} HOURS, ` +
    `JOURNAL_CODES => 'R', JOURNAL_ENTRY_TYPES => 'PT PX UB UP DL DR', ` +
    `OBJECT_LIBRARY => ${lit(q.library)}, OBJECT_NAME => ${lit(q.table)}, OBJECT_OBJTYPE => '*FILE', OBJECT_MEMBER => '*ALL')) J` +
    `${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY SEQUENCE_NUMBER DESC FETCH FIRST ${q.limit ?? 500} ROWS ONLY`;
}

// ---------------------------------------------------------------- authority checker

export type AuthFlag = 'OBJOPR' | 'OBJMGT' | 'OBJEXIST' | 'OBJALTER' | 'OBJREF' | 'READ' | 'ADD' | 'UPD' | 'DLT' | 'EXECUTE';
const ALL_FLAGS: AuthFlag[] = ['OBJOPR', 'OBJMGT', 'OBJEXIST', 'OBJALTER', 'OBJREF', 'READ', 'ADD', 'UPD', 'DLT', 'EXECUTE'];

/** The individual authorities each system-defined authority stands for. */
export const AUTHORITY_FLAGS: Record<string, AuthFlag[]> = {
  '*ALL': ALL_FLAGS,
  '*CHANGE': ['OBJOPR', 'READ', 'ADD', 'UPD', 'DLT', 'EXECUTE'],
  '*USE': ['OBJOPR', 'READ', 'EXECUTE'],
  '*EXCLUDE': [],
};

/** What the user wants to do, and the authority it needs. */
export const NEEDS: Record<string, { label: string; flags: AuthFlag[]; grant: string }> = {
  use: { label: 'Use it (read a file, call a program, run a command)', flags: AUTHORITY_FLAGS['*USE'], grant: '*USE' },
  change: { label: 'Change its data (add, update, delete rows)', flags: AUTHORITY_FLAGS['*CHANGE'], grant: '*CHANGE' },
  manage: { label: 'Manage it (move, rename, delete, recompile over it)', flags: ALL_FLAGS, grant: '*ALL' },
};

/** One row of QSYS2.OBJECT_PRIVILEGES (or of an authorization list). */
export interface Privilege {
  name: string; authority: string;
  flags?: Partial<Record<AuthFlag, boolean>>;
}

export function flagsOf(p: Privilege): Set<AuthFlag> {
  const a = p.authority.trim().toUpperCase();
  if (AUTHORITY_FLAGS[a]) { return new Set(AUTHORITY_FLAGS[a]); }
  return new Set(ALL_FLAGS.filter(f => p.flags?.[f]));
}

export interface UserFacts {
  user: string; specialAuthorities: string; groups: string[]; status?: string;
}

export interface AuthorityVerdict {
  allowed: boolean;
  source: string;
  authority: string;
  missing: AuthFlag[];
  explanation: string;
}

/**
 * Resolve the authority a user gets on an object, in the order IBM i checks it (simplified):
 * *ALLOBJ special authority → private authority of the user → private authority of the user's
 * groups → authorization list → *PUBLIC. (Adopted authority is not considered.)
 */
export function resolveAuthority(u: UserFacts, privileges: Privilege[], needed: AuthFlag[], autl: Privilege[] = [], autlName = ''): AuthorityVerdict {
  const verdict = (source: string, p: Privilege | undefined, explanation: string): AuthorityVerdict => {
    const have = p ? flagsOf(p) : new Set<AuthFlag>();
    const missing = needed.filter(f => !have.has(f));
    return { allowed: missing.length === 0, source, authority: p?.authority ?? '*EXCLUDE', missing, explanation };
  };
  if (/\*ALLOBJ/i.test(u.specialAuthorities)) {
    return { allowed: true, source: '*ALLOBJ special authority', authority: '*ALL', missing: [], explanation: `${u.user} has *ALLOBJ, which gives every authority on every object.` };
  }
  const byName = new Map(privileges.map(p => [p.name.trim().toUpperCase(), p]));
  const own = byName.get(u.user.toUpperCase());
  if (own) {
    return verdict(`private authority of ${u.user}`, own, `${u.user} has its own authority ${own.authority} on the object, so group, list and *PUBLIC authorities are not used.`);
  }
  const groupRows = u.groups.map(g => byName.get(g.toUpperCase())).filter((p): p is Privilege => !!p);
  if (groupRows.length) {
    const merged = new Set<AuthFlag>(); groupRows.forEach(g => flagsOf(g).forEach(f => merged.add(f)));
    const missing = needed.filter(f => !merged.has(f));
    return { allowed: !missing.length, source: `group profile ${groupRows.map(g => g.name).join(', ')}`, authority: groupRows.map(g => g.authority).join(' + '), missing,
      explanation: `${u.user} has no authority of its own; it gets the authority of its group profile(s).` };
  }
  if (autlName && autl.length) {
    const al = new Map(autl.map(p => [p.name.trim().toUpperCase(), p]));
    const hit = al.get(u.user.toUpperCase()) ?? u.groups.map(g => al.get(g.toUpperCase())).find(Boolean);
    if (hit) { return verdict(`authorization list ${autlName}`, hit, `The object is secured by authorization list ${autlName}, which lists ${hit.name}.`); }
  }
  let pub = byName.get('*PUBLIC');
  if (pub && /\*AUTL/i.test(pub.authority) && autl.length) {
    pub = autl.find(p => p.name.trim().toUpperCase() === '*PUBLIC') ?? pub;
    return verdict(`*PUBLIC from authorization list ${autlName}`, pub, `${u.user} is not named anywhere, so the *PUBLIC authority of authorization list ${autlName} applies.`);
  }
  return verdict('*PUBLIC', pub, `${u.user} is not named on the object, so *PUBLIC authority applies.`);
}

/** The GRTOBJAUT command that would give the user what is missing. */
export function grantCommand(library: string, name: string, type: string, user: string, authority: string): string {
  return `GRTOBJAUT OBJ(${library}/${name}) OBJTYPE(${type}) USER(${user}) AUT(${authority})`;
}

// ---------------------------------------------------------------- data areas & data queues

export interface DataAreaInfo { type: string; length: number; decimals: number }

/** Validate a new value and build the CHGDTAARA command for it. */
export function changeDataAreaCommand(library: string, name: string, info: DataAreaInfo, value: string): string {
  const t = info.type.toUpperCase().replace(/^\*/, '');
  const target = `${library}/${name}`;
  if (t === 'DEC') {
    const v = value.trim();
    if (!/^[-+]?\d*(\.\d*)?$/.test(v) || !/\d/.test(v)) { throw new Error('Enter a number.'); }
    const [int = '', dec = ''] = v.replace(/^[-+]/, '').split('.');
    if (dec.length > info.decimals) { throw new Error(`At most ${info.decimals} decimal position(s).`); }
    if (int.replace(/^0+/, '').length > info.length - info.decimals) { throw new Error(`The number is too large for a ${info.length},${info.decimals} data area.`); }
    return `CHGDTAARA DTAARA(${target}) VALUE(${v})`;
  }
  if (t === 'LGL') {
    if (!/^[01]$/.test(value.trim())) { throw new Error("A logical data area holds '0' or '1'."); }
    return `CHGDTAARA DTAARA(${target}) VALUE('${value.trim()}')`;
  }
  if (value.length > info.length) { throw new Error(`The value is ${value.length} characters; the data area holds ${info.length}.`); }
  return `CHGDTAARA DTAARA(${target} (1 ${info.length})) VALUE('${value.padEnd(info.length).replace(/'/g, "''")}')`;
}

/** Make binary-ish queue data readable: keep printable characters, show the rest as dots. */
export function printable(text: string, max = 500): string {
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '·');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// ---------------------------------------------------------------- PTF & system health

export type Level = 'ok' | 'warn' | 'bad';
export interface HealthFinding { level: Level; area: string; text: string; action?: string }

export interface HealthInput {
  release?: string;
  aspUsedPercent?: number;
  groups?: { id: string; title: string; installed: number; available: number; currency: string }[];
  pendingPtfs?: { ptf: string; product: string; action: string; ipl: string }[];
  expiringCerts?: { label: string; ends: string; days: number }[];
  disabledProfiles?: number;
  expiringPasswords?: number;
  defaultPasswords?: number;
}

/** Turn the raw numbers into a short list of findings, worst first. */
export function healthFindings(h: HealthInput): HealthFinding[] {
  const f: HealthFinding[] = [];
  if (h.aspUsedPercent !== undefined) {
    const p = h.aspUsedPercent;
    f.push({ level: p >= 90 ? 'bad' : p >= 80 ? 'warn' : 'ok', area: 'Storage',
      text: `System ASP is ${p.toFixed(1)}% used.`, action: p >= 80 ? 'Clean up spooled files, journal receivers and old save files; IBM recommends staying below 80%.' : undefined });
  }
  if (h.groups) {
    const behind = h.groups.filter(g => /UPDATE AVAILABLE/i.test(g.currency) || g.available > g.installed);
    const critical = behind.filter(g => /SECURITY|HIPER|CUMULATIVE|DB2|DATABASE/i.test(`${g.id} ${g.title}`));
    f.push(behind.length
      ? { level: critical.length ? 'bad' : 'warn', area: 'PTF groups', text: `${behind.length} PTF group(s) have a newer level at IBM${critical.length ? ` (incl. ${critical.map(g => g.id).join(', ')})` : ''}.`, action: 'Order the newer levels with SNDPTFORD or Fix Central.' }
      : { level: 'ok', area: 'PTF groups', text: 'All PTF groups are at the level IBM currently offers.' });
  }
  if (h.pendingPtfs) {
    const ipl = h.pendingPtfs.filter(p => /IMMEDIATE|DELAYED/i.test(p.ipl) || /APPLIED|REMOVED/i.test(p.action));
    if (ipl.length) { f.push({ level: 'warn', area: 'Pending PTFs', text: `${ipl.length} PTF(s) are waiting for the next IPL to be applied or removed.`, action: 'Plan an IPL so the fixes take effect.' }); }
    const loaded = h.pendingPtfs.length - ipl.length;
    if (loaded > 0) { f.push({ level: 'warn', area: 'Pending PTFs', text: `${loaded} PTF(s) are loaded but not applied.`, action: 'Apply them with APYPTF, or remove them if not wanted.' }); }
    if (!h.pendingPtfs.length) { f.push({ level: 'ok', area: 'Pending PTFs', text: 'No PTFs waiting for an IPL.' }); }
  }
  if (h.expiringCerts) {
    const expired = h.expiringCerts.filter(c => c.days < 0);
    const soon = h.expiringCerts.filter(c => c.days >= 0);
    if (expired.length) { f.push({ level: 'bad', area: 'Certificates', text: `${expired.length} certificate(s) have expired: ${expired.map(c => c.label).join(', ')}.`, action: 'Renew them in Digital Certificate Manager (DCM).' }); }
    if (soon.length) { f.push({ level: 'warn', area: 'Certificates', text: `${soon.length} certificate(s) expire within 60 days: ${soon.map(c => `${c.label} (${c.days} d)`).join(', ')}.`, action: 'Renew them before they expire to avoid TLS outages.' }); }
    if (!h.expiringCerts.length) { f.push({ level: 'ok', area: 'Certificates', text: 'No certificate expires within 60 days.' }); }
  }
  if (h.defaultPasswords) { f.push({ level: 'bad', area: 'Security', text: `${h.defaultPasswords} enabled user profile(s) have a default password (same as the profile name).`, action: 'Change or disable them (ANZDFTPWD lists them).' }); }
  if (h.expiringPasswords) { f.push({ level: 'warn', area: 'Security', text: `${h.expiringPasswords} enabled user profile(s) have a password that expires within 7 days.` }); }
  if (h.disabledProfiles !== undefined) { f.push({ level: 'ok', area: 'Security', text: `${h.disabledProfiles} user profile(s) are disabled.` }); }
  const rank: Record<Level, number> = { bad: 0, warn: 1, ok: 2 };
  return f.sort((a, b) => rank[a.level] - rank[b.level]);
}
