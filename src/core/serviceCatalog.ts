// The IBM i services the features depend on, for the self-check. Pure functions (no vscode import), unit tested.


export interface Service { schema: string; name: string; kind: 'function' | 'view' | 'procedure'; features: string }

/** The IBM i services Vanthrex's features use. */
export const SERVICES: Service[] = [
  { schema: 'QSYS2', name: 'OBJECT_STATISTICS', kind: 'function', features: 'Libraries & objects, storage advisor, promotion' },
  { schema: 'QSYS2', name: 'ACTIVE_JOB_INFO', kind: 'function', features: 'Active jobs, performance monitor, live alerts' },
  { schema: 'QSYS2', name: 'JOBLOG_INFO', kind: 'function', features: 'Job log, job log analyzer' },
  { schema: 'QSYS2', name: 'OBJECT_LOCK_INFO', kind: 'view', features: 'Member locks, who has it locked' },
  { schema: 'QSYS2', name: 'SYSIXADV', kind: 'view', features: 'Index advisor' },
  { schema: 'QSYS2', name: 'MESSAGE_FILE_DATA', kind: 'view', features: 'Message help, message file editor' },
  { schema: 'QSYS2', name: 'DISPLAY_JOURNAL', kind: 'function', features: 'Journal explorer, security audit journal' },
  { schema: 'QSYS2', name: 'OBJECT_PRIVILEGES', kind: 'view', features: 'Authority checker' },
  { schema: 'QSYS2', name: 'DATA_QUEUE_ENTRIES', kind: 'function', features: 'Data queue viewer' },
  { schema: 'QSYS2', name: 'DATA_AREA_INFO', kind: 'function', features: 'Data area viewer' },
  { schema: 'SYSTOOLS', name: 'GROUP_PTF_CURRENCY', kind: 'view', features: 'PTF & system health (compare with IBM)' },
  { schema: 'QSYS2', name: 'PTF_INFO', kind: 'view', features: 'PTF & system health' },
  { schema: 'QSYS2', name: 'SUBSYSTEM_INFO', kind: 'view', features: 'Work with subsystems' },
  { schema: 'QSYS2', name: 'JOB_QUEUE_INFO', kind: 'view', features: 'Work with job queues' },
  { schema: 'QSYS2', name: 'OUTPUT_QUEUE_ENTRIES_BASIC', kind: 'view', features: 'Output queues, storage advisor' },
  { schema: 'QSYS2', name: 'SCHEDULED_JOB_INFO', kind: 'view', features: 'Job scheduler' },
  { schema: 'QSYS2', name: 'USER_INFO', kind: 'view', features: 'User profiles, authority checker' },
  { schema: 'QSYS2', name: 'SYSTEM_VALUE_INFO', kind: 'view', features: 'System values' },
  { schema: 'QSYS2', name: 'SAVE_FILE_OBJECTS', kind: 'function', features: 'Save file contents' },
  { schema: 'QSYS2', name: 'NETSTAT_INFO', kind: 'view', features: 'TCP/IP connections & servers' },
  { schema: 'QSYS2', name: 'JOURNAL_RECEIVER_INFO', kind: 'view', features: 'Storage advisor (journal receivers)' },
  { schema: 'QSYS2', name: 'IFS_OBJECT_STATISTICS', kind: 'function', features: 'IFS folders by size' },
  { schema: 'SYSTOOLS', name: 'DELETE_OLD_SPOOLED_FILES', kind: 'procedure', features: 'Storage advisor (old spooled files)' },
  { schema: 'QSYS2', name: 'HISTORY_LOG_INFO', kind: 'function', features: 'Live alerts (abnormal job ends)' },
  { schema: 'QSYS2', name: 'MESSAGE_QUEUE_INFO', kind: 'view', features: 'Messages, live alerts (QSYSOPR)' },
  { schema: 'QSYS2', name: 'SYSTEM_STATUS', kind: 'function', features: 'Performance monitor' },
  { schema: 'QSYS2', name: 'MEMORY_POOL_INFO', kind: 'view', features: 'Performance monitor (memory pools)' },
  { schema: 'QSYS2', name: 'BOUND_SRVPGM_INFO', kind: 'view', features: 'Who calls each exported procedure' },
];

/** Which services are missing, given the names found in the catalog ("SCHEMA.NAME"). */
export function missingServices(found: Iterable<string>): Service[] {
  const f = new Set([...found].map(x => x.toUpperCase()));
  return SERVICES.filter(s => !f.has(`${s.schema}.${s.name}`));
}

export interface CheckResult { area: string; ok: boolean | 'warn'; detail: string; fix?: string }

/** Turn raw self-check facts into results with fixes. */
export function evaluateSelfCheck(f: {
  qsh?: boolean; sqlEngine?: string; javaVersion?: string; ccsid?: number; jobCcsid?: number; homeWritable?: boolean;
  missingLibraries?: string[]; release?: string; db2Level?: string; specialAuthorities?: string; rpgUnit?: boolean; debugService?: boolean;
}): CheckResult[] {
  const r: CheckResult[] = [];
  r.push(f.qsh ? { area: 'QSH / CL commands', ok: true, detail: 'CL commands run.' }
    : { area: 'QSH / CL commands', ok: false, detail: 'CL commands could not be run through QSH.', fix: 'Check that the user can run /QOpenSys/usr/bin/qsh (5770-SS1 option 30).' });
  r.push(f.sqlEngine && !/not started/i.test(f.sqlEngine) ? { area: 'SQL engine', ok: f.sqlEngine.startsWith('Mapepire') ? true : 'warn', detail: f.sqlEngine,
    fix: f.sqlEngine.startsWith('Mapepire') ? undefined : 'Some features need Mapepire (QTEMP work, source dates). Install Java 11+ so Vanthrex can start it.' }
    : { area: 'SQL engine', ok: false, detail: 'No SQL engine started.', fix: 'Install Java 11+ (5770-JV1) for Mapepire, or set another SQL engine in the connection settings.' });
  if (f.javaVersion !== undefined) {
    const v = Number(/version "?(\d+)/.exec(f.javaVersion)?.[1] ?? /(\d+)\./.exec(f.javaVersion)?.[1] ?? 0);
    r.push(v >= 11 ? { area: 'Java', ok: true, detail: f.javaVersion.split('\n')[0] }
      : { area: 'Java', ok: 'warn', detail: f.javaVersion ? f.javaVersion.split('\n')[0] : 'Java not found on the PATH.', fix: 'Mapepire needs Java 11 or later (5770-JV1 option 17 or later).' });
  }
  if (f.ccsid !== undefined) {
    r.push(f.ccsid === 65535 || f.jobCcsid === 65535
      ? { area: 'CCSID', ok: 'warn', detail: `User profile CCSID ${f.ccsid}, job CCSID ${f.jobCcsid ?? '?'}.`, fix: 'CCSID 65535 garbles text. Set the profile CCSID to your language (e.g. CHGUSRPRF CCSID(37) or 297 for French).' }
      : { area: 'CCSID', ok: true, detail: `User profile CCSID ${f.ccsid}${f.jobCcsid ? `, job CCSID ${f.jobCcsid}` : ''}.` });
  }
  if (f.homeWritable !== undefined) {
    r.push(f.homeWritable ? { area: 'Home directory', ok: true, detail: 'Exists and is writable.' }
      : { area: 'Home directory', ok: 'warn', detail: 'Missing or not writable.', fix: 'Create it: MKDIR DIR(\'/home/USER\') and CHGUSRPRF HOMEDIR(\'/home/USER\').' });
  }
  if (f.missingLibraries) {
    r.push(f.missingLibraries.length ? { area: 'Library list', ok: 'warn', detail: `Not found: ${f.missingLibraries.join(', ')}.`, fix: 'Remove them from the connection\'s library list, or create them.' }
      : { area: 'Library list', ok: true, detail: 'Every library exists.' });
  }
  if (f.release) {
    const m = /(\d)\.(\d)/.exec(f.release); const rel = m ? Number(m[1]) * 10 + Number(m[2]) : 0;
    r.push(rel >= 74 ? { area: 'IBM i release', ok: true, detail: `IBM i ${f.release}${f.db2Level ? `, Db2 PTF group level ${f.db2Level}` : ''}.` }
      : { area: 'IBM i release', ok: 'warn', detail: `IBM i ${f.release}.`, fix: 'Most features need IBM i 7.4 or later with recent Db2 PTF groups; older releases miss some IBM i Services.' });
  }
  if (f.specialAuthorities !== undefined) {
    const has = (a: string) => f.specialAuthorities!.includes(a);
    const missing = ['*JOBCTL', '*SPLCTL', '*IOSYSCFG', '*SECADM', '*AUDIT'].filter(a => !has(a) && !has('*ALLOBJ'));
    r.push({ area: 'Special authorities', ok: missing.length > 3 ? 'warn' : true, detail: f.specialAuthorities || '*NONE',
      fix: missing.length ? `Without ${missing.join(', ')} some admin screens show only your own jobs or are refused (jobs of others, servers, user profiles, audit journal).` : undefined });
  }
  if (f.rpgUnit !== undefined) { r.push({ area: 'RPGUnit', ok: f.rpgUnit ? true : 'warn', detail: f.rpgUnit ? 'Installed.' : 'Not found.', fix: f.rpgUnit ? undefined : 'Install iRPGUnit to run RPG unit tests, or set vanthrex.rpgunit.library.' }); }
  if (f.debugService !== undefined) { r.push({ area: 'Debug service', ok: f.debugService ? true : 'warn', detail: f.debugService ? 'Listening.' : 'Not listening on its port.', fix: f.debugService ? undefined : 'Start it with STRTCPSVR SERVER(*IBMDBG) (Navigator for i → Debug Service) to debug from VS Code.' }); }
  return r;
}
