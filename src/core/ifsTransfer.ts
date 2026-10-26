// Folder upload and download between this PC and the IFS (also drag and drop onto the IFS view). Pure, unit tested.

export interface TransferEntry { rel: string; isDirectory: boolean; size: number }
export interface TransferPlan { folders: string[]; files: { rel: string; size: number }[]; skipped: string[]; bytes: number }

const SAFE = /^[^\0]+$/;

/** Join an IFS folder and a relative path, refusing anything that climbs out of the folder. */
export function joinIfs(dir: string, rel: string): string {
  const r = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!SAFE.test(r) || r.split('/').some(p => p === '..')) { throw new Error(`Invalid path ${rel}`); }
  return `${dir.replace(/\/+$/, '') || ''}/${r}`.replace(/\/{2,}/g, '/');
}

/** Name of the last part of a path (Windows or POSIX). */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

/** What to copy: folders first (parents before children), then files; ignored entries and over-size files skipped. */
export function planTransfer(entries: TransferEntry[], ignore: (rel: string) => boolean, maxFileBytes = 2 * 1024 * 1024 * 1024): TransferPlan {
  const folders: string[] = []; const files: { rel: string; size: number }[] = []; const skipped: string[] = [];
  for (const e of entries) {
    const rel = e.rel.replace(/\\/g, '/');
    if (rel.split('/').some(p => p === '..')) { skipped.push(rel); continue; }
    if (ignore(rel)) { skipped.push(rel); continue; }
    if (e.isDirectory) { folders.push(rel); continue; }
    if (e.size > maxFileBytes) { skipped.push(rel); continue; }
    files.push({ rel, size: e.size });
  }
  folders.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { folders, files, skipped, bytes: files.reduce((a, f) => a + f.size, 0) };
}

/** Name that does not clash with existing names: "report.txt" → "report (2).txt". */
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) { return name; }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10000; i++) { const n = `${stem} (${i})${ext}`; if (!taken.has(n)) { return n; } }
  throw new Error(`No free name for ${name}.`);
}

export function formatBytes(n: number): string {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  if (n < 1024 ** 3) { return `${(n / 1024 / 1024).toFixed(1)} MB`; }
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
