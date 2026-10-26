// Find a value anywhere in a table, and table rows as an SQL INSERT script. Pure (no vscode import), unit tested.

import { ColumnInfo, isNumericType, quoteIdent, sqlLiteral } from './sqlLiteral';

const CHAR = /^(CHAR|CHARACTER|VARCHAR|CHARACTER VARYING|GRAPHIC|VARG|VARGRAPHIC|NCHAR|NVARCHAR|CLOB|DBCLOB)$/i;
const TEMPORAL = /^(DATE|TIME|TIMESTMP|TIMESTAMP)$/i;

export interface SearchPlan { sql: string; searched: string[]; skipped: string[] }

/**
 * A query returning the rows where any column holds `value`: text columns contain it (case-insensitive unless asked),
 * number columns equal it when it is a number, date/time columns start with it. VX_MATCH names the first column that matched.
 */
export function searchSql(table: string, columns: ColumnInfo[], value: string, opts: { caseSensitive?: boolean; max?: number; exact?: boolean } = {}): SearchPlan {
  const v = value.trim();
  if (!v) { throw new Error('Type the value to look for.'); }
  if (v.length > 500) { throw new Error('The value is too long (500 characters at most).'); }
  const like = v.replace(/[\\%_]/g, m => '\\' + m).replace(/'/g, "''");
  const text = opts.caseSensitive ? like : like.toUpperCase();
  const isNum = /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(v);
  const conds: { col: string; cond: string }[] = []; const skipped: string[] = [];
  for (const c of columns.slice(0, 1000)) {
    const id = quoteIdent(c.name); const t = c.type.toUpperCase();
    if (CHAR.test(t)) {
      if (/CLOB/.test(t)) { skipped.push(c.name); continue; }
      const expr = opts.caseSensitive ? `${id}` : `UPPER(${id})`;
      conds.push({ col: c.name, cond: opts.exact ? `${expr} = '${opts.caseSensitive ? v.replace(/'/g, "''") : v.toUpperCase().replace(/'/g, "''")}'` : `${expr} LIKE '%${text}%' ESCAPE '\\'` });
    } else if (isNumericType(t)) {
      if (isNum) { conds.push({ col: c.name, cond: `${id} = ${v}` }); } else { skipped.push(c.name); }
    } else if (TEMPORAL.test(t)) {
      conds.push({ col: c.name, cond: `VARCHAR(${id}) LIKE '${like}%' ESCAPE '\\'` });
    } else { skipped.push(c.name); }
  }
  if (!conds.length) { throw new Error('No column of this table can hold that value.'); }
  const max = Math.max(1, Math.min(10000, Math.floor(opts.max ?? 500)));
  const match = `CASE ${conds.map(c => `WHEN ${c.cond} THEN '${c.col.replace(/'/g, "''")}'`).join(' ')} END AS VX_MATCH`;
  return {
    sql: `SELECT RRN(T) AS VX_RRN, ${match}, T.* FROM ${table} T WHERE ${conds.map(c => `(${c.cond})`).join(' OR ')} FETCH FIRST ${max} ROWS ONLY`,
    searched: conds.map(c => c.col), skipped,
  };
}

/** One INSERT per row (WITH NC: works on tables that are not journaled), for a test system or a fix script. */
export function insertScript(table: string, columns: ColumnInfo[], rows: Record<string, unknown>[], opts: { header?: string; batch?: number } = {}): string {
  const cols = columns.filter(c => !/^(ROWID|DATALINK|BLOB|XML)$/i.test(c.type));
  const names = cols.map(c => quoteIdent(c.name)).join(', ');
  const lit = (v: unknown, c: ColumnInfo): string => {
    if (v === null || v === undefined) { return 'NULL'; }
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (isNumericType(c.type)) { return /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s.trim()) ? s.trim() : 'NULL'; }
    try { return sqlLiteral(CHAR.test(c.type) ? s.replace(/\s+$/, '') : s, { ...c, length: 0, nullable: true }); } catch { return `'${s.replace(/'/g, "''")}'`; }
  };
  const batch = Math.max(1, Math.min(1000, opts.batch ?? 1));
  const out: string[] = [];
  if (opts.header) { out.push(...opts.header.split('\n').map(l => `-- ${l}`), ''); }
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch).map(r => `(${cols.map(c => lit(r[c.name], c)).join(', ')})`);
    out.push(`INSERT INTO ${table} (${names})\n  VALUES ${chunk.join(',\n         ')} WITH NC;`);
  }
  return out.join('\n') + '\n';
}
