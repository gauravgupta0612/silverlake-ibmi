// Test data generation and SQL INSERT scripts. Pure functions (no vscode import), unit tested.
import { Column, sqlValue } from './dataTransfer';

/** Small deterministic random generator (so a preview and the insert give the same rows). */
export function seeded(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

const WORDS = ['ALPHA', 'BRAVO', 'DELTA', 'ECHO', 'NORTH', 'SOUTH', 'PARIS', 'LYON', 'BERLIN', 'MADRID', 'ROMA', 'OSLO', 'ACME', 'GLOBEX', 'INITECH', 'UMBRELLA'];

/** Generated rows for a table: keys continue after `startKey`, other values fit each column's type. */
export function testRows(cols: (Column & { pk?: boolean })[], count: number, startKey = 0, seed = 42): (string | null)[][] {
  const rnd = seeded(seed); const rows: (string | null)[][] = [];
  const pkNumeric = cols.filter(c => c.pk && /DEC|NUM|INT/i.test(c.type));
  for (let n = 1; n <= count; n++) {
    rows.push(cols.map(c => {
      const t = c.type.toUpperCase();
      if (c.pk && pkNumeric.includes(c)) { return String(startKey + n); }
      if (c.nullable && !c.pk && rnd() < 0.05) { return null; }
      if (/^(DECIMAL|NUMERIC)$/.test(t)) {
        const intDigits = Math.max(0, c.length - c.scale); const max = Math.min(10 ** Math.min(intDigits, 9) - 1, 99999);
        const v = rnd() * max; return c.scale ? v.toFixed(Math.min(c.scale, 2)) : String(Math.floor(v));
      }
      if (/INT/.test(t)) { return String(Math.floor(rnd() * (t === 'SMALLINT' ? 30000 : 100000))); }
      if (/FLOAT|DOUBLE|REAL|DECFLOAT/.test(t)) { return (rnd() * 1000).toFixed(3); }
      if (t === 'DATE') { const d = new Date(Date.UTC(2020, 0, 1) + Math.floor(rnd() * 2400) * 86400000); return d.toISOString().slice(0, 10); }
      if (/TIMESTAMP|TIMESTMP/.test(t)) { const d = new Date(Date.UTC(2020, 0, 1) + Math.floor(rnd() * 2400 * 86400) * 1000); return d.toISOString().replace('T', ' ').slice(0, 19); }
      if (t === 'TIME') { return `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00`; }
      if (/CHAR|GRAPHIC|CLOB/.test(t)) {
        const base = c.pk ? `T${String(startKey + n).padStart(Math.min(6, Math.max(1, c.length - 1)), '0')}` : `${WORDS[Math.floor(rnd() * WORDS.length)]} ${n}`;
        return base.slice(0, Math.max(1, Math.min(c.length, 60)));
      }
      return null;
    }));
  }
  return rows;
}

/** A script of INSERT statements for rows already read from a table. */
export function insertScript(library: string, table: string, cols: Column[], rows: Record<string, unknown>[]): string {
  const names = cols.map(c => `"${c.name.replace(/"/g, '""')}"`).join(', ');
  const out = [`-- ${rows.length} row(s) of ${library}/${table}, exported by Vanthrex for IBM i`];
  for (const r of rows) {
    out.push(`INSERT INTO ${library}/${table} (${names}) VALUES (${cols.map(c => {
      const v = r[c.name];
      if (v === null || v === undefined) { return 'NULL'; }
      try { return sqlValue(typeof v === 'string' ? v.trimEnd() || ' ' : String(v), { ...c, nullable: true, length: Math.max(c.length, String(v).length) }); } catch { return `'${String(v).replace(/'/g, "''")}'`; }
    }).join(', ')});`);
  }
  return out.join('\n') + '\n';
}
