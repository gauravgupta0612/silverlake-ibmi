// SQL Error Logging Facility (SELF): which SQL codes are logged, the log itself and its summary. Pure, unit tested.
// SYSIBMADM.SELFCODES lists the SQLCODEs to log ('*ERR', '*WARN', '*ALL', '*NONE' or codes such as '-204, -803');
// QSYS2.SQL_ERROR_LOG holds what was logged.

export type SelfPreset = '*ERR' | '*WARN' | '*ALL' | '*NONE';

/** Check and normalise a SELFCODES value. */
export function selfCodesValue(input: string): string {
  const v = input.trim().toUpperCase();
  if (['*ERR', '*WARN', '*ALL', '*NONE'].includes(v)) { return v; }
  const parts = v.split(/[\s,]+/).filter(Boolean);
  if (!parts.length) { throw new Error('Give *ERR, *WARN, *ALL, *NONE or a list of SQL codes such as -204, -803.'); }
  for (const p of parts) {
    if (!/^[-+]?\d{1,5}$/.test(p)) { throw new Error(`"${p}" is not an SQL code (for example -204).`); }
  }
  const out = parts.map(p => String(Number(p))).join(', ');
  if (out.length > 256) { throw new Error('Too many SQL codes: the list may be at most 256 characters.'); }
  return out;
}

/** Make the setting the default of every new SQL session on the system (needs *SECADM or authority to SYSIBMADM). */
export function systemWideSql(value: string): string {
  return `CREATE OR REPLACE VARIABLE SYSIBMADM.SELFCODES VARCHAR(256) DEFAULT '${selfCodesValue(value).replace(/'/g, "''")}'`;
}

export interface ErrorLogFilter { hours?: number; user?: string; program?: string; sqlcode?: number }

const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

export function errorLogSql(f: ErrorLogFilter, max = 1000): string {
  const where: string[] = [];
  const hours = Math.floor(f.hours ?? 24);
  if (hours > 0) { where.push(`LOGGED_TIME >= CURRENT TIMESTAMP - ${Math.min(hours, 24 * 366)} HOURS`); }
  const user = f.user?.trim().toUpperCase();
  if (user) { if (!NAME.test(user)) { throw new Error('Invalid user name.'); } where.push(`JOB_NAME LIKE '%/${user}/%'`); }
  const pgm = f.program?.trim().toUpperCase();
  if (pgm) { if (!NAME.test(pgm)) { throw new Error('Invalid program name.'); } where.push(`PROGRAM_NAME = '${pgm}'`); }
  if (f.sqlcode !== undefined && Number.isFinite(f.sqlcode)) { where.push(`LOGGED_SQLCODE = ${Math.trunc(f.sqlcode)}`); }
  return `SELECT VARCHAR_FORMAT(LOGGED_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LOGGED, LOGGED_SQLCODE AS SQLCODE, COALESCE(LOGGED_SQLSTATE, '') AS SQLSTATE, ` +
    `COALESCE(JOB_NAME, '') AS JOB, COALESCE(PROGRAM_LIBRARY, '') AS PGMLIB, COALESCE(PROGRAM_NAME, '') AS PGM, COALESCE(MODULE_NAME, '') AS MODULE, ` +
    `COALESCE(PROGRAM_TYPE, '') AS PGMTYPE, COALESCE(STATEMENT_OPERATION_DETAIL, '') AS OPERATION, CAST(COALESCE(STATEMENT_TEXT, '') AS VARCHAR(2000)) AS STMT ` +
    `FROM QSYS2.SQL_ERROR_LOG${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY LOGGED_TIME DESC FETCH FIRST ${Math.max(1, Math.floor(max))} ROWS ONLY`;
}

/** Message ID for an SQLCODE: -204 → SQL0204, 100 → SQL0100, -7008 → SQL7008. */
export function sqlMessageId(code: number): string {
  const a = Math.abs(Math.trunc(code));
  return `SQL${String(a).padStart(4, '0').slice(-4)}`;
}

export interface LoggedError { logged: string; sqlcode: number; sqlstate: string; job: string; program: string; module: string; statement: string }
export interface ErrorGroup { sqlcode: number; messageId: string; program: string; statement: string; count: number; last: string; jobs: number }

export function toLoggedError(r: Record<string, unknown>): LoggedError {
  const s = (k: string) => String(r[k] ?? '').trim();
  const lib = s('PGMLIB'); const pgm = s('PGM');
  return { logged: s('LOGGED'), sqlcode: Number(r.SQLCODE ?? 0) || 0, sqlstate: s('SQLSTATE'), job: s('JOB'), program: pgm ? (lib ? `${lib}/${pgm}` : pgm) : '', module: s('MODULE'), statement: s('STMT').replace(/\s+/g, ' ') };
}

/** Same error from the same program and statement counted once: what fails most, and where. */
export function groupErrors(list: LoggedError[]): ErrorGroup[] {
  const m = new Map<string, ErrorGroup & { jobSet: Set<string> }>();
  for (const e of list) {
    const k = `${e.sqlcode}|${e.program}|${e.statement.slice(0, 300)}`;
    let g = m.get(k);
    if (!g) { g = { sqlcode: e.sqlcode, messageId: sqlMessageId(e.sqlcode), program: e.program, statement: e.statement, count: 0, last: e.logged, jobs: 0, jobSet: new Set() }; m.set(k, g); }
    g.count++; g.jobSet.add(e.job);
    if (e.logged > g.last) { g.last = e.logged; }
  }
  return [...m.values()].map(({ jobSet, ...g }) => ({ ...g, jobs: jobSet.size })).sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}

/** Plain-language meaning of the setting. */
export function describeSelfCodes(value: string | null | undefined): string {
  const v = (value ?? '').trim().toUpperCase();
  if (!v || v === '*NONE') { return 'Off: no SQL errors are logged.'; }
  if (v === '*ERR') { return 'On: every SQL error (negative SQLCODE) is logged.'; }
  if (v === '*WARN') { return 'On: every SQL warning (positive SQLCODE except 100) is logged.'; }
  if (v === '*ALL') { return 'On: every SQL error and warning is logged.'; }
  return `On for these SQL codes: ${v}.`;
}
