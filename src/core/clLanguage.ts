// CL source understanding for the editor: statements (with + and - continuations), outline symbols (variables, files,
// labels, subroutines), folding of DO/SELECT/SUBR blocks and what a name refers to. Pure, unit tested.

export interface ClStatement { line: number; endLine: number; label?: string; command: string; text: string }
export type ClSymbolKind = 'program' | 'variable' | 'file' | 'label' | 'subroutine';
export interface ClSymbol { name: string; kind: ClSymbolKind; line: number; endLine: number; detail: string }

/** Remove /* comments *\/ (outside quoted strings), keeping the text length. */
function stripComments(text: string): string {
  let out = ''; let inString = false; let inComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inComment) { if (c === '*' && text[i + 1] === '/') { out += '  '; i++; inComment = false; } else { out += c === '\n' ? '\n' : ' '; } continue; }
    if (!inString && c === '/' && text[i + 1] === '*') { inComment = true; out += '  '; i++; continue; }
    if (c === "'") { inString = !inString; }
    out += c;
  }
  return out;
}

/** CL statements, continuation joined (`+` keeps leading blanks of the next line out, `-` keeps them in). */
export function clStatements(source: string): ClStatement[] {
  const lines = stripComments(source).split(/\r?\n/);
  const out: ClStatement[] = [];
  let buf = ''; let start = -1;
  for (let i = 0; i < lines.length; i++) {
    // Sequence numbers / dates of a source member are not part of the editor text; the line is the statement area.
    const line = lines[i].replace(/\s+$/, '');
    if (start < 0) { if (!line.trim()) { continue; } start = i; }
    const cont = line.match(/([+-])$/);
    if (cont) {
      buf += cont[1] === '+' ? line.slice(0, -1).replace(/\s+$/, ' ') : line.slice(0, -1);
      if (cont[1] === '+' && i + 1 < lines.length) { lines[i + 1] = lines[i + 1].replace(/^\s+/, ''); }
      continue;
    }
    buf += line;
    push(i);
  }
  if (start >= 0 && buf.trim()) { push(lines.length - 1); }
  return out;

  function push(end: number): void {
    let text = buf.trim(); buf = '';
    const s = start; start = -1;
    if (!text) { return; }
    let label: string | undefined;
    const lm = text.match(/^([A-Za-z$#@][\w$#@]{0,9})\s*:\s*/);
    if (lm) { label = lm[1].toUpperCase(); text = text.slice(lm[0].length); }
    const cm = text.match(/^([A-Za-z$#@][\w$#@]*(?:\/[A-Za-z$#@][\w$#@]*)?)/);
    out.push({ line: s, endLine: end, label, command: cm ? cm[1].toUpperCase() : '', text });
  }
}

/** Value of a keyword parameter, e.g. param('DCL VAR(&X) TYPE(*CHAR)', 'TYPE') → '*CHAR'. */
export function clParam(text: string, keyword: string): string | undefined {
  const re = new RegExp(`\\b${keyword}\\s*\\(`, 'i');
  const m = re.exec(text);
  if (!m) { return undefined; }
  let depth = 1; let inString = false; let i = m.index + m[0].length; const from = i;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "'") { inString = !inString; continue; }
    if (inString) { continue; }
    if (c === '(') { depth++; } else if (c === ')' && --depth === 0) { break; }
  }
  return text.substring(from, i).trim();
}

/** Positional words after the command (outside parentheses and strings). */
function positional(text: string): string[] {
  const words: string[] = []; let cur = ''; let depth = 0; let inString = false;
  for (const c of text) {
    if (c === "'") { inString = !inString; }
    if (!inString && c === '(') { depth++; } if (!inString && c === ')') { depth--; }
    if (!inString && depth === 0 && /\s/.test(c)) { if (cur) { words.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) { words.push(cur); }
  return words.slice(1);
}

export function clSymbols(source: string): ClSymbol[] {
  const out: ClSymbol[] = [];
  const stmts = clStatements(source);
  const subrs: { name: string; line: number }[] = [];
  for (const s of stmts) {
    if (s.label) { out.push({ name: s.label, kind: 'label', line: s.line, endLine: s.line, detail: 'label' }); }
    const t = s.text;
    switch (s.command) {
      case 'PGM': { const parm = clParam(t, 'PARM') ?? positional(t).join(' '); out.push({ name: 'PGM', kind: 'program', line: s.line, endLine: s.endLine, detail: parm ? `PARM(${parm})` : '' }); break; }
      case 'DCL': {
        const pos = positional(t);
        const name = (clParam(t, 'VAR') ?? pos[0] ?? '').toUpperCase();
        if (!name.startsWith('&')) { break; }
        const type = (clParam(t, 'TYPE') ?? (pos[1]?.startsWith('*') ? pos[1] : '') ?? '').toUpperCase();
        const len = clParam(t, 'LEN') ?? (pos[2] && /^\d/.test(pos[2]) ? pos[2].replace(/[()]/g, '') : '');
        const stg = clParam(t, 'STG'); const value = clParam(t, 'VALUE');
        out.push({ name, kind: 'variable', line: s.line, endLine: s.endLine,
          detail: [type, len ? `LEN(${len})` : '', stg ? `STG(${stg.toUpperCase()})` : '', value ? `VALUE(${value})` : ''].filter(Boolean).join(' ') });
        break;
      }
      case 'DCLF': {
        const file = (clParam(t, 'FILE') ?? positional(t)[0] ?? '').toUpperCase();
        const open = clParam(t, 'OPNID');
        if (file) { out.push({ name: file, kind: 'file', line: s.line, endLine: s.endLine, detail: open ? `OPNID(${open.toUpperCase()})` : 'declared file' }); }
        break;
      }
      case 'SUBR': {
        const name = (clParam(t, 'SUBR') ?? positional(t)[0] ?? '').toUpperCase();
        if (name) { subrs.push({ name, line: s.line }); }
        break;
      }
      case 'ENDSUBR': {
        const sub = subrs.pop();
        if (sub) { out.push({ name: sub.name, kind: 'subroutine', line: sub.line, endLine: s.endLine, detail: 'subroutine' }); }
        break;
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Blocks to fold: DO…ENDDO (also THEN(DO), ELSE(DO), WHEN … THEN(DO)), SELECT…ENDSELECT, SUBR…ENDSUBR. */
export function clFolds(source: string): { start: number; end: number }[] {
  const stack: { close: string; line: number }[] = []; const out: { start: number; end: number }[] = [];
  for (const s of clStatements(source)) {
    const c = s.command; const t = s.text.toUpperCase();
    if (c === 'ENDDO' || c === 'ENDSELECT' || c === 'ENDSUBR') {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].close === c) { const o = stack.splice(k)[0]; if (s.line > o.line) { out.push({ start: o.line, end: s.line }); } break; }
      }
      continue;
    }
    if (c === 'SELECT') { stack.push({ close: 'ENDSELECT', line: s.line }); continue; }
    if (c === 'SUBR') { stack.push({ close: 'ENDSUBR', line: s.line }); continue; }
    if (['DO', 'DOWHILE', 'DOUNTIL', 'DOFOR'].includes(c)) { stack.push({ close: 'ENDDO', line: s.line }); continue; }
    if (['IF', 'ELSE', 'WHEN', 'OTHERWISE'].includes(c) && (/\b(THEN|CMD)\s*\(\s*(DO|DOWHILE|DOUNTIL|DOFOR)\b[^)]*\)\s*$/.test(t) || /\s(DO|\(DO\))\s*$/.test(t))) {
      stack.push({ close: 'ENDDO', line: s.line });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** What a word at the cursor refers to: a variable, a label (GOTO), a subroutine (CALLSUBR) or a file. */
export function clDefinition(source: string, word: string): ClSymbol | undefined {
  const w = word.toUpperCase();
  const symbols = clSymbols(source);
  if (w.startsWith('&')) { return symbols.find(s => s.kind === 'variable' && s.name === w); }
  return symbols.find(s => (s.kind === 'subroutine' || s.kind === 'label' || s.kind === 'file') && s.name === w);
}

/** Lines that use a name (for references and highlights). */
export function clReferences(source: string, word: string): { line: number; start: number; end: number }[] {
  const w = word.toUpperCase();
  const esc = w.replace(/[$&]/g, '\\$&');
  const re = new RegExp(`(?<![\\w$#@&])${esc}(?![\\w$#@])`, 'gi');
  const out: { line: number; start: number; end: number }[] = [];
  const lines = stripComments(source).split(/\r?\n/);
  lines.forEach((l, i) => {
    let inString = false; const masked = [...l].map(c => { if (c === "'") { inString = !inString; return ' '; } return inString ? ' ' : c; }).join('');
    for (const m of masked.matchAll(re)) { out.push({ line: i, start: m.index ?? 0, end: (m.index ?? 0) + w.length }); }
  });
  return out;
}
