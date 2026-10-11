// Pure helpers for 0.12: storage advisor, live alerts, message files & field finder, object
// promotion. No vscode import, unit tested.

import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};
const clq = (v: string) => `'${v.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------- storage advisor

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

// ---------------------------------------------------------------- live alerts

export type AlertKind = 'msgw' | 'inquiry' | 'abend' | 'disk';
export interface Alert { kind: AlertKind; key: string; title: string; detail: string; job?: string; msgKey?: string; time: string }

/** End code from a CPF1164 job completion message ("…; end code 20 ."), or undefined. */
export function endCode(text: string): number | undefined {
  const m = /end code\s+(\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** End codes 10 and above mean the job did not end normally. */
export function isAbnormalEnd(text: string): boolean {
  const c = endCode(text);
  return c !== undefined && c >= 10;
}

/** Remember which alerts were already shown; returns only the new ones. */
export class AlertMemory {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 2000) {}
  fresh(alerts: Alert[]): Alert[] {
    const out = alerts.filter(a => !this.seen.has(a.key));
    for (const a of out) { this.seen.set(a.key, Date.now()); }
    if (this.seen.size > this.max) {
      const old = [...this.seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.seen.size - this.max);
      old.forEach(([k]) => this.seen.delete(k));
    }
    return out;
  }
  forget(key: string): void { this.seen.delete(key); }
}

/** SNDRPY for an inquiry message on a message queue (key as 8 hex digits). */
export function replyCommand(msgKeyHex: string, queueLibrary: string, queue: string, reply: string): string {
  if (!/^[0-9A-F]{8}$/i.test(msgKeyHex)) { throw new Error('Invalid message key.'); }
  if (!reply.trim() || reply.length > 132) { throw new Error('Enter a reply (at most 132 characters).'); }
  return `SNDRPY MSGKEY(X'${msgKeyHex.toUpperCase()}') MSGQ(${NAME(queueLibrary, 'library')}/${NAME(queue, 'message queue')}) RPY(${clq(reply.trim())}) RMV(*NO)`;
}

/** Valid replies listed in an inquiry text, e.g. "(C D I R)" or "(C G)". */
export function validReplies(text: string): string[] {
  const m = /\(([A-Z0-9](?:\s+[A-Z0-9]){1,9})\)\s*$/i.exec(text.trim()) ?? /\(([A-Z0-9](?:\s+[A-Z0-9]){1,9})\)/i.exec(text);
  return m ? m[1].split(/\s+/).map(x => x.toUpperCase()) : [];
}

// ---------------------------------------------------------------- message files

export const MESSAGE_ID_FORMAT = /^[A-Z][A-Z0-9]{2}[0-9A-F]{4}$/;

export interface MessageDesc { id: string; text: string; help?: string; severity?: number }

function msgParts(m: MessageDesc): string {
  const id = m.id.trim().toUpperCase();
  if (!MESSAGE_ID_FORMAT.test(id)) { throw new Error('A message ID is 3 characters and 4 hexadecimal digits, like APP0001.'); }
  if (!m.text.trim()) { throw new Error('Enter the message text.'); }
  if (m.text.length > 132) { throw new Error('The message text is at most 132 characters.'); }
  if ((m.help ?? '').length > 3000) { throw new Error('The help text is at most 3000 characters.'); }
  const sev = m.severity ?? 0;
  if (!Number.isInteger(sev) || sev < 0 || sev > 99) { throw new Error('Severity is 0 to 99.'); }
  return `MSGID(${id}) MSGF(&MSGF) MSG(${clq(m.text)})${m.help?.trim() ? ` SECLVL(${clq(m.help.trim())})` : ''} SEV(${sev})`;
}

export function addMessageCommand(lib: string, msgf: string, m: MessageDesc): string {
  return `ADDMSGD ${msgParts(m).replace('&MSGF', `${NAME(lib, 'library')}/${NAME(msgf, 'message file')}`)}`;
}

export function changeMessageCommand(lib: string, msgf: string, m: MessageDesc): string {
  const p = msgParts(m).replace('&MSGF', `${NAME(lib, 'library')}/${NAME(msgf, 'message file')}`);
  return `CHGMSGD ${m.help?.trim() ? p : p + ' SECLVL(*NONE)'}`;
}

export function removeMessageCommand(lib: string, msgf: string, id: string): string {
  if (!MESSAGE_ID_FORMAT.test(id.trim().toUpperCase())) { throw new Error('Invalid message ID.'); }
  return `RMVMSGD MSGID(${id.trim().toUpperCase()}) MSGF(${NAME(lib, 'library')}/${NAME(msgf, 'message file')})`;
}

/** Next free ID after the highest one with the same prefix (hexadecimal numbering, as IBM does). */
export function nextMessageId(existing: string[], prefix: string): string {
  const p = prefix.trim().toUpperCase().slice(0, 3);
  if (!/^[A-Z][A-Z0-9]{2}$/.test(p)) { throw new Error('The prefix is 3 characters, starting with a letter.'); }
  const nums = existing.map(x => x.trim().toUpperCase()).filter(x => x.startsWith(p) && MESSAGE_ID_FORMAT.test(x)).map(x => parseInt(x.slice(3), 16));
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  if (n > 0xffff) { throw new Error(`No free IDs left for ${p}.`); }
  return p + n.toString(16).toUpperCase().padStart(4, '0');
}

/** Turn a field-finder pattern (with * or % wildcards) into an SQL LIKE pattern. */
export function likePattern(input: string): string {
  const t = input.trim().toUpperCase().replace(/'/g, "''").replace(/\*/g, '%');
  if (!t) { throw new Error('Enter a field name.'); }
  return /[%_]/.test(t) ? t : `%${t}%`;
}

// ---------------------------------------------------------------- object promotion

export interface PromoteObject { name: string; type: string; attribute?: string; sourceChanged?: string; targetChanged?: string; existsInTarget: boolean }

export type PromoteStatus = 'new' | 'newer in source' | 'NEWER IN TARGET' | 'same date';

export function promoteStatus(o: PromoteObject): PromoteStatus {
  if (!o.existsInTarget) { return 'new'; }
  const s = o.sourceChanged ?? ''; const t = o.targetChanged ?? '';
  if (s === t) { return 'same date'; }
  return s > t ? 'newer in source' : 'NEWER IN TARGET';
}

/** Physical files carry data: restoring them would replace the target's data. */
export function carriesData(o: PromoteObject): boolean {
  return o.type.toUpperCase() === '*FILE' && /^PF/i.test(o.attribute ?? '');
}

/** Save file name for a backup or a transfer: prefix + MMDDHHMM (10 characters). */
export function stampedName(prefix: 'VB' | 'VP', d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface PromotionPlan {
  source: string; target: string; objects: { name: string; type: string }[]; backupLibrary: string; when: string;
}

/** The commands a promotion runs, in order. */
export function promotionCommands(plan: PromotionPlan, existingInTarget: { name: string; type: string }[]): { backupSavf?: string; transferSavf: string; steps: string[] } {
  const src = NAME(plan.source, 'library'); const tgt = NAME(plan.target, 'library'); const bl = NAME(plan.backupLibrary, 'library');
  if (src === tgt) { throw new Error('Source and target library are the same.'); }
  if (!plan.objects.length) { throw new Error('Pick at least one object.'); }
  const d = new Date(plan.when);
  const names = (os: { name: string; type: string }[]) => [...new Set(os.map(o => NAME(o.name, 'object')))].join(' ');
  const types = (os: { name: string; type: string }[]) => [...new Set(os.map(o => o.type.toUpperCase()))].join(' ');
  const steps: string[] = [];
  let backupSavf: string | undefined;
  if (existingInTarget.length) {
    backupSavf = `${bl}/${stampedName('VB', d)}`;
    steps.push(`CRTSAVF FILE(${backupSavf}) TEXT('Vanthrex backup of ${tgt} before promotion from ${src}')`);
    steps.push(`SAVOBJ OBJ(${names(existingInTarget)}) LIB(${tgt}) DEV(*SAVF) SAVF(${backupSavf}) OBJTYPE(${types(existingInTarget)})`);
  }
  const transferSavf = `${bl}/${stampedName('VP', d)}`;
  steps.push(`CRTSAVF FILE(${transferSavf}) TEXT('Vanthrex promotion ${src} to ${tgt}')`);
  steps.push(`SAVOBJ OBJ(${names(plan.objects)}) LIB(${src}) DEV(*SAVF) SAVF(${transferSavf}) OBJTYPE(${types(plan.objects)})`);
  steps.push(`RSTOBJ OBJ(${names(plan.objects)}) SAVLIB(${src}) DEV(*SAVF) SAVF(${transferSavf}) OBJTYPE(${types(plan.objects)}) MBROPT(*ALL) ALWOBJDIF(*COMPATIBLE) RSTLIB(${tgt})`);
  steps.push(`DLTF FILE(${transferSavf})`);
  return { backupSavf, transferSavf, steps };
}

/** Undo a promotion: restore the backup over the target library. */
export function undoPromotionCommand(target: string, backupSavf: string): string {
  return `RSTOBJ OBJ(*ALL) SAVLIB(${NAME(target, 'library')}) DEV(*SAVF) SAVF(${backupSavf}) MBROPT(*ALL) ALWOBJDIF(*COMPATIBLE)`;
}
