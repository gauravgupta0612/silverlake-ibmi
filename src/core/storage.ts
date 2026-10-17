// Storage and clean-up advisor: sizes, clean-up suggestions and the commands for them. Pure functions (no vscode
// import), unit tested.
import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

/** Human-readable size. */
export function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) { return '0 B'; }
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Tables worth reorganizing: many deleted rows, both in count and in share. */
export function reorgCandidates<T extends { rows: number; deleted: number }>(tables: T[], minDeleted = 10000, minShare = 0.2): (T & { share: number })[] {
  return tables
    .map(t => ({ ...t, share: t.deleted / Math.max(1, t.rows + t.deleted) }))
    .filter(t => t.deleted >= minDeleted && t.share >= minShare)
    .sort((a, b) => b.deleted - a.deleted);
}

export function reorgCommand(library: string, file: string): string {
  return `RGZPFM FILE(${NAME(library, 'library')}/${NAME(file, 'file')}) REUSEDLT(*NO)`;
}

/** The delete command for an object type (DLTOBJ needs IBM i 7.4 TR or later, so use the classic ones). */
export function deleteCommand(library: string, name: string, type: string): string {
  const map: Record<string, string> = {
    '*PGM': 'DLTPGM PGM', '*SRVPGM': 'DLTSRVPGM SRVPGM', '*MODULE': 'DLTMOD MODULE', '*FILE': 'DLTF FILE', '*DTAARA': 'DLTDTAARA DTAARA',
    '*DTAQ': 'DLTDTAQ DTAQ', '*CMD': 'DLTCMD CMD', '*MSGF': 'DLTMSGF MSGF', '*BNDDIR': 'DLTBNDDIR BNDDIR', '*USRSPC': 'DLTUSRSPC USRSPC',
    '*JOBD': 'DLTJOBD JOBD', '*OUTQ': 'DLTOUTQ OUTQ', '*MENU': 'DLTMNU MENU', '*PNLGRP': 'DLTPNLGRP PNLGRP', '*QRYDFN': 'DLTQRY QRY',
  };
  const t = type.toUpperCase();
  return map[t] ? `${map[t]}(${NAME(library, 'library')}/${NAME(name, 'object')})` : `DLTOBJ OBJ(${NAME(library, 'library')}/${NAME(name, 'object')}) OBJTYPE(${t})`;
}

export interface Receiver { library: string; name: string; status: string; detached?: string; size: number }

/** Detached journal receivers older than `days`: saved ones can be deleted, unsaved ones need a save first. */
export function receiverAdvice(rs: Receiver[], now: Date, days = 30): (Receiver & { advice: 'delete' | 'save first'; ageDays: number })[] {
  const out: (Receiver & { advice: 'delete' | 'save first'; ageDays: number })[] = [];
  for (const r of rs) {
    if (/ATTACHED/i.test(r.status) || !r.detached) { continue; }
    const age = Math.floor((now.getTime() - new Date(r.detached.replace(' ', 'T')).getTime()) / 86400000);
    if (isNaN(age) || age < days) { continue; }
    out.push({ ...r, ageDays: age, advice: /SAVED|FREED/i.test(r.status) ? 'delete' : 'save first' });
  }
  return out.sort((a, b) => b.size - a.size);
}
