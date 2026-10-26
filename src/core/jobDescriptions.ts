// Work with Job Descriptions (WRKJOBD): the list, and the CHGJOBD command for a new initial library list or job queue.
// Pure (no vscode import), unit tested.

import { parseLibraryList } from './systemCommands';

const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

export function jobDescriptionsSql(library: string, max = 2000): string {
  const lib = library.trim().toUpperCase() || '*ALL';
  if (lib !== '*ALL' && lib !== '*LIBL' && !NAME.test(lib)) { throw new Error(`"${library}" is not a valid library name.`); }
  const where = lib === '*ALL' ? '' : lib === '*LIBL' ? `WHERE JOB_DESCRIPTION_LIBRARY IN (SELECT SYSTEM_SCHEMA_NAME FROM QSYS2.LIBRARY_LIST_INFO)` : `WHERE JOB_DESCRIPTION_LIBRARY = '${lib}'`;
  return `SELECT JOB_DESCRIPTION_LIBRARY AS L, JOB_DESCRIPTION AS N, COALESCE(AUTHORIZATION_NAME, '') AS U, ` +
    `COALESCE(JOB_QUEUE_LIBRARY, '') AS QL, COALESCE(JOB_QUEUE, '') AS Q, COALESCE(OUTPUT_QUEUE, '') AS OQ, COALESCE(LIBRARY_LIST, '') AS LL, ` +
    `COALESCE(MESSAGE_LOGGING_LEVEL, 0) AS ML, COALESCE(MESSAGE_LOGGING_SEVERITY, 0) AS MS, COALESCE(MESSAGE_LOGGING_TEXT, '') AS MT, ` +
    `COALESCE(TEXT_DESCRIPTION, '') AS T FROM QSYS2.JOB_DESCRIPTION_INFO ${where} ORDER BY JOB_DESCRIPTION_LIBRARY, JOB_DESCRIPTION FETCH FIRST ${Math.max(1, Math.floor(max))} ROWS ONLY`;
}

export interface JobDescription { library: string; name: string; user: string; jobQueue: string; outputQueue: string; libraries: string[]; special?: string; log: string; text: string }

export function toJobDescription(r: Record<string, unknown>): JobDescription {
  const s = (k: string) => String(r[k] ?? '').trim();
  const ll = parseLibraryList(s('LL'));
  return { library: s('L'), name: s('N'), user: s('U'), jobQueue: s('Q') ? `${s('QL') ? s('QL') + '/' : ''}${s('Q')}` : '', outputQueue: s('OQ'),
    libraries: ll.libraries, special: ll.special, log: `${Number(r.ML) || 0} ${Number(r.MS) || 0} ${s('MT')}`.trim(), text: s('T') };
}

/** CHGJOBD for a new initial library list (up to 250 names, or *SYSVAL / *NONE). */
export function chgjobdLibraryList(library: string, name: string, libraries: string[] | '*SYSVAL' | '*NONE'): string {
  const lib = library.toUpperCase(); const jd = name.toUpperCase();
  if (!NAME.test(lib) || !NAME.test(jd)) { throw new Error('Invalid job description name.'); }
  let list: string;
  if (typeof libraries === 'string') { list = libraries; }
  else {
    const libs = libraries.map(l => l.trim().toUpperCase()).filter(Boolean);
    const bad = libs.find(l => !NAME.test(l));
    if (bad) { throw new Error(`"${bad}" is not a valid library name.`); }
    if (libs.length > 250) { throw new Error('A job description holds at most 250 libraries.'); }
    if (new Set(libs).size !== libs.length) { throw new Error('A library is listed twice.'); }
    list = libs.length ? libs.join(' ') : '*NONE';
  }
  return `CHGJOBD JOBD(${lib}/${jd}) INLLIBL(${list})`;
}

/** CHGJOBD for another job queue. */
export function chgjobdJobQueue(library: string, name: string, queue: string): string {
  const [ql, qn] = queue.toUpperCase().includes('/') ? queue.toUpperCase().split('/') : ['*LIBL', queue.toUpperCase()];
  if (!NAME.test(qn) || (ql !== '*LIBL' && !NAME.test(ql))) { throw new Error(`"${queue}" is not a valid job queue.`); }
  if (!NAME.test(library.toUpperCase()) || !NAME.test(name.toUpperCase())) { throw new Error('Invalid job description name.'); }
  return `CHGJOBD JOBD(${library.toUpperCase()}/${name.toUpperCase()}) JOBQ(${ql}/${qn})`;
}
