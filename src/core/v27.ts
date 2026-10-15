// Pure helpers for the 2.3 stability work: reconnect back-off, connection health, which errors mean
// "the connection is gone", and copying between systems. No vscode import, unit tested.

/** Seconds to wait before each reconnect attempt (attempt 1 = right after the drop). */
export const RECONNECT_DELAYS = [2, 5, 15, 30, 60];

export function reconnectDelay(attempt: number): number | undefined {
  return attempt >= 1 && attempt <= RECONNECT_DELAYS.length ? RECONNECT_DELAYS[attempt - 1] : undefined;
}

/** Response time of a tiny query → health. */
export function latencyState(ms: number | undefined, failures: number): { state: 'good' | 'slow' | 'bad' | 'down'; text: string } {
  if (failures >= 2) { return { state: 'down', text: 'not answering' }; }
  if (ms === undefined) { return { state: 'good', text: '' }; }
  if (ms >= 5000) { return { state: 'bad', text: `${(ms / 1000).toFixed(1)} s` }; }
  if (ms >= 1500) { return { state: 'slow', text: `${(ms / 1000).toFixed(1)} s` }; }
  return { state: 'good', text: `${Math.round(ms)} ms` };
}

/** Errors that mean the connection is gone (as opposed to an IBM i message about the request itself). */
export function isConnectionError(message: string): boolean {
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|Not connected|No response from server|Channel open failure|Unavailable|connection (was )?(lost|closed)|Timed out while waiting for handshake/i.test(message);
}

/** File name for a remembered edit (safe on Windows, readable). */
export function pendingFileName(uri: string, at = new Date()): string {
  const clean = uri.replace(/^[a-z-]+:\/*/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120);
  return `${at.toISOString().replace(/[:.]/g, '-')}__${clean}`;
}

// ---------------------------------------------------------------- copy to another system

const NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

/** ADDPFM for the target member when it does not exist yet. */
export function addMemberIfMissing(lib: string, file: string, mbr: string, type: string, text: string): string {
  const [l, f, m] = [lib, file, mbr].map(x => x.trim().toUpperCase());
  if (![l, f, m].every(x => NAME.test(x))) { throw new Error('Invalid name.'); }
  const t = type.trim().toUpperCase();
  return `ADDPFM FILE(${l}/${f}) MBR(${m}) TEXT('${text.slice(0, 50).replace(/'/g, "''")}')${/^[A-Z0-9]{1,10}$/.test(t) ? ` SRCTYPE(${t})` : ''}`;
}

/** Short summary of what differs between the copy being sent and the one already there. */
export function lineDiffSummary(a: string, b: string): { same: boolean; added: number; removed: number } {
  const al = a.replace(/\r\n/g, '\n').replace(/\s+$/gm, '').split('\n'); const bl = b.replace(/\r\n/g, '\n').replace(/\s+$/gm, '').split('\n');
  const count = (lines: string[]) => { const m = new Map<string, number>(); for (const l of lines) { m.set(l, (m.get(l) ?? 0) + 1); } return m; };
  const ca = count(al); const cb = count(bl);
  let added = 0; let removed = 0;
  for (const [l, n] of ca) { added += Math.max(0, n - (cb.get(l) ?? 0)); }
  for (const [l, n] of cb) { removed += Math.max(0, n - (ca.get(l) ?? 0)); }
  return { same: added === 0 && removed === 0, added, removed };
}
