// SQL text analysis for autocomplete (pure, unit tested).

export interface TableRef {
  schema?: string;
  table: string;
  alias?: string;
}

export type CompletionContext =
  | { kind: 'table'; schema?: string; prefix: string }
  | { kind: 'qualified'; qualifier: string; prefix: string }
  | { kind: 'any'; prefix: string };

const IDENT = '(?:"[^"]+"|[A-Za-z$#@_][\\w$#@]*)';
const RESERVED = new Set([
  'WHERE', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'EXCEPTION', 'SET', 'VALUES',
  'GROUP', 'ORDER', 'HAVING', 'FETCH', 'UNION', 'EXCEPT', 'INTERSECT', 'LIMIT', 'OFFSET', 'WITH', 'FOR',
  'USING', 'AS', 'SELECT', 'FROM', 'INTO', 'UPDATE', 'DELETE', 'INSERT', 'TABLE', 'AND', 'OR', 'NOT',
]);

export function unquote(id: string): string {
  return id.startsWith('"') ? id.slice(1, -1) : id.toUpperCase();
}

/** Remove comments and string contents so keywords inside them don't confuse the scanner. */
export function maskSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:[^']|'')*'/g, m => `'${' '.repeat(Math.max(0, m.length - 2))}'`);
}

/** Tables (with aliases) referenced by FROM / JOIN / UPDATE / INTO clauses. */
export function tableReferences(sql: string): TableRef[] {
  const text = maskSql(sql);
  const refs: TableRef[] = [];
  const single = new RegExp(`\\b(JOIN|UPDATE|INTO|TABLE)\\s+(${IDENT})(?:\\s*[./]\\s*(${IDENT}))?(?:\\s+(?:AS\\s+)?(${IDENT}))?`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = single.exec(text))) {
    if (m[1].toUpperCase() === 'TABLE' && /^\(/.test(text.substring(m.index + m[0].length).trim())) { continue; }
    pushRef(m[2], m[3], m[4]);
  }
  // FROM a, b x, lib.c AS y
  const from = /\bFROM\s+([\s\S]*?)(?=\b(?:WHERE|GROUP|ORDER|HAVING|FETCH|UNION|EXCEPT|INTERSECT|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|LIMIT|OFFSET|FOR|WITH)\b|;|\)|$)/gi;
  while ((m = from.exec(text))) {
    for (const part of m[1].split(',')) {
      const p = part.trim().match(new RegExp(`^(${IDENT})(?:\\s*[./]\\s*(${IDENT}))?(?:\\s+(?:AS\\s+)?(${IDENT}))?`, 'i'));
      if (p && !/^TABLE$/i.test(p[1])) { pushRef(p[1], p[2], p[3]); }
    }
  }
  return refs;

  function pushRef(a: string, b: string | undefined, alias: string | undefined): void {
    const schema = b ? unquote(a) : undefined;
    const table = unquote(b ?? a);
    if (RESERVED.has(table)) { return; }
    const al = alias && !RESERVED.has(alias.toUpperCase()) ? unquote(alias) : undefined;
    if (!refs.some(r => r.schema === schema && r.table === table && r.alias === al)) {
      refs.push({ schema, table, alias: al });
    }
  }
}

/** What should be suggested at the end of `before` (text from statement start to the cursor). */
export function completionContext(before: string): CompletionContext {
  const text = maskSql(before);
  const qualified = text.match(new RegExp(`(${IDENT})\\s*[./]\\s*([\\w$#@]*)$`));
  if (qualified) {
    const precedingKw = text.substring(0, qualified.index).match(/\b(FROM|JOIN|UPDATE|INTO|TABLE)\s*$/i)
      || /\bFROM\s+[^;]*,\s*$/i.test(text.substring(0, qualified.index));
    if (precedingKw) { return { kind: 'table', schema: unquote(qualified[1]), prefix: qualified[2] }; }
    return { kind: 'qualified', qualifier: unquote(qualified[1]), prefix: qualified[2] };
  }
  const word = text.match(/([\w$#@]*)$/);
  const prefix = word ? word[1] : '';
  const beforeWord = text.substring(0, text.length - prefix.length);
  if (/\b(FROM|JOIN|UPDATE|INTO|TABLE)\s+$/i.test(beforeWord) || /\bFROM\s+[^;()]*,\s*$/i.test(beforeWord) && !/\bWHERE\b/i.test(beforeWord.split(/\bFROM\b/i).pop() ?? '')) {
    return { kind: 'table', prefix };
  }
  return { kind: 'any', prefix };
}
