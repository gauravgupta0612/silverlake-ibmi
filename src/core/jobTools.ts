// Job helpers: call stacks, live job log, signed-on users and failed jobs. Pure functions (no vscode import), unit
// tested.
import { isValidSystemName } from './util';

export function stackLine(r: Record<string, unknown>): string {
  const v = (k: string) => String(r[k] ?? '').trim();
  const pgm = v('PROGRAM_LIBRARY_NAME') ? `${v('PROGRAM_LIBRARY_NAME')}/${v('PROGRAM_NAME')}` : v('PROGRAM_NAME');
  const proc = v('PROCEDURE_NAME') && v('PROCEDURE_NAME') !== v('PROGRAM_NAME') ? ` ${v('PROCEDURE_NAME')}` : '';
  const stmt = v('STATEMENT_IDENTIFIERS') ? ` (statement ${v('STATEMENT_IDENTIFIERS').split(/\s+/)[0]})` : '';
  return `${pgm || v('ENTRY_TYPE')}${v('MODULE_NAME') && v('MODULE_NAME') !== v('PROGRAM_NAME') ? `·${v('MODULE_NAME')}` : ''}${proc}${stmt}`;
}

export interface JobLogMessage { pos: number; time: string; id: string; type: string; severity: number; text: string; from: string }

export function jobLogLine(m: JobLogMessage): string {
  const t = (m.time.match(/\d{2}[.:]\d{2}[.:]\d{2}/)?.[0] ?? m.time).replace(/\./g, ':');
  const sev = m.severity ? String(m.severity).padStart(2, '0') : '  ';
  return `${t} ${(m.id || '       ').padEnd(7)} ${sev} ${m.type.slice(0, 13).padEnd(13)} ${m.text}${m.from ? `  [${m.from}]` : ''}`;
}

export function jobLogSql(job: string, after: number): string {
  if (!/^\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}$/i.test(job.trim()) && job.trim() !== '*') { throw new Error('Use a qualified job name: 123456/USER/NAME.'); }
  return `SELECT ORDINAL_POSITION AS P, VARCHAR(MESSAGE_TIMESTAMP) AS T, COALESCE(MESSAGE_ID, '') AS I, COALESCE(MESSAGE_TYPE, '') AS Y, ` +
    `COALESCE(SEVERITY, 0) AS S, COALESCE(MESSAGE_TEXT, '') AS X, COALESCE(FROM_PROGRAM, '') AS F ` +
    `FROM TABLE(QSYS2.JOBLOG_INFO('${job.trim().toUpperCase()}')) J WHERE ORDINAL_POSITION > ${Math.max(0, Math.floor(after))} ORDER BY ORDINAL_POSITION`;
}

/** Messages that deserve attention in a live job log (escape messages, severity 30+, inquiry). */
export function isAlarming(m: JobLogMessage): boolean {
  return m.severity >= 30 || /ESCAPE|INQUIRY/i.test(m.type);
}

export function breakMessageCommand(text: string, msgq: string): string {
  const q = msgq.trim().toUpperCase();
  if (!/^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/.test(q)) { throw new Error('Invalid message queue.'); }
  if (!text.trim()) { throw new Error('Enter the message.'); }
  return `SNDBRKMSG MSG('${text.slice(0, 512).replace(/'/g, "''")}') TOMSGQ(${q})`;
}

export function endJobCommand(job: string, immediate: boolean): string {
  if (!/^\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}$/i.test(job.trim())) { throw new Error('Invalid job name.'); }
  return `ENDJOB JOB(${job.trim().toUpperCase()}) OPTION(${immediate ? '*IMMED' : '*CNTRLD'})${immediate ? '' : ' DELAY(30)'}`;
}

/** Host server and SSH jobs grouped per user and kind of connection. */
export function connectionKind(jobName: string, fn: string): string {
  const n = `${jobName} ${fn}`.toUpperCase();
  if (/QZDASOINIT|QZDASSINIT/.test(n)) { return 'ODBC / JDBC (database)'; }
  if (/QZRCSRVS/.test(n)) { return 'Remote command'; }
  if (/QZLSFILE|QZLSFILET/.test(n)) { return 'File server (IFS / NetServer)'; }
  if (/QZSOSIGN/.test(n)) { return 'Sign-on server'; }
  if (/QZHQSSRV/.test(n)) { return 'Data queue server'; }
  if (/QP0ZSPWP|SSHD|QP0ZSPWT/.test(n)) { return 'SSH / PASE'; }
  if (/QSQSRVR/.test(n)) { return 'SQL server mode'; }
  if (/QTVDEVICE|QPADEV/.test(n)) { return '5250 session'; }
  return 'Other';
}

/** The job a SBMJOB started, from its CPC1221 completion message. */
export function submittedJob(output: string): string | undefined {
  return /Job (\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}) submitted/i.exec(output)?.[1]?.toUpperCase();
}

export function sbmjobCommand(command: string, job: string, jobq?: string): string {
  const name = job.trim().toUpperCase();
  if (!isValidSystemName(name)) { throw new Error(`"${job}" is not a valid job name.`); }
  if (!command.trim()) { throw new Error('Enter the command to submit.'); }
  return `SBMJOB CMD(${command.trim()}) JOB(${name})${jobq?.trim() ? ` JOBQ(${jobq.trim().toUpperCase()})` : ''}`;
}

/** Where a submitted job is, from QSYS2.JOB_INFO's JOB_STATUS. */
export function jobPhase(status: string): 'queued' | 'running' | 'ended' | 'unknown' {
  const s = status.toUpperCase().trim();
  if (/^(JOBQ|\*JOBQ)$/.test(s)) { return 'queued'; }
  if (/^(ACTIVE|\*ACTIVE)$/.test(s)) { return 'running'; }
  if (/^(OUTQ|\*OUTQ|ENDED|\*COMPLETE)$/.test(s)) { return 'ended'; }
  return 'unknown';
}

/** End code from the CPF1164 text ("... end code 30 ."), language independent: the last number in the text. */
export function endCodeOf(text: string): number | undefined {
  const m = /end code\s+(\d+)/i.exec(text) ?? /(\d+)\s*\.?\s*$/.exec((text ?? '').trim());
  return m ? Number(m[1]) : undefined;
}

export function endCodeMeaning(code: number | undefined): string {
  switch (code) {
    case 0: return 'Normal';
    case 10: return 'Normal, during a controlled end';
    case 20: return 'Exceeded the end severity (ENDSEV)';
    case 30: return 'Ended abnormally';
    case 40: return 'Ended before it became active';
    case 50: return 'Ended while active';
    case 60: return 'Subsystem ended abnormally';
    case 70: return 'System ended abnormally';
    case 80: return 'Ended (ENDJOBABN)';
    case 90: return 'Forced to end after the time limit';
    case 999: return 'Ended abnormally (999)';
  }
  return code === undefined ? 'Unknown' : `End code ${code}`;
}

/** number/user/name from the message text, or the FROM_JOB column. */
export function jobFromText(text: string, fromJob?: string): string {
  const m = /\b(\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10})\b/i.exec(text ?? '');
  return (m?.[1] ?? fromJob ?? '').trim().toUpperCase();
}

export interface FailedJob { at: string; job: string; user: string; name: string; code?: number }

export function failedJobs(rows: { at: string; text: string; fromJob?: string }[], minCode = 20): FailedJob[] {
  return rows.map(r => { const job = jobFromText(r.text, r.fromJob); const [, user = '', name = ''] = job.split('/'); return { at: r.at, job, user, name, code: endCodeOf(r.text) }; })
    .filter(j => j.job && (j.code === undefined || j.code >= minCode));
}

/** Count failures per job name, most first. */
export function failuresByName(jobs: FailedJob[]): { name: string; count: number; last: string; codes: string }[] {
  const m = new Map<string, { name: string; count: number; last: string; codes: Set<number> }>();
  for (const j of jobs) {
    const e = m.get(j.name) ?? { name: j.name, count: 0, last: '', codes: new Set<number>() };
    e.count++; if (j.at > e.last) { e.last = j.at; } if (j.code !== undefined) { e.codes.add(j.code); }
    m.set(j.name, e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).map(e => ({ name: e.name, count: e.count, last: e.last, codes: [...e.codes].sort((a, b) => a - b).join(', ') }));
}
