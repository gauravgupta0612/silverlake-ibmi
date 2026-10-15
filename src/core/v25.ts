// Pure helpers for the second 2.2 batch: compile history, changes since the last compile, live job log
// and pinned items. No vscode import, unit tested.

// ---------------------------------------------------------------- compile history

export interface CompileRecord {
  at: string;            // ISO time
  system: string;        // connection name
  uri: string;           // member / IFS document URI
  name: string;          // LIB/FILE(MBR) or IFS path
  object: string;        // OBJLIB/NAME
  ok: boolean;
  errors: number;
  warnings: number;
  command: string;
  message?: string;
}

export const HISTORY_SIZE = 200;

export function addCompile(list: CompileRecord[], r: CompileRecord): CompileRecord[] {
  return [r, ...list].slice(0, HISTORY_SIZE);
}

/** Latest result per source (what is broken right now), newest first. */
export function latestPerSource(list: CompileRecord[]): CompileRecord[] {
  const seen = new Set<string>();
  return list.filter(r => { if (seen.has(r.uri)) { return false; } seen.add(r.uri); return true; });
}

export function compileSummary(list: CompileRecord[]): { total: number; failed: number; rate: number; brokenNow: number } {
  const failed = list.filter(r => !r.ok).length;
  return { total: list.length, failed, rate: list.length ? Math.round(100 * (list.length - failed) / list.length) : 0, brokenNow: latestPerSource(list).filter(r => !r.ok).length };
}

// ---------------------------------------------------------------- changes since the last compile

/** YYYY-MM-DD of an IBM i timestamp (2026-10-05-11.00.00.000000 or 2026-10-05 11:00:00). */
export function dayOf(ts: string | undefined): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((ts ?? '').trim());
  return m?.[1];
}

/** The most recent compile among objects built from a member (by creation time). */
export function lastCompileDay(objects: { created?: string }[]): string | undefined {
  return objects.map(o => dayOf(o.created)).filter((d): d is string => !!d).sort().pop();
}

// ---------------------------------------------------------------- live job log

export interface JobLogMessage { pos: number; time: string; id: string; type: string; severity: number; text: string; from: string }

export function jobLogLine(m: JobLogMessage): string {
  const t = (m.time.match(/\d{2}[.:]\d{2}[.:]\d{2}/)?.[0] ?? m.time).replace(/\./g, ':');
  const sev = m.severity ? String(m.severity).padStart(2, '0') : '  ';
  return `${t} ${(m.id || '       ').padEnd(7)} ${sev} ${m.type.slice(0, 13).padEnd(13)} ${m.text}${m.from ? `  [${m.from}]` : ''}`;
}

export function jobLogSql(job: string, after: number): string {
  if (!/^\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}$/i.test(job.trim()) && job.trim() !== '*') { throw new Error('Use a qualified job name: 123456/USER/NAME.'); }
  return `SELECT ORDINAL_POSITION AS P, VARCHAR(MESSAGE_TIMESTAMP) AS T, COALESCE(MESSAGE_ID, '') AS I, COALESCE(MESSAGE_TYPE, '') AS Y, ` +
    `COALESCE(SEVERITY, 0) AS S, COALESCE(MESSAGE_TEXT, '') AS X, COALESCE(FROM_PROGRAM, '') AS F ` +
    `FROM TABLE(QSYS2.JOBLOG_INFO('${job.trim().toUpperCase()}')) J WHERE ORDINAL_POSITION > ${Math.max(0, Math.floor(after))} ORDER BY ORDINAL_POSITION`;
}

/** Messages that deserve attention in a live job log (escape messages, severity 30+, inquiry). */
export function isAlarming(m: JobLogMessage): boolean {
  return m.severity >= 30 || /ESCAPE|INQUIRY/i.test(m.type);
}

// ---------------------------------------------------------------- pinned items

export type PinKind = 'member' | 'srcfile' | 'library' | 'object' | 'ifs';
export interface Pin { kind: PinKind; library?: string; file?: string; name?: string; type?: string; path?: string; text?: string }

export function pinKey(p: Pin): string {
  return p.kind === 'ifs' ? `ifs:${p.path}` : `${p.kind}:${p.library ?? ''}/${p.file ?? ''}/${p.name ?? ''}/${p.type ?? ''}`.toUpperCase();
}

export function pinLabel(p: Pin): string {
  switch (p.kind) {
    case 'member': return `${p.name}.${(p.type ?? '').toLowerCase()}`;
    case 'srcfile': return `${p.library}/${p.file}`;
    case 'library': return p.library ?? '';
    case 'object': return `${p.library}/${p.name}`;
    case 'ifs': return (p.path ?? '').split('/').filter(Boolean).pop() ?? p.path ?? '/';
  }
}

export function pinDescription(p: Pin): string {
  switch (p.kind) {
    case 'member': return `${p.library}/${p.file}${p.text ? ` · ${p.text}` : ''}`;
    case 'object': return `${p.type ?? ''}${p.text ? ` · ${p.text}` : ''}`;
    case 'ifs': return p.path ?? '';
    default: return p.text ?? '';
  }
}

export function togglePin(list: Pin[], p: Pin): { list: Pin[]; pinned: boolean } {
  const k = pinKey(p);
  if (list.some(x => pinKey(x) === k)) { return { list: list.filter(x => pinKey(x) !== k), pinned: false }; }
  return { list: [...list, p], pinned: true };
}

export function movePin(list: Pin[], key: string, delta: number): Pin[] {
  const i = list.findIndex(x => pinKey(x) === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) { return list; }
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
