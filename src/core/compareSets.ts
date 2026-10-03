// Pure comparison of two libraries' contents (unit tested).

export interface CompareItem {
  /** Unique key within one side, e.g. "QRPGLESRC(ORDENTRY)" or "ORDENTRY *PGM". */
  key: string;
  /** Values that should match on both sides (size, row count…). */
  fingerprint: string;
  changed?: string;
  detail?: string;
}

export type CompareStatus = 'onlyA' | 'onlyB' | 'different' | 'same';

export interface CompareRow {
  key: string;
  status: CompareStatus;
  a?: CompareItem;
  b?: CompareItem;
  /** Which side was changed more recently, when both exist and differ. */
  newer?: 'A' | 'B';
}

export function compareSets(a: CompareItem[], b: CompareItem[]): CompareRow[] {
  const mapB = new Map(b.map(x => [x.key, x]));
  const rows: CompareRow[] = [];
  for (const x of a) {
    const y = mapB.get(x.key);
    if (!y) { rows.push({ key: x.key, status: 'onlyA', a: x }); continue; }
    mapB.delete(x.key);
    const status: CompareStatus = x.fingerprint === y.fingerprint ? 'same' : 'different';
    const newer = status === 'different' && x.changed && y.changed && x.changed !== y.changed
      ? (x.changed > y.changed ? 'A' : 'B') : undefined;
    rows.push({ key: x.key, status, a: x, b: y, newer });
  }
  for (const y of mapB.values()) { rows.push({ key: y.key, status: 'onlyB', b: y }); }
  const order: Record<CompareStatus, number> = { different: 0, onlyA: 1, onlyB: 2, same: 3 };
  return rows.sort((p, q) => order[p.status] - order[q.status] || p.key.localeCompare(q.key));
}

export function summarize(rows: CompareRow[]): Record<CompareStatus, number> {
  const s: Record<CompareStatus, number> = { onlyA: 0, onlyB: 0, different: 0, same: 0 };
  for (const r of rows) { s[r.status]++; }
  return s;
}
