// RPG code generators: data structures from a JSON sample (for DATA-INTO / DATA-GEN) and an embedded-SQL cursor loop
// for any query. Pure functions (no vscode import), unit tested.

import { rpgType, TableColumn } from './rpgFromTable';

const RESERVED = new Set(['DIM', 'LIKE', 'LIKEDS', 'CONST', 'VALUE', 'OPTIONS', 'POS', 'INZ', 'END-DS', 'QUALIFIED', 'TEMPLATE', 'SELECT', 'IF', 'FOR', 'DO', 'ON', 'IN', 'BY', 'TO']);

/** An RPG-valid name for a JSON key: letters, digits and _; not starting with a digit; not a keyword. */
export function rpgName(key: string, taken?: Set<string>): string {
  let n = key.replace(/[^A-Za-z0-9_$#@]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'field';
  if (/^[0-9]/.test(n)) { n = 'n' + n; }
  if (RESERVED.has(n.toUpperCase())) { n += '_'; }
  n = n.slice(0, 4096);
  if (taken) {
    let x = n; let i = 2;
    while (taken.has(x.toLowerCase())) { x = `${n}_${i++}`; }
    taken.add(x.toLowerCase()); n = x;
  }
  return n;
}

interface Shape { kind: 'string' | 'int' | 'dec' | 'bool' | 'null' | 'object' | 'array'; maxLen: number; decimals: number; big: boolean; fields?: Map<string, Shape>; item?: Shape; maxItems: number }

const empty = (): Shape => ({ kind: 'null', maxLen: 0, decimals: 0, big: false, maxItems: 0 });

function merge(a: Shape, b: Shape): Shape {
  if (a.kind === 'null') { return b; }
  if (b.kind === 'null') { return a; }
  const out: Shape = { ...a, maxLen: Math.max(a.maxLen, b.maxLen), decimals: Math.max(a.decimals, b.decimals), big: a.big || b.big, maxItems: Math.max(a.maxItems, b.maxItems) };
  if (a.kind !== b.kind) {
    if ((a.kind === 'int' || a.kind === 'dec') && (b.kind === 'int' || b.kind === 'dec')) { out.kind = 'dec'; return out; }
    out.kind = 'string'; out.maxLen = Math.max(out.maxLen, 20); return out;
  }
  if (a.kind === 'object') {
    const f = new Map(a.fields);
    for (const [k, v] of b.fields ?? []) { f.set(k, f.has(k) ? merge(f.get(k)!, v) : v); }
    out.fields = f;
  }
  if (a.kind === 'array') { out.item = merge(a.item ?? empty(), b.item ?? empty()); }
  return out;
}

function shapeOf(v: unknown): Shape {
  const s = empty();
  if (v === null || v === undefined) { return s; }
  if (typeof v === 'string') { return { ...s, kind: 'string', maxLen: v.length }; }
  if (typeof v === 'boolean') { return { ...s, kind: 'bool' }; }
  if (typeof v === 'number') {
    const dec = Number.isInteger(v) ? 0 : (String(v).split('.')[1] ?? '').length;
    return { ...s, kind: dec ? 'dec' : 'int', decimals: dec, big: Math.abs(v) > 2147483647, maxLen: String(Math.trunc(Math.abs(v))).length };
  }
  if (Array.isArray(v)) { return { ...s, kind: 'array', maxItems: v.length, item: v.reduce<Shape>((acc, x) => merge(acc, shapeOf(x)), empty()) }; }
  const fields = new Map<string, Shape>();
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) { fields.set(k, shapeOf(x)); }
  return { ...s, kind: 'object', fields };
}

function scalarType(s: Shape): string {
  switch (s.kind) {
    case 'string': { const n = s.maxLen <= 10 ? 20 : s.maxLen <= 40 ? 50 : s.maxLen <= 90 ? 100 : s.maxLen <= 240 ? 256 : Math.min(65535, Math.ceil((s.maxLen * 2) / 1024) * 1024); return `varchar(${n})`; }
    case 'int': return s.big ? 'int(20)' : 'int(10)';
    case 'dec': return `packed(${Math.min(63, Math.max(15, s.maxLen + Math.max(2, s.decimals) + 2))}:${Math.max(2, s.decimals)})`;
    case 'bool': return 'ind';
    default: return 'varchar(100)';
  }
}

export interface JsonRpgOptions { root?: string; dim?: number; countPrefix?: string }

/** Data structures for a JSON sample, ready for DATA-INTO with YAJLINTO (or DATA-GEN with YAJLDTAGEN). */
export function jsonToRpg(json: string, opts: JsonRpgOptions = {}): string {
  let data: unknown;
  try { data = JSON.parse(json); } catch (e) { throw new Error(`The text is not valid JSON: ${(e as Error).message}`); }
  const dim = Math.max(1, Math.min(32767, opts.dim ?? 100));
  const prefix = opts.countPrefix ?? 'num_';
  const templates: string[] = [];
  const used = new Set<string>();
  const renamed: string[] = [];
  const rootShape = shapeOf(data);
  const rootName = rpgName(opts.root || 'doc', used);

  // Data structure body lines for an object shape; nested objects become templates first.
  const body = (fields: Map<string, Shape>, indent: string): string[] => {
    const lines: string[] = []; const local = new Set<string>();
    for (const [key, sh] of fields) {
      const name = rpgName(key, local);
      if (name !== key) { renamed.push(`${key} → ${name}`); }
      const note = name !== key ? ` // JSON "${key}"` : '';
      if (sh.kind === 'object') {
        lines.push(`${indent}${name} likeds(${template(key, sh)});${note}`);
      } else if (sh.kind === 'array') {
        const n = Math.max(dim, sh.maxItems);
        lines.push(`${indent}${rpgName(prefix + key, local)} int(10); // how many ${name} were read (countprefix)`);
        const it = sh.item ?? empty();
        if (it.kind === 'object') { lines.push(`${indent}${name} likeds(${template(key + '_item', it)}) dim(${n});${note}`); }
        else { lines.push(`${indent}${name} ${scalarType(it.kind === 'array' ? empty() : it)} dim(${n});${note}${it.kind === 'array' ? ' // nested arrays: adjust by hand' : ''}`); }
      } else {
        lines.push(`${indent}${name} ${scalarType(sh)};${note}${sh.kind === 'null' ? ' // only null in the sample: check the type' : ''}`);
      }
    }
    return lines;
  };
  const template = (key: string, sh: Shape): string => {
    const name = rpgName(key + '_t', used);
    const lines = [`dcl-ds ${name} qualified template;`, ...body(sh.fields ?? new Map(), '  '), 'end-ds;'];
    templates.push(lines.join('\n'));
    return name;
  };

  const out: string[] = ['// ---- Generated by Vanthrex for IBM i from a JSON sample. Review the lengths and the dim() sizes. ----', ''];
  let main: string[]; let target: string;
  if (rootShape.kind === 'object') {
    main = [`dcl-ds ${rootName} qualified inz;`, ...body(rootShape.fields ?? new Map(), '  '), 'end-ds;'];
    target = rootName;
  } else if (rootShape.kind === 'array') {
    const it = rootShape.item ?? empty();
    const n = Math.max(dim, rootShape.maxItems);
    main = it.kind === 'object'
      ? [`dcl-ds ${rootName} likeds(${template(rootName + '_item', it)}) dim(${n}) inz;`]
      : [`dcl-s ${rootName} ${scalarType(it)} dim(${n});`];
    main.push(`dcl-s ${rpgName(prefix + rootName, used)} int(10); // how many elements were read`);
    target = rootName;
  } else {
    throw new Error('The JSON must be an object or an array.');
  }
  out.push(...templates, ...(templates.length ? [''] : []), ...main, '');
  const countOpt = rootShape.kind === 'array' ? '' : ` countprefix=${prefix}`;
  out.push(
    '// Read: JSON text (or doc=file with an IFS path) into the structure. YAJLINTO comes with the YAJL port (Scott Klement).',
    `// data-into ${target} %data(json: 'doc=string case=any allowmissing=yes allowextra=yes${countOpt}')`,
    `//                    %parser('YAJLINTO');`,
    ...(rootShape.kind === 'array' ? [`// ${rpgName(prefix + rootName, new Set())} = %elem(${target}); // or count with %lookup, since a top-level array has no count field`] : []),
    '// Write the structure back as JSON (DATA-GEN: IBM i 7.3 with PTFs or later):',
    `// data-gen ${target} %data(json: 'doc=string countprefix=${prefix}') %gen('YAJLDTAGEN');`,
  );
  if (renamed.length) { out.push('', `// Renamed to valid RPG names (DATA-INTO matches names with case=any, so map these by hand or rename in the JSON): ${renamed.slice(0, 20).join(', ')}`); }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- query → RPG

/** Column descriptions from DSPFFD output (QADSPFFD), for a query when the catalog does not show QTEMP. */
export function ffdToColumns(rows: Record<string, unknown>[]): TableColumn[] {
  const s = (r: Record<string, unknown>, k: string) => String(r[k] ?? '').trim();
  return rows.map(r => {
    const t = s(r, 'WHFLDT').toUpperCase(); const digits = Number(r.WHFLDD ?? 0) || 0; const dec = Number(r.WHFLDP ?? 0) || 0; const len = Number(r.WHFLDB ?? 0) || 0;
    const varying = s(r, 'WHVARL') === 'Y';
    const type = t === 'A' ? (varying ? 'VARCHAR' : 'CHARACTER') : t === 'P' ? 'DECIMAL' : t === 'S' ? 'NUMERIC'
      : t === 'B' ? (digits <= 4 ? 'SMALLINT' : digits <= 9 ? 'INTEGER' : 'BIGINT') : t === 'F' ? (len <= 4 ? 'REAL' : 'DOUBLE')
      : t === 'L' ? 'DATE' : t === 'T' ? 'TIME' : t === 'Z' ? 'TIMESTAMP' : /^[GJOE]$/.test(t) ? (varying ? 'VARGRAPHIC' : 'GRAPHIC') : 'CHARACTER';
    const name = s(r, 'WHALIS') || s(r, 'WHFLDE');
    return { name, system: s(r, 'WHFLDE'), type, length: /^(DECIMAL|NUMERIC)$/.test(type) ? digits : varying ? Math.max(1, len - 2) : len, scale: dec, nullable: s(r, 'WHNULL') === 'Y', text: s(r, 'WHFTXT') };
  });
}

/** A cursor loop with a multi-row FETCH for a query (SQLRPGLE). */
export function queryToRpg(sql: string, cols: TableColumn[], name = 'row', rows = 100): string {
  if (!cols.length) { throw new Error('The query returns no columns.'); }
  const query = sql.trim().replace(/;\s*$/, '');
  const taken = new Set<string>();
  const ids = cols.map(c => rpgName((c.system || c.name).toLowerCase(), taken));
  const pad = Math.max(...ids.map(i => i.length)) + 2;
  const tpl = rpgName(`${name}_t`);
  const nullable = cols.some(c => c.nullable);
  const n = Math.max(1, Math.min(32767, rows));
  return [
    '// ---- Generated by Vanthrex for IBM i from a query. Review before use (SQLRPGLE source). ----',
    `dcl-ds ${tpl} qualified template;`,
    ...cols.map((c, i) => `  ${ids[i].padEnd(pad)}${rpgType(c)};${c.name !== ids[i].toUpperCase() ? ` // ${c.name}` : ''}${c.text ? ` ${c.name !== ids[i].toUpperCase() ? '·' : '//'} ${c.text}` : ''}`),
    'end-ds;',
    '',
    `dcl-ds ${name}s likeds(${tpl}) dim(${n});`,
    ...(nullable ? [`dcl-ds ${name}Nulls qualified dim(${n}); // null indicators of each row (-1 = null)`, `  ind int(5) dim(${cols.length});`, 'end-ds;'] : []),
    'dcl-s fetched int(10);',
    'dcl-s i int(10);',
    '',
    'exec sql declare c1 cursor for',
    ...query.split(/\r?\n/).map(l => `  ${l}`),
    '  for read only;',
    'exec sql open c1;',
    'dou fetched < %elem(' + name + 's) or sqlcode <> 0;',
    `  exec sql fetch next from c1 for ${n} rows into :${name}s${nullable ? ` :${name}Nulls` : ''};`,
    '  exec sql get diagnostics :fetched = ROW_COUNT;',
    '  for i = 1 to fetched;',
    `    // ... use ${name}s(i).${ids[0]}`,
    '  endfor;',
    'enddo;',
    'exec sql close c1;',
    '',
  ].join('\n');
}
