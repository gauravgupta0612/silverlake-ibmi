// Ready-made Db2 for i queries for a library, source file, member or object (pure module, unit tested).
// Used by the "Run SQL Query…" editor panel opened from the Libraries view, the call graph and reports.

import { sqlString } from './util';

export interface SqlTarget {
  library: string;
  name?: string;      // object name
  type?: string;      // *FILE, *PGM, *SRVPGM…
  file?: string;      // source file (member / srcfile nodes)
  member?: string;
}

export interface SqlTemplate { label: string; sql: string; }

const up = (s?: string) => (s ?? '').trim().toUpperCase();

/** A short title for the panel: MYLIB, MYLIB/QRPGLESRC(ORD100) or MYLIB/ORDERS *FILE. */
export function targetLabel(t: SqlTarget): string {
  if (t.member) { return `${up(t.library)}/${up(t.file)}(${up(t.member)})`; }
  if (t.file) { return `${up(t.library)}/${up(t.file)}`; }
  if (t.name) { return `${up(t.library)}/${up(t.name)}${t.type ? ' ' + up(t.type) : ''}`; }
  return up(t.library);
}

export function sqlTemplatesFor(t: SqlTarget): SqlTemplate[] {
  const lib = up(t.library);
  const L = sqlString(lib);
  const out: SqlTemplate[] = [];

  if (t.member || t.file) {
    const file = up(t.file), F = sqlString(file);
    if (t.member) {
      out.push({ label: 'Member information', sql:
        `SELECT SYSTEM_TABLE_MEMBER AS MEMBER, SOURCE_TYPE, NUMBER_ROWS AS LINES, PARTITION_TEXT AS TEXT,\n` +
        `       CREATE_TIMESTAMP, LAST_SOURCE_UPDATE_TIMESTAMP\n  FROM QSYS2.SYSPARTITIONSTAT\n` +
        ` WHERE SYSTEM_TABLE_SCHEMA = ${L} AND SYSTEM_TABLE_NAME = ${F} AND SYSTEM_TABLE_MEMBER = ${sqlString(up(t.member))}` });
    }
    out.push({ label: 'Members of this source file', sql:
      `SELECT SYSTEM_TABLE_MEMBER AS MEMBER, SOURCE_TYPE, NUMBER_ROWS AS LINES, PARTITION_TEXT AS TEXT,\n` +
      `       LAST_SOURCE_UPDATE_TIMESTAMP\n  FROM QSYS2.SYSPARTITIONSTAT\n` +
      ` WHERE SYSTEM_TABLE_SCHEMA = ${L} AND SYSTEM_TABLE_NAME = ${F}\n ORDER BY SYSTEM_TABLE_MEMBER` });
    out.push({ label: 'Most recently changed members', sql:
      `SELECT SYSTEM_TABLE_MEMBER AS MEMBER, SOURCE_TYPE, LAST_SOURCE_UPDATE_TIMESTAMP\n  FROM QSYS2.SYSPARTITIONSTAT\n` +
      ` WHERE SYSTEM_TABLE_SCHEMA = ${L} AND SYSTEM_TABLE_NAME = ${F}\n ORDER BY LAST_SOURCE_UPDATE_TIMESTAMP DESC\n FETCH FIRST 20 ROWS ONLY` });
    return out;
  }

  if (!t.name) {
    out.push({ label: 'All objects', sql:
      `SELECT OBJNAME, OBJTYPE, OBJATTRIBUTE, OBJTEXT, OBJSIZE, LAST_USED_TIMESTAMP\n` +
      `  FROM TABLE(QSYS2.OBJECT_STATISTICS(${L}, '*ALL'))\n ORDER BY OBJTYPE, OBJNAME` });
    out.push({ label: 'Tables, views and physical files', sql:
      `SELECT SYSTEM_TABLE_NAME, TABLE_NAME, TABLE_TYPE, TABLE_TEXT\n  FROM QSYS2.SYSTABLES\n` +
      ` WHERE SYSTEM_TABLE_SCHEMA = ${L} AND FILE_TYPE = 'D'\n ORDER BY SYSTEM_TABLE_NAME` });
    out.push({ label: 'Source members', sql:
      `SELECT SYSTEM_TABLE_NAME AS SOURCE_FILE, SYSTEM_TABLE_MEMBER AS MEMBER, SOURCE_TYPE, NUMBER_ROWS AS LINES,\n` +
      `       LAST_SOURCE_UPDATE_TIMESTAMP\n  FROM QSYS2.SYSPARTITIONSTAT\n` +
      ` WHERE SYSTEM_TABLE_SCHEMA = ${L} AND SOURCE_TYPE IS NOT NULL\n ORDER BY 1, 2` });
    out.push({ label: 'Largest objects', sql:
      `SELECT OBJNAME, OBJTYPE, OBJSIZE, OBJTEXT\n  FROM TABLE(QSYS2.OBJECT_STATISTICS(${L}, '*ALL'))\n ORDER BY OBJSIZE DESC\n FETCH FIRST 50 ROWS ONLY` });
    return out;
  }

  const name = up(t.name), N = sqlString(name), type = up(t.type) || '*ALL';
  if (type === '*FILE') {
    out.push({ label: 'First 100 rows', sql: `SELECT *\n  FROM ${lib}/${name}\n FETCH FIRST 100 ROWS ONLY` });
    out.push({ label: 'Row count', sql: `SELECT COUNT(*) AS ROW_COUNT\n  FROM ${lib}/${name}` });
    out.push({ label: 'Columns', sql:
      `SELECT SYSTEM_COLUMN_NAME, COLUMN_NAME, DATA_TYPE, LENGTH, NUMERIC_SCALE, IS_NULLABLE, COLUMN_TEXT\n` +
      `  FROM QSYS2.SYSCOLUMNS\n WHERE SYSTEM_TABLE_SCHEMA = ${L} AND SYSTEM_TABLE_NAME = ${N}\n ORDER BY ORDINAL_POSITION` });
    out.push({ label: 'Members and size', sql:
      `SELECT SYSTEM_TABLE_MEMBER AS MEMBER, NUMBER_ROWS, NUMBER_DELETED_ROWS, DATA_SIZE, LAST_CHANGE_TIMESTAMP\n` +
      `  FROM QSYS2.SYSPARTITIONSTAT\n WHERE SYSTEM_TABLE_SCHEMA = ${L} AND SYSTEM_TABLE_NAME = ${N}` });
  }
  if (type === '*PGM' || type === '*SRVPGM' || type === '*MODULE') {
    const P = `PROGRAM_LIBRARY = ${L} AND PROGRAM_NAME = ${N}`;
    if (type !== '*MODULE') {
      out.push({ label: 'Program information', sql: `SELECT *\n  FROM QSYS2.PROGRAM_INFO\n WHERE ${P}` });
      out.push({ label: 'Bound modules and their source', sql:
        `SELECT BOUND_MODULE_LIBRARY, BOUND_MODULE, MODULE_ATTRIBUTE, SOURCE_FILE_LIBRARY, SOURCE_FILE,\n` +
        `       SOURCE_FILE_MEMBER, SOURCE_CHANGE_TIMESTAMP, MODULE_CREATE_TIMESTAMP\n  FROM QSYS2.BOUND_MODULE_INFO\n WHERE ${P}` });
      out.push({ label: 'Service programs it is bound to', sql:
        `SELECT BOUND_SERVICE_PROGRAM_LIBRARY, BOUND_SERVICE_PROGRAM, BOUND_SERVICE_PROGRAM_SIGNATURE\n` +
        `  FROM QSYS2.BOUND_SRVPGM_INFO\n WHERE ${P}` });
    }
    if (type === '*SRVPGM') {
      out.push({ label: 'Exported procedures', sql:
        `SELECT SYMBOL_NAME, SYMBOL_USAGE\n  FROM QSYS2.PROGRAM_EXPORT_IMPORT_INFO\n WHERE ${P} AND OBJECT_TYPE = '*SRVPGM'\n ORDER BY SYMBOL_USAGE, SYMBOL_NAME` });
      out.push({ label: 'Programs bound to it', sql:
        `SELECT PROGRAM_LIBRARY, PROGRAM_NAME, OBJECT_TYPE\n  FROM QSYS2.BOUND_SRVPGM_INFO\n` +
        ` WHERE BOUND_SERVICE_PROGRAM = ${N} AND BOUND_SERVICE_PROGRAM_LIBRARY IN (${L}, '*LIBL')\n ORDER BY 1, 2` });
    }
  }
  if (type === '*DTAARA') {
    out.push({ label: 'Data area value', sql: `SELECT *\n  FROM QSYS2.DATA_AREA_INFO\n WHERE DATA_AREA_LIBRARY = ${L} AND DATA_AREA_NAME = ${N}` });
  }
  if (type === '*DTAQ') {
    out.push({ label: 'Data queue information', sql: `SELECT *\n  FROM QSYS2.DATA_QUEUE_INFO\n WHERE DATA_QUEUE_LIBRARY = ${L} AND DATA_QUEUE_NAME = ${N}` });
  }
  out.push({ label: 'Object details', sql:
    `SELECT *\n  FROM TABLE(QSYS2.OBJECT_STATISTICS(${L}, ${sqlString(type)}, OBJECT_NAME => ${N}))` });
  out.push({ label: 'Who has it locked?', sql:
    `SELECT JOB_NAME, LOCK_STATE, LOCK_STATUS, LOCK_SCOPE\n  FROM QSYS2.OBJECT_LOCK_INFO\n` +
    ` WHERE OBJECT_SCHEMA = ${L} AND OBJECT_NAME = ${N}${type !== '*ALL' ? ` AND OBJECT_TYPE = ${sqlString(type)}` : ''}` });
  return out;
}
