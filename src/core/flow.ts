// Control flow of RPG (free and fixed C specs) and CL: matching block keywords (IF … ELSE … ENDIF, DOW … ENDDO,
// SELECT … WHEN … ENDSL, MONITOR … ON-ERROR … ENDMON) and a Mermaid flowchart of a procedure, a subroutine or the
// main line. Pure (no vscode import), unit tested.

export type Tok =
  | { k: 'stmt'; text: string; line: number } | { k: 'if'; text: string; line: number } | { k: 'elseif'; text: string; line: number }
  | { k: 'else'; line: number } | { k: 'loop'; text: string; line: number } | { k: 'select'; line: number } | { k: 'when'; text: string; line: number }
  | { k: 'other'; line: number } | { k: 'monitor'; line: number } | { k: 'onerror'; text: string; line: number } | { k: 'end'; line: number }
  | { k: 'return'; text: string; line: number } | { k: 'leave'; line: number } | { k: 'iter'; line: number } | { k: 'do'; line: number };

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** One token per statement of free-form RPG (statements split on ";" outside strings, comments removed). */
function freeRpgTokens(lines: string[]): Tok[] {
  const out: Tok[] = [];
  let buf = ''; let start = -1; let q = false;
  const flush = (line: number) => {
    const s = clean(buf); buf = '';
    if (!s) { return; }
    const t = toFreeTok(s, start >= 0 ? start : line);
    if (t) { out.push(t); }
    start = -1;
  };
  const fullyFree = /^\s*\*\*free/i.test(lines[0] ?? '');
  lines.forEach((raw, i) => {
    if (/^\s*\*\*free/i.test(raw) || /^\s*\/(copy|include|if|endif|else|define|undefine|eof|title|space|eject|set|restore)\b/i.test(fullyFree ? raw : raw.slice(6))) { return; }
    // Column-limited sources: free code is in columns 8-80; a letter in column 6 is a fixed spec, * in column 7 a comment.
    if (!fullyFree && (/^.{5}[A-Za-z]/.test(raw) || raw[6] === '*')) { return; }
    const text = fullyFree ? raw : raw.slice(7, 80);
    for (let j = 0; j < text.length; j++) {
      const c = text[j];
      if (!q && c === '/' && text[j + 1] === '/') { break; }
      if (c === "'") { q = !q; }
      if (!q && c === ';') { flush(i); continue; }
      if (start < 0 && c.trim()) { start = i; }
      buf += c;
    }
    buf += ' ';
  });
  flush(lines.length - 1);
  return out;
}

function toFreeTok(s: string, line: number): Tok | undefined {
  const w = s.split(/[\s(]/)[0].toUpperCase().replace(/\(.*$/, '');
  const rest = clean(s.slice(s.split(/\s/)[0].length));
  if (/^(DCL-|END-DS|END-PR|END-PI|END-PROC|CTL-OPT|BEGSR|ENDSR)/.test(w) || w === 'DCL-PROC') { return undefined; }
  switch (w) {
    case 'IF': return { k: 'if', text: rest, line };
    case 'ELSEIF': return { k: 'elseif', text: rest, line };
    case 'ELSE': return { k: 'else', line };
    case 'DOW': case 'DOU': case 'FOR': case 'FOR-EACH': return { k: 'loop', text: `${w} ${rest}`, line };
    case 'SELECT': return { k: 'select', line };
    case 'WHEN': return { k: 'when', text: rest, line };
    case 'WHEN-IS': case 'WHEN-IN': return { k: 'when', text: `${w} ${rest}`, line };
    case 'OTHER': return { k: 'other', line };
    case 'MONITOR': return { k: 'monitor', line };
    case 'ON-ERROR': return { k: 'onerror', text: rest || '*ALL', line };
    case 'ON-EXIT': return { k: 'onerror', text: 'ON-EXIT', line };
    case 'ENDIF': case 'ENDDO': case 'ENDFOR': case 'ENDSL': case 'ENDMON': case 'END': return { k: 'end', line };
    case 'RETURN': return { k: 'return', text: rest, line };
    case 'LEAVE': return { k: 'leave', line };
    case 'ITER': return { k: 'iter', line };
    case 'LEAVESR': return { k: 'return', text: '(leave subroutine)', line };
    default: return { k: 'stmt', text: /^EXEC$/i.test(w) ? s.replace(/^exec\s+sql\s+/i, 'SQL: ') : s, line };
  }
}

/** Fixed-format C specs: the operation code in columns 26-35, factor 1 in 12-25, factor 2 / extended factor 2 from 36. */
function fixedRpgTokens(lines: string[]): Tok[] {
  const out: Tok[] = [];
  lines.forEach((l, line) => {
    if (!/^.{5}[Cc]/.test(l) || l[6] === '*' || l[6] === '/') { return; }
    const op = l.slice(25, 35).trim().toUpperCase().replace(/\(.*\)$/, '');
    if (!op) { return; }
    const f1 = l.slice(11, 25).trim(); const f2 = clean(l.slice(35, 80));
    const cond = (o: string) => /^(IF|DOW|DOU|WHEN)(EQ|NE|GT|LT|GE|LE)$/.test(o) ? `${f1} ${o.slice(-2)} ${l.slice(35, 49).trim()}` : f2;
    if (/^IF(EQ|NE|GT|LT|GE|LE)?$/.test(op)) { out.push({ k: 'if', text: cond(op), line }); }
    else if (op === 'ELSEIF') { out.push({ k: 'elseif', text: f2, line }); }
    else if (op === 'ELSE') { out.push({ k: 'else', line }); }
    else if (/^(DOW|DOU)(EQ|NE|GT|LT|GE|LE)?$/.test(op) || op === 'FOR' || op === 'DO') { out.push({ k: 'loop', text: `${op} ${cond(op)}`.trim(), line }); }
    else if (op === 'SELECT') { out.push({ k: 'select', line }); }
    else if (/^WHEN(EQ|NE|GT|LT|GE|LE)?$/.test(op)) { out.push({ k: 'when', text: cond(op), line }); }
    else if (op === 'OTHER') { out.push({ k: 'other', line }); }
    else if (op === 'MONITOR') { out.push({ k: 'monitor', line }); }
    else if (op === 'ON-ERROR') { out.push({ k: 'onerror', text: f2 || '*ALL', line }); }
    else if (/^END(IF|DO|FOR|SL|MON)?$/.test(op)) { out.push({ k: 'end', line }); }
    else if (op === 'RETURN') { out.push({ k: 'return', text: f2, line }); }
    else if (op === 'LEAVE') { out.push({ k: 'leave', line }); }
    else if (op === 'ITER') { out.push({ k: 'iter', line }); }
    else if (op === 'LEAVESR') { out.push({ k: 'return', text: '(leave subroutine)', line }); }
    else if (!/^(BEGSR|ENDSR|TAG|PLIST|PARM|KLIST|KFLD|DEFINE)$/.test(op)) { out.push({ k: 'stmt', text: clean(`${f1} ${op} ${f2}`), line }); }
  });
  return out;
}

/** CL: IF COND(…) THEN(DO) / ELSE CMD(DO) / ENDDO, DOWHILE, DOUNTIL, DOFOR, SELECT / WHEN / OTHERWISE / ENDSELECT. */
function clTokens(lines: string[]): Tok[] {
  // Join continuation lines (+ or - at the end) and drop comments.
  const cmds: { text: string; line: number }[] = [];
  let buf = ''; let start = -1;
  lines.forEach((raw, i) => {
    const l = raw.replace(/\/\*.*?\*\//g, '').replace(/\/\*.*$/, '');
    if (!l.trim()) { return; }
    if (start < 0) { start = i; }
    const t = l.trimEnd();
    if (/[+-]$/.test(t)) { buf += t.slice(0, -1) + ' '; return; }
    cmds.push({ text: clean(buf + t), line: start }); buf = ''; start = -1;
  });
  const out: Tok[] = [];
  const stack: ('if' | 'else' | 'loop' | 'do' | 'when' | 'other')[] = [];
  const param = (s: string, kw: string) => { const m = new RegExp(`\\b${kw}\\(`, 'i').exec(s); if (!m) { return undefined; } let d = 0; let j = m.index + m[0].length - 1; const b = j; for (; j < s.length; j++) { if (s[j] === '(') { d++; } else if (s[j] === ')') { d--; if (!d) { break; } } } return s.slice(b + 1, j).trim(); };
  for (const { text, line } of cmds) {
    let s = text.replace(/^[A-Z_][A-Z0-9_]*:\s*/i, '');
    const w = s.split(/[\s(]/)[0].toUpperCase();
    if (/^(PGM|ENDPGM|DCL|DCLF|DCLPRCOPT|COPYRIGHT|INCLUDE)$/.test(w)) { continue; }
    if (w === 'IF') {
      const pos = positional(s.slice(2));
      const cond = param(s, 'COND') ?? pos[0] ?? s.slice(2).trim(); const then = param(s, 'THEN') ?? pos[1] ?? '';
      const tok: Tok = { k: 'if', text: cond, line };
      // ELSE IF on one line (ELSE CMD(IF …)) is handled by the ELSE branch below.
      out.push(tok);
      if (/^DO$/i.test(then.trim())) { stack.push('if'); } else { if (then.trim()) { out.push(clStmt(then, line)); } out.push({ k: 'end', line }); }
      continue;
    }
    if (w === 'ELSE') {
      const cmd = (param(s, 'CMD') ?? s.slice(4).trim()).trim();
      // The IF before it was already closed by its ENDDO or one-line command: reopen it as the else branch.
      const prevEnd = out.length - 1;
      if (out[prevEnd]?.k === 'end') { out.pop(); }
      out.push({ k: 'else', line });
      if (/^DO$/i.test(cmd)) { stack.push('else'); }
      else if (/^IF\b/i.test(cmd)) { s = cmd; const c2 = param(s, 'COND') ?? ''; const th = (param(s, 'THEN') ?? '').trim(); out.pop(); out.push({ k: 'elseif', text: c2, line }); if (/^DO$/i.test(th)) { stack.push('if'); } else { if (th) { out.push(clStmt(th, line)); } out.push({ k: 'end', line }); } }
      else { if (cmd) { out.push(clStmt(cmd, line)); } out.push({ k: 'end', line }); }
      continue;
    }
    if (w === 'DOWHILE' || w === 'DOUNTIL' || w === 'DOFOR') { out.push({ k: 'loop', text: `${w} ${param(s, 'COND') ?? clean(s.slice(w.length))}`, line }); stack.push('loop'); continue; }
    if (w === 'DO') { stack.push('do'); continue; }
    if (w === 'ENDDO') {
      const what = stack.pop();
      if (what === 'when' || what === 'other') { stack.push(what); continue; } // ENDDO of a WHEN THEN(DO) body: the WHEN stays open
      if (what !== 'do') { out.push({ k: 'end', line }); }
      continue;
    }
    if (w === 'SELECT') { out.push({ k: 'select', line }); stack.push('do'); continue; }
    if (w === 'WHEN') { const th = (param(s, 'THEN') ?? '').trim(); out.push({ k: 'when', text: param(s, 'COND') ?? '', line }); if (th && !/^DO$/i.test(th)) { out.push(clStmt(th, line)); } else if (/^DO$/i.test(th)) { stack.push('do'); } continue; }
    if (w === 'OTHERWISE') { const c = (param(s, 'CMD') ?? '').trim(); out.push({ k: 'other', line }); if (c && !/^DO$/i.test(c)) { out.push(clStmt(c, line)); } else if (/^DO$/i.test(c)) { stack.push('do'); } continue; }
    if (w === 'ENDSELECT') { if (stack[stack.length - 1] === 'do') { stack.pop(); } out.push({ k: 'end', line }); continue; }
    if (w === 'RETURN' || w === 'ENDPGM') { out.push({ k: 'return', text: '', line }); continue; }
    if (w === 'LEAVE') { out.push({ k: 'leave', line }); continue; }
    if (w === 'ITERATE') { out.push({ k: 'iter', line }); continue; }
    out.push(clStmt(s, line));
  }
  return out;
}
const clStmt = (s: string, line: number): Tok => {
  const w = s.trim().split(/[\s(]/)[0].toUpperCase();
  return w === 'RETURN' ? { k: 'return', text: '', line } : w === 'LEAVE' ? { k: 'leave', line } : w === 'ITERATE' ? { k: 'iter', line } : { k: 'stmt', text: clean(s), line };
};

/** The positional parameters of a CL command: the parenthesized groups, in order (IF (&A *EQ 1) (DO)). */
function positional(s: string): string[] {
  const out: string[] = []; let d = 0; let b = -1;
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '(') { if (!d) { b = j; } d++; }
    else if (s[j] === ')') { d--; if (!d && b >= 0) { out.push(s.slice(b + 1, j).trim()); b = -1; } }
  }
  return out;
}

export function tokens(text: string, language: string): Tok[] {
  const lines = text.split(/\r?\n/);
  if (language === 'cl') { return clTokens(lines); }
  const fixed = lines.some(l => /^.{5}[Cc][ N0-9]/.test(l) && l.length > 26 && l.slice(25, 35).trim() && !/^\s*\*\*free/i.test(lines[0] ?? ''));
  const free = freeRpgTokens(lines);
  return fixed ? [...fixedRpgTokens(lines), ...free].sort((a, b) => a.line - b.line) : free;
}

// ---------------------------------------------------------------- matching block keywords

export interface BlockGroup { lines: number[] }

/** Groups of lines that belong to the same block: IF / ELSEIF / ELSE / ENDIF, DOW / LEAVE / ITER / ENDDO… */
export function blockGroups(text: string, language: string): BlockGroup[] {
  const groups: BlockGroup[] = []; const stack: { g: BlockGroup; loop: boolean }[] = [];
  for (const t of tokens(text, language)) {
    if (t.k === 'if' || t.k === 'loop' || t.k === 'select' || t.k === 'monitor') { const g = { lines: [t.line] }; groups.push(g); stack.push({ g, loop: t.k === 'loop' }); }
    else if (t.k === 'elseif' || t.k === 'else' || t.k === 'when' || t.k === 'other' || t.k === 'onerror') { stack[stack.length - 1]?.g.lines.push(t.line); }
    else if (t.k === 'leave' || t.k === 'iter') { for (let i = stack.length - 1; i >= 0; i--) { if (stack[i].loop) { stack[i].g.lines.push(t.line); break; } } }
    else if (t.k === 'end') { const top = stack.pop(); top?.g.lines.push(t.line); }
  }
  groups.forEach(g => { g.lines = [...new Set(g.lines)].sort((a, b) => a - b); });
  return groups;
}

export function matchingLines(text: string, language: string, line: number): number[] {
  const g = blockGroups(text, language).filter(x => x.lines.includes(line));
  return g.length ? g.sort((a, b) => b.lines[0] - a.lines[0])[0].lines : [];
}

// ---------------------------------------------------------------- flowchart

/** The lines of a procedure (dcl-proc … end-proc / P B … P E), a subroutine (BEGSR … ENDSR), or the main line (outside both). */
export function scopeText(text: string, scope: string, language: string): string {
  const lines = text.split(/\r?\n/);
  if (language === 'cl') { return text; }
  const keep = lines.map(() => false);
  let proc: string | undefined; let sr: string | undefined;
  lines.forEach((l, i) => {
    const u = l.toUpperCase();
    const p = /^\s*DCL-PROC\s+([\w$#@]+)/.exec(u) ?? (/^.{5}P/.test(u) && u.slice(23, 24) === 'B' ? [u, u.slice(6, 21).trim()] : null);
    if (p) { proc = p[1]; return; }
    if (/^\s*END-PROC\b/.test(u) || (/^.{5}P/.test(u) && u.slice(23, 24) === 'E')) { proc = undefined; return; }
    const b = /^\s*BEGSR\s+([\w$#@]+)/.exec(u) ?? (/^.{5}C/.test(u) && u.slice(25, 35).trim() === 'BEGSR' ? [u, u.slice(11, 25).trim()] : null);
    if (b) { sr = b[1]; return; }
    if (/^\s*ENDSR\b/.test(u) || (/^.{5}C/.test(u) && u.slice(25, 35).trim() === 'ENDSR')) { sr = undefined; return; }
    const S = scope.toUpperCase();
    keep[i] = S === '*MAIN' ? !proc && !sr : proc === S && !sr ? true : sr === S;
  });
  return lines.map((l, i) => (keep[i] || (i === 0 && /^\s*\*\*free/i.test(l)) ? l : '')).join('\n');
}

/** Procedures and subroutines of a source, for the scope picker. */
export function scopes(text: string): { name: string; kind: 'procedure' | 'subroutine' }[] {
  const out: { name: string; kind: 'procedure' | 'subroutine' }[] = [];
  for (const l of text.split(/\r?\n/)) {
    const u = l.toUpperCase();
    const p = /^\s*DCL-PROC\s+([\w$#@]+)/.exec(u)?.[1] ?? (/^.{5}P/.test(u) && u.slice(23, 24) === 'B' ? u.slice(6, 21).trim() : undefined);
    if (p) { out.push({ name: p, kind: 'procedure' }); }
    const s = /^\s*BEGSR\s+([\w$#@]+)/.exec(u)?.[1] ?? (/^.{5}C/.test(u) && u.slice(25, 35).trim() === 'BEGSR' ? u.slice(11, 25).trim() : undefined);
    if (s) { out.push({ name: s, kind: 'subroutine' }); }
  }
  return out;
}

type Stmt = { k: 'stmt'; text: string; line: number };
type Node = { t: 'stmts'; items: Stmt[] } | { t: 'if'; branches: { cond: string; body: Node[]; line: number }[]; other?: Node[]; select?: boolean }
  | { t: 'loop'; text: string; body: Node[]; line: number } | { t: 'monitor'; body: Node[]; handlers: { text: string; body: Node[]; line: number }[]; line: number }
  | { t: 'return'; text: string; line: number } | { t: 'leave' } | { t: 'iter' };

function tree(toks: Tok[]): Node[] {
  let i = 0;
  const block = (): Node[] => {
    const out: Node[] = [];
    while (i < toks.length) {
      const t = toks[i];
      if (t.k === 'end' || t.k === 'else' || t.k === 'elseif' || t.k === 'when' || t.k === 'other' || t.k === 'onerror') { return out; }
      i++;
      if (t.k === 'stmt') { const last = out[out.length - 1]; if (last?.t === 'stmts') { last.items.push(t); } else { out.push({ t: 'stmts', items: [t] }); } }
      else if (t.k === 'if') {
        const n: Node = { t: 'if', branches: [{ cond: t.text, body: block(), line: t.line }] };
        while (toks[i]?.k === 'elseif') { const e = toks[i++] as { text: string; line: number }; n.branches.push({ cond: e.text, body: block(), line: e.line }); }
        if (toks[i]?.k === 'else') { i++; n.other = block(); }
        if (toks[i]?.k === 'end') { i++; }
        out.push(n);
      } else if (t.k === 'select') {
        const n: Node = { t: 'if', branches: [], select: true };
        while (i < toks.length && toks[i].k !== 'end') {
          const w = toks[i];
          if (w.k === 'when') { i++; n.branches.push({ cond: w.text, body: block(), line: w.line }); }
          else if (w.k === 'other') { i++; n.other = block(); }
          else { const body = block(); if (body.length) { (n.other ??= []).push(...body); } if (i < toks.length && toks[i].k !== 'end' && toks[i].k !== 'when' && toks[i].k !== 'other') { i++; } }
        }
        i++;
        out.push(n);
      } else if (t.k === 'loop') { const body = block(); if (toks[i]?.k === 'end') { i++; } out.push({ t: 'loop', text: t.text, body, line: t.line }); }
      else if (t.k === 'monitor') {
        const n: Node = { t: 'monitor', body: block(), handlers: [], line: t.line };
        while (toks[i]?.k === 'onerror') { const h = toks[i++] as { text: string; line: number }; n.handlers.push({ text: h.text, body: block(), line: h.line }); }
        if (toks[i]?.k === 'end') { i++; }
        out.push(n);
      } else if (t.k === 'return') { out.push({ t: 'return', text: t.text, line: t.line }); }
      else if (t.k === 'leave') { out.push({ t: 'leave' }); }
      else if (t.k === 'iter') { out.push({ t: 'iter' }); }
    }
    return out;
  };
  const all: Node[] = [];
  while (i < toks.length) { all.push(...block()); if (i < toks.length) { i++; } } // a stray END: skip it
  return all;
}

export type FlowKind = 'start' | 'end' | 'stmts' | 'decision' | 'loop' | 'monitor' | 'handler' | 'return';
export interface FlowNode { id: string; kind: FlowKind; text: string[]; line?: number }
export interface FlowEdge { from: string; to: string; label?: string; back?: boolean; error?: boolean }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }

const short = (s: string, max = 70) => { const t = clean(s); return t.length > max ? t.slice(0, max - 1) + '…' : t; };

/** The control flow as a graph: boxes for runs of statements, decisions, loops, MONITOR / ON-ERROR, RETURN. */
export function flowGraph(text: string, language: string, title = ''): FlowGraph {
  const nodes: FlowNode[] = [{ id: 'S', kind: 'start', text: [title || 'start'] }];
  const edges: FlowEdge[] = [];
  let n = 0;
  const add = (kind: FlowKind, txt: string[], line?: number) => { const id = `N${++n}`; nodes.push({ id, kind, text: txt, line }); return id; };
  type End = { id: string; label?: string };
  const link = (from: End[], to: string, back = false) => from.forEach(f => edges.push({ from: f.id, to, label: f.label, ...(back ? { back: true } : {}) }));
  const loops: { id: string; exits: End[] }[] = [];
  const emit = (block: Node[], ins: End[]): End[] => {
    let cur = ins;
    for (const b of block) {
      if (!cur.length) { break; } // code after RETURN / LEAVE is not reachable
      if (b.t === 'stmts') {
        const lines = b.items.map(x => short(x.text, 60));
        const x = add('stmts', lines.length > 4 ? [...lines.slice(0, 3), `… ${lines.length - 3} more`] : lines, b.items[0].line);
        link(cur, x); cur = [{ id: x }];
      } else if (b.t === 'if') {
        let prev: End[] = cur; const exits: End[] = [];
        b.branches.forEach((br, k) => {
          const d = add('decision', [short((b.select ? 'WHEN ' : k ? 'ELSEIF ' : 'IF ') + br.cond)], br.line);
          link(prev, d);
          exits.push(...emit(br.body, [{ id: d, label: b.select ? 'yes' : 'true' }]));
          prev = [{ id: d, label: b.select ? 'no' : 'false' }];
        });
        if (b.other) { exits.push(...emit(b.other, prev.map(p => ({ ...p, label: b.select ? 'other' : 'else' })))); } else { exits.push(...prev); }
        cur = exits;
      } else if (b.t === 'loop') {
        const l = add('loop', [short(b.text)], b.line);
        link(cur, l);
        loops.push({ id: l, exits: [] });
        const back = emit(b.body, [{ id: l, label: 'repeat' }]);
        link(back, l, true);
        const ctx = loops.pop()!;
        cur = [{ id: l, label: 'done' }, ...ctx.exits];
      } else if (b.t === 'monitor') {
        const m = add('monitor', ['MONITOR'], b.line);
        link(cur, m);
        const exits = emit(b.body, [{ id: m }]);
        for (const h of b.handlers) {
          const e = add('handler', [h.text === 'ON-EXIT' ? 'ON-EXIT' : short('ON-ERROR ' + h.text)], h.line);
          edges.push({ from: m, to: e, label: 'error', error: true });
          exits.push(...emit(h.body, [{ id: e }]));
        }
        cur = exits;
      } else if (b.t === 'return') {
        const r = add('return', [short('RETURN ' + b.text)], b.line); link(cur, r); cur = [];
      } else if (b.t === 'leave') { loops[loops.length - 1]?.exits.push(...cur); cur = []; }
      else if (b.t === 'iter') { const l = loops[loops.length - 1]; if (l) { link(cur, l.id, true); } cur = []; }
    }
    return cur;
  };
  const last = emit(tree(tokens(text, language)), [{ id: 'S' }]);
  if (last.length || !nodes.some(x => x.kind === 'return')) { nodes.push({ id: 'E', kind: 'end', text: ['end'] }); link(last, 'E'); }
  return { nodes, edges };
}

const mm = (s: string) => s.replace(/"/g, '#quot;').replace(/[<>]/g, m => (m === '<' ? '#lt;' : '#gt;'));

export function toMermaidFlow(g: FlowGraph): string {
  const shape: Record<FlowKind, [string, string]> = { start: ['(["', '"])'], end: ['(["', '"])'], return: ['(["', '"])'], stmts: ['["', '"]'], decision: ['{"', '"}'], loop: ['{{"', '"}}'], monitor: ['[/"', '"/]'], handler: ['[/"', '"/]'] };
  const out = ['flowchart TD'];
  for (const x of g.nodes) { out.push(`  ${x.id}${shape[x.kind][0]}${x.text.map(mm).join('<br/>')}${shape[x.kind][1]}`); }
  for (const e of g.edges) { out.push(`  ${e.from} ${e.error ? '-.->' : '-->'}${e.label ? `|${mm(e.label)}|` : ''} ${e.to}`); }
  return out.join('\n') + '\n';
}

/** A Mermaid flowchart (top-down) of the statements. */
export function flowchart(text: string, language: string, title = ''): string {
  return toMermaidFlow(flowGraph(text, language, title));
}

// ---------------------------------------------------------------- layout for drawing

export interface Placed { id: string; x: number; y: number; w: number; h: number; lines: string[] }
export interface FlowLayout { boxes: Placed[]; width: number; height: number; edges: (FlowEdge & { points: [number, number][] })[] }

/** Wraps a text into lines of at most `w` characters. */
export function wrap(text: string, w = 34): string[] {
  const out: string[] = []; let cur = '';
  for (const word of text.split(' ')) {
    if ((cur + ' ' + word).trim().length > w && cur) { out.push(cur); cur = word; } else { cur = (cur + ' ' + word).trim(); }
    while (cur.length > w) { out.push(cur.slice(0, w)); cur = cur.slice(w); }
  }
  if (cur) { out.push(cur); }
  return out.length ? out : [''];
}

/** Layers from the start (back edges ignored), each node under the average of its parents, overlaps pushed apart. */
export function layoutFlow(g: FlowGraph, boxW = 230, gapX = 40, gapY = 46): FlowLayout {
  const fwd = g.edges.filter(e => !e.back);
  const preds = new Map<string, string[]>(g.nodes.map(n => [n.id, []]));
  const succ = new Map<string, string[]>(g.nodes.map(n => [n.id, []]));
  fwd.forEach(e => { preds.get(e.to)?.push(e.from); succ.get(e.from)?.push(e.to); });
  // What follows a loop goes below the whole loop body: the ends of the body (sources of the edges back to the loop)
  // come before the targets of the loop's "done" edge when layering.
  const order0 = new Map(g.nodes.map((nd, i) => [nd.id, i]));
  for (const b of g.edges.filter(e => e.back)) {
    for (const d of fwd.filter(e => e.from === b.to && e.label === 'done')) {
      if (order0.get(b.from)! < order0.get(d.to)! && !succ.get(b.from)!.includes(d.to)) { succ.get(b.from)!.push(d.to); }
    }
  }
  const layer = new Map<string, number>();
  const indeg = new Map<string, number>(g.nodes.map(n => [n.id, 0]));
  succ.forEach(ts => ts.forEach(t => indeg.set(t, indeg.get(t)! + 1)));
  const queue = g.nodes.filter(n => !indeg.get(n.id)).map(n => n.id);
  queue.forEach(id => layer.set(id, 0));
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of succ.get(id)!) {
      layer.set(t, Math.max(layer.get(t) ?? 0, layer.get(id)! + 1));
      indeg.set(t, indeg.get(t)! - 1);
      if (!indeg.get(t)) { queue.push(t); }
    }
  }
  g.nodes.forEach(nd => { if (!layer.has(nd.id)) { layer.set(nd.id, 0); } });
  const lines = new Map(g.nodes.map(nd => [nd.id, nd.text.flatMap(t => wrap(t)).slice(0, 6)]));
  const height = (id: string) => { const k = g.nodes.find(x => x.id === id)!.kind; return lines.get(id)!.length * 16 + (k === 'decision' || k === 'loop' ? 30 : 18); };
  const byLayer: string[][] = [];
  const order = new Map(g.nodes.map((nd, i) => [nd.id, i]));
  g.nodes.forEach(nd => { (byLayer[layer.get(nd.id)!] ??= []).push(nd.id); });
  const x = new Map<string, number>();
  const step = boxW + gapX;
  byLayer.forEach((ids, li) => {
    const want = ids.map(id => { const p = preds.get(id)!.filter(q => x.has(q)); return { id, want: p.length ? p.reduce((t, q) => t + x.get(q)!, 0) / p.length : 0 }; });
    want.sort((a, b) => a.want - b.want || order.get(a.id)! - order.get(b.id)!);
    // Spread with at least `step` between neighbours, then shift so the group stays centred on what it wanted.
    const placed: number[] = [];
    want.forEach((w, i) => { placed.push(i ? Math.max(w.want, placed[i - 1] + step) : w.want); });
    const shift = want.reduce((t, w, i) => t + w.want - placed[i], 0) / (want.length || 1);
    want.forEach((w, i) => x.set(w.id, li === 0 ? 0 : placed[i] + shift));
  });
  const minX = Math.min(...x.values()) - boxW / 2 - 20;
  let y = 20; const boxes: Placed[] = [];
  byLayer.forEach(ids => {
    const h = Math.max(...ids.map(height));
    ids.forEach(id => boxes.push({ id, x: x.get(id)! - minX - boxW / 2, y: y + (h - height(id)) / 2, w: boxW, h: height(id), lines: lines.get(id)! }));
    y += h + gapY;
  });
  const at = new Map(boxes.map(b => [b.id, b]));
  const right = Math.max(...boxes.map(b => b.x + b.w));
  let lane = 0;
  const edges = g.edges.map(e => {
    const a = at.get(e.from)!; const b = at.get(e.to)!;
    let points: [number, number][];
    if (e.back) {
      // Out of the bottom of the source, along the free gap to a lane on the right, up, and into the top of the loop.
      const lx = right + 18 + (lane++ % 8) * 10;
      const sx = a.x + a.w * 0.8; const sy = a.y + a.h; const gy = sy + gapY * 0.3; const ty = b.y - gapY * 0.3; const tx = b.x + b.w * 0.8;
      points = [[sx, sy], [sx, gy], [lx, gy], [lx, ty], [tx, ty], [tx, b.y]];
    } else {
      const sx = a.x + a.w / 2; const sy = a.y + a.h; const tx = b.x + b.w / 2; const ty = b.y;
      const my = Math.min(sy + gapY / 2, ty - 8);
      points = Math.abs(sx - tx) < 1 ? [[sx, sy], [tx, ty]] : [[sx, sy], [sx, my], [tx, my], [tx, ty]];
    }
    return { ...e, points };
  });
  return { boxes, width: right - 0 + 90, height: y, edges };
}
