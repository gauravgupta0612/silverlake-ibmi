// Libraries with their details, read the reliable way (see libraryListSql).

import { IbmiConnection } from '../core/connection';
import { logError } from '../core/log';
import { Row, libraryListSql, mergeLibraries } from '../core/tracker';

/** The list of libraries changes rarely: the System Tracker, PDM and the pickers share it for two minutes. */
const LIBRARY_CACHE_MS = 120_000;

export async function readLibraries(conn: IbmiConnection, names?: string[], max = 50000): Promise<{ rows: Row[]; error?: string }> {
  const sql = libraryListSql(names);
  const [a, b] = await Promise.all([
    conn.cachedRows<Row>(sql.stats, max, LIBRARY_CACHE_MS).then(rows => ({ rows, error: undefined as string | undefined })).catch(e => { logError(e); return { rows: [] as Row[], error: String(e instanceof Error ? e.message : e).split('\n')[0] }; }),
    conn.cachedRows<Row>(sql.catalog, max, LIBRARY_CACHE_MS).then(rows => ({ rows, error: undefined as string | undefined })).catch(e => { logError(e); return { rows: [] as Row[], error: String(e instanceof Error ? e.message : e).split('\n')[0] }; }),
  ]);
  const rows = mergeLibraries(a.rows, b.rows);
  return { rows, error: rows.length ? undefined : (a.error ?? b.error) };
}
