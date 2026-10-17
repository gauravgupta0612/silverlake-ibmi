// Security helpers: exit points, *PUBLIC authority, ownership and authority in bulk. Pure functions (no vscode import),
// unit tested.
import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

/** Network exit points worth protecting with an exit program (database, file, FTP, remote command…). */
export const NETWORK_EXIT_POINTS: Record<string, string> = {
  QIBM_QZDA_INIT: 'Database server — connect (ODBC / JDBC)', QIBM_QZDA_SQL1: 'Database server — SQL requests', QIBM_QZDA_SQL2: 'Database server — SQL requests',
  QIBM_QZDA_NDB1: 'Database server — native database', QIBM_QZDA_ROI1: 'Database server — catalog', QIBM_QPWFS_FILE_SERV: 'File server (IFS over NetServer / ACS)',
  QIBM_QTF_TRANSFER: 'FTP — file transfer', QIBM_QTF_SERVER_LOGON: 'FTP — sign-on', QIBM_QTMF_SERVER_REQ: 'FTP — server requests',
  QIBM_QZRC_RMT: 'Remote command / program call', QIBM_QZSO_SIGNONSRV: 'Sign-on server', QIBM_QTG_DEVINIT: 'Telnet — device initialization',
  QIBM_QRQ_SQL: 'DRDA / DDM — SQL', QIBM_QTMX_SERVER_REQ: 'REXEC server requests', QIBM_QZHQ_DATA_QUEUE: 'Data queue server', QIBM_QNPS_ENTRY: 'Network print server',
};

/** Which network exit points have no exit program registered. */
export function unprotectedExitPoints(registered: { point: string }[]): { point: string; what: string }[] {
  const have = new Set(registered.map(r => r.point.toUpperCase()));
  return Object.entries(NETWORK_EXIT_POINTS).filter(([p]) => !have.has(p)).map(([point, what]) => ({ point, what }));
}

export function chgobjownCommand(lib: string, obj: string, type: string, newOwner: string, revokeOld: boolean): string {
  return `CHGOBJOWN OBJ(${NAME(lib, 'library')}/${NAME(obj, 'object')}) OBJTYPE(${type.toUpperCase()}) NEWOWN(${NAME(newOwner, 'user profile')}) CUROWNAUT(${revokeOld ? '*REVOKE' : '*SAME'})`;
}

/** GRTOBJAUT / RVKOBJAUT accept generic names and *ALL, so one command covers many objects. */
export function bulkAuthorityCommand(grant: boolean, lib: string, pattern: string, type: string, user: string, aut: string): string {
  const p = pattern.trim().toUpperCase();
  if (!/^(\*ALL|[A-Z$#@][A-Z0-9$#@_.]{0,9}\*?)$/.test(p)) { throw new Error('Use a name, a generic name like ORD* or *ALL.'); }
  const u = user.trim().toUpperCase() === '*PUBLIC' ? '*PUBLIC' : NAME(user, 'user profile');
  return `${grant ? 'GRTOBJAUT' : 'RVKOBJAUT'} OBJ(${NAME(lib, 'library')}/${p}) OBJTYPE(${type.toUpperCase()}) USER(${u}) AUT(${aut.toUpperCase()})`;
}

/** Generic name test like the IBM i one: "ORD*" matches ORDENT, "*ALL" matches everything. */
export function matchesGeneric(name: string, pattern: string): boolean {
  const p = pattern.trim().toUpperCase();
  if (p === '*ALL') { return true; }
  return p.endsWith('*') ? name.toUpperCase().startsWith(p.slice(0, -1)) : name.toUpperCase() === p;
}

export type Risk = 'bad' | 'warn' | 'info' | 'ok';

export function publicRisk(authority: string, autl?: string): Risk {
  const a = authority.trim().toUpperCase();
  if (a === '*ALL') { return 'bad'; }
  if (a === '*CHANGE') { return 'warn'; }
  if (a === '*AUTL') { return autl ? 'info' : 'warn'; }
  if (a === 'USER DEF' || a === 'USER DEFINED') { return 'info'; }
  return 'ok';
}

const OBJECT_NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

export function setPublicCommand(lib: string, obj: string, type: string, aut: '*USE' | '*EXCLUDE' | '*CHANGE'): string {
  const l = lib.trim().toUpperCase(); const o = obj.trim().toUpperCase(); const t = type.trim().toUpperCase();
  if (!OBJECT_NAME.test(l) || !OBJECT_NAME.test(o) || !/^\*[A-Z]{2,9}$/.test(t)) { throw new Error('Invalid object.'); }
  return aut === '*EXCLUDE' ? `RVKOBJAUT OBJ(${l}/${o}) OBJTYPE(${t}) USER(*PUBLIC) AUT(*ALL)` : `GRTOBJAUT OBJ(${l}/${o}) OBJTYPE(${t}) USER(*PUBLIC) AUT(${aut}) REPLACE(*YES)`;
}
