// Modernization generators: an SQL procedure or function over an RPG / CL program or an exported procedure (callable
// from SQL, Java, Python, Node), DDS physical / logical file source to SQL DDL, the CRUD statements of a table, the
// column list for SELECT *, named constants for literals, and change-log entries. Pure (no vscode import), unit tested.

// ---------------------------------------------------------------- RPG / CL types → SQL

/** The SQL type for an RPG free-form type (char(10), packed(7:2), int(10), date…) or a CL type; undefined when unknown (LIKE, LIKEDS, pointer). */
export function sqlTypeForRpg(type: string): string | undefined {
  const t = type.trim().toLowerCase().replace(/\s+/g, '');
  let m: RegExpExecArray | null;
  if ((m = /^char\((\d+)\)/.exec(t))) { return `CHAR(${m[1]})`; }
  if ((m = /^varchar\((\d+)(?::\d+)?\)/.exec(t))) { return `VARCHAR(${m[1]})`; }
  if ((m = /^graph\((\d+)\)/.exec(t))) { return `GRAPHIC(${m[1]})`; }
  if ((m = /^vargraph\((\d+)\)/.exec(t))) { return `VARGRAPHIC(${m[1]})`; }
  if ((m = /^ucs2\((\d+)\)/.exec(t))) { return `GRAPHIC(${m[1]}) CCSID 13488`; }
  if ((m = /^varucs2\((\d+)\)/.exec(t))) { return `VARGRAPHIC(${m[1]}) CCSID 13488`; }
  if ((m = /^packed\((\d+)(?::(\d+))?\)/.exec(t))) { return `DECIMAL(${m[1]}, ${m[2] ?? 0})`; }
  if ((m = /^zoned\((\d+)(?::(\d+))?\)/.exec(t))) { return `NUMERIC(${m[1]}, ${m[2] ?? 0})`; }
  if ((m = /^bindec\((\d+)(?::(\d+))?\)/.exec(t))) { return +m[1] <= 4 ? 'SMALLINT' : +m[1] <= 9 ? 'INTEGER' : 'BIGINT'; }
  if ((m = /^(int|uns)\((3|5|10|20)\)/.exec(t))) { return { 3: 'SMALLINT', 5: 'SMALLINT', 10: 'INTEGER', 20: 'BIGINT' }[m[2]]; }
  if ((m = /^float\((4|8)\)/.exec(t))) { return m[1] === '4' ? 'REAL' : 'DOUBLE'; }
  if (/^ind\b/.test(t)) { return 'CHAR(1)'; }
  if (/^date\b/.test(t)) { return 'DATE'; }
  if (/^time\b/.test(t)) { return 'TIME'; }
  if (/^timestamp\b/.test(t)) { return 'TIMESTAMP'; }
  return undefined;
}

export interface WrapParam { name: string; type: string; mode?: 'IN' | 'INOUT' | 'OUT' }
export interface WrapTarget { schema: string; name: string; library: string; object: string; procedure?: string; language: 'RPGLE' | 'CL' | 'COBOL' | 'C'; params: WrapParam[]; returns?: string; text?: string }

/** Parameters of a dcl-pi / dcl-pr body ("name char(10) const;" lines), with IN for CONST / VALUE and INOUT otherwise. */
export function piParams(body: string): WrapParam[] {
  return body.split(';').map(x => x.replace(/\/\/.*$/gm, '').trim().replace(/\s+/g, ' ')).filter(x => x && !/^end-p[ir]/i.test(x) && !/^dcl-p[ir]/i.test(x))
    .map(x => { const m = /^([\w$#@]+)\s+(.+)$/.exec(x); return m ? { name: m[1], type: m[2], mode: /\b(const|value)\b/i.test(m[2]) ? 'IN' as const : 'INOUT' as const } : undefined; })
    .filter((x): x is { name: string; type: string; mode: 'IN' | 'INOUT' } => !!x);
}

/** The program entry (dcl-pi without a dcl-proc around it) and the exported procedures of a free-form source. */
export function entryPoints(source: string): { name: string; kind: 'program' | 'procedure'; params: WrapParam[]; returns?: string }[] {
  const out: { name: string; kind: 'program' | 'procedure'; params: WrapParam[]; returns?: string }[] = [];
  const text = source.replace(/\/\/.*$/gm, '');
  const procs = [...text.matchAll(/dcl-proc\s+([\w$#@]+)([^;]*);([\s\S]*?)end-proc/gi)];
  let outside = text;
  for (const p of procs) {
    outside = outside.replace(p[0], '');
    if (!/\bexport\b/i.test(p[2])) { continue; }
    const pi = /dcl-pi\s+([\w$#@*]+)([^;]*);([\s\S]*?)end-pi/i.exec(p[3]);
    out.push({ name: p[1], kind: 'procedure', params: pi ? piParams(pi[3]) : [], returns: pi?.[2].trim() || undefined });
  }
  const main = /dcl-pi\s+([\w$#@*]+)([^;]*);([\s\S]*?)end-pi/i.exec(outside);
  if (main) { out.unshift({ name: main[1].toUpperCase() === '*N' ? '' : main[1], kind: 'program', params: piParams(main[3]) }); }
  return out;
}

const sqlName = (n: string) => n.toUpperCase().replace(/[^A-Z0-9_$#@]/g, '_').replace(/^([^A-Z$#@_])/, 'P_$1');

/** CREATE PROCEDURE (or FUNCTION when the procedure returns a value) with EXTERNAL NAME over the program. */
export function wrapperSql(t: WrapTarget): { sql: string; unknown: string[] } {
  const unknown: string[] = [];
  const parms = t.params.map(p => {
    const ty = sqlTypeForRpg(p.type);
    if (!ty) { unknown.push(`${p.name} ${p.type}`); }
    return `  ${t.returns ? '' : `${p.mode ?? 'INOUT'} `}${sqlName(p.name)} ${ty ?? 'VARCHAR(1000) /* TODO: type of ' + p.type.replace(/\*\//g, '') + ' */'}`;
  });
  const ext = t.procedure ? `'${t.library}/${t.object}(${t.procedure.toUpperCase()})'` : `${t.library}/${t.object}`;
  const ret = t.returns ? sqlTypeForRpg(t.returns) : undefined;
  if (t.returns && !ret) { unknown.push(`returns ${t.returns}`); }
  const head = t.returns ? `CREATE OR REPLACE FUNCTION ${t.schema}.${t.name} (` : `CREATE OR REPLACE PROCEDURE ${t.schema}.${t.name} (`;
  const lines = [head, parms.join(',\n'), ')'];
  if (t.returns) { lines.push(`  RETURNS ${ret ?? 'VARCHAR(1000)'}`); }
  lines.push(`  LANGUAGE ${t.language}`, `  SPECIFIC ${t.schema}.${t.name.slice(0, 18)}`, '  NOT DETERMINISTIC', t.returns ? '  READS SQL DATA' : '  MODIFIES SQL DATA');
  if (!t.returns) { lines.push('  DYNAMIC RESULT SETS 0'); }
  lines.push('  PARAMETER STYLE GENERAL', `  EXTERNAL NAME ${ext};`);
  if (t.text) { lines.push('', `COMMENT ON ${t.returns ? 'FUNCTION' : 'PROCEDURE'} ${t.schema}.${t.name} IS '${t.text.replace(/'/g, "''").slice(0, 2000)}';`); }
  const call = t.returns ? `VALUES ${t.schema}.${t.name}(${t.params.map(() => '?').join(', ')});` : `CALL ${t.schema}.${t.name}(${t.params.map(() => '?').join(', ')});`;
  lines.push('', `-- ${call}`);
  return { sql: lines.join('\n') + '\n', unknown };
}

// ---------------------------------------------------------------- DDS → SQL DDL

export interface DdsField { name: string; ref: boolean; length: number; type: string; decimals: number | undefined; keywords: string; text?: string; colhdg?: string; alias?: string }
export interface DdsFile { fileKeywords: string; format: string; pfile?: string; fields: DdsField[]; keys: { name: string; descend: boolean }[]; selects: string[]; unique: boolean; text?: string }

const kw = (all: string, name: string) => { const m = new RegExp(`\\b${name}\\(`, 'i').exec(all); if (!m) { return undefined; } let d = 0; let j = m.index + m[0].length - 1; const b = j; for (; j < all.length; j++) { if (all[j] === "'") { const k = all.indexOf("'", j + 1); j = k < 0 ? all.length : k; continue; } if (all[j] === '(') { d++; } else if (all[j] === ')') { d--; if (!d) { break; } } } return all.slice(b + 1, j).trim(); };
const unquote = (s?: string) => s?.replace(/^'|'$/g, '').replace(/''/g, "'").trim();

export function parseDds(source: string): DdsFile {
  const f: DdsFile = { fileKeywords: '', format: '', fields: [], keys: [], selects: [], unique: false };
  let last: { keywords: string } | undefined;
  for (const raw of source.split(/\r?\n/)) {
    const l = raw.padEnd(80);
    if (!/^.{5}[Aa ]/.test(l) || l[6] === '*') { continue; }
    const type = l[16].toUpperCase(); const name = l.slice(18, 28).trim(); const keywords = l.slice(44, 80).trim();
    if (type === 'R') { f.format = name; f.pfile = kw(keywords, 'PFILE')?.split(/\s+/)[0]; last = { keywords: '' }; continue; }
    if (type === 'K') { f.keys.push({ name, descend: /\bDESCEND\b/i.test(keywords) }); last = undefined; continue; }
    if (type === 'S' || type === 'O') { f.selects.push(`${type === 'S' ? 'select' : 'omit'} ${name} ${keywords}`.trim()); last = undefined; continue; }
    if (name) {
      const len = l.slice(29, 34).trim(); const dec = l.slice(35, 37).trim();
      const fld: DdsField = { name, ref: l[28].toUpperCase() === 'R', length: Number(len) || 0, type: l[34].trim().toUpperCase(), decimals: dec ? Number(dec) : undefined, keywords };
      f.fields.push(fld); last = fld; continue;
    }
    if (keywords) { if (last) { last.keywords += ' ' + keywords; } else if (!f.format) { f.fileKeywords += ' ' + keywords; } }
  }
  f.unique = /\bUNIQUE\b/i.test(f.fileKeywords);
  f.text = unquote(kw(f.fileKeywords, 'TEXT'));
  for (const x of f.fields) { x.text = unquote(kw(x.keywords, 'TEXT')); x.colhdg = kw(x.keywords, 'COLHDG')?.match(/'([^']*)'/g)?.map(s => unquote(s) ?? '').map((h, i, a) => (i < a.length - 1 ? h.padEnd(20) : h)).join(''); x.alias = kw(x.keywords, 'ALIAS'); }
  return f;
}

function ddsSqlType(x: DdsField): string | undefined {
  if (x.ref && !x.length) { return undefined; }
  const t = x.type || (x.decimals !== undefined ? 'S' : 'A');
  const varlen = /\bVARLEN\b/i.test(x.keywords);
  switch (t) {
    case 'A': return `${varlen ? 'VARCHAR' : 'CHAR'}(${x.length})`;
    case 'P': return `DECIMAL(${x.length}, ${x.decimals ?? 0})`;
    case 'S': return `NUMERIC(${x.length}, ${x.decimals ?? 0})`;
    case 'B': return x.length <= 4 ? 'SMALLINT' : x.length <= 9 ? 'INTEGER' : 'BIGINT';
    case 'F': return x.length <= 7 ? 'REAL' : 'DOUBLE';
    case 'L': return 'DATE'; case 'T': return 'TIME'; case 'Z': return 'TIMESTAMP';
    case 'G': case 'O': case 'E': case 'J': return `${varlen ? 'VARGRAPHIC' : 'GRAPHIC'}(${x.length})`;
    case 'H': return `${varlen ? 'VARBINARY' : 'BINARY'}(${x.length})`;
    default: return undefined;
  }
}

/** CREATE TABLE for a DDS physical file, CREATE INDEX (or a VIEW for select / omit) for a logical file. */
export function ddsToSql(source: string, library: string, file: string): { sql: string; notes: string[] } {
  const d = parseDds(source); const notes: string[] = [];
  const q = (s: string) => s.replace(/'/g, "''");
  const out: string[] = [];
  if (d.pfile) {
    const on = `${library}.${d.pfile}`;
    if (d.selects.length) {
      notes.push(`Select / omit (${d.selects.join('; ')}) became a VIEW: add the WHERE yourself; a view has no key — keep an INDEX for the key.`);
      const cols = d.fields.length ? d.fields.map(x => x.name).join(', ') : '*';
      out.push(`CREATE OR REPLACE VIEW ${library}.${file} AS\n  SELECT ${cols}\n    FROM ${on}\n    WHERE 1 = 1 /* TODO: ${q(d.selects.join(' / '))} */;`);
      if (d.keys.length) { out.push(`CREATE INDEX ${library}.${file.slice(0, 8)}IX ON ${on} (${d.keys.map(k => k.name + (k.descend ? ' DESC' : '')).join(', ')});`); }
    } else {
      if (!d.keys.length) { notes.push('No key fields: an unkeyed logical file is a VIEW.'); out.push(`CREATE OR REPLACE VIEW ${library}.${file} AS\n  SELECT ${d.fields.map(x => x.name).join(', ') || '*'}\n    FROM ${on};`); }
      else {
        out.push(`CREATE ${d.unique ? 'UNIQUE ' : ''}INDEX ${library}.${file}\n  ON ${on} (${d.keys.map(k => k.name + (k.descend ? ' DESC' : '')).join(', ')})${d.format ? `\n  RCDFMT ${d.format}` : ''}${d.fields.length ? `\n  ADD ${d.fields.filter(x => !d.keys.some(k => k.name === x.name)).map(x => x.name).join(', ')}` : ''};`);
        if (d.fields.length) { notes.push('RCDFMT … ADD keeps the record format of the logical file so RPG programs can still use it as a keyed file.'); }
      }
    }
    if (d.text) { out.push(`LABEL ON ${d.keys.length && !d.selects.length ? 'INDEX' : 'TABLE'} ${library}.${file} IS '${q(d.text).slice(0, 50)}';`); }
    return { sql: out.join('\n\n') + '\n', notes };
  }
  const cols: string[] = [];
  for (const x of d.fields) {
    const t = ddsSqlType(x);
    if (!t) { notes.push(`${x.name}: a reference field (REFFLD) with no length — type it yourself.`); }
    const nulls = /\bALWNULL\b/i.test(x.keywords) ? '' : ' NOT NULL';
    const dft = kw(x.keywords, 'DFT');
    const def = dft !== undefined ? ` DEFAULT ${dft}` : nulls ? ` DEFAULT` : '';
    cols.push(`  ${x.alias ? `${x.alias} FOR COLUMN ${x.name}` : x.name} ${t ?? 'CHAR(1) /* TODO: referenced field */'}${nulls}${def}`);
  }
  if (d.keys.length && d.unique) { cols.push(`  PRIMARY KEY (${d.keys.map(k => k.name).join(', ')})`); }
  out.push(`CREATE OR REPLACE TABLE ${library}.${file} (\n${cols.join(',\n')}\n)${d.format ? `\n  RCDFMT ${d.format}` : ''};`);
  if (d.keys.length && !d.unique) { out.push(`CREATE INDEX ${library}.${file.slice(0, 8)}K1 ON ${library}.${file} (${d.keys.map(k => k.name + (k.descend ? ' DESC' : '')).join(', ')});`); notes.push('The key of the physical file is not unique: it became an index (the table has no primary key).'); }
  if (d.keys.some(k => k.descend) && d.unique) { notes.push('DESCEND on a key of a unique file: the primary key is ascending; add an index with DESC if programs read it in that order.'); }
  if (d.text) { out.push(`LABEL ON TABLE ${library}.${file} IS '${q(d.text).slice(0, 50)}';`); }
  const texts = d.fields.filter(x => x.text); const hdgs = d.fields.filter(x => x.colhdg);
  if (hdgs.length) { out.push(`LABEL ON COLUMN ${library}.${file} (\n${hdgs.map(x => `  ${x.name} IS '${q(x.colhdg!).slice(0, 60)}'`).join(',\n')}\n);`); }
  if (texts.length) { out.push(`LABEL ON COLUMN ${library}.${file} (\n${texts.map(x => `  ${x.name} TEXT IS '${q(x.text!).slice(0, 50)}'`).join(',\n')}\n);`); }
  notes.push('Unlike DDS, SQL tables check data on write (no decimal data errors) and are faster to read. Keep RCDFMT so programs need only a recompile, not a change.');
  return { sql: out.join('\n\n') + '\n', notes };
}

// ---------------------------------------------------------------- CRUD statements

export interface TableColumn { name: string; type: string; nullable: boolean; identity?: boolean; generated?: boolean }

const hv = (c: string) => `:${c.toLowerCase().replace(/^"|"$/g, '').replace(/[^a-z0-9_]/g, '_')}`;

/** SELECT, INSERT, UPDATE, DELETE and MERGE for a table with its key, with host variables (embedded SQL) — '?' for dynamic SQL is the same with each :name replaced. */
export function crudSql(table: string, cols: TableColumn[], keys: string[]): string {
  if (!cols.length) { throw new Error(`No column found for ${table}.`); }
  const k = keys.length ? keys : [cols[0].name];
  const where = k.map(c => `${c} = ${hv(c)}`).join('\n   AND ');
  const writable = cols.filter(c => !c.identity && !c.generated);
  const nonKey = writable.filter(c => !k.includes(c.name));
  const w = Math.max(...cols.map(c => c.name.length));
  const out = [
    `-- ${table}: key ${k.join(', ')}${keys.length ? '' : ' (no key found: the first column is used — check it)'}`,
    `-- Embedded SQL uses the host variables below; for dynamic SQL replace each :name with ?.`,
    '',
    `-- Read one row`, `SELECT ${cols.map(c => c.name).join(',\n       ')}\n  INTO ${cols.map(c => hv(c.name)).join(', ')}\n  FROM ${table}\n WHERE ${where};`,
    '',
    `-- Insert`, `INSERT INTO ${table}\n  (${writable.map(c => c.name).join(', ')})\n  VALUES (${writable.map(c => hv(c.name)).join(', ')});`,
    '',
    `-- Update`, nonKey.length ? `UPDATE ${table}\n   SET ${nonKey.map(c => `${c.name.padEnd(w)} = ${hv(c.name)}`).join(',\n       ')}\n WHERE ${where};` : '-- (every column is part of the key: nothing to update)',
    '',
    `-- Delete`, `DELETE FROM ${table}\n WHERE ${where};`,
    '',
    `-- Insert or update (upsert)`,
    `MERGE INTO ${table} T\n  USING (VALUES (${writable.map(c => hv(c.name)).join(', ')}))\n    AS S (${writable.map(c => c.name).join(', ')})\n  ON ${k.map(c => `T.${c} = S.${c}`).join(' AND ')}\n${nonKey.length ? `  WHEN MATCHED THEN UPDATE SET ${nonKey.map(c => `${c.name} = S.${c.name}`).join(', ')}\n` : ''}  WHEN NOT MATCHED THEN INSERT (${writable.map(c => c.name).join(', ')})\n    VALUES (${writable.map(c => `S.${c.name}`).join(', ')});`,
    '',
    `-- Cursor over the rows`, `DECLARE C1 CURSOR FOR\n  SELECT ${cols.map(c => c.name).join(', ')}\n    FROM ${table}\n    ORDER BY ${k.join(', ')}\n    FOR READ ONLY;`,
  ];
  if (cols.some(c => c.nullable)) { out.push('', `-- Nullable: ${cols.filter(c => c.nullable).map(c => c.name).join(', ')} — use an indicator (:var :ind) or COALESCE in the SELECT.`); }
  return out.join('\n') + '\n';
}

/** Where SELECT * is in a statement (only a bare *, not COUNT(*) or T.*). */
export function starAt(sql: string): { start: number; end: number; table?: string } | undefined {
  const m = /\bSELECT\s+(?:DISTINCT\s+)?(\*)\s+FROM\s+([\w$#@."]+)/i.exec(sql);
  if (!m) { return undefined; }
  const start = m.index + m[0].indexOf('*', m[0].search(/SELECT/i) + 6);
  return { start, end: start + 1, table: m[2] };
}

// ---------------------------------------------------------------- named constants

/** A constant name for a literal: 'Customer not found' → CUSTOMER_NOT_FOUND, 100 → C_100. */
export function constantName(literal: string, taken: Set<string> = new Set()): string {
  const t = literal.replace(/^'|'$/g, '');
  let n = t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30).replace(/_+$/, '');
  if (!n || /^\d/.test(n)) { n = 'C_' + (n || 'BLANK'); }
  let x = n; let i = 2;
  while (taken.has(x.toUpperCase())) { x = `${n}_${i++}`; }
  return x;
}

/** The line after which a new DCL-C goes: after the last DCL-C, else after CTL-OPT / **FREE / the leading comments. */
export function constantInsertLine(text: string): number {
  const lines = text.split(/\r?\n/);
  let last = -1; let header = -1;
  lines.forEach((l, i) => {
    if (/^\s*dcl-c\b/i.test(l)) { last = i; }
    if (header === i - 1 && (/^\s*(\*\*free|ctl-opt\b|\/\/|$)/i.test(l) || /^.{5}[Hh]/.test(l) || /^\s*\/(copy|include)\b/i.test(l))) { header = i; }
    if (/^\s*ctl-opt\b/i.test(l) && header < i) { header = i; }
  });
  return (last >= 0 ? last : header) + 1;
}

// ---------------------------------------------------------------- change log

/** A change-log comment for the top of a source: the template with {date}, {user}, {ticket}, {text} filled, in the comment style of the language. */
export function changeLogEntry(template: string, vars: { date: string; user: string; ticket: string; text: string }, language: string, fixed = false): string {
  const body = template.replace(/\{(date|user|ticket|text)\}/g, (_, k: keyof typeof vars) => vars[k] ?? '');
  const lines = body.split('\n');
  if (language === 'cl') { return lines.map(l => `/* ${l.padEnd(70)} */`).join('\n'); }
  if (language === 'sql') { return lines.map(l => `-- ${l}`).join('\n'); }
  if (language === 'dds') { return lines.map(l => `     A* ${l}`).join('\n'); }
  if (language === 'rpgle' && fixed) { return lines.map(l => `      * ${l}`).join('\n'); }
  return lines.map(l => `// ${l}`).join('\n');
}
