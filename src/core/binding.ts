// Binding directories, binder source and service program signatures. Pure functions (no vscode import), unit tested.
import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

export function addBnddirEntryCommand(bnddir: string, objLib: string, obj: string, type: '*SRVPGM' | '*MODULE'): string {
  const [l, b] = bnddir.includes('/') ? bnddir.split('/') : ['*LIBL', bnddir];
  return `ADDBNDDIRE BNDDIR(${l === '*LIBL' ? '*LIBL' : NAME(l, 'library')}/${NAME(b, 'binding directory')}) OBJ((${objLib.toUpperCase() === '*LIBL' ? '*LIBL' : NAME(objLib, 'library')}/${NAME(obj, 'object')} ${type}))`;
}

export function removeBnddirEntryCommand(bnddir: string, objLib: string, obj: string, type: string): string {
  const [l, b] = bnddir.includes('/') ? bnddir.split('/') : ['*LIBL', bnddir];
  return `RMVBNDDIRE BNDDIR(${l === '*LIBL' ? '*LIBL' : NAME(l, 'library')}/${NAME(b, 'binding directory')}) OBJ((${objLib.toUpperCase() === '*LIBL' ? '*LIBL' : NAME(objLib, 'library')}/${NAME(obj, 'object')} ${type.toUpperCase()}))`;
}

export function rtvbndsrcCommand(srvLib: string, srv: string, srcLib: string, srcFile: string, member: string): string {
  return `RTVBNDSRC SRVPGM(${NAME(srvLib, 'library')}/${NAME(srv, 'service program')}) SRCFILE(${NAME(srcLib, 'library')}/${NAME(srcFile, 'source file')}) SRCMBR(${NAME(member, 'member')}) MBROPT(*REPLACE)`;
}

/** EXPORT_SIGNATURES as hex: each signature is 16 bytes (32 hex digits) followed by a X'00' separator; the current
 *  signature comes first. Lists without separators are read too. All-zero entries are padding. */
export function splitSignatures(hex: string): string[] {
  const h = (hex ?? '').replace(/\s+/g, '').toUpperCase(); const out: string[] = [];
  const stride = h.length % 34 === 0 || h.length % 34 === 32 ? 34 : 32;
  for (let i = 0; i + 32 <= h.length; i += stride) { const s = h.slice(i, i + 32); if (!/^0+$/.test(s)) { out.push(s); } }
  return out;
}

export type SigState = 'current' | 'older' | 'mismatch' | 'unknown';

export function signatureState(bound: string, signatures: string[]): SigState {
  const b = (bound ?? '').replace(/\s+/g, '').toUpperCase();
  if (!b || !signatures.length) { return 'unknown'; }
  if (signatures[0] === b) { return 'current'; }
  return signatures.includes(b) ? 'older' : 'mismatch';
}

const OBJ = /^(\*LIBL|[A-Z$#@][A-Z0-9$#@_.]{0,9})$/;

/** Re-binds a program or service program to the service program's current signature, without changing any module. */
export function rebindCommand(type: string, lib: string, name: string, srvLib: string, srv: string): string {
  const [l, n, sl, s] = [lib, name, srvLib || '*LIBL', srv].map(x => x.trim().toUpperCase());
  if (![l, n, sl, s].every(x => OBJ.test(x)) || l === '*LIBL' || n === '*LIBL' || s === '*LIBL') { throw new Error('Invalid object name.'); }
  return /SRVPGM/i.test(type)
    ? `UPDSRVPGM SRVPGM(${l}/${n}) MODULE(*NONE) BNDSRVPGM((${sl}/${s}))`
    : `UPDPGM PGM(${l}/${n}) MODULE(*NONE) BNDSRVPGM((${sl}/${s}))`;
}
