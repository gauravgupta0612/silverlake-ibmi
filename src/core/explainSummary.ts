// Turns Db2 for i database monitor records into a short "Visual Explain"-style summary (pure, unit tested).

export interface ExplainSummary {
  tableScans: { table: string; rows: string; reason: string }[];
  indexesUsed: { table: string; index: string }[];
  temporaryIndexes: { table: string; keys: string }[];
  advised: { table: string; keys: string }[];
  sorts: number;
  temporaryResults: number;
  planRebuilt: string[];
  estimatedMs?: number;
  tips: string[];
}

const SCAN_REASONS: Record<string, string> = {
  T1: 'no index exists',
  T2: 'indexes exist but none could be used',
  T3: 'the optimizer chose a table scan over the available indexes',
  T4: 'the table is small or most rows are selected',
  T5: 'no ordering or grouping needed — a scan is cheapest',
  T6: 'scanning in parallel',
  T7: 'a materialized query table was used',
  T8: 'statistics advised a table scan',
};

function g(row: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    const v = row[n] ?? row[n.toLowerCase()];
    if (v !== null && v !== undefined && String(v).trim() !== '') { return String(v).trim(); }
  }
  return '';
}

function tableOf(row: Record<string, unknown>): string {
  const lib = g(row, 'QQPTLN', 'QQTLN');
  const file = g(row, 'QQPTFN', 'QQTFN');
  return file ? (lib ? `${lib}/${file}` : file) : '(unknown table)';
}

export function summarizeMonitor(rows: Record<string, unknown>[]): ExplainSummary {
  const s: ExplainSummary = { tableScans: [], indexesUsed: [], temporaryIndexes: [], advised: [], sorts: 0, temporaryResults: 0, planRebuilt: [], tips: [] };
  const seen = new Set<string>();
  const once = (key: string) => { if (seen.has(key)) { return false; } seen.add(key); return true; };
  let est = 0;
  for (const r of rows) {
    const id = Number(g(r, 'QQRID'));
    const ept = Number(g(r, 'QQEPT'));
    if (Number.isFinite(ept) && ept > 0) { est = Math.max(est, ept); }
    const advisedKeys = g(r, 'QQIDXD');
    if (g(r, 'QQIDXA').toUpperCase() === 'Y' && advisedKeys && once(`adv:${tableOf(r)}:${advisedKeys}`)) {
      s.advised.push({ table: tableOf(r), keys: advisedKeys });
    }
    switch (id) {
      case 3000: {
        const code = g(r, 'QQRCOD').toUpperCase();
        if (once(`scan:${tableOf(r)}`)) {
          s.tableScans.push({ table: tableOf(r), rows: g(r, 'QQTOTR'), reason: SCAN_REASONS[code] ?? (code || '—') });
        }
        break;
      }
      case 3001: {
        const index = [g(r, 'QQILNM'), g(r, 'QQIFNM')].filter(Boolean).join('/');
        if (index && once(`idx:${tableOf(r)}:${index}`)) { s.indexesUsed.push({ table: tableOf(r), index }); }
        break;
      }
      case 3002: {
        if (once(`tmp:${tableOf(r)}`)) { s.temporaryIndexes.push({ table: tableOf(r), keys: advisedKeys || g(r, 'QQ1000') }); }
        break;
      }
      case 3003: s.sorts++; break;
      case 3004: s.temporaryResults++; break;
      case 3006: {
        const code = g(r, 'QQRCOD');
        if (code && once(`rebuilt:${code}`)) { s.planRebuilt.push(code); }
        break;
      }
    }
  }
  if (est > 0) { s.estimatedMs = est * 1000; }
  const big = s.tableScans.filter(t => Number(t.rows) > 100000);
  if (big.length) { s.tips.push(`Large table scan on ${big.map(b => b.table).join(', ')} — an index on the WHERE / JOIN columns usually helps.`); }
  if (s.temporaryIndexes.length) { s.tips.push('Db2 had to build a temporary index while running the query; creating a permanent one avoids that cost every time.'); }
  if (s.advised.length) { s.tips.push('The optimizer advised one or more indexes (below). Review them before creating — every index slows inserts a little.'); }
  if (s.sorts) { s.tips.push('The query needed a sort; an index in ORDER BY / GROUP BY order can remove it.'); }
  if (!s.tableScans.length && !s.temporaryIndexes.length && s.indexesUsed.length) { s.tips.push('Every table was read through an index — this access plan looks good.'); }
  return s;
}

/** CREATE INDEX statement for an advised index (key columns as the monitor lists them). */
export function createIndexSql(table: string, keys: string): string {
  const [lib, file] = table.includes('/') ? table.split('/') : ['', table];
  const cols = keys.split(',').map(k => k.trim()).filter(Boolean);
  const name = `${file.substring(0, 6)}_IX${Math.abs(hash(keys)) % 1000}`.toUpperCase();
  return `CREATE INDEX ${lib ? lib + '.' : ''}${name}\n  ON ${lib ? lib + '.' : ''}${file} (${cols.join(', ')});`;
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) { h = (h * 31 + ch.charCodeAt(0)) | 0; }
  return h;
}
