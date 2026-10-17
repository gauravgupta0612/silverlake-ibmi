// Live alerts: which system events to report and how. Pure functions (no vscode import), unit tested.
import { isValidSystemName } from './util';

const NAME = (v: string, what: string): string => {
  const u = v.trim().toUpperCase();
  if (!isValidSystemName(u)) { throw new Error(`"${v}" is not a valid ${what} name.`); }
  return u;
};

const clq = (v: string) => `'${v.replace(/'/g, "''")}'`;

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
