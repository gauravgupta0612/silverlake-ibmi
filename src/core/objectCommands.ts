// CL commands for copying, moving, renaming and creating objects and source files; duplicate finder. Pure functions (no
// vscode import), unit tested.
import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

export function duplicatesSql(library: string, table: string, keys: string[], limit = 500): string {
  if (!keys.length) { throw new Error('Pick at least one column.'); }
  const k = keys.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
  return `SELECT ${k}, COUNT(*) AS "COPIES" FROM ${NAME(library, 'library')}/${NAME(table, 'table')} GROUP BY ${k} HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC FETCH FIRST ${limit} ROWS ONLY`;
}

export function crtdupobjCommand(fromLib: string, name: string, type: string, toLib: string, newName?: string, data = false): string {
  const t = type.toUpperCase();
  return `CRTDUPOBJ OBJ(${NAME(name, 'object')}) FROMLIB(${NAME(fromLib, 'library')}) OBJTYPE(${t}) TOLIB(${NAME(toLib, 'library')})` +
    `${newName && newName.toUpperCase() !== name.toUpperCase() ? ` NEWOBJ(${NAME(newName, 'object')})` : ''}${t === '*FILE' ? ` DATA(${data ? '*YES' : '*NO'})` : ''}`;
}

export function moveCommand(lib: string, name: string, type: string, toLib: string): string {
  return `MOVOBJ OBJ(${NAME(lib, 'library')}/${NAME(name, 'object')}) OBJTYPE(${type.toUpperCase()}) TOLIB(${NAME(toLib, 'library')})`;
}

export function renameCommand(lib: string, name: string, type: string, newName: string): string {
  return `RNMOBJ OBJ(${NAME(lib, 'library')}/${NAME(name, 'object')}) OBJTYPE(${type.toUpperCase()}) NEWOBJ(${NAME(newName, 'object')})`;
}

/** CPYSRCF keeps sequence numbers and dates; MBROPT(*ADD) refuses to overwrite. */
export function cpysrcfCommand(fromLib: string, fromFile: string, member: string, toLib: string, toFile: string, replace: boolean, newName?: string): string {
  return `CPYSRCF FROMFILE(${NAME(fromLib, 'library')}/${NAME(fromFile, 'file')}) TOFILE(${NAME(toLib, 'library')}/${NAME(toFile, 'file')}) FROMMBR(${NAME(member, 'member')})` +
    ` TOMBR(${newName ? NAME(newName, 'member') : '*FROMMBR'}) MBROPT(${replace ? '*REPLACE' : '*ADD'})`;
}

const OBJECT_NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

export const STANDARD_SOURCE_FILES: { file: string; text: string }[] = [
  { file: 'QRPGLESRC', text: 'RPG IV source' }, { file: 'QCLLESRC', text: 'CL source' }, { file: 'QDDSSRC', text: 'DDS source' },
  { file: 'QSQLSRC', text: 'SQL source' }, { file: 'QCPYSRC', text: 'Copy members' }, { file: 'QSRVSRC', text: 'Binder source' }, { file: 'QCMDSRC', text: 'Command source' },
];

export function createSourceFileCommand(lib: string, file: string, text: string, recordLength = 112): string {
  const l = lib.trim().toUpperCase(); const f = file.trim().toUpperCase();
  if (!OBJECT_NAME.test(l) || !OBJECT_NAME.test(f)) { throw new Error('Invalid name.'); }
  const len = Math.max(13, Math.min(32766, Math.floor(recordLength)));
  return `CRTSRCPF FILE(${l}/${f}) RCDLEN(${len}) TEXT('${text.slice(0, 50).replace(/'/g, "''")}')`;
}
