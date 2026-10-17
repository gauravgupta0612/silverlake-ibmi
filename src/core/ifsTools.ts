// IFS helpers: search (grep), authorities, CCSID tagging and path checks. Pure functions (no vscode import), unit
// tested.
import { isValidSystemName } from './util';

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** find + grep over an IFS folder (PASE grep has no -r --include, so find picks the files). */
export function ifsGrepCommand(folder: string, text: string, opts: { regex?: boolean; matchCase?: boolean; include?: string; max?: number } = {}): string {
  if (!text) { throw new Error('Enter the text to find.'); }
  if (!folder.startsWith('/')) { throw new Error('The folder must be an absolute IFS path.'); }
  const flags = `-n${opts.regex ? 'E' : 'F'}${opts.matchCase ? '' : 'i'}`;
  const name = opts.include?.trim() ? ` -name ${shq(opts.include.trim())}` : '';
  return `/QOpenSys/usr/bin/find ${shq(folder)} -type f${name} -exec /QOpenSys/usr/bin/grep ${flags} -e ${shq(text)} /dev/null {} + 2>/dev/null | /QOpenSys/usr/bin/head -n ${Math.max(1, opts.max ?? 1000)}`;
}

export function parseGrep(out: string): { file: string; line: number; text: string }[] {
  return out.split('\n').map(l => /^(.+?):(\d+):(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map(m => ({ file: m[1], line: Number(m[2]), text: m[3] }));
}

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const DATA_AUTHORITIES = ['*RWX', '*RX', '*RW', '*WX', '*R', '*W', '*X', '*EXCLUDE', '*NONE'];

export function chgautCommand(path: string, user: string, dtaaut: string, subtree: boolean): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  const u = user.trim().toUpperCase() === '*PUBLIC' ? '*PUBLIC' : NAME(user, 'user profile');
  if (!DATA_AUTHORITIES.includes(dtaaut.toUpperCase())) { throw new Error('Unknown data authority.'); }
  return `CHGAUT OBJ(${q(path)}) USER(${u}) DTAAUT(${dtaaut.toUpperCase()}) OBJAUT(*NONE)${subtree ? ' SUBTREE(*ALL)' : ''}`;
}

export function chgownCommand(path: string, owner: string, subtree: boolean): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  return `CHGOWN OBJ(${q(path)}) NEWOWN(${NAME(owner, 'user profile')}) RVKOLDAUT(*YES)${subtree ? ' SUBTREE(*ALL)' : ''}`;
}

export const COMMON_CCSIDS: Record<number, string> = { 1208: 'UTF-8', 819: 'ISO 8859-1 (Latin-1)', 1252: 'Windows Latin-1', 37: 'EBCDIC US', 297: 'EBCDIC France', 273: 'EBCDIC Germany', 284: 'EBCDIC Spain', 280: 'EBCDIC Italy', 500: 'EBCDIC International', 1200: 'UTF-16' };

export function tagCcsidCommand(path: string, ccsid: number, subtree: boolean): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  if (!Number.isInteger(ccsid) || ccsid < 1 || ccsid > 65535) { throw new Error('Enter a CCSID between 1 and 65535.'); }
  return `CHGATR OBJ('${path.replace(/'/g, "''")}') ATR(*CCSID) VALUE(${ccsid})${subtree ? ' SUBTREE(*ALL)' : ''}`;
}

export function convertCcsidCommand(path: string, ccsid: number): string {
  if (!path.startsWith('/')) { throw new Error('The path must start with /.'); }
  const p = path.replace(/'/g, "''");
  return `CPY OBJ('${p}') TOOBJ('${p}') TOCCSID(${ccsid}) DTAFMT(*TEXT) REPLACE(*YES)`;
}

/** An absolute IFS path without empty or relative parts. */
export function checkIfsPath(path: string): string {
  const p = path.trim().replace(/\/+$/, '') || '/';
  if (!p.startsWith('/')) { throw new Error('Start the path with / (for example /home/me/app).'); }
  if (/(^|\/)\.\.?(\/|$)/.test(p) || /\/\//.test(p) || /[\0\n]/.test(p)) { throw new Error('The path cannot contain //, . or .. parts.'); }
  return p;
}

/** chmod mode like 755 or 640. */
export function checkMode(mode: string): string {
  const m = mode.trim();
  if (!/^[0-7]{3,4}$/.test(m)) { throw new Error('Use an octal mode such as 755 or 640.'); }
  return m;
}
