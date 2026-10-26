// Db2 for i schema browser and stored procedure caller: the SQL objects of a schema by kind, the DDL object type of
// each, procedure parameters and the CALL statement built from typed values. Pure, unit tested.

export type SchemaKind = 'table' | 'view' | 'index' | 'alias' | 'mqt' | 'physical' | 'logical' | 'procedure' | 'function' | 'trigger' | 'sequence' | 'variable';

export interface SchemaObject { kind: SchemaKind; name: string; systemName: string; on: string; detail: string; specific?: string }

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const SCHEMA = /^[A-Z$#@_][A-Z0-9$#@_]{0,127}$/;

export function checkSchema(schema: string): string {
  const s = schema.trim().replace(/^"|"$/g, '');
  const up = /^".*"$/.test(schema.trim()) ? s : s.toUpperCase();
  if (!SCHEMA.test(up.toUpperCase())) { throw new Error(`"${schema}" is not a valid schema (library) name.`); }
  return up;
}

/** One query per kind (each may fail alone on an older release without stopping the others). */
export function schemaQueries(schema: string): { kinds: SchemaKind[]; label: string; sql: string }[] {
  const s = q(checkSchema(schema));
  return [
    { kinds: ['table', 'view', 'index', 'alias', 'mqt', 'physical', 'logical'], label: 'Tables, views and files',
      sql: `SELECT TABLE_NAME AS N, SYSTEM_TABLE_NAME AS SN, TABLE_TYPE AS T, COALESCE(TABLE_TEXT, '') AS D, '' AS O FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = ${s} ORDER BY TABLE_NAME` },
    { kinds: ['index'], label: 'Indexes',
      sql: `SELECT INDEX_NAME AS N, SYSTEM_INDEX_NAME AS SN, 'I' AS T, CASE IS_UNIQUE WHEN 'U' THEN 'unique' WHEN 'P' THEN 'primary key' WHEN 'V' THEN 'unique where not null' ELSE '' END AS D, TABLE_NAME AS O FROM QSYS2.SYSINDEXES WHERE INDEX_SCHEMA = ${s} ORDER BY INDEX_NAME` },
    { kinds: ['procedure', 'function'], label: 'Procedures and functions',
      sql: `SELECT ROUTINE_NAME AS N, SPECIFIC_NAME AS SN, CASE ROUTINE_TYPE WHEN 'PROCEDURE' THEN 'R' ELSE 'F' END AS T, ` +
        `TRIM(COALESCE(ROUTINE_BODY, '')) || CASE WHEN EXTERNAL_NAME IS NOT NULL THEN ' ' || EXTERNAL_NAME ELSE '' END AS D, '' AS O FROM QSYS2.SYSROUTINES WHERE ROUTINE_SCHEMA = ${s} ORDER BY ROUTINE_NAME` },
    { kinds: ['trigger'], label: 'Triggers',
      sql: `SELECT TRIGGER_NAME AS N, TRIGGER_NAME AS SN, 'G' AS T, TRIM(COALESCE(ACTION_TIMING, '')) || ' ' || TRIM(COALESCE(EVENT_MANIPULATION, '')) AS D, EVENT_OBJECT_TABLE AS O FROM QSYS2.SYSTRIGGERS WHERE TRIGGER_SCHEMA = ${s} ORDER BY TRIGGER_NAME` },
    { kinds: ['sequence'], label: 'Sequences',
      sql: `SELECT SEQUENCE_NAME AS N, SEQUENCE_NAME AS SN, 'S' AS T, COALESCE(DATA_TYPE, '') AS D, '' AS O FROM QSYS2.SYSSEQUENCES WHERE SEQUENCE_SCHEMA = ${s} ORDER BY SEQUENCE_NAME` },
    { kinds: ['variable'], label: 'Global variables',
      sql: `SELECT VARIABLE_NAME AS N, VARIABLE_NAME AS SN, 'GV' AS T, COALESCE(DATA_TYPE, '') AS D, '' AS O FROM QSYS2.SYSVARIABLES WHERE VARIABLE_SCHEMA = ${s} ORDER BY VARIABLE_NAME` },
  ];
}

const TYPE_KIND: Record<string, SchemaKind> = { T: 'table', V: 'view', A: 'alias', M: 'mqt', P: 'physical', L: 'logical', I: 'index', R: 'procedure', F: 'function', G: 'trigger', S: 'sequence', GV: 'variable' };

export function toSchemaObject(r: Record<string, unknown>): SchemaObject | undefined {
  const s = (k: string) => String(r[k] ?? '').trim();
  const kind = TYPE_KIND[s('T')];
  if (!kind || !s('N')) { return undefined; }
  return { kind, name: s('N'), systemName: s('SN'), on: s('O'), detail: s('D'), specific: kind === 'procedure' || kind === 'function' ? s('SN') : undefined };
}

export const KIND_LABEL: Record<SchemaKind, string> = {
  table: 'Table', view: 'View', index: 'Index', alias: 'Alias', mqt: 'Materialized query table', physical: 'Physical file', logical: 'Logical file',
  procedure: 'Procedure', function: 'Function', trigger: 'Trigger', sequence: 'Sequence', variable: 'Global variable',
};

/** DATABASE_OBJECT_TYPE values for QSYS2.GENERATE_SQL (a logical file is generated as a view or an index). */
export function ddlTypes(kind: SchemaKind): string[] {
  switch (kind) {
    case 'table': case 'physical': case 'mqt': return ['TABLE'];
    case 'logical': return ['VIEW', 'INDEX'];
    case 'view': return ['VIEW'];
    case 'index': return ['INDEX'];
    case 'alias': return ['ALIAS'];
    case 'procedure': return ['PROCEDURE'];
    case 'function': return ['FUNCTION'];
    case 'trigger': return ['TRIGGER'];
    case 'sequence': return ['SEQUENCE'];
    case 'variable': return ['VARIABLE'];
  }
}

export function countByKind(list: SchemaObject[]): [SchemaKind, number][] {
  const m = new Map<SchemaKind, number>();
  for (const o of list) { m.set(o.kind, (m.get(o.kind) ?? 0) + 1); }
  return (Object.keys(KIND_LABEL) as SchemaKind[]).filter(k => m.has(k)).map(k => [k, m.get(k)!]);
}

// ---------------------------------------------------------------- stored procedure caller

export interface ProcParam { position: number; name: string; mode: 'IN' | 'OUT' | 'INOUT'; type: string; length?: number; precision?: number; scale?: number; hasDefault?: boolean }

export function parametersSql(schema: string, specific: string, withDefault = true): string {
  return `SELECT ORDINAL_POSITION AS P, COALESCE(PARAMETER_NAME, '') AS N, PARAMETER_MODE AS M, DATA_TYPE AS T, CHARACTER_MAXIMUM_LENGTH AS L, ` +
    `NUMERIC_PRECISION AS PR, NUMERIC_SCALE AS SC, ${withDefault ? 'CASE WHEN DEFAULT IS NULL THEN 0 ELSE 1 END' : '0'} AS DF FROM QSYS2.SYSPARMS ` +
    `WHERE SPECIFIC_SCHEMA = ${q(checkSchema(schema))} AND SPECIFIC_NAME = ${q(checkSchema(specific))} ORDER BY ORDINAL_POSITION`;
}

export function toProcParam(r: Record<string, unknown>): ProcParam {
  const n = (k: string) => (r[k] === null || r[k] === undefined || r[k] === '' ? undefined : Number(r[k]));
  const mode = String(r.M ?? 'IN').trim().toUpperCase();
  return { position: Number(r.P) || 0, name: String(r.N ?? '').trim(), mode: mode === 'OUT' || mode === 'INOUT' ? mode : 'IN', type: String(r.T ?? '').trim().toUpperCase(),
    length: n('L'), precision: n('PR'), scale: n('SC'), hasDefault: Number(r.DF) === 1 };
}

const NUMERIC = /^(SMALLINT|INTEGER|INT|BIGINT|DECIMAL|NUMERIC|DECFLOAT|DOUBLE|REAL|FLOAT|DOUBLE PRECISION)$/;

/** SQL data type of a parameter, as written in a declaration. */
export function sqlTypeOf(p: ProcParam): string {
  const t = p.type;
  if (/^(DECIMAL|NUMERIC)$/.test(t)) { return `${t}(${p.precision ?? 15}, ${p.scale ?? 0})`; }
  if (/^(CHARACTER|CHAR)$/.test(t)) { return `CHAR(${p.length ?? 1})`; }
  if (/^(CHARACTER VARYING|VARCHAR)$/.test(t)) { return `VARCHAR(${p.length ?? 256})`; }
  if (/^(GRAPHIC|VARGRAPHIC|BINARY|VARBINARY)$/.test(t)) { return `${t}(${p.length ?? 1})`; }
  if (/^(CLOB|BLOB|DBCLOB)$/.test(t)) { return `${t}(${p.length ?? 1048576})`; }
  if (/^TIMESTAMP/.test(t)) { return 'TIMESTAMP'; }
  return t || 'VARCHAR(256)';
}

/** SQL text for one value typed by the user: NULL and DEFAULT as keywords, numbers checked, everything else quoted. */
export function paramLiteral(p: ProcParam, value: string): string {
  const v = value.trim();
  if (/^null$/i.test(v)) { return 'NULL'; }
  if (/^default$/i.test(v)) {
    if (!p.hasDefault) { throw new Error(`Parameter ${p.name || p.position} has no default value.`); }
    return 'DEFAULT';
  }
  if (NUMERIC.test(p.type)) {
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) { throw new Error(`Parameter ${p.name || p.position} (${p.type}) needs a number, not "${value}".`); }
    return v;
  }
  if (p.length !== undefined && /CHAR|GRAPHIC/.test(p.type) && value.length > p.length) {
    throw new Error(`Parameter ${p.name || p.position} takes at most ${p.length} characters (you typed ${value.length}).`);
  }
  return q(value);
}

/** Global variable used as the argument of an OUT or INOUT parameter (in QTEMP of the SQL job). */
export function outVariable(p: ProcParam): string { return `QTEMP.VX_CALL_P${p.position}`; }

export interface CallPlan { setup: string[]; call: string; read?: string; cleanup: string[] }

/**
 * The statements that call a procedure: IN values as literals, OUT and INOUT through global variables in QTEMP (created
 * before, read after and dropped at the end), so the values come back without host variables.
 */
export function callPlan(schema: string, name: string, params: ProcParam[], values: Record<number, string>, quoteName = false): CallPlan {
  const setup: string[] = []; const cleanup: string[] = [];
  const args = params.map(p => {
    const v = values[p.position] ?? '';
    if (p.mode === 'IN') { return v === '' && p.hasDefault ? 'DEFAULT' : paramLiteral(p, v); }
    const gv = outVariable(p);
    setup.push(`CREATE OR REPLACE VARIABLE ${gv} ${sqlTypeOf(p)}`);
    if (p.mode === 'INOUT' && v !== '') { setup.push(`SET ${gv} = ${paramLiteral(p, v)}`); }
    cleanup.push(`DROP VARIABLE ${gv}`);
    return gv;
  });
  const qn = (s: string) => (quoteName ? `"${s.replace(/"/g, '""')}"` : s);
  const outs = params.filter(p => p.mode !== 'IN');
  return {
    setup,
    call: `CALL ${qn(checkSchema(schema))}.${qn(name)}(${args.join(', ')})`,
    read: outs.length ? `SELECT ${outs.map(p => `${outVariable(p)} AS "${(p.name || `P${p.position}`).replace(/"/g, '')}"`).join(', ')} FROM SYSIBM.SYSDUMMY1` : undefined,
    cleanup,
  };
}
