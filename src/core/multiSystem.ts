// Run the same SQL or CL on several connected systems and line the answers up. Pure (no vscode import), unit tested.

export interface SystemResult { system: string; columns: string[]; rows: Record<string, unknown>[]; error?: string; ms?: number }
export interface MergedRow { values: Record<string, unknown>; on: string[] }
export interface Merged { columns: string[]; rows: MergedRow[]; systems: string[]; differ: number }

const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v).replace(/\s+$/, ''));

/** Rows of every system in one table, with the systems each row is on; rows on only some systems are the differences. */
export function mergeResults(results: SystemResult[]): Merged {
  const ok = results.filter(r => !r.error);
  const columns = [...new Set(ok.flatMap(r => r.columns))];
  const map = new Map<string, MergedRow>();
  for (const r of ok) {
    for (const row of r.rows) {
      const key = columns.map(c => cell(row[c])).join('\u0001');
      const m = map.get(key) ?? { values: Object.fromEntries(columns.map(c => [c, row[c] ?? null])), on: [] };
      if (!m.on.includes(r.system)) { m.on.push(r.system); }
      map.set(key, m);
    }
  }
  const systems = ok.map(r => r.system);
  const rows = [...map.values()].sort((a, b) => a.on.length - b.on.length);
  return { columns, rows, systems, differ: rows.filter(r => r.on.length < systems.length).length };
}
