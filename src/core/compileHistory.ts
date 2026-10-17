// Compile history and changes since the last compile. Pure functions (no vscode import), unit tested.


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

/** YYYY-MM-DD of an IBM i timestamp (2026-10-05-11.00.00.000000 or 2026-10-05 11:00:00). */
export function dayOf(ts: string | undefined): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((ts ?? '').trim());
  return m?.[1];
}

/** The most recent compile among objects built from a member (by creation time). */
export function lastCompileDay(objects: { created?: string }[]): string | undefined {
  return objects.map(o => dayOf(o.created)).filter((d): d is string => !!d).sort().pop();
}
