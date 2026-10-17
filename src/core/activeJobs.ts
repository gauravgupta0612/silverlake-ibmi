// Work with Active Jobs (WRKACTJOB) as a screen: the query, the options typed next to each job, the commands they run
// and the subsystem grouping. Pure functions (no vscode import), unit tested.

export interface ActiveJob {
  job: string; subsystem: string; user: string; type: string; status: string; function: string;
  cpu: number; threads?: number; tempMb?: number; cpuTimeMs?: number; io?: number; pool?: string; priority?: number; runSeconds?: number;
}
export interface ActiveJobFilter { subsystem?: string; user?: string; job?: string; status?: string }

const NAME = /^[A-Z$#@*][A-Z0-9$#@_.*]{0,9}$/;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The query behind the screen (ACTIVE_JOB_INFO, filtered on the server). */
export function activeJobsSql(f: ActiveJobFilter, max = 5000, reset = false): string {
  const args = [`DETAILED_INFO => 'NONE'`, `RESET_STATISTICS => '${reset ? 'YES' : 'NO'}'`];
  const sub = f.subsystem?.trim().toUpperCase(); const usr = f.user?.trim().toUpperCase(); const job = f.job?.trim().toUpperCase();
  if (sub && sub !== '*ALL') { if (!NAME.test(sub)) { throw new Error('Invalid subsystem name.'); } args.push(`SUBSYSTEM_LIST_FILTER => ${q(sub)}`); }
  if (usr && usr !== '*ALL') { if (!NAME.test(usr)) { throw new Error('Invalid user name.'); } args.push(`CURRENT_USER_LIST_FILTER => ${q(usr)}`); }
  if (job && job !== '*ALL') { if (!NAME.test(job)) { throw new Error('Invalid job name.'); } args.push(`JOB_NAME_FILTER => ${q(job)}`); }
  const where: string[] = ["JOB_TYPE <> 'SYS'"];
  const st = f.status?.trim().toUpperCase();
  if (st && st !== '*ALL') { if (!/^[A-Z]{3,4}$/.test(st)) { throw new Error('Invalid status.'); } where.push(`JOB_STATUS = ${q(st)}`); }
  return `SELECT JOB_NAME AS J, COALESCE(SUBSYSTEM, '') AS S, COALESCE(AUTHORIZATION_NAME, '') AS U, COALESCE(JOB_TYPE, '') AS T, COALESCE(JOB_STATUS, '') AS ST, ` +
    `COALESCE(FUNCTION_TYPE, '') || CASE WHEN FUNCTION IS NULL THEN '' ELSE '-' || FUNCTION END AS F, COALESCE(ELAPSED_CPU_PERCENTAGE, 0) AS C, ` +
    `COALESCE(THREAD_COUNT, 0) AS TH, COALESCE(TEMPORARY_STORAGE, 0) AS TMP, COALESCE(CPU_TIME, 0) AS CT, COALESCE(ELAPSED_TOTAL_DISK_IO_COUNT, 0) AS IO, ` +
    `COALESCE(MEMORY_POOL, '') AS P, COALESCE(RUN_PRIORITY, 0) AS PR, COALESCE(ELAPSED_TIME, 0) AS ET ` +
    `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(${args.join(', ')})) X WHERE ${where.join(' AND ')} ORDER BY SUBSYSTEM, JOB_NAME FETCH FIRST ${Math.max(1, Math.floor(max))} ROWS ONLY`;
}

export function toActiveJob(r: Record<string, unknown>): ActiveJob {
  const s = (k: string) => String(r[k] ?? '').trim(); const n = (k: string) => Number(r[k] ?? 0) || 0;
  return { job: s('J'), subsystem: s('S'), user: s('U'), type: s('T'), status: s('ST'), function: s('F').replace(/^-/, ''), cpu: n('C'), threads: n('TH'), tempMb: n('TMP'),
    cpuTimeMs: n('CT'), io: n('IO'), pool: s('P'), priority: n('PR'), runSeconds: n('ET') };
}

/** Jobs grouped under their subsystem, subsystems in name order, like the 5250 screen. */
export function bySubsystem(jobs: ActiveJob[]): { subsystem: string; jobs: ActiveJob[]; cpu: number }[] {
  const m = new Map<string, ActiveJob[]>();
  for (const j of jobs) { const k = j.subsystem || '(none)'; if (!m.has(k)) { m.set(k, []); } m.get(k)!.push(j); }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([subsystem, list]) => ({ subsystem, jobs: list, cpu: Math.round(list.reduce((a, j) => a + j.cpu, 0) * 10) / 10 }));
}

export const ACTJOB_OPTIONS: { code: string; label: string }[] = [
  { code: '3', label: 'Hold' }, { code: '4', label: 'End' }, { code: '5', label: 'Work with' }, { code: '6', label: 'Release' },
  { code: '7', label: 'Display message' }, { code: '8', label: 'Work with spooled files' }, { code: '10', label: 'Display job log' },
  { code: '11', label: 'Call stack' }, { code: 'L', label: 'Live job log' },
];

/** Options typed on the screen: only known codes, at most one per job. Unknown codes are returned apart. */
export function parseJobOptions(entries: { job: string; option: string }[]): { ok: { job: string; option: string }[]; bad: { job: string; option: string }[] } {
  const known = new Set(ACTJOB_OPTIONS.map(o => o.code));
  const ok: { job: string; option: string }[] = []; const bad: { job: string; option: string }[] = [];
  for (const e of entries) {
    const o = e.option.trim().toUpperCase();
    if (!o) { continue; }
    (known.has(o) ? ok : bad).push({ job: e.job, option: o });
  }
  return { ok, bad };
}

const JOB = /^\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}$/i;
/** The CL command for options 3, 4 and 6. */
export function jobCommand(option: string, job: string, how: '*CNTRLD' | '*IMMED' = '*CNTRLD'): string {
  if (!JOB.test(job)) { throw new Error(`Invalid job name ${job}.`); }
  const j = job.toUpperCase();
  switch (option) {
    case '3': return `HLDJOB JOB(${j})`;
    case '6': return `RLSJOB JOB(${j})`;
    case '4': return how === '*IMMED' ? `ENDJOB JOB(${j}) OPTION(*IMMED)` : `ENDJOB JOB(${j}) OPTION(*CNTRLD) DELAY(30)`;
  }
  throw new Error(`Option ${option} does not run a command.`);
}

/** CPU time (milliseconds) as the 5250 screen shows it. */
export function formatCpuTime(ms: number | undefined): string {
  if (!ms) { return '0.0'; }
  const s = ms / 1000;
  if (s < 60) { return s.toFixed(1); }
  const m = Math.floor(s / 60); if (m < 60) { return `${m}m ${Math.round(s % 60)}s`; }
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
