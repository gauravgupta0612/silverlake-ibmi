// A Db2 for i SQL formatter. Pure functions (no vscode import), unit tested.

const KEYWORDS = new Set(('SELECT FROM WHERE AND OR NOT IN IS NULL AS ON JOIN INNER LEFT RIGHT FULL OUTER CROSS EXCEPTION GROUP BY ORDER HAVING UNION ALL DISTINCT ' +
  'INSERT INTO VALUES UPDATE SET DELETE CREATE OR REPLACE TABLE VIEW INDEX ALTER DROP ADD COLUMN PRIMARY KEY FOREIGN REFERENCES WITH CASE WHEN THEN ELSE END ' +
  'FETCH FIRST NEXT ROWS ROW ONLY OFFSET LIMIT ASC DESC BETWEEN LIKE EXISTS ANY SOME CAST COALESCE CURRENT DATE TIME TIMESTAMP DEFAULT CALL DECLARE CURSOR FOR ' +
  'OPEN CLOSE COMMIT ROLLBACK LATERAL TABLE MERGE USING MATCHED INTERSECT EXCEPT LABEL COMMENT GRANT REVOKE TO NC CS RR RS UR DISTINCT').split(' '));

const CLAUSES = /^(SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|UNION ALL|UNION|INTERSECT|EXCEPT|FETCH FIRST|OFFSET|LIMIT|VALUES|SET|INSERT INTO|UPDATE|DELETE FROM|WITH|(LEFT |RIGHT |FULL |INNER |CROSS |EXCEPTION |LEFT OUTER |RIGHT OUTER |FULL OUTER )?JOIN|ON|MERGE INTO|USING|WHEN MATCHED|WHEN NOT MATCHED)$/;

interface Tok { t: 'word' | 'str' | 'num' | 'punct' | 'comment' | 'space'; v: string }

function tokenize(sql: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { let j = i; while (j < sql.length && /\s/.test(sql[j])) { j++; } out.push({ t: 'space', v: sql.slice(i, j) }); i = j; continue; }
    if (c === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); const e = j < 0 ? sql.length : j; out.push({ t: 'comment', v: sql.slice(i, e) }); i = e; continue; }
    if (c === '/' && sql[i + 1] === '*') { const j = sql.indexOf('*/', i + 2); const e = j < 0 ? sql.length : j + 2; out.push({ t: 'comment', v: sql.slice(i, e) }); i = e; continue; }
    if (c === "'" || c === '"') { let j = i + 1; while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; } out.push({ t: 'str', v: sql.slice(i, j + 1) }); i = j + 1; continue; }
    if (/[A-Za-z_$#@:]/.test(c)) { let j = i + 1; while (j < sql.length && /[\w$#@./*-]/.test(sql[j]) && !(sql[j] === '-' && sql[j + 1] === '-') && !(sql[j] === '*' && !/[/.]/.test(sql[j - 1]))) { j++; } out.push({ t: 'word', v: sql.slice(i, j) }); i = j; continue; }
    if (/\d/.test(c)) { let j = i + 1; while (j < sql.length && /[\d.eE]/.test(sql[j])) { j++; } out.push({ t: 'num', v: sql.slice(i, j) }); i = j; continue; }
    if ((c === '<' || c === '>' || c === '!' || c === '|') && /[=>|]/.test(sql[i + 1] ?? '')) { out.push({ t: 'punct', v: sql.slice(i, i + 2) }); i += 2; continue; }
    out.push({ t: 'punct', v: c }); i++;
  }
  return out;
}

/** Format Db2 for i SQL: keywords upper case, one clause per line, select lists and AND/OR indented. */
export function formatSql(sql: string, indent = '  '): string {
  const toks = tokenize(sql).filter(t => t.t !== 'space');
  const lines: string[] = []; let cur = ''; let depth = 0; let clause = '';
  const stack: { depth: number; clause: string }[] = [];
  const nl = (extra = 0) => { if (cur.trim()) { lines.push(cur.replace(/\s+$/, '')); } cur = indent.repeat(Math.max(0, depth + extra)); };
  const word = (t: Tok) => (t.t === 'word' && KEYWORDS.has(t.v.toUpperCase()) ? t.v.toUpperCase() : t.v);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'comment') { cur = cur.trimEnd() + (cur.trim() ? ' ' : cur) + t.v; if (t.v.startsWith('--')) { nl(); } else { cur += ' '; } continue; }
    if (t.v === ';') { cur = cur.trimEnd() + ';'; nl(); lines.push(''); depth = 0; clause = ''; continue; }
    // Multi-word clauses.
    let w = word(t); let used = 0;
    for (const n of [3, 2]) {
      const phrase = toks.slice(i, i + n).map(word).join(' ');
      if (toks.slice(i, i + n).every(x => x.t === 'word') && CLAUSES.test(phrase)) { w = phrase; used = n - 1; break; }
    }
    if (t.t === 'word' && CLAUSES.test(w)) {
      if (w === 'ON') { nl(1); } else { nl(); }
      cur += w; clause = w; i += used;
      if (/^(SELECT|SET|GROUP BY|ORDER BY)$/.test(w)) { nl(1); }
      else { cur += ' '; }
      continue;
    }
    if (t.t === 'word' && /^(AND|OR)$/.test(w) && /^(WHERE|ON|HAVING|WHEN MATCHED)$/.test(clause) && !stack.some(s => s.depth === depth && s.clause === 'BETWEEN')) {
      const prev = toks[i - 2]; if (prev && word(prev) === 'BETWEEN') { cur = `${cur.trimEnd()} ${w} `; continue; }
      nl(1); cur += `${w} `; continue;
    }
    if (t.v === '(') {
      const next = toks[i + 1];
      if (next && next.t === 'word' && /^(SELECT|WITH)$/i.test(next.v)) { cur += '('; stack.push({ depth, clause }); depth++; continue; }
      cur = cur.replace(/\s+$/, (m) => (/[\w"]$/.test(cur.trimEnd()) && !/\b(IN|AS|VALUES|EXISTS|ON|AND|OR|=)\s*$/i.test(cur) ? '' : m)) + '('; stack.push({ depth: -1, clause }); continue;
    }
    if (t.v === ')') {
      const s = stack.pop();
      if (s && s.depth >= 0) { depth = s.depth; clause = s.clause; nl(); cur += ')'; continue; }
      cur = cur.replace(/\s+$/, '') + ') '; continue;
    }
    if (t.v === ',') {
      cur = cur.replace(/\s+$/, '') + ',';
      if ((stack.length === 0 || stack[stack.length - 1].depth >= 0) && /^(SELECT|SET|GROUP BY|ORDER BY)$/.test(clause)) { nl(1); } else { cur += ' '; }
      continue;
    }
    if (t.v === '.' ) { cur = cur.replace(/\s+$/, '') + '.'; continue; }
    cur += (cur.endsWith('(') || cur.endsWith('.') ? '' : (cur.trim() && !/\s$/.test(cur) ? ' ' : '')) + (t.t === 'word' ? w : t.v) + ' ';
  }
  nl();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim() + '\n';
}
