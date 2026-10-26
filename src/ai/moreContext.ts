// Facts read from the system for the newer AI commands (/tune, /data, /security, /changes). Metadata only: table
// sizes, indexes, columns, keys and authorities — never table rows.
import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { ConnectionManager } from '../core/manager';
import { lineDiff } from '../core/aiGuard';
import { sourceRecords, MEMBER_SCHEME, IFS_SCHEME } from '../features/fileSystems';
import { parseMemberPath, sqlString } from '../core/util';
import { errorMessage } from '../core/log';
import { datedChanges, tablesInSql } from './context';
import { rowsToText } from './prompts';
import { tableFacts } from './tools';
import { checkLibraries, safeRows } from './guard';

type Row = Record<string, unknown>;
const t = (rows: Row[]) => (rows.length ? rowsToText(Object.keys(rows[0]), safeRows(Object.keys(rows[0]), rows).rows) : 'none');

/** /tune: for each table of the statement, its size, indexes and index advice. */
export async function tuneContext(manager: ConnectionManager, sql: string): Promise<string[]> {
  const conn = manager.require();
  const out: string[] = [];
  for (const tb of tablesInSql(sql)) {
    let lib = tb.library;
    if (!lib) {
      const r = await conn.rows<Row>(`SELECT SYSTEM_TABLE_SCHEMA AS L FROM QSYS2.SYSTABLES WHERE (SYSTEM_TABLE_NAME = ${sqlString(tb.name)} OR TABLE_NAME = ${sqlString(tb.name)}) ` +
        `AND SYSTEM_TABLE_SCHEMA IN (SELECT SYSTEM_SCHEMA_NAME FROM QSYS2.LIBRARY_LIST_INFO) FETCH FIRST 1 ROW ONLY`, 1).catch(() => []);
      lib = String(r[0]?.L ?? '').trim();
    }
    if (!lib) { out.push(`Table ${tb.name}: not found in the library list.`); continue; }
    try { out.push(await tableFacts(manager, `${lib}/${tb.name}`)); } catch (e) { out.push(`Table ${lib}/${tb.name}: ${errorMessage(e)}`); }
  }
  return out;
}

/** /data: the structure of a table (columns, keys, foreign keys) — the rows are never read. */
export async function dataContext(conn: IbmiConnection, lib: string, table: string): Promise<string[]> {
  checkLibraries(`${lib}/${table}`);
  const cols = await conn.rows<Row>(`SELECT COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE, IS_NULLABLE, HAS_DEFAULT, COALESCE(COLUMN_TEXT, '') AS TEXT ` +
    `FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(table)} ORDER BY ORDINAL_POSITION`, 1000);
  if (!cols.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', lib, table)); }
  const keys = await conn.rows<Row>(`SELECT C.CONSTRAINT_TYPE, C.CONSTRAINT_NAME, K.COLUMN_NAME FROM QSYS2.SYSCST C JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
    `WHERE C.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND C.SYSTEM_TABLE_NAME = ${sqlString(table)} ORDER BY C.CONSTRAINT_NAME, K.ORDINAL_POSITION`, 200).catch(() => [] as Row[]);
  const fks = await conn.rows<Row>(`SELECT R.CONSTRAINT_NAME, P.TABLE_SCHEMA AS PARENT_SCHEMA, P.TABLE_NAME AS PARENT_TABLE FROM QSYS2.SYSREFCST R JOIN QSYS2.SYSCST P ON P.CONSTRAINT_SCHEMA = R.UNIQUE_CONSTRAINT_SCHEMA AND P.CONSTRAINT_NAME = R.UNIQUE_CONSTRAINT_NAME ` +
    `JOIN QSYS2.SYSCST C ON C.CONSTRAINT_SCHEMA = R.CONSTRAINT_SCHEMA AND C.CONSTRAINT_NAME = R.CONSTRAINT_NAME WHERE C.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND C.SYSTEM_TABLE_NAME = ${sqlString(table)}`, 50).catch(() => [] as Row[]);
  return [`Table ${lib}/${table} (structure only; no rows were read):\nColumns:\n${rowsToText(Object.keys(cols[0]), cols)}`, `Keys and constraints:\n${t(keys)}`, `Foreign keys:\n${t(fks)}`];
}

/** /security: authorities of an object, or the risky *PUBLIC authorities and adopting programs of a library. */
export async function securityContext(conn: IbmiConnection, lib: string, name?: string, type?: string): Promise<string[]> {
  checkLibraries(`${lib}/${name ?? 'X'}`);
  if (name) {
    const ty = type ?? '*ALL';
    const priv = await conn.rows<Row>(`SELECT * FROM QSYS2.OBJECT_PRIVILEGES WHERE SYSTEM_OBJECT_SCHEMA = ${sqlString(lib)} AND SYSTEM_OBJECT_NAME = ${sqlString(name)}${ty !== '*ALL' ? ` AND OBJECT_TYPE = ${sqlString(ty)}` : ''} FETCH FIRST 300 ROWS ONLY`, 300);
    const adopt = await conn.rows<Row>(`SELECT PROGRAM_LIBRARY, PROGRAM_NAME, OBJECT_TYPE, PROGRAM_OWNER, USER_PROFILE, USE_ADOPTED_AUTHORITY FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} AND PROGRAM_NAME = ${sqlString(name)}`, 5).catch(() => [] as Row[]);
    return [`Authorities of ${lib}/${name} ${ty}:\n${t(priv)}`, ...(adopt.length ? [`Program attributes:\n${t(adopt)}`] : [])];
  }
  const pub = await conn.rows<Row>(`SELECT SYSTEM_OBJECT_NAME, OBJECT_TYPE, OBJECT_AUTHORITY, OWNER, AUTHORIZATION_LIST FROM QSYS2.OBJECT_PRIVILEGES WHERE SYSTEM_OBJECT_SCHEMA = ${sqlString(lib)} ` +
    `AND AUTHORIZATION_NAME = '*PUBLIC' AND OBJECT_AUTHORITY NOT IN ('*EXCLUDE', '*USE') ORDER BY OBJECT_AUTHORITY DESC FETCH FIRST 200 ROWS ONLY`, 200).catch(e => [{ ERROR: errorMessage(e) }] as Row[]);
  const adopt = await conn.rows<Row>(`SELECT PROGRAM_NAME, OBJECT_TYPE, PROGRAM_OWNER, USER_PROFILE FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} AND USER_PROFILE = '*OWNER' FETCH FIRST 100 ROWS ONLY`, 100).catch(e => [{ ERROR: errorMessage(e) }] as Row[]);
  const libAut = await conn.rows<Row>(`SELECT * FROM QSYS2.OBJECT_PRIVILEGES WHERE SYSTEM_OBJECT_SCHEMA = 'QSYS' AND SYSTEM_OBJECT_NAME = ${sqlString(lib)} AND OBJECT_TYPE = '*LIB' FETCH FIRST 50 ROWS ONLY`, 50).catch(() => [] as Row[]);
  return [`Authorities of the library ${lib} itself:\n${t(libAut)}`, `Objects in ${lib} where *PUBLIC has more than *USE:\n${t(pub)}`, `Programs in ${lib} that adopt their owner's authority (USRPRF(*OWNER)):\n${t(adopt)}`];
}

/** /changes: only what changed — against Git HEAD for local files, the saved copy on the IBM i, or the latest change day (source dates). */
export async function changesContext(manager: ConnectionManager, uri: vscode.Uri): Promise<{ diff: string; how: string } | undefined> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const now = doc.getText();
  if (uri.scheme === 'file') {
    const git = vscode.extensions.getExtension('vscode.git');
    try {
      const api = (git?.isActive ? git.exports : await git?.activate())?.getAPI(1);
      const repo = api?.getRepository(uri);
      if (repo) {
        const head = await repo.show('HEAD', uri.fsPath).catch(() => '');
        return { diff: lineDiff(head, now), how: head ? 'compared with the last Git commit (HEAD)' : 'a new file, not in Git yet: every line is new' };
      }
    } catch { /* no Git: fall through */ }
    return undefined;
  }
  const conn = manager.connection;
  if (doc.isDirty && conn) {
    if (uri.scheme === MEMBER_SCHEME) { const m = parseMemberPath(uri.path); return { diff: lineDiff(await conn.readMember(m.library, m.file, m.member), now), how: 'unsaved changes compared with the member on the IBM i' }; }
    if (uri.scheme === IFS_SCHEME) { return { diff: lineDiff((await conn.readStreamFile(uri.path)).toString('utf8'), now), how: 'unsaved changes compared with the file in the IFS' }; }
  }
  const recs = sourceRecords.get(uri.toString());
  if (recs?.length) {
    const lines = now.split(/\r?\n/);
    const dates = recs.map(r => r.date);
    const latest = Math.max(...dates);
    if (latest > 0) { return { diff: datedChanges(lines, dates, latest), how: `lines changed on the latest change day (source date ${String(latest).padStart(6, '0')})` }; }
  }
  return undefined;
}
