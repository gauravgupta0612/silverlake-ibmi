// Pure helpers (no vscode import) so they can be unit-tested with plain Node.

/**
 * One pass over the statement: comments removed, string literals emptied, quoted identifiers
 * unquoted (so "QSYS2"."QCMDEXC" is seen as QSYS2.QCMDEXC). Comment markers inside strings and
 * quotes inside comments are handled correctly. Returns undefined when a ';' separates statements.
 */
export function normaliseForCheck(sql: string): { text: string; statements: number } {
  let out = '';
  let statements = 0;
  let sawCode = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === '-' && n === '-') { const nl = sql.indexOf('\n', i); i = nl === -1 ? sql.length : nl; out += ' '; continue; }
    if (c === '/' && n === '*') { const e = sql.indexOf('*/', i + 2); i = e === -1 ? sql.length : e + 2; out += ' '; continue; }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; } if (sql[j] === "'") { break; } j++; }
      out += "''"; i = j + 1; sawCode = true; continue;
    }
    if (c === '"') {
      let j = i + 1; let ident = '';
      while (j < sql.length) { if (sql[j] === '"' && sql[j + 1] === '"') { ident += '"'; j += 2; continue; } if (sql[j] === '"') { break; } ident += sql[j]; j++; }
      out += ident; i = j + 1; sawCode = true; continue;
    }
    if (c === ';') { if (sawCode) { statements++; } sawCode = false; out += ' '; i++; continue; }
    if (!/\s/.test(c)) { sawCode = true; }
    out += c; i++;
  }
  if (sawCode) { statements++; }
  return { text: out.trim().toUpperCase().replace(/\s+/g, ' '), statements };
}

// Inside a single SELECT only a data-change table reference (FROM FINAL TABLE (INSERT …)) can write.
const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|GRANT|REVOKE)\b/;

/** Functions that look like queries but change something on the system (run commands, write files, send mail…). */
const SIDE_EFFECT_FUNCTIONS = /\b(QCMDEXC|GENERATE_SPREADSHEET|GENERATE_PDF|IFS_WRITE\w*|HTTP_?(POST|PUT|PATCH|DELETE)\w*|SEND_\w+|END_\w+|CHANGE_\w+|REMOVE_\w+|ADD_\w+|DELETE_\w+|RESET_\w+|CLEAR_\w+|CREATE_\w+|DROP_\w+|SET_\w+|LPRINTF|SYSTEM_\w*COMMAND\w*|SUBMIT_\w+)\s*\(/;

/**
 * True when a statement only reads data: a single SELECT / WITH / VALUES statement with no
 * data-change table references (FINAL TABLE (INSERT…)) and no functions known to have side effects.
 * This is a safety net, not a sandbox: user-defined functions can still do anything, so callers
 * that run model-written SQL also ask the user first.
 */
export function isReadOnlySql(sql: string): boolean {
  const { text, statements } = normaliseForCheck(sql);
  if (statements !== 1) { return false; }
  if (!/^(SELECT|WITH|VALUES|\()/.test(text)) { return false; }
  if (WRITE_KEYWORDS.test(text)) { return false; }
  if (SIDE_EFFECT_FUNCTIONS.test(text)) { return false; }
  return true;
}

/** Add FETCH FIRST n ROWS ONLY when a query has no row limit, before any trailing isolation / read-only / optimize clauses. */
export function limitRows(sql: string, max: number): string {
  const s = sql.trim().replace(/;+\s*$/, '');
  const { text } = normaliseForCheck(s);
  if (/\bFETCH\s+(FIRST|NEXT)\b|\bLIMIT\s+\d+/.test(text) || /^VALUES\b/.test(text)) { return s; }
  const clause = ` FETCH FIRST ${Math.max(1, Math.floor(max))} ROWS ONLY`;
  // Trailing clauses that must come after FETCH FIRST (only matched outside literals: check on the normalised text).
  const tail = /\s+((?:FOR\s+(?:READ|FETCH)\s+ONLY|OPTIMIZE\s+FOR\s+\d+\s+ROWS?|WITH\s+(?:NC|UR|CS|RS|RR)|SKIP\s+LOCKED\s+DATA|USE\s+AND\s+KEEP\s+\w+\s+LOCKS)(?:\s+|$))+$/i;
  const m = text.match(tail) ? s.match(tail) : null;
  return m && m.index !== undefined ? s.substring(0, m.index) + clause + s.substring(m.index) : s + clause;
}
