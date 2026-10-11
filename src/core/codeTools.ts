// Pure helpers for 1.1: RPG code metrics, Markdown documentation, RPGUnit test skeletons and
// results, and sparkline geometry for the performance monitor. No vscode import, unit tested.

// ---------------------------------------------------------------- RPG metrics

export interface ProcMetrics { name: string; lines: number; complexity: number; maxNesting: number }
export interface Metrics {
  lines: number; code: number; comments: number; blank: number;
  free: number; fixed: number; procedures: number; subroutines: number; copies: number;
  sqlStatements: number; indicators: number; gotos: number; complexity: number; maxNesting: number;
  procs: ProcMetrics[];
  grade: 'A' | 'B' | 'C' | 'D';
  notes: string[];
}

const DECISION = /^\s*(IF|ELSEIF|WHEN|WHEN-IS|WHEN-IN|DOW|DOU|FOR|FOR-EACH|MONITOR|ON-ERROR)\b/i;
const OPEN = /^\s*(IF|DOW|DOU|FOR|FOR-EACH|SELECT|MONITOR|BEGSR)\b/i;
const CLOSE = /^\s*(ENDIF|ENDDO|ENDFOR|ENDSL|ENDMON|ENDSR|END)\b/i;
const FIXED_OP = (l: string) => (l.length > 25 ? l.substring(25, 35).trim().toUpperCase() : '');

/** Line-level metrics of an RPG source (free, fixed or mixed). */
export function rpgMetrics(text: string): Metrics {
  const lines = text.split(/\r?\n/);
  const fullyFree = /^\s*\*\*FREE/i.test(lines[0] ?? '');
  const m: Metrics = { lines: lines.length, code: 0, comments: 0, blank: 0, free: 0, fixed: 0, procedures: 0, subroutines: 0, copies: 0,
    sqlStatements: 0, indicators: 0, gotos: 0, complexity: 1, maxNesting: 0, procs: [], grade: 'A', notes: [] };
  let depth = 0; let cur: ProcMetrics | undefined; let curDepth = 0;
  for (const raw of lines) {
    const fixedSpec = !fullyFree && raw.length > 6 && /^[ 0-9]{5}[HFDICOPhfdicop]/.test(raw.slice(0, 6)) && !/^\s*\/\//.test(raw);
    const free = fullyFree ? raw : (!fixedSpec && raw.length > 7 ? raw.slice(7) : fixedSpec ? '' : raw);
    const trimmed = (fixedSpec ? raw.slice(6) : free).trim();
    if (!trimmed) { m.blank++; continue; }
    if (/^\/\//.test(trimmed) || (!fullyFree && raw[6] === '*')) { m.comments++; continue; }
    m.code++;
    if (/^\/(COPY|INCLUDE)\b/i.test(trimmed)) { m.copies++; continue; }
    let stmt: string;
    if (fixedSpec) {
      m.fixed++;
      const spec = raw[5].toUpperCase();
      stmt = spec === 'C' ? FIXED_OP(raw) : '';
      if (spec === 'P' && /^B/i.test(raw.substring(23, 24))) { m.procedures++; cur = { name: raw.substring(6, 21).trim(), lines: 0, complexity: 1, maxNesting: 0 }; curDepth = depth; m.procs.push(cur); }
      if (spec === 'P' && /^E/i.test(raw.substring(23, 24))) { cur = undefined; }
      if (spec === 'C' && /\*IN\d\d|\b\d\d\b/.test(raw.substring(8, 11))) { m.indicators++; }
    } else {
      m.free++;
      stmt = trimmed.replace(/;.*$/, '');
      const pb = /^DCL-PROC\s+([\w$#@]+)/i.exec(stmt);
      if (pb) { m.procedures++; cur = { name: pb[1], lines: 0, complexity: 1, maxNesting: 0 }; curDepth = depth; m.procs.push(cur); }
      if (/^END-PROC\b/i.test(stmt)) { cur = undefined; }
    }
    if (cur) { cur.lines++; }
    if (/^EXEC\s+SQL\b/i.test(stmt) || /^C\+?\s*\/EXEC\s+SQL/i.test(raw.slice(5))) { m.sqlStatements++; }
    const ind = trimmed.match(/\*IN\d\d\b/gi); if (ind) { m.indicators += ind.length; }
    if (/^(GOTO|CABxx|CAB(EQ|NE|LT|LE|GT|GE))\b/i.test(stmt)) { m.gotos++; }
    if (/^BEGSR\b/i.test(stmt)) { m.subroutines++; }
    if (DECISION.test(stmt) || /^(IF|DO[WU]|WHEN|CAS)(EQ|NE|LT|LE|GT|GE)?$/i.test(stmt)) {
      m.complexity++; if (cur) { cur.complexity++; }
      const ands = (stmt.match(/\b(AND|OR)\b/gi) ?? []).length; m.complexity += ands; if (cur) { cur.complexity += ands; }
    }
    if (OPEN.test(stmt) || /^(IF|DO[WU]|DO|FOR)(EQ|NE|LT|LE|GT|GE)?$/i.test(stmt)) {
      depth++; m.maxNesting = Math.max(m.maxNesting, depth); if (cur) { cur.maxNesting = Math.max(cur.maxNesting, depth - curDepth); }
    }
    if (CLOSE.test(stmt) && depth > 0) { depth--; }
  }
  const freeShare = m.free / Math.max(1, m.free + m.fixed);
  const worstProc = Math.max(0, ...m.procs.map(p => p.complexity));
  let score = 0;
  if (freeShare < 0.5) { score++; m.notes.push(`Mostly fixed format (${Math.round(freeShare * 100)} % free) — consider converting to free form.`); }
  if (m.gotos) { score++; m.notes.push(`${m.gotos} GOTO/CABxx — restructure with loops or procedures.`); }
  if (m.indicators > 20) { score++; m.notes.push(`${m.indicators} numbered indicators — use named indicators or *IN aliases.`); }
  if (worstProc > 20 || (!m.procs.length && m.complexity > 40)) { score++; m.notes.push(`High complexity (${Math.max(worstProc, m.complexity)}) — split into smaller procedures.`); }
  if (m.maxNesting > 5) { score++; m.notes.push(`Nesting depth ${m.maxNesting} — flatten with early exits.`); }
  if (m.code > 3000 && m.procedures < 3) { score++; m.notes.push('Large source with few procedures — consider modularizing.'); }
  m.grade = score === 0 ? 'A' : score === 1 ? 'B' : score <= 3 ? 'C' : 'D';
  return m;
}

// ---------------------------------------------------------------- Markdown documentation

export interface DocInput { library: string; file: string; member: string; type: string; text: string; memberText?: string }

/** Markdown documentation of an RPG / CL source from what the source itself says. */
export function generateDocs(d: DocInput): string {
  const lines = d.text.split(/\r?\n/);
  const out: string[] = [`# ${d.member}`, '', `*${d.library}/${d.file}(${d.member}) · ${d.type.toUpperCase()}*${d.memberText ? ` — ${d.memberText}` : ''}`, ''];
  // Leading comment block = description.
  const head: string[] = [];
  for (const l of lines.slice(/^\s*\*\*FREE/i.test(lines[0] ?? '') ? 1 : 0, 80)) {
    const c = /^\s*\/\/\s?(.*)$/.exec(l) ?? (/^.{6}\*(.*)$/.exec(l)) ?? /^\s*\/\*\s?(.*?)\s*\*?\/?$/.exec(l);
    if (c && !/^[-=*\s]*$/.test(c[1])) { head.push(c[1].trim()); continue; }
    if (c || !l.trim() || /ctl-opt|^.{5}H/i.test(l)) { continue; }
    break;
  }
  if (head.length) { out.push('## Description', '', head.join(' '), ''); }
  const m = rpgMetrics(d.text);
  // Parameters (PI of the main procedure, *ENTRY PLIST, CL PGM PARM).
  const params: string[] = [];
  const pi = d.text.match(/dcl-pi\s+(\*N|[\w$#@]+)[^;]*;([\s\S]*?)end-pi/i);
  if (pi && !d.text.slice(0, pi.index).match(/dcl-proc/i)) {
    for (const p of pi[2].split(';')) { const t = p.trim(); if (t && !/^\/\//.test(t)) { params.push(`- \`${t.replace(/\s+/g, ' ')}\``); } }
  }
  const entry = /^.{5}C.{20}\*ENTRY\s+PLIST/im.test(d.text);
  if (entry) { for (const l of lines) { const p = /^.{5}C.{19}\s*PARM\s+(\S*)\s+(\S+)/i.exec(l); if (p) { params.push(`- \`${p[2]}\``); } } }
  const clParm = /^\s*PGM\s+PARM\(([^)]*)\)/im.exec(d.text);
  if (clParm) { clParm[1].trim().split(/\s+/).forEach(p => params.push(`- \`${p}\``)); }
  out.push('## Parameters', '', ...(params.length ? params : ['None.']), '');
  // Files.
  const files = new Set<string>();
  for (const f of d.text.matchAll(/dcl-f\s+([\w$#@]+)([^;]*);/gi)) { files.add(`- \`${f[1].toUpperCase()}\`${/usage\(([^)]*)\)/i.exec(f[2]) ? ` — usage ${/usage\(([^)]*)\)/i.exec(f[2])![1]}` : ''}${/workstn/i.test(f[2]) ? ' (display)' : /printer/i.test(f[2]) ? ' (printer)' : ''}`); }
  for (const l of lines) { const f = /^.{5}F([\w$#@]{1,10})\s*([IOUC])/i.exec(l); if (f && !/^\*/.test(l[6] ?? '')) { files.add(`- \`${f[1].toUpperCase()}\` — ${({ I: 'input', O: 'output', U: 'update', C: 'combined' } as Record<string, string>)[f[2].toUpperCase()]}`); } }
  for (const f of d.text.matchAll(/^\s*DCLF\s+FILE\(([^)]+)\)/gim)) { files.add(`- \`${f[1].toUpperCase()}\``); }
  out.push('## Files', '', ...(files.size ? [...files] : ['None.']), '');
  // Calls.
  const calls = new Set<string>();
  for (const c of d.text.matchAll(/extpgm\(\s*'([^']+)'\s*\)/gi)) { calls.add(`- program \`${c[1].toUpperCase()}\``); }
  for (const c of d.text.matchAll(/^\s*CALL\s+PGM\(([^)]+)\)/gim)) { calls.add(`- program \`${c[1].toUpperCase()}\``); }
  for (const l of lines) { const c = /^.{5}C.{19}\s*CALL\s+'([^']+)'/i.exec(l); if (c) { calls.add(`- program \`${c[1].toUpperCase()}\``); } }
  for (const c of d.text.matchAll(/extproc\(\s*'([^']+)'\s*\)/gi)) { calls.add(`- procedure \`${c[1]}\``); }
  out.push('## Calls', '', ...(calls.size ? [...calls] : ['None found in the source.']), '');
  // Copybooks.
  const copies = [...d.text.matchAll(/^\s*(?:.{5}[ A-Za-z])?\s*\/(?:copy|include)\s+(\S+)/gim)].map(c => `- \`${c[1]}\``);
  if (copies.length) { out.push('## Copybooks', '', ...new Set(copies), ''); }
  // Procedures with their preceding comment.
  const procs: string[] = [];
  lines.forEach((l, i) => {
    const p = /^\s*dcl-proc\s+([\w$#@]+)\s*(export)?/i.exec(l);
    if (!p) { return; }
    const doc: string[] = [];
    for (let k = i - 1; k >= 0 && k > i - 15; k--) { const c = /^\s*\/\/\s?(.*)$/.exec(lines[k]); if (!c) { break; } if (!/^[-=*\s]*$/.test(c[1])) { doc.unshift(c[1].trim()); } }
    const pm = m.procs.find(x => x.name.toUpperCase() === p[1].toUpperCase());
    procs.push(`### ${p[1]}${p[2] ? ' *(exported)*' : ''}`, '', doc.join(' ') || '_No description._', '', `Lines: ${pm?.lines ?? '?'} · complexity: ${pm?.complexity ?? '?'}`, '');
  });
  if (procs.length) { out.push('## Procedures', '', ...procs); }
  out.push('## Metrics', '', '| Lines | Code | Comments | Free / fixed | Procedures | Subroutines | SQL | Complexity | Grade |', '|---|---|---|---|---|---|---|---|---|',
    `| ${m.lines} | ${m.code} | ${m.comments} | ${m.free} / ${m.fixed} | ${m.procedures} | ${m.subroutines} | ${m.sqlStatements} | ${m.complexity} | ${m.grade} |`, '');
  if (m.notes.length) { out.push(...m.notes.map(n => `- ${n}`), ''); }
  out.push('---', '', '*Generated by Vanthrex for IBM i from the source. Review and complete it.*', '');
  return out.join('\n');
}

// ---------------------------------------------------------------- RPGUnit

export interface ProcSignature { name: string; params: { name: string; type: string }[]; returns?: string }

/** Exported procedures of a free-form source with their parameters (from the PI). */
export function exportedProcedures(text: string): ProcSignature[] {
  const out: ProcSignature[] = [];
  for (const m of text.matchAll(/dcl-proc\s+([\w$#@]+)\s+export[^;]*;([\s\S]*?)end-proc/gi)) {
    const pi = /dcl-pi\s+[^;]*?(?:\s+([^;]*))?;([\s\S]*?)end-pi/i.exec(m[2]);
    const sig: ProcSignature = { name: m[1], params: [] };
    if (pi) {
      const ret = /dcl-pi\s+(?:\*N|[\w$#@]+)\s+([^;]+);/i.exec(m[2]);
      if (ret && ret[1].trim()) { sig.returns = ret[1].trim(); }
      for (const p of pi[2].split(';')) {
        const t = p.trim().replace(/\s+/g, ' ');
        const pm = /^([\w$#@]+)\s+(.+)$/.exec(t);
        if (pm && !/^\/\//.test(t)) { sig.params.push({ name: pm[1], type: pm[2] }); }
      }
    }
    out.push(sig);
  }
  return out;
}

/** An RPGUnit test module (free form) with one test per procedure. */
export function rpgUnitSkeleton(member: string, procs: ProcSignature[], prototypeCopy?: string): string {
  const dflt = (t: string) => /char|varchar/i.test(t) ? `''` : /ind/i.test(t) ? '*off' : /date/i.test(t) ? '%date()' : /time/i.test(t) ? '%timestamp()' : '0';
  const out = ['**FREE', `// RPGUnit tests for ${member} — generated by Vanthrex. Fill in the expected values.`,
    '// Compile with RUCRTRPG, run with RUCALLTST (or from VS Code\'s Test Explorer).', '',
    'ctl-opt nomain;', '', '/include qinclude,TESTCASE', prototypeCopy ? `/include ${prototypeCopy}` : '// /include the prototypes of the procedures under test here', '',
    'dcl-proc setUp export;', '  // Runs before each test.', 'end-proc;', '', 'dcl-proc tearDown export;', '  // Runs after each test.', 'end-proc;', ''];
  for (const p of procs) {
    out.push(`dcl-proc test_${p.name} export;`);
    for (const a of p.params) { out.push(`  dcl-s ${a.name} ${a.type.replace(/\b(const|value)\b/gi, '').replace(/\s+/g, ' ').trim()} inz(${dflt(a.type)});`); }
    if (p.returns) {
      out.push(`  dcl-s actual ${p.returns.replace(/\b(rtnparm|opdesc)\b/gi, '').trim()};`, `  dcl-s expected like(actual);`, '');
      out.push(`  // Arrange: set the input values above and the expected result.`, `  expected = ${dflt(p.returns)};`, '');
      out.push(`  actual = ${p.name}(${p.params.map(a => a.name).join(' : ')});`, '');
      out.push(/char|varchar/i.test(p.returns) ? `  aEqual(expected : actual);` : /ind/i.test(p.returns) ? `  nEqual(expected : actual);` : `  iEqual(expected : actual);`);
    } else {
      out.push('', `  ${p.name}(${p.params.map(a => a.name).join(' : ')});`, '', `  assert(*on : 'Replace with a real check');`);
    }
    out.push('end-proc;', '');
  }
  return out.join('\n');
}

export interface TestResult { name: string; status: 'passed' | 'failed' | 'error'; message?: string; time?: number }

/** Parse JUnit XML written by RUCALLTST XMLSTMF(). */
export function parseJUnit(xml: string): TestResult[] {
  const out: TestResult[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /name="([^"]*)"/.exec(m[1])?.[1] ?? '?';
    const time = Number(/time="([^"]*)"/.exec(m[1])?.[1] ?? NaN);
    const body = m[3] ?? '';
    const fail = /<failure\b([^>]*)(?:\/>|>([\s\S]*?)<\/failure>)/.exec(body);
    const err = /<error\b([^>]*)(?:\/>|>([\s\S]*?)<\/error>)/.exec(body);
    const msg = (x: RegExpExecArray) => (/message="([^"]*)"/.exec(x[1])?.[1] ?? x[2] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
    out.push(fail ? { name, status: 'failed', message: msg(fail), time } : err ? { name, status: 'error', message: msg(err), time } : { name, status: 'passed', time });
  }
  return out;
}

/** Summary from the RUCALLTST completion message, when no XML is available. */
export function parseRuSummary(text: string): { ok: boolean; tests?: number; failures?: number; errors?: number } | undefined {
  const m = /(Success|FAILURE)\.?\s*(\d+)\s+test case[s]?,\s*(\d+)\s+assertion[s]?,\s*(\d+)\s+failure[s]?,\s*(\d+)\s+error/i.exec(text);
  if (!m) { return undefined; }
  return { ok: /success/i.test(m[1]), tests: Number(m[2]), failures: Number(m[4]), errors: Number(m[5]) };
}

// ---------------------------------------------------------------- sparklines

/** SVG polyline points for a series in a w×h box; max is at least `minMax` so small values stay small. */
export function sparkPoints(values: number[], w: number, h: number, minMax = 1): string {
  if (!values.length) { return ''; }
  const max = Math.max(minMax, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (Math.max(0, v) / max) * h).toFixed(1)}`).join(' ');
}

/** Keep the last `size` samples. */
export function pushSample(series: number[], v: number, size = 120): number[] {
  const out = [...series, v];
  return out.length > size ? out.slice(out.length - size) : out;
}
