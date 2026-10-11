// Pure helpers for the 0.11 "Work with…" screens: work management, users & security,
// save/restore and network. No vscode import, unit tested.

import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

// ---------------------------------------------------------------- work management

/** Qualified job name 123456/USER/NAME. */
export function isQualifiedJob(job: string): boolean {
  return /^\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}$/i.test(job.trim());
}

export interface ScheduleEntry {
  name: string; command: string; frequency: '*ONCE' | '*WEEKLY' | '*MONTHLY';
  /** *CURRENT (today), *MONTHSTR or *MONTHEND. */
  date?: string; time: string; days?: string[]; jobq?: string; user?: string; text?: string;
}

const DAYS = ['*MON', '*TUE', '*WED', '*THU', '*FRI', '*SAT', '*SUN', '*ALL'];

/** ADDJOBSCDE for a new job schedule entry, validated. */
export function addJobScheduleCommand(e: ScheduleEntry): string {
  const name = NAME(e.name, 'job');
  if (!e.command.trim()) { throw new Error('Enter the command to run.'); }
  if (!/^([01]\d|2[0-3]):?[0-5]\d(:?[0-5]\d)?$/.test(e.time.trim())) { throw new Error('Enter the time as HH:MM (24 hours).'); }
  const time = e.time.trim().replace(/:/g, '').padEnd(6, '0');
  const parts = [`ADDJOBSCDE JOB(${name})`, `CMD(${e.command.trim()})`, `FRQ(${e.frequency})`, `SCDTIME(${time})`];
  if (e.frequency === '*WEEKLY') {
    const days = (e.days ?? []).map(d => d.trim().toUpperCase()).filter(Boolean);
    if (!days.length || days.some(d => !DAYS.includes(d))) { throw new Error('Pick the days of the week.'); }
    parts.push(`SCDDATE(*NONE)`, `SCDDAY(${days.join(' ')})`);
  } else {
    const d = (e.date ?? '*CURRENT').trim().toUpperCase() || '*CURRENT';
    if (!['*CURRENT', '*MONTHSTR', '*MONTHEND'].includes(d)) { throw new Error('The date is *CURRENT, *MONTHSTR or *MONTHEND.'); }
    parts.push(`SCDDATE(${d})`);
  }
  if (e.jobq?.trim()) { parts.push(`JOBQ(${e.jobq.trim().toUpperCase()})`); }
  if (e.user?.trim()) { parts.push(`USER(${NAME(e.user, 'user profile')})`); }
  if (e.text?.trim()) { parts.push(`TEXT('${e.text.trim().slice(0, 50).replace(/'/g, "''")}')`); }
  return parts.join(' ');
}

// ---------------------------------------------------------------- users & security

/** Short descriptions of the system values people look up most. */
export const SYSTEM_VALUES: Record<string, { group: string; text: string }> = {
  QSECURITY: { group: 'Security', text: 'System security level (40 or 50 recommended)' },
  QPWDEXPITV: { group: 'Security', text: 'Days before a password expires' },
  QPWDMINLEN: { group: 'Security', text: 'Minimum password length' },
  QPWDLVL: { group: 'Security', text: 'Password level (long / case-sensitive passwords)' },
  QPWDRULES: { group: 'Security', text: 'Password composition rules' },
  QMAXSIGN: { group: 'Security', text: 'Sign-on attempts allowed before action' },
  QMAXSGNACN: { group: 'Security', text: 'Action when sign-on attempts are exceeded' },
  QINACTITV: { group: 'Security', text: 'Minutes before an inactive job is acted on' },
  QINACTMSGQ: { group: 'Security', text: 'What happens to inactive jobs' },
  QLMTSECOFR: { group: 'Security', text: 'Limit security officer device access' },
  QCRTAUT: { group: 'Security', text: 'Default *PUBLIC authority for new objects' },
  QALWOBJRST: { group: 'Security', text: 'Allow restore of security-sensitive objects' },
  QRETSVRSEC: { group: 'Security', text: 'Retain server security data' },
  QAUDCTL: { group: 'Auditing', text: 'Auditing control' },
  QAUDLVL: { group: 'Auditing', text: 'Security auditing level' },
  QAUDLVL2: { group: 'Auditing', text: 'Security auditing level extension' },
  QSYSLIBL: { group: 'Library lists', text: 'System part of the library list' },
  QUSRLIBL: { group: 'Library lists', text: 'User part of the library list' },
  QCCSID: { group: 'Language', text: 'Coded character set identifier' },
  QLANGID: { group: 'Language', text: 'Language identifier' },
  QCNTRYID: { group: 'Language', text: 'Country or region identifier' },
  QDATFMT: { group: 'Date & time', text: 'Date format' },
  QDATSEP: { group: 'Date & time', text: 'Date separator' },
  QTIMZON: { group: 'Date & time', text: 'Time zone' },
  QDECFMT: { group: 'Language', text: 'Decimal format' },
  QMODEL: { group: 'System', text: 'System model' },
  QSRLNBR: { group: 'System', text: 'Serial number' },
  QIPLTYPE: { group: 'System', text: 'Type of IPL to perform' },
  QSTRUPPGM: { group: 'System', text: 'Startup program' },
  QCTLSBSD: { group: 'System', text: 'Controlling subsystem' },
  QMAXACTLVL: { group: 'Performance', text: 'Maximum activity level of the system' },
  QPFRADJ: { group: 'Performance', text: 'Performance adjustment' },
  QQRYDEGREE: { group: 'Performance', text: 'Parallel processing degree for queries' },
  QJOBMSGQFL: { group: 'Work management', text: 'Job message queue full action' },
  QJOBMSGQMX: { group: 'Work management', text: 'Job message queue maximum size' },
  QLOGOUTPUT: { group: 'Work management', text: 'Produce a printer output for the job log' },
  QMAXSPLF: { group: 'Work management', text: 'Maximum spooled files per job' },
  QSPLFACN: { group: 'Work management', text: 'Spooled file action when the job ends' },
  QATNPGM: { group: 'Work management', text: 'Attention program' },
};

/** Security audit journal (QAUDJRN) entry types worth looking at. */
export const AUDIT_TYPES: Record<string, string> = {
  AF: 'Authority failure', PW: 'Invalid password or user ID', CA: 'Authority changed', CP: 'User profile created, changed or restored',
  DO: 'Object deleted', OW: 'Object owner changed', SV: 'System value changed', PS: 'Profile swap', PA: 'Program changed to adopt authority',
  ZC: 'Object changed', ZR: 'Object read', CO: 'Object created', GR: 'Generic record (exit points, functions)', AD: 'Auditing changed',
  RA: 'Authority changed on restore', RO: 'Object owner changed on restore', SE: 'Subsystem routing entry changed', ST: 'Service tools used',
  JS: 'Job changed or ended', SO: 'Server security user information', PG: 'Primary group changed', DS: 'Service tools user ID reset',
};

/** QSYS2.DISPLAY_JOURNAL on QAUDJRN for the chosen entry types. */
export function auditJournalSql(types: string[], hours: number, user?: string, limit = 500): string {
  const t = types.map(x => x.trim().toUpperCase()).filter(x => /^[A-Z]{2}$/.test(x));
  if (!t.length) { throw new Error('Pick at least one entry type.'); }
  const u = user?.trim() ? NAME(user, 'user profile') : '';
  return `SELECT VARCHAR_FORMAT(ENTRY_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TIME, JOURNAL_ENTRY_TYPE AS TYPE, ` +
    `JOB_NUMBER || '/' || TRIM(JOB_USER) || '/' || TRIM(JOB_NAME) AS JOB, TRIM(COALESCE("CURRENT_USER", JOB_USER)) AS USR, ` +
    `TRIM(COALESCE(PROGRAM_LIBRARY, '')) || CASE WHEN PROGRAM_LIBRARY IS NULL THEN '' ELSE '/' END || TRIM(COALESCE(PROGRAM_NAME, '')) AS PGM, ` +
    `COALESCE(REMOTE_ADDRESS, '') AS RMT, ` +
    `CAST(CAST(SUBSTR(ENTRY_DATA, 1, 400) AS VARBINARY(400)) AS VARCHAR(400) CCSID 37) AS DATA ` +
    `FROM TABLE(QSYS2.DISPLAY_JOURNAL('QSYS', 'QAUDJRN', STARTING_RECEIVER_NAME => '*CURCHAIN', ` +
    `STARTING_TIMESTAMP => CURRENT TIMESTAMP - ${Math.max(1, Math.trunc(hours))} HOURS, JOURNAL_CODES => 'T', JOURNAL_ENTRY_TYPES => '${t.join(' ')}')) J` +
    `${u ? ` WHERE JOB_USER = '${u}' OR "CURRENT_USER" = '${u}'` : ''} ORDER BY ENTRY_TIMESTAMP DESC FETCH FIRST ${limit} ROWS ONLY`;
}

// ---------------------------------------------------------------- save / restore

export interface SaveSpec {
  what: 'library' | 'objects'; library: string; objects?: string[];
  savfLibrary: string; savf: string; targetRelease?: string; compress?: boolean;
}

export function saveCommand(s: SaveSpec): string {
  const lib = NAME(s.library, 'library'); const sl = NAME(s.savfLibrary, 'library'); const sf = NAME(s.savf, 'save file');
  const extra = `${s.targetRelease && s.targetRelease !== '*CURRENT' ? ` TGTRLS(${s.targetRelease.toUpperCase()})` : ''}${s.compress ? ' DTACPR(*YES)' : ''}`;
  if (s.what === 'library') { return `SAVLIB LIB(${lib}) DEV(*SAVF) SAVF(${sl}/${sf})${extra}`; }
  const objs = (s.objects ?? []).map(o => o.trim().toUpperCase()).filter(Boolean);
  if (!objs.length) { throw new Error('Name at least one object (generic names like ORD* are allowed).'); }
  if (objs.some(o => !/^[A-Z$#@][A-Z0-9$#@_.]{0,9}\*?$|^\*ALL$/.test(o))) { throw new Error('Object names are 1–10 characters; a generic name ends with *.'); }
  return `SAVOBJ OBJ(${objs.join(' ')}) LIB(${lib}) DEV(*SAVF) SAVF(${sl}/${sf}) OBJTYPE(*ALL)${extra}`;
}

export interface RestoreSpec {
  what: 'library' | 'objects'; savedLibrary: string; objects?: string[];
  savfLibrary: string; savf: string; restoreInto?: string;
}

export function restoreCommand(r: RestoreSpec): string {
  const lib = NAME(r.savedLibrary, 'library'); const sl = NAME(r.savfLibrary, 'library'); const sf = NAME(r.savf, 'save file');
  const into = r.restoreInto?.trim() ? NAME(r.restoreInto, 'library') : '';
  const target = into && into !== lib ? ` RSTLIB(${into})` : '';
  if (r.what === 'library') { return `RSTLIB SAVLIB(${lib}) DEV(*SAVF) SAVF(${sl}/${sf})${target}`; }
  const objs = (r.objects ?? ['*ALL']).map(o => o.trim().toUpperCase()).filter(Boolean);
  return `RSTOBJ OBJ(${objs.join(' ') || '*ALL'}) SAVLIB(${lib}) DEV(*SAVF) SAVF(${sl}/${sf}) OBJTYPE(*ALL)${target}`;
}

/** Releases a save can target, newest first: the current one and the two before it. */
export function targetReleases(current: string): string[] {
  const m = /V?(\d)R(\d)M(\d)/i.exec(current) ?? /(\d)\.(\d)/.exec(current);
  if (!m) { return ['*CURRENT', '*PRV']; }
  const v = Number(m[1]); const r = Number(m[2]);
  const out = ['*CURRENT', '*PRV'];
  for (let i = 1; i <= 2; i++) { const rr = r - i; if (rr >= 0) { out.push(`V${v}R${rr}M0`); } }
  return out;
}

// ---------------------------------------------------------------- network & services

export interface TcpServer { server: string; name: string; ports: number[]; start: string; end: string; note?: string }

/** The common TCP/IP servers, the ports they listen on and how to start / end them. */
export const TCP_SERVERS: TcpServer[] = [
  { server: '*SSHD', name: 'SSH (used by Vanthrex)', ports: [22], start: 'STRTCPSVR SERVER(*SSHD)', end: 'ENDTCPSVR SERVER(*SSHD)', note: 'Ending it disconnects every SSH session, including Vanthrex.' },
  { server: '*HOSTSVR', name: 'Host servers (ACS, ODBC, JDBC)', ports: [449, 8470, 8471, 8472, 8473, 8474, 8475, 8476], start: 'STRHOSTSVR SERVER(*ALL)', end: 'ENDHOSTSVR SERVER(*ALL)' },
  { server: '*DDM', name: 'DDM / DRDA', ports: [446, 448], start: 'STRTCPSVR SERVER(*DDM)', end: 'ENDTCPSVR SERVER(*DDM)' },
  { server: '*FTP', name: 'FTP', ports: [21], start: 'STRTCPSVR SERVER(*FTP)', end: 'ENDTCPSVR SERVER(*FTP)' },
  { server: '*TELNET', name: 'Telnet (5250)', ports: [23, 992], start: 'STRTCPSVR SERVER(*TELNET)', end: 'ENDTCPSVR SERVER(*TELNET)', note: 'Ending it disconnects 5250 sessions.' },
  { server: '*HTTP', name: 'HTTP admin (Navigator, DCM)', ports: [2001, 2005], start: "STRTCPSVR SERVER(*HTTP) HTTPSVR(*ADMIN)", end: "ENDTCPSVR SERVER(*HTTP) HTTPSVR(*ADMIN)" },
  { server: '*NETSVR', name: 'NetServer (Windows file shares)', ports: [445, 139], start: 'STRTCPSVR SERVER(*NETSVR)', end: 'ENDTCPSVR SERVER(*NETSVR)' },
  { server: '*SMTP', name: 'SMTP mail', ports: [25], start: 'STRTCPSVR SERVER(*SMTP)', end: 'ENDTCPSVR SERVER(*SMTP)' },
  { server: '*MAPEPIRE', name: 'Mapepire (SQL for Vanthrex)', ports: [8076], start: '', end: '', note: 'Started automatically by Vanthrex when needed.' },
];

/** Which of the known servers are listening, given the local ports in LISTEN state. */
export function serverStatus(listening: number[]): (TcpServer & { listening: boolean; open: number[] })[] {
  const set = new Set(listening);
  return TCP_SERVERS.map(s => {
    const open = s.ports.filter(p => set.has(p));
    return { ...s, listening: open.length > 0, open };
  });
}

/** ENDTCPCNN for one TCP connection. */
export function endConnectionCommand(localAddress: string, localPort: number, remoteAddress: string, remotePort: number): string {
  const ip = (a: string) => { if (!/^[0-9a-fA-F:.]+$/.test(a)) { throw new Error(`"${a}" is not an IP address.`); } return a; };
  return `ENDTCPCNN PROTOCOL(*TCP) LCLINTNETA('${ip(localAddress)}') LCLPORT(${Math.trunc(localPort)}) RMTINTNETA('${ip(remoteAddress)}') RMTPORT(${Math.trunc(remotePort)})`;
}
