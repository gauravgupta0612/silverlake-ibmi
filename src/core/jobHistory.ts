// Batch job run-time history from the history log (CPF1124 started, CPF1164 ended), and searching job logs of
// recent jobs for a message. Pure (no vscode import), unit tested.

const NAME = /^[A-Z$#@*][A-Z0-9$#@_.*]{0,9}$/;

export function jobHistorySql(jobName: string, days: number, user?: string): string {
  const n = jobName.trim().toUpperCase();
  if (!NAME.test(n)) { throw new Error(`"${jobName}" is not a valid job name.`); }
  const u = user?.trim().toUpperCase();
  if (u && !NAME.test(u)) { throw new Error(`"${user}" is not a valid user name.`); }
  const d = Math.max(1, Math.min(366, Math.floor(days)));
  const like = n.includes('*') ? n.replace(/\*/g, '%') : n;
  return `SELECT MESSAGE_ID AS ID, VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, FROM_JOB AS JOB, COALESCE(MESSAGE_TEXT, '') AS TEXT ` +
    `FROM TABLE(QSYS2.HISTORY_LOG_INFO(START_TIME => CURRENT TIMESTAMP - ${d} DAYS)) H WHERE MESSAGE_ID IN ('CPF1124', 'CPF1164') ` +
    `AND FROM_JOB LIKE '%/${u ? u.replace(/\*/g, '%') : '%'}/${like}' ORDER BY MESSAGE_TIMESTAMP FETCH FIRST 20000 ROWS ONLY`;
}

export interface JobRun { job: string; started?: string; ended?: string; seconds?: number; cpuSeconds?: number; endCode?: number; ok?: boolean }

const ts = (s: string) => new Date(s.replace(' ', 'T') + 'Z').getTime();

/** One row per job: start and end from CPF1124 / CPF1164, elapsed seconds, CPU seconds and end code from the end message. */
export function jobRuns(rows: { ID: string; TS: string; JOB: string; TEXT: string }[]): JobRun[] {
  const m = new Map<string, JobRun>();
  for (const r of rows) {
    const job = String(r.JOB).trim();
    const run = m.get(job) ?? { job };
    if (String(r.ID).trim() === 'CPF1124') { run.started = r.TS; }
    else {
      run.ended = r.TS;
      const text = String(r.TEXT);
      const cpu = /([\d.,]+)\s+seconds?\s+used/i.exec(text) ?? /([\d.,]+)\s+(?:secondes|segundos|Sekunden|secondi)/i.exec(text);
      if (cpu) { run.cpuSeconds = Number(cpu[1].replace(/,(?=\d{3}\b)/g, '').replace(',', '.')); }
      const code = /end code\s+(\d+)/i.exec(text) ?? /\bcode\s+(?:de\s+fin\s+)?(\d+)/i.exec(text);
      if (code) { run.endCode = Number(code[1]); }
      run.ok = run.endCode === undefined ? !/abnormal/i.test(text) : run.endCode < 20;
    }
    m.set(job, run);
  }
  for (const r of m.values()) { if (r.started && r.ended) { r.seconds = Math.max(0, Math.round((ts(r.ended) - ts(r.started)) / 1000)); } }
  return [...m.values()].sort((a, b) => (a.started ?? a.ended ?? '').localeCompare(b.started ?? b.ended ?? ''));
}

export interface RunStats { runs: number; failed: number; avg?: number; max?: number; last?: number; slow: JobRun[] }

/** Average and longest run, and the runs that took more than twice the median (the ones worth a look). */
export function runStats(runs: JobRun[]): RunStats {
  const done = runs.filter(r => r.seconds !== undefined).map(r => r.seconds!);
  const sorted = [...done].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
  return {
    runs: runs.length, failed: runs.filter(r => r.ok === false).length,
    avg: done.length ? Math.round(done.reduce((a, b) => a + b, 0) / done.length) : undefined,
    max: done.length ? Math.max(...done) : undefined,
    last: [...runs].reverse().find(r => r.seconds !== undefined)?.seconds,
    slow: median !== undefined && median > 0 ? runs.filter(r => (r.seconds ?? 0) > median * 2) : [],
  };
}

export function formatSeconds(s: number | undefined): string {
  if (s === undefined) { return ''; }
  if (s < 60) { return `${s}s`; }
  if (s < 3600) { return `${Math.floor(s / 60)}m ${s % 60}s`; }
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ---------------------------------------------------------------- message in job logs

export function recentJobsSql(opts: { user?: string; jobName?: string; days: number; max: number }): string {
  const u = opts.user?.trim().toUpperCase(); const n = opts.jobName?.trim().toUpperCase();
  if (u && !NAME.test(u)) { throw new Error('Invalid user name.'); }
  if (n && !NAME.test(n)) { throw new Error('Invalid job name.'); }
  const where = [`JOB_ENTERED_SYSTEM_TIME >= CURRENT TIMESTAMP - ${Math.max(1, Math.min(60, Math.floor(opts.days)))} DAYS`];
  if (n) { where.push(`JOB_NAME LIKE '%/%/${n.replace(/\*/g, '%')}'`); }
  return `SELECT JOB_NAME AS J FROM TABLE(QSYS2.JOB_INFO(JOB_USER_FILTER => '${u || '*ALL'}', JOB_STATUS_FILTER => '*ALL')) X WHERE ${where.join(' AND ')} ` +
    `ORDER BY JOB_ENTERED_SYSTEM_TIME DESC FETCH FIRST ${Math.max(1, Math.min(200, Math.floor(opts.max)))} ROWS ONLY`;
}

export function messageInJobSql(job: string, messageId: string): string {
  if (!/^\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}$/i.test(job)) { throw new Error(`Invalid job ${job}.`); }
  const id = messageId.trim().toUpperCase();
  const cond = /^[A-Z]{3}[0-9A-F]{4}$/.test(id) ? `MESSAGE_ID = '${id}'` : /^[A-Z]{3}[0-9A-F*]{1,4}\*?$/.test(id) ? `MESSAGE_ID LIKE '${id.replace(/\*/g, '%')}'`
    : `UPPER(MESSAGE_TEXT) LIKE '%${id.replace(/'/g, "''").replace(/[%_]/g, '')}%'`;
  return `SELECT '${job.toUpperCase()}' AS J, VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, COALESCE(MESSAGE_ID, '') AS ID, COALESCE(SEVERITY, 0) AS SEV, ` +
    `COALESCE(MESSAGE_TEXT, '') AS TEXT, COALESCE(FROM_PROGRAM, '') AS PGM FROM TABLE(QSYS2.JOBLOG_INFO('${job.toUpperCase()}')) L WHERE ${cond} FETCH FIRST 20 ROWS ONLY`;
}
