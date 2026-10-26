// Production protection: which SQL statements, CL commands and paths change a system. Pure functions (no vscode
// import), unit tested.


export type Protection = 'none' | 'confirm' | 'readOnly';

const READ_VERBS = /^(DSP|RTV|CHK|WRK|PRT|ANZ|QRY|DMP|EDT|GO|SIGNOFF)/;

const ALWAYS_SAFE = new Set(['DSPPGMREF', 'DSPFD', 'DSPFFD', 'DSPOBJD', 'DSPDBR', 'DSPJOBLOG', 'DSPSPLF', 'CHGJOB', 'OVRDBF', 'DLTOVR', 'RCLRSC', 'ADDLIBLE', 'RMVLIBLE', 'CHGCURLIB', 'CHGLIBL', 'SETATNPGM', 'STRDBMON', 'ENDDBMON', 'DSPDBMON']);

/** True when a CL command only reads, or only touches QTEMP / the temporary IFS directory. */
export function isReadOnlyCommand(command: string, tempDir = '/tmp'): boolean {
  const c = command.trim().toUpperCase();
  const verb = /^([A-Z][A-Z0-9]*)/.exec(c)?.[1] ?? '';
  if (verb === 'CHGJOB' && /\bJOB\(/.test(c)) { return false; } // another job
  if (ALWAYS_SAFE.has(verb) || READ_VERBS.test(verb)) { return true; }
  // APIs that only read (the command definition for F4 and the CL help in the editor).
  if (verb === 'CALL' && /\bPGM\(\s*(QSYS\/)?QCDRCMDD\s*\)/.test(c)) { return true; }
  if (verb === 'CPYTOSTMF') {
    const to = /TOSTMF\('([^']+)'\)/i.exec(command)?.[1] ?? '';
    return to.startsWith(tempDir.replace(/\/$/, '') + '/');
  }
  // Commands whose every qualified object is in QTEMP (work files, aliases, overrides).
  const quals = [...c.matchAll(/\b([A-Z$#@][A-Z0-9$#@_.]{0,9})\/[A-Z$#@*]/g)].map(m => m[1]);
  if (/^(CRT|DLT|CLR|CPYF|CPY|ADDPFM|RMVM)/.test(verb) && quals.length && quals.every(q => q === 'QTEMP')) { return true; }
  return false;
}

/** True when an SQL statement changes something outside QTEMP. */
export function isChangingSql(sql: string, tempDir = '/tmp'): boolean {
  const cmd = /^\s*CALL\s+(?:QSYS2[./])?QCMDEXC\s*\(\s*'((?:[^']|'')*)'/i.exec(sql);
  if (cmd) { return !isReadOnlyCommand(cmd[1].replace(/''/g, "'"), tempDir); }
  const s = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^(SELECT|WITH|VALUES|DESCRIBE|SET (PATH|SCHEMA|CURRENT)|DECLARE GLOBAL TEMPORARY)/.test(s)) { return false; }
  if (!/^(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|COMMENT|LABEL|CALL|REFRESH)/.test(s)) { return false; }
  // Work in QTEMP / SESSION is not a change to the system.
  const targets = [...s.matchAll(/\b(?:INTO|UPDATE|FROM|TABLE|VIEW|INDEX|ALIAS|VARIABLE|ON|TRUNCATE)\s+([A-Z0-9_$#@"]+)[./]/g)].map(m => m[1].replace(/"/g, ''));
  if (targets.length && targets.every(t => t === 'QTEMP' || t === 'SESSION') && !/^CALL/.test(s)) { return false; }
  return true;
}

/** True when an IFS path is Vanthrex's own temporary file. */
export function isTempPath(path: string, tempDir = '/tmp'): boolean {
  return path.startsWith(tempDir.replace(/\/$/, '') + '/slk_');
}
