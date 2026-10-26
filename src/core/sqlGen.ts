// SQL generators: CREATE TABLE for a CSV file (types guessed from the data), a JSON_TABLE query for a JSON sample, and
// searching spooled files for a text. Pure (no vscode import), unit tested.

export interface GuessedColumn { name: string; header: string; type: string; nullable: boolean }

const RESERVED = new Set(['SELECT', 'FROM', 'WHERE', 'ORDER', 'GROUP', 'TABLE', 'USER', 'DATE', 'TIME', 'TIMESTAMP', 'VALUE', 'VALUES', 'KEY', 'INDEX', 'COUNT', 'YEAR', 'MONTH', 'DAY', 'NAME', 'TYPE', 'TEXT', 'DESC', 'ASC', 'BY', 'TO', 'AS', 'ON', 'IN', 'IS', 'OR', 'AND', 'NOT', 'NULL', 'LEVEL', 'POSITION', 'CURRENT', 'END', 'CASE', 'WHEN', 'THEN', 'ELSE']);

/** A column name valid in Db2 for i: letters, digits and _, starting with a letter, unique, not a reserved word. */
export function sqlColumnName(header: string, taken: Set<string>): string {
  let n = header.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'COL';
  if (!/^[A-Z]/.test(n)) { n = 'C_' + n; }
  if (RESERVED.has(n)) { n += '_'; }
  n = n.slice(0, 120);
  let x = n; let i = 2;
  while (taken.has(x)) { x = `${n}_${i++}`; }
  taken.add(x);
  return x;
}

const INT = /^[-+]?\d+$/;
const DEC = /^[-+]?(\d+[.,]\d+|\d+[.,]|[.,]\d+)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}[ T-]\d{2}[:.]\d{2}([:.]\d{2}([.,]\d{1,12})?)?$/;

/** Column types from the values: integers, decimals (precision and scale from the widest values), ISO dates and timestamps, text. */
export function guessColumns(header: string[], rows: string[][]): GuessedColumn[] {
  const taken = new Set<string>();
  return header.map((h, i) => {
    const vals = rows.map(r => (r[i] ?? '').trim());
    const filled = vals.filter(v => v !== '');
    const nullable = filled.length < vals.length;
    let type: string;
    if (!filled.length) { type = 'VARCHAR(50)'; }
    else if (filled.every(v => INT.test(v)) && !filled.some(v => /^[-+]?0\d/.test(v))) {
      const digits = Math.max(...filled.map(v => v.replace(/^[-+]/, '').length));
      type = digits <= 9 ? 'INTEGER' : digits <= 18 ? 'BIGINT' : `DECIMAL(${Math.min(63, digits)}, 0)`;
    } else if (filled.every(v => INT.test(v) || DEC.test(v)) && !filled.some(v => /^[-+]?0\d/.test(v))) {
      const parts = filled.map(v => v.replace(/^[-+]/, '').split(/[.,]/));
      const scale = Math.max(...parts.map(p => (p[1] ?? '').length)); const ints = Math.max(...parts.map(p => p[0].length));
      type = `DECIMAL(${Math.min(63, Math.max(ints + scale, scale + 1) + 2)}, ${scale})`;
    } else if (filled.every(v => ISO_DATE.test(v))) { type = 'DATE'; }
    else if (filled.every(v => ISO_TS.test(v))) { type = 'TIMESTAMP'; }
    else {
      const max = Math.max(...filled.map(v => v.length));
      const len = max <= 10 ? max + 5 : Math.ceil((max * 1.25) / 10) * 10;
      type = `VARCHAR(${Math.min(32000, Math.max(10, len))})`;
    }
    return { name: sqlColumnName(h || `COL${i + 1}`, taken), header: h, type, nullable };
  });
}

export function createTableSql(schema: string, table: string, cols: GuessedColumn[], label?: string): string {
  const lines = cols.map(c => `  ${c.name.padEnd(Math.max(...cols.map(x => x.name.length)) + 1)}${c.type}${c.nullable ? '' : ' NOT NULL'}`);
  const out = [`CREATE TABLE ${schema}.${table} (`, lines.join(',\n'), ');'];
  if (label) { out.push(`LABEL ON TABLE ${schema}.${table} IS '${label.replace(/'/g, "''").slice(0, 50)}';`); }
  const labelled = cols.filter(c => c.header && c.header.toUpperCase() !== c.name);
  if (labelled.length) { out.push(`LABEL ON COLUMN ${schema}.${table} (\n${labelled.map(c => `  ${c.name} TEXT IS '${c.header.replace(/'/g, "''").slice(0, 50)}'`).join(',\n')}\n);`); }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- JSON_TABLE

interface Shape { kind: 'string' | 'int' | 'dec' | 'bool' | 'null' | 'object' | 'array'; len: number; scale: number; digits: number; fields?: Map<string, Shape>; item?: Shape }
const none = (): Shape => ({ kind: 'null', len: 0, scale: 0, digits: 0 });
function merge(a: Shape, b: Shape): Shape {
  if (a.kind === 'null') { return b; } if (b.kind === 'null') { return a; }
  const o: Shape = { ...a, len: Math.max(a.len, b.len), scale: Math.max(a.scale, b.scale), digits: Math.max(a.digits, b.digits) };
  if (a.kind !== b.kind) { o.kind = (['int', 'dec'].includes(a.kind) && ['int', 'dec'].includes(b.kind)) ? 'dec' : 'string'; return o; }
  if (a.kind === 'object') { const f = new Map(a.fields); for (const [k, v] of b.fields ?? []) { f.set(k, f.has(k) ? merge(f.get(k)!, v) : v); } o.fields = f; }
  if (a.kind === 'array') { o.item = merge(a.item ?? none(), b.item ?? none()); }
  return o;
}
function shape(v: unknown): Shape {
  if (v === null || v === undefined) { return none(); }
  if (typeof v === 'string') { return { ...none(), kind: 'string', len: v.length }; }
  if (typeof v === 'boolean') { return { ...none(), kind: 'bool', len: 5 }; }
  if (typeof v === 'number') { const sc = Number.isInteger(v) ? 0 : (String(v).split('.')[1] ?? '').length; return { ...none(), kind: sc ? 'dec' : 'int', scale: sc, digits: String(Math.trunc(Math.abs(v))).length }; }
  if (Array.isArray(v)) { return { ...none(), kind: 'array', item: v.reduce<Shape>((a, x) => merge(a, shape(x)), none()) }; }
  const f = new Map<string, Shape>(); for (const [k, x] of Object.entries(v as Record<string, unknown>)) { f.set(k, shape(x)); }
  return { ...none(), kind: 'object', fields: f };
}
const sqlType = (s: Shape) => s.kind === 'int' ? (s.digits > 9 ? 'BIGINT' : 'INTEGER') : s.kind === 'dec' ? `DECIMAL(${Math.min(63, Math.max(15, s.digits + s.scale + 2))}, ${Math.max(2, s.scale)})`
  : s.kind === 'bool' ? 'VARCHAR(5)' : `VARCHAR(${s.len <= 20 ? 50 : s.len <= 80 ? 100 : s.len <= 200 ? 256 : Math.min(32000, Math.ceil(s.len * 2 / 100) * 100)})`;
const quoteKey = (k: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `"${k.replace(/"/g, '\\"')}"`);

function columns(fields: Map<string, Shape>, path: string, taken: Set<string>, prefix: string, indent: string): string[] {
  const out: string[] = [];
  for (const [k, v] of fields) {
    const p = `${path}.${quoteKey(k)}`;
    if (v.kind === 'object') { out.push(...columns(v.fields ?? new Map(), p, taken, `${prefix}${k}_`, indent)); continue; }
    if (v.kind === 'array') {
      const it = v.item ?? none();
      if (it.kind === 'object') {
        out.push(`${indent}NESTED PATH '${p}[*]' COLUMNS(`, columns(it.fields ?? new Map(), 'lax $', taken, `${k}_`, indent + '  ').join(',\n'), `${indent})`);
      } else { out.push(`${indent}${sqlColumnName(prefix + k, taken)} ${sqlType(it.kind === 'array' ? { ...none(), kind: 'string', len: 100 } : it)} PATH '${p}[0]' -- first element; NESTED PATH '${p}[*]' for all`); }
      continue;
    }
    out.push(`${indent}${sqlColumnName(prefix + k, taken)} ${sqlType(v)} PATH '${p}'`);
  }
  return out;
}

/** A SELECT over JSON_TABLE for a JSON sample: one column per value, NESTED PATH for arrays of objects. */
export function jsonTableSql(json: string, source: { kind: 'ifs'; path: string } | { kind: 'column'; table: string; column: string } | { kind: 'variable' }): string {
  let data: unknown;
  try { data = JSON.parse(json); } catch (e) { throw new Error(`The text is not valid JSON: ${(e as Error).message}`); }
  const root = shape(data);
  const taken = new Set<string>();
  let rootPath = 'lax $'; let fields: Map<string, Shape>;
  if (root.kind === 'array' && root.item?.kind === 'object') { rootPath = 'lax $[*]'; fields = root.item.fields ?? new Map(); }
  else if (root.kind === 'object') { fields = root.fields ?? new Map(); }
  else { throw new Error('The JSON must be an object or an array of objects.'); }
  const cols = columns(fields, 'lax $', taken, '', '      ');
  // Commas between column definitions (not after an opening NESTED PATH line).
  const joined = cols.map((l, i) => {
    const next = cols[i + 1];
    if (l.trimEnd().endsWith('(') || next === undefined || /^\s*\)/.test(next)) { return l; }
    return l.includes(' -- ') ? l.replace(' -- ', ', -- ') : l + ',';
  }).join('\n').replace(/\n(\s*)\)\n(\s+)(?=\S)/g, '\n$1),\n$2');
  const src = source.kind === 'ifs' ? `GET_CLOB_FROM_FILE('${source.path.replace(/'/g, "''")}')` : source.kind === 'column' ? `T.${source.column}` : ':json_text';
  const from = source.kind === 'column' ? `${source.table} T,\n       ` : '';
  return `SELECT J.*\n  FROM ${from}JSON_TABLE(\n    ${src},\n    '${rootPath}'\n    COLUMNS(\n${joined}\n    )\n  ) AS J;\n` +
    (source.kind === 'ifs' ? '-- GET_CLOB_FROM_FILE needs commitment control (or run it with COMMIT = *CHG).\n' : '');
}

// ---------------------------------------------------------------- spooled file search

export function spooledFilesSql(user: string, days: number, max = 200): string {
  const u = user.trim().toUpperCase();
  if (!/^[A-Z$#@*][A-Z0-9$#@_.]{0,9}$/.test(u)) { throw new Error(`"${user}" is not a valid user.`); }
  return `SELECT JOB_NAME AS J, SPOOLED_FILE_NAME AS F, FILE_NUMBER AS N, COALESCE(USER_DATA, '') AS UD, VARCHAR_FORMAT(CREATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS C, TOTAL_PAGES AS P ` +
    `FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE ${u === '*ALL' ? '' : `USER_NAME = '${u}' AND `}CREATE_TIMESTAMP >= CURRENT TIMESTAMP - ${Math.max(1, Math.min(90, Math.floor(days)))} DAYS ` +
    `ORDER BY CREATE_TIMESTAMP DESC FETCH FIRST ${Math.max(1, Math.min(1000, Math.floor(max)))} ROWS ONLY`;
}

export function spoolSearchSql(job: string, file: string, number: number, text: string): string {
  if (!/^\d{6}\/[A-Z0-9$#@_.]{1,10}\/[A-Z0-9$#@_.]{1,10}$/i.test(job) || !/^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/i.test(file)) { throw new Error('Invalid spooled file.'); }
  const t = text.trim().toUpperCase().replace(/'/g, "''").replace(/[\\%_]/g, m => '\\' + m);
  if (!t) { throw new Error('Type the text to find.'); }
  return `SELECT ORDINAL_POSITION AS L, SPOOLED_DATA AS D FROM TABLE(SYSTOOLS.SPOOLED_FILE_DATA(JOB_NAME => '${job.toUpperCase()}', SPOOLED_FILE_NAME => '${file.toUpperCase()}', SPOOLED_FILE_NUMBER => ${Math.floor(number)})) X ` +
    `WHERE UPPER(SPOOLED_DATA) LIKE '%${t}%' ESCAPE '\\' FETCH FIRST 20 ROWS ONLY`;
}

// ---------------------------------------------------------------- comment folding

/** Blocks of 3 or more comment lines (RPG // and * in column 7, CL /* *\/, SQL --) to fold as comments. */
export function commentBlocks(text: string, language: string, min = 3): { start: number; end: number }[] {
  const lines = text.split(/\r?\n/);
  const isComment = (l: string) => {
    const t = l.trim();
    if (!t) { return false; }
    if (language === 'rpgle') { return t.startsWith('//') || /^.{5}[ A-Za-z]\*/.test(l) || /^\*\s/.test(l.slice(0, 2)) && !/^\*\*/.test(l); }
    if (language === 'cl') { return /^\/\*.*\*\/$/.test(t) || /^\/\*/.test(t); }
    if (language === 'dds') { return /^.{5}A\*/i.test(l); }
    return t.startsWith('--');
  };
  const out: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && isComment(lines[i])) { if (start < 0) { start = i; } continue; }
    if (start >= 0 && i - start >= min) { out.push({ start, end: i - 1 }); }
    start = -1;
  }
  return out;
}
