// Safe SQL statement building for the table data editor (pure, unit tested).

export interface ColumnInfo {
  name: string;
  type: string;
  length: number;
  scale: number;
  nullable: boolean;
  text?: string;
}

const NUMERIC = new Set(['DECIMAL', 'NUMERIC', 'INTEGER', 'INT', 'SMALLINT', 'BIGINT', 'FLOAT', 'DOUBLE', 'REAL', 'DECFLOAT']);
const TEXT = new Set(['CHAR', 'CHARACTER', 'VARCHAR', 'CHARACTER VARYING', 'GRAPHIC', 'VARG', 'VARGRAPHIC', 'NCHAR', 'NVARCHAR', 'CLOB', 'DBCLOB', 'NCLOB']);
const TEMPORAL = new Set(['DATE', 'TIME', 'TIMESTMP', 'TIMESTAMP']);

export function isEditableType(type: string): boolean {
  const t = type.toUpperCase();
  return NUMERIC.has(t) || TEXT.has(t) || TEMPORAL.has(t) || t === 'BOOLEAN';
}

export function isNumericType(type: string): boolean {
  return NUMERIC.has(type.toUpperCase());
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Turn an edited cell value into an SQL literal for the column. null means SQL NULL. */
export function sqlLiteral(value: string | null, col: ColumnInfo): string {
  const t = col.type.toUpperCase();
  if (value === null) {
    if (!col.nullable) { throw new Error(`${col.name} does not allow NULL.`); }
    return 'NULL';
  }
  if (!isEditableType(t)) { throw new Error(`${col.name} (${t}) cannot be edited here.`); }
  if (NUMERIC.has(t)) {
    const v = value.trim();
    if (v === '') {
      if (col.nullable) { return 'NULL'; }
      throw new Error(`${col.name} needs a number.`);
    }
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(v)) { throw new Error(`"${value}" is not a valid number for ${col.name}.`); }
    if ((t === 'DECIMAL' || t === 'NUMERIC') && col.length > 0) {
      const [intPart, frac = ''] = v.replace(/^[-+]/, '').split('.');
      const maxInt = col.length - col.scale;
      if (intPart.replace(/^0+(?=\d)/, '').length > maxInt) { throw new Error(`${value} is too large for ${col.name} (${col.length},${col.scale}).`); }
      if (frac.length > col.scale) { throw new Error(`${value} has more than ${col.scale} decimals for ${col.name}.`); }
    }
    return v;
  }
  if (t === 'BOOLEAN') {
    const v = value.trim().toUpperCase();
    if (['TRUE', '1', 'Y', 'YES'].includes(v)) { return 'TRUE'; }
    if (['FALSE', '0', 'N', 'NO'].includes(v)) { return 'FALSE'; }
    throw new Error(`${col.name} needs TRUE or FALSE.`);
  }
  if (TEMPORAL.has(t)) {
    const v = value.trim();
    if (v === '' && col.nullable) { return 'NULL'; }
    const fn = t === 'DATE' ? 'DATE' : t === 'TIME' ? 'TIME' : 'TIMESTAMP';
    return `${fn}('${v.replace(/'/g, "''")}')`;
  }
  if ((t === 'CHAR' || t === 'CHARACTER' || t === 'VARCHAR' || t === 'GRAPHIC' || t === 'VARG') && col.length > 0 && value.length > col.length) {
    throw new Error(`${col.name} holds at most ${col.length} characters.`);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function tableName(library: string, file: string): string {
  return `${library}/${file}`;
}

export function updateStatement(table: string, rrn: number, changes: Record<string, string | null>, columns: ColumnInfo[]): string {
  const sets = Object.entries(changes).map(([name, value]) => {
    const col = columns.find(c => c.name === name);
    if (!col) { throw new Error(`Unknown column ${name}`); }
    return `${quoteIdent(name)} = ${sqlLiteral(value, col)}`;
  });
  if (!sets.length) { throw new Error('Nothing to update.'); }
  return `UPDATE ${table} T SET ${sets.join(', ')} WHERE RRN(T) = ${Math.floor(rrn)} WITH NC`;
}

export function insertStatement(table: string, values: Record<string, string | null>, columns: ColumnInfo[]): string {
  const names: string[] = [];
  const literals: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const col = columns.find(c => c.name === name);
    if (!col) { throw new Error(`Unknown column ${name}`); }
    // Left blank in the new row: let the column default apply.
    if (value === '') { continue; }
    names.push(quoteIdent(name));
    literals.push(sqlLiteral(value, col));
  }
  if (!names.length) { return `INSERT INTO ${table} DEFAULT VALUES WITH NC`; }
  return `INSERT INTO ${table} (${names.join(', ')}) VALUES (${literals.join(', ')}) WITH NC`;
}

export function deleteStatement(table: string, rrn: number): string {
  return `DELETE FROM ${table} T WHERE RRN(T) = ${Math.floor(rrn)} WITH NC`;
}
