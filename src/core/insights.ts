// Pure helpers for the 0.6 "insights" features: index advice, impact map, data compare and
// message help. No vscode import, unit tested.

// ---------------------------------------------------------------- index advisor

/** A short, valid system name for a new index: TABLE (up to 7 chars) + "IX" + n. */
export function indexName(table: string, n = 1): string {
  const base = table.toUpperCase().replace(/[^A-Z0-9$#@_]/g, '').slice(0, 10 - 2 - String(n).length);
  return `${base}IX${n}`;
}

/** Quote an SQL column name when it is not an ordinary upper-case identifier. */
export function sqlIdent(name: string): string {
  const n = name.trim();
  return /^[A-Z$#@][A-Z0-9_$#@]*$/.test(n) ? n : `"${n.replace(/^"|"$/g, '').replace(/"/g, '""')}"`;
}

/** CREATE INDEX statement for one row of QSYS2.SYSIXADV. */
export function indexStatement(schema: string, table: string, keyColumns: string, indexType: string, name: string): string {
  const keys = keyColumns.split(',').map(k => k.trim()).filter(Boolean).map(sqlIdent);
  if (!keys.length) { throw new Error('The advice has no key columns.'); }
  const evi = /EVI|VECTOR/i.test(indexType);
  return `CREATE ${evi ? 'ENCODED VECTOR ' : ''}INDEX ${sqlIdent(schema)}/${sqlIdent(name)} ON ${sqlIdent(schema)}/${sqlIdent(table)} (${keys.join(', ')})`;
}

// ---------------------------------------------------------------- data compare

export interface DataCompareSpec { libA: string; libB: string; table: string; keys: string[]; columns: string[] }

/** System naming (the SQL engines run with naming=system), so qualify with '/'. */
function qualified(lib: string, table: string): string { return `${sqlIdent(lib)}/${sqlIdent(table)}`; }

/** SQL for rows whose keys exist only in A (kind 'onlyA'), only in B ('onlyB'), or rows that differ ('changed'). */
export function dataCompareSql(s: DataCompareSpec, kind: 'onlyA' | 'onlyB' | 'changed' | 'count', limit = 200): string {
  if (!s.keys.length) { throw new Error('Pick at least one key column.'); }
  const a = qualified(s.libA, s.table); const b = qualified(s.libB, s.table);
  const keys = s.keys.map(sqlIdent);
  const on = keys.map(k => `A.${k} = B.${k}`).join(' AND ');
  const others = s.columns.map(sqlIdent).filter(c => !keys.includes(c));
  const differs = others.length ? others.map(c => `A.${c} IS DISTINCT FROM B.${c}`).join(' OR ') : '1 = 0';
  const fetch = ` FETCH FIRST ${Math.max(1, Math.floor(limit))} ROWS ONLY`;
  switch (kind) {
    case 'onlyA': return `SELECT A.* FROM ${a} A EXCEPTION JOIN ${b} B ON ${on} ORDER BY ${keys.map(k => `A.${k}`).join(', ')}${fetch}`;
    case 'onlyB': return `SELECT B.* FROM ${b} B EXCEPTION JOIN ${a} A ON ${on} ORDER BY ${keys.map(k => `B.${k}`).join(', ')}${fetch}`;
    case 'changed': return `SELECT ${[...keys.map(k => `A.${k}`), ...others.flatMap(c => [`A.${c} AS "A_${c.replace(/"/g, '')}"`, `B.${c} AS "B_${c.replace(/"/g, '')}"`])].join(', ')} ` +
      `FROM ${a} A INNER JOIN ${b} B ON ${on} WHERE ${differs} ORDER BY ${keys.map(k => `A.${k}`).join(', ')}${fetch}`;
    case 'count': return `SELECT ` +
      `(SELECT COUNT(*) FROM ${a}) AS ROWS_A, (SELECT COUNT(*) FROM ${b}) AS ROWS_B, ` +
      `(SELECT COUNT(*) FROM ${a} A EXCEPTION JOIN ${b} B ON ${on}) AS ONLY_A, ` +
      `(SELECT COUNT(*) FROM ${b} B EXCEPTION JOIN ${a} A ON ${on}) AS ONLY_B, ` +
      `(SELECT COUNT(*) FROM ${a} A INNER JOIN ${b} B ON ${on} WHERE ${differs}) AS CHANGED FROM SYSIBM.SYSDUMMY1`;
  }
}

/** Which non-key columns differ in one "changed" row (A_x vs B_x). */
export function changedColumns(row: Record<string, unknown>, columns: string[], keys: string[]): string[] {
  const norm = (v: unknown) => (v === null || v === undefined ? null : String(v).trimEnd());
  return columns.filter(c => !keys.includes(c)).filter(c => norm(row[`A_${c}`]) !== norm(row[`B_${c}`]));
}

// ---------------------------------------------------------------- message help

export const MESSAGE_ID = /\b(CP[ACDEFIX]|MCH|RN[FQX]|SQL|CEE|CPF|LNR|LBE|TCP|CAE|PWS|IWS|SQ)[0-9A-F]{4}\b/;

/** IBM message file that holds a message ID. */
export function messageFileFor(id: string): { library: string; file: string } | undefined {
  const p = id.toUpperCase().slice(0, 3);
  if (/^CP[ACDEFIX]$/.test(p) || p === 'MCH' || p === 'TCP') { return { library: 'QSYS', file: 'QCPFMSG' }; }
  if (p === 'RNQ' || p === 'RNX') { return { library: 'QSYS', file: 'QRNXMSG' }; }
  if (p === 'RNF') { return { library: 'QDEVTOOLS', file: 'QRPGLEMSG' }; }
  if (p === 'SQL' || id.toUpperCase().startsWith('SQ')) { return { library: 'QSYS', file: 'QSQLMSG' }; }
  if (p === 'CEE') { return { library: 'QSYS', file: 'QCEEMSG' }; }
  if (p === 'LNR' || p === 'LBE') { return { library: 'QSYS', file: 'QLNRMSG' }; }
  return undefined;
}

/** Practical hints for messages developers meet every day (plain words, what to do next). */
export const MESSAGE_HINTS: Record<string, string> = {
  CPF9801: 'An object was not found. Check the library list (and the current library) of the job, and that the object exists with the right type.',
  CPF9810: 'A library was not found. Check the spelling and that the library exists on this system.',
  CPF9802: 'Not authorized to the object. Ask the owner or security officer for *USE (or more) authority.',
  CPF9803: 'The object could not be allocated — another job has it locked. Use "Who has this object locked?".',
  CPF4131: 'Level check: the file changed since the program was compiled. Recompile the program (and every program using the file).',
  CPF5027: 'A record is locked by another job. Find the holder with "Who has this object locked?", or add a lock wait / retry.',
  CPF5026: 'Duplicate key: the record has a key that already exists in a unique keyed file.',
  CPF4128: 'The file was not opened: often a missing member, override (OVRDBF) or authority. Read the previous messages in the job log.',
  CPF5029: 'Data mapping error on a record: a numeric field contains non-numeric data (decimal data error).',
  CPF0864: 'End of file reached on a CL RCVF. Monitor for it (MONMSG CPF0864) to end the loop.',
  CPF9898: 'A generic escape message sent by an application. Its text is the real error — read it and the message before it.',
  CPF9999: 'A function check: an unmonitored error ended the program. The message just before it in the job log is the real cause.',
  CPD0172: 'Parameters passed on CALL do not match those required — check the number and types of the PARM values.',
  MCH1211: 'Attempt to divide by zero. Guard the division or check the divisor.',
  MCH0603: 'Array index or substring out of range. Check the index / %SUBST start and length.',
  MCH1202: 'Decimal data error: a packed or zoned field contains invalid data. Initialise the field or fix the data in the file.',
  MCH3601: 'Pointer not set: a parameter, based field or pointer was used before it was set (often a missing *NOPASS check).',
  MCH1210: 'Receiver value too small: the result does not fit in the target field. Make the field bigger or check the calculation.',
  RNX1216: 'Error on a file operation (record lock or I/O). The message before it names the file and the real reason.',
  RNQ1216: 'Error on a file operation (record lock or I/O). The message before it names the file and the real reason.',
  RNX0100: 'Length or start position out of range for a string operation (%SUBST / %REPLACE).',
  RNQ0100: 'Length or start position out of range for a string operation (%SUBST / %REPLACE).',
  RNX0102: 'Divide by zero in RPG. Guard the division.',
  RNQ0102: 'Divide by zero in RPG. Guard the division.',
  RNX0103: 'The target field is too small for the result of an EVAL. Make it bigger or check the calculation.',
  RNQ0103: 'The target field is too small for the result of an EVAL. Make it bigger or check the calculation.',
  RNX0121: 'Array index out of range. Check the index against the array size.',
  RNQ0121: 'Array index out of range. Check the index against the array size.',
  RNX0907: 'Decimal data error in RPG: a numeric field contains invalid data.',
  RNQ0907: 'Decimal data error in RPG: a numeric field contains invalid data.',
  SQL0204: 'An SQL object was not found. Check the schema / library list (system naming uses *LIBL) and the name.',
  SQL0206: 'A column name is not valid for the tables in the statement. Check the spelling (and quotes for lower-case names).',
  SQL0803: 'Duplicate key on INSERT/UPDATE: a unique index or primary key already has this value.',
  SQL0901: 'SQL system error. Look at the previous messages in the job log for the real cause.',
  SQL0913: 'The row or object is locked by another job. Retry, or find the holder with "Who has this object locked?".',
  SQL7008: 'The table is not journaled but the statement runs under commitment control. Journal the file or use COMMIT(*NONE).',
};

export function messageHint(id: string): string | undefined {
  return MESSAGE_HINTS[id.toUpperCase()];
}

export interface JobLogEntry { id: string; type: string; severity: number; text: string; help?: string; program?: string; time?: string }
export interface JobLogFinding { id: string; count: number; severity: number; text: string; hint?: string; help?: string; program?: string; first?: string }

/** Group a job log's errors (diagnostic / escape, or severity ≥ 30) by message ID, worst and earliest first. */
export function analyzeJobLog(entries: JobLogEntry[]): { findings: JobLogFinding[]; rootCause?: JobLogFinding } {
  const bad = entries.filter(e => /ESCAPE|DIAGNOSTIC/i.test(e.type) || e.severity >= 30);
  const groups = new Map<string, JobLogFinding>();
  for (const e of bad) {
    const key = e.id || e.text.slice(0, 40);
    const g = groups.get(key);
    if (g) { g.count++; continue; }
    groups.set(key, { id: e.id, count: 1, severity: e.severity, text: e.text, help: e.help, program: e.program, first: e.time, hint: e.id ? messageHint(e.id) : undefined });
  }
  const findings = [...groups.values()].sort((a, b) => b.severity - a.severity || String(a.first ?? '').localeCompare(String(b.first ?? '')));
  // The first escape message that is not a generic function check is usually the real cause.
  const firstEscape = bad.find(e => /ESCAPE/i.test(e.type) && !/^(CPF9999|CPF9898|MCH2004)$/.test(e.id)) ?? bad[0];
  const rootCause = firstEscape ? groups.get(firstEscape.id || firstEscape.text.slice(0, 40)) : undefined;
  return { findings, rootCause };
}
