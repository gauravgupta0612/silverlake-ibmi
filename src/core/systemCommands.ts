// System helpers: journals, message queues, PTFs, library lists from job descriptions and system values. Pure functions
// (no vscode import), unit tested.
import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function chgjrnCommand(lib: string, jrn: string): string {
  return `CHGJRN JRN(${NAME(lib, 'library')}/${NAME(jrn, 'journal')}) JRNRCV(*GEN)`;
}

export function strjrnlibCommand(lib: string, jrnLib: string, jrn: string): string {
  return `STRJRNLIB LIB(${NAME(lib, 'library')}) JRN(${NAME(jrnLib, 'library')}/${NAME(jrn, 'journal')}) INHRULES((*ALL *ALLOPR *INCLUDE *BOTH *OPNCLO))`;
}

export function removeMessageCommand(msgqLib: string, msgq: string, keyHex: string): string {
  if (!/^[0-9A-F]{8}$/i.test(keyHex)) { throw new Error('Invalid message key.'); }
  return `RMVMSG MSGQ(${NAME(msgqLib, 'library')}/${NAME(msgq, 'message queue')}) MSGKEY(X'${keyHex.toUpperCase()}')`;
}

export function sendMessageCommand(msgqLib: string, msgq: string, text: string, inquiry: boolean): string {
  if (!text.trim()) { throw new Error('Enter the message.'); }
  return `SNDMSG MSG(${q(text.slice(0, 512))}) TOMSGQ(${NAME(msgqLib, 'library')}/${NAME(msgq, 'message queue')})${inquiry ? ' MSGTYPE(*INQ)' : ''}`;
}

/** PTF identifiers like SI12345 or MF67890, from any text. */
export function parsePtfIds(input: string): string[] {
  return [...new Set((input.toUpperCase().match(/\b[A-Z]{2}\d{5}\b/g) ?? []))];
}

/** JOB_DESCRIPTION_INFO.LIBRARY_LIST holds the names separated by blanks (or *SYSVAL / *NONE). */
export function parseLibraryList(v: string): { libraries: string[]; special?: string } {
  const parts = (v ?? '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (parts.length === 1 && /^\*(SYSVAL|NONE)$/.test(parts[0])) { return { libraries: [], special: parts[0] }; }
  return { libraries: parts.filter(p => /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/.test(p)) };
}

/** Before / after for a library list change. */
export function libraryListChange(current: string[], next: string[]): { added: string[]; removed: string[]; same: boolean } {
  const c = current.map(x => x.toUpperCase()); const n = next.map(x => x.toUpperCase());
  return { added: n.filter(x => !c.includes(x)), removed: c.filter(x => !n.includes(x)), same: c.join(',') === n.join(',') };
}

export interface SysvalDiff { name: string; a: string; b: string; same: boolean; text?: string }

export function diffSystemValues(a: Record<string, string>, b: Record<string, string>, texts: Record<string, string> = {}): SysvalDiff[] {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const norm = (v?: string) => (v ?? '').trim().replace(/\s+/g, ' ');
  return names.map(n => ({ name: n, a: norm(a[n]), b: norm(b[n]), same: norm(a[n]) === norm(b[n]), text: texts[n] }))
    .sort((x, y) => Number(x.same) - Number(y.same) || x.name.localeCompare(y.name));
}

/** System values that usually differ between systems on purpose (names, dates, serials). */
export const EXPECTED_DIFFERENT = /^(QDATE|QTIME|QDAY|QMONTH|QYEAR|QHOUR|QMINUTE|QSECOND|QDATETIME|QUTCOFFSET|QSRLNBR|QMODEL|QPRCFEAT|QIPLDATTIM|QIPLSTS|QABNORMSW|QCENTURY|QDAYOFWEEK|QPRCMLTTSK|QPWRDWNLMT|QSTRUPPGM|QCONSOLE|QPRTDEV|QSYSLIBL)$/;
