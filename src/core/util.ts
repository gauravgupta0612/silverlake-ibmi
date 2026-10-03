// Pure helpers (no vscode import) so they can be unit-tested with plain Node.

/** IBM i object / library / member name: 1-10 chars, starts with A-Z, $, #, @. */
const SYSTEM_NAME = /^[A-Z$#@][A-Z0-9$#@_.]{0,9}$/;

export function isValidSystemName(name: string): boolean {
  return SYSTEM_NAME.test(name.toUpperCase());
}

export function assertSystemName(name: string, what = 'name'): string {
  const upper = name.trim().toUpperCase();
  if (!isValidSystemName(upper)) {
    throw new Error(`"${name}" is not a valid IBM i ${what} (1–10 characters, starting with a letter, $, # or @).`);
  }
  return upper;
}

/** Escape a value for use inside an SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Escape a value for use inside a CL quoted string. */
export function clString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Escape a string for use inside double quotes in a POSIX / QSH shell. */
export function shDoubleQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** Escape a string for use inside single quotes in a POSIX / QSH shell. */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** QSYS.LIB IFS path of a source member. */
export function memberPath(lib: string, file: string, member: string): string {
  return `/QSYS.LIB/${lib.toUpperCase()}.LIB/${file.toUpperCase()}.FILE/${member.toUpperCase()}.MBR`;
}

export interface MemberParts {
  library: string;
  file: string;
  member: string;
  extension: string;
}

/** Parse "/LIB/FILE/MEMBER.EXT" (the path part of a vanthrex-member URI). */
export function parseMemberPath(path: string): MemberParts {
  const parts = path.replace(/^\/+/, '').split('/');
  if (parts.length !== 3) {
    throw new Error(`Invalid member path "${path}". Expected /LIBRARY/FILE/MEMBER.TYPE`);
  }
  const [library, file, memberWithExt] = parts;
  const dot = memberWithExt.lastIndexOf('.');
  const member = dot > 0 ? memberWithExt.substring(0, dot) : memberWithExt;
  const extension = dot > 0 ? memberWithExt.substring(dot + 1) : '';
  return {
    library: library.toUpperCase(),
    file: file.toUpperCase(),
    member: member.toUpperCase(),
    extension: extension.toLowerCase(),
  };
}

export interface CompileVariables {
  LIB?: string;
  OBJLIB?: string;
  SRCFILE?: string;
  NAME?: string;
  EXT?: string;
  FULLPATH?: string;
  CURLIB?: string;
  USER?: string;
}

/** Replace &VAR placeholders. Longer names first so &OBJLIB isn't eaten by &LIB. */
export function substituteVariables(template: string, vars: CompileVariables): string {
  const keys = Object.keys(vars).sort((a, b) => b.length - a.length) as (keyof CompileVariables)[];
  let out = template;
  for (const key of keys) {
    const value = vars[key];
    if (value === undefined) { continue; }
    out = out.replace(new RegExp(`&${key}\\b`, 'g'), value);
  }
  return out;
}

/** Turn an IFS file name into a valid object name (e.g. "my_pgm.pgm.rpgle" -> "MY_PGM"). */
export function objectNameFromFile(fileName: string): string {
  const base = fileName.split('/').pop() || fileName;
  const name = base.split('.')[0].toUpperCase().replace(/[^A-Z0-9$#@_]/g, '');
  return name.substring(0, 10);
}

/** Pick sensible SQL statement under the cursor: statements separated by ';' (ignores ';' in strings/comments). */
export function splitSqlStatements(text: string): { sql: string; start: number; end: number }[] {
  const out: { sql: string; start: number; end: number }[] = [];
  let i = 0;
  let start = 0;
  let inString = false;
  let inQuoted = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (!inString && !inQuoted && c === '-' && n === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (!inString && !inQuoted && c === '/' && n === '*') {
      const endC = text.indexOf('*/', i + 2);
      i = endC === -1 ? text.length : endC + 2;
      continue;
    }
    if (c === "'" && !inQuoted) { inString = !inString; }
    else if (c === '"' && !inString) { inQuoted = !inQuoted; }
    else if (c === ';' && !inString && !inQuoted) {
      out.push({ sql: text.substring(start, i), start, end: i });
      start = i + 1;
    }
    i++;
  }
  out.push({ sql: text.substring(start), start, end: text.length });
  return out
    .map(s => {
      const lead = s.sql.length - s.sql.trimStart().length;
      return { sql: s.sql.trim(), start: s.start + lead, end: s.end };
    })
    .filter(s => stripSqlComments(s.sql).trim().length > 0);
}

export function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export function statementAtOffset(text: string, offset: number): string | undefined {
  const statements = splitSqlStatements(text);
  const hit = statements.find(s => offset >= s.start && offset <= s.end + 1);
  return (hit ?? statements[statements.length - 1])?.sql;
}

/** True when a statement looks destructive enough to warrant a confirmation. */
export function isDestructiveSql(sql: string): boolean {
  const s = stripSqlComments(sql).trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^(DROP|TRUNCATE)\b/.test(s)) { return true; }
  if (/^(DELETE|UPDATE)\b/.test(s) && !/\bWHERE\b/.test(s)) { return true; }
  return false;
}

/** Convert rows to CSV (RFC 4180 quoting). */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) { return ''; }
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(esc).join(',')];
  for (const row of rows) {
    lines.push(columns.map(c => esc(row[c])).join(','));
  }
  return lines.join('\r\n');
}
