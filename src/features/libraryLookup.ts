// Libraries with their details, read the reliable way (see libraryListSql).

import { IbmiConnection } from '../core/connection';
import { logError } from '../core/log';
import { Row, libraryListSql, mergeLibraries } from '../core/tracker';

export async function readLibraries(conn: IbmiConnection, names?: string[], max = 50000): Promise<{ rows: Row[]; error?: string }> {
  const sql = libraryListSql(names);
  const [a, b] = await Promise.all([
    conn.rows<Row>(sql.stats, max).then(rows => ({ rows, error: undefined as string | undefined })).catch(e => { logError(e); return { rows: [] as Row[], error: String(e instanceof Error ? e.message : e).split('\n')[0] }; }),
    conn.rows<Row>(sql.catalog, max).then(rows => ({ rows, error: undefined as string | undefined })).catch(e => { logError(e); return { rows: [] as Row[], error: String(e instanceof Error ? e.message : e).split('\n')[0] }; }),
  ]);
  const rows = mergeLibraries(a.rows, b.rows);
  return { rows, error: rows.length ? undefined : (a.error ?? b.error) };
}
