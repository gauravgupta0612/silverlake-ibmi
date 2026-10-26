// Context for the AI commands that work on real system data: compile errors with the source around them,
// program dependencies, and the failing statement from a job log. Pure module (no vscode), unit tested.

import { analyzeJobLog, messageHint } from '../core/insights';

export interface Diag { line: number; message: string; code?: string; severity?: number }

/** The source lines around each compile error (numbered, error lines marked with >>). */
export function errorSnippets(text: string, diags: Diag[], radius = 3, max = 15): string {
  const lines = text.split(/\r?\n/);
  const sorted = [...diags].sort((a, b) => a.line - b.line).slice(0, max);
  const blocks: { from: number; to: number; marks: Set<number> }[] = [];
  for (const d of sorted) {
    const from = Math.max(1, d.line - radius); const to = Math.min(lines.length, d.line + radius);
    const last = blocks[blocks.length - 1];
    if (last && from <= last.to + 1) { last.to = Math.max(last.to, to); last.marks.add(d.line); } else { blocks.push({ from, to, marks: new Set([d.line]) }); }
  }
  const w = String(lines.length).length;
  return blocks.map(b => {
    const out: string[] = [];
    for (let n = b.from; n <= b.to; n++) { out.push(`${b.marks.has(n) ? '>>' : '  '}${String(n).padStart(w)}| ${lines[n - 1] ?? ''}`); }
    return out.join('\n');
  }).join('\n   …\n');
}

/** Message IDs of compile errors, without duplicates. */
export function messageIds(diags: Diag[]): string[] {
  return [...new Set(diags.map(d => (d.code ?? '').toUpperCase()).filter(c => /^[A-Z]{2,3}[0-9A-F]{4,5}$/.test(c)))];
}

/** Second-level text uses &N / &P / &B formatting codes; turn them into plain paragraphs. */
export function plainHelp(t: string): string {
  return (t ?? '').replace(/&N\s*/g, '\n').replace(/&P\s*/g, '\n  ').replace(/&B\s*/g, '\n- ').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------- job log

export interface JobLogRow {
  id: string; type: string; severity: number; text: string; help?: string; time?: string;
  fromLib?: string; fromPgm?: string; fromModule?: string; fromProc?: string; fromStmt?: string;
  toLib?: string; toPgm?: string; toModule?: string; toProc?: string; toStmt?: string;
}
export interface Failing { lib: string; pgm: string; module?: string; proc?: string; stmt?: string; message: JobLogRow }

const SYSTEM_LIB = /^(QSYS|QSYS2|QSYSINC|QSHELL|QSQL|QTCP|QGPL|QDEVTOOLS|QRPGLE|QCBLLE|QTEMP|\*N|\*LIBL)?$/;
const SYSTEM_PGM = /^(Q[A-Z0-9]*|\*N|\*EXT)$/;
const isUser = (lib?: string, pgm?: string) => !!pgm && !SYSTEM_PGM.test(pgm.toUpperCase()) && !SYSTEM_LIB.test((lib ?? '').toUpperCase());
const isUserLib = (lib?: string, pgm?: string) => !!pgm && !!lib && !SYSTEM_LIB.test(lib.toUpperCase()) && pgm.toUpperCase() !== '*N';

/** The user program where the job went wrong: the first serious message sent from or to a non-system program. */
export function failingProgram(rows: JobLogRow[]): Failing | undefined {
  const bad = rows.filter(r => /ESCAPE|DIAGNOSTIC|INQUIRY/i.test(r.type) || r.severity >= 30);
  for (const strict of [true, false]) {
    for (const r of bad) {
      const ok = strict ? isUser : isUserLib;
      if (ok(r.fromLib, r.fromPgm)) { return { lib: r.fromLib!.toUpperCase(), pgm: r.fromPgm!.toUpperCase(), module: r.fromModule || undefined, proc: r.fromProc || undefined, stmt: r.fromStmt || undefined, message: r }; }
      if (ok(r.toLib, r.toPgm)) { return { lib: r.toLib!.toUpperCase(), pgm: r.toPgm!.toUpperCase(), module: r.toModule || undefined, proc: r.toProc || undefined, stmt: r.toStmt || undefined, message: r }; }
    }
  }
  return undefined;
}

/** 1-based source line of an ILE statement number. With OPTION(*SRCSTMT) the statement is the sequence number
 *  times 100 (SRCSEQ 12.00 → 1200); without it, it is roughly the line number of the compile listing. */
export function lineForStatement(stmt: string | undefined, seqs: number[] | undefined, lineCount: number): { line?: number; how: string } {
  const n = Number(String(stmt ?? '').trim().split(/[\s,]+/)[0]);
  if (!Number.isFinite(n) || n <= 0) { return { how: 'no statement number in the job log' }; }
  if (seqs?.length) {
    const i = seqs.findIndex(s => Math.round(s * 100) === n);
    if (i >= 0) { return { line: i + 1, how: `statement ${n} = source sequence number ${(n / 100).toFixed(2)}` }; }
  }
  if (n % 100 === 0 && n / 100 <= lineCount) { return { line: n / 100, how: `statement ${n}, read as sequence number ${(n / 100).toFixed(2)}` }; }
  if (n <= lineCount) { return { line: n, how: `statement ${n}, read as a listing statement number (approximate)` }; }
  return { how: `statement ${n} could not be matched to a source line` };
}

/** Numbered source lines around a line, the line itself marked. */
export function sourceWindow(text: string, line: number, radius = 15): string {
  const lines = text.split(/\r?\n/);
  const from = Math.max(1, line - radius); const to = Math.min(lines.length, line + radius);
  const w = String(to).length; const out: string[] = [];
  for (let n = from; n <= to; n++) { out.push(`${n === line ? '>>' : '  '}${String(n).padStart(w)}| ${lines[n - 1]}`); }
  return out.join('\n');
}

/** The job log for the model: serious messages with help text first, then the last messages in order. */
export function jobLogForModel(rows: JobLogRow[], maxChars = 12000): string {
  const { findings, rootCause } = analyzeJobLog(rows.map(r => ({ id: r.id, type: r.type, severity: r.severity, text: r.text, help: r.help, program: r.fromPgm, time: r.time })));
  const parts: string[] = [];
  if (rootCause) { parts.push(`Most likely cause: ${rootCause.id} ${rootCause.text}${rootCause.hint ? `\nHint: ${rootCause.hint}` : ''}${rootCause.help ? `\nIBM help: ${plainHelp(rootCause.help).slice(0, 1500)}` : ''}`); }
  if (findings.length) {
    parts.push('Errors (grouped, worst first):\n' + findings.slice(0, 15).map(f => `- ${f.id || '(no id)'} sev ${f.severity} ×${f.count}${f.program ? ` from ${f.program}` : ''}: ${f.text}${f.hint ? ` — ${f.hint}` : ''}`).join('\n'));
  }
  const tail = rows.slice(-60).map(r => `${r.time ?? ''} ${r.id || '-'} ${r.type} sev ${r.severity} ${r.fromPgm ? `[${r.fromLib ?? ''}/${r.fromPgm}${r.fromStmt ? ` stmt ${r.fromStmt}` : ''} → ${r.toPgm ?? ''}${r.toStmt ? ` stmt ${r.toStmt}` : ''}]` : ''}: ${r.text}`);
  parts.push('Last job log messages in order:\n' + tail.join('\n'));
  let s = parts.join('\n\n');
  if (s.length > maxChars) { s = s.slice(0, maxChars) + '\n(cut)'; }
  return s;
}

// ---------------------------------------------------------------- program dependencies

export interface Dependencies {
  object: string; type: string; text?: string; attribute?: string; activationGroup?: string; created?: string; source?: string;
  modules: { lib: string; name: string; source?: string; attribute?: string }[];
  servicePrograms: { lib: string; name: string; activation?: string }[];
  refs: { lib: string; name: string; type: string; usage?: string }[];
  usedBy: { lib: string; name: string; type: string }[];
  bindingDirectories?: string[];
  refsNote?: string;
}

const USAGE: Record<string, string> = { '1': 'input', '2': 'output', '3': 'input/output', '4': 'update', '5': 'input/update', '6': 'output/update', '7': 'input/output/update', '8': 'not specified' };
export function fileUsage(u: string | number | undefined): string | undefined {
  const k = String(u ?? '').trim(); return k ? USAGE[k] ?? k : undefined;
}

export function dependenciesForModel(d: Dependencies): string {
  const lines: string[] = [`${d.type} ${d.object}${d.attribute ? ` (${d.attribute})` : ''}${d.text ? ` — ${d.text}` : ''}`];
  if (d.activationGroup) { lines.push(`Activation group: ${d.activationGroup}`); }
  if (d.source) { lines.push(`Source: ${d.source}`); }
  if (d.created) { lines.push(`Created: ${d.created}`); }
  const sec = (title: string, items: string[], empty: string) => { lines.push('', `${title} (${items.length}):`, ...(items.length ? items.slice(0, 150).map(x => `- ${x}`) : [`- ${empty}`])); if (items.length > 150) { lines.push(`- … ${items.length - 150} more`); } };
  sec('Modules bound in', d.modules.map(m => `${m.lib}/${m.name}${m.attribute ? ` ${m.attribute}` : ''}${m.source ? ` from ${m.source}` : ''}`), 'none (OPM program or no modules listed)');
  sec('Service programs bound', d.servicePrograms.map(s => `${s.lib}/${s.name}${s.activation ? ` (${s.activation})` : ''}`), 'none');
  const files = d.refs.filter(r => r.type === '*FILE'); const others = d.refs.filter(r => r.type !== '*FILE');
  sec('Files used', files.map(r => `${r.lib}/${r.name}${r.usage ? ` (${r.usage})` : ''}`), d.refsNote ?? 'none found');
  sec('Programs, data areas and other objects referenced', others.map(r => `${r.lib}/${r.name} ${r.type}`), d.refsNote ?? 'none found');
  sec('Used by (bound to it or referencing it, in the libraries searched)', d.usedBy.map(u => `${u.lib}/${u.name} ${u.type}`), 'nothing found');
  if (d.bindingDirectories?.length) { sec('Binding directories', d.bindingDirectories, ''); }
  return lines.join('\n');
}

/** Hint for a message, for the user-facing summary. */
export function hintFor(id: string): string | undefined { return messageHint(id); }

/** Rows from a spooled job log (QPJOBLOG), for ended jobs whose job log is no longer in JOBLOG_INFO.
 *  Reads the English layout: a header line per message, then "From module / Statement / To module / Message / Cause" lines. */
export function parseSpooledJobLog(text: string): JobLogRow[] {
  const out: JobLogRow[] = []; let cur: JobLogRow | undefined; let field = ''; let side: 'from' | 'to' = 'from';
  const head = /^([A-Z]{3}[0-9A-F]{4}|\*NONE)\s+(Escape|Diagnostic|Inquiry|Information|Completion|Notify|Request|Reply|Sender copy)\s+(\d{2})\s+(\S+)\s+(\S+)\s+(.*)$/i;
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^[01 +-](?=[A-Z*]{3})/, '').trimEnd();
    const h = head.exec(line.trim());
    if (h) {
      const t = h[6].trim().split(/\s+/);
      const [fromPgm, fromLib, fromStmt] = t; const rest = t.slice(3);
      const [toPgm, toLib, toStmt] = rest.length >= 3 ? rest : [rest[0], '', rest[1]];
      cur = { id: h[1] === '*NONE' ? '' : h[1].toUpperCase(), type: h[2].toUpperCase(), severity: Number(h[3]), text: '', time: `${h[4]} ${h[5]}`, fromPgm, fromLib, fromStmt: /^\d+$/.test(fromStmt ?? '') ? fromStmt : undefined, toPgm, toLib, toStmt: /^\d+$/.test(toStmt ?? '') ? toStmt : undefined };
      out.push(cur); field = ''; side = 'from'; continue;
    }
    if (!cur) { continue; }
    const kv = /^\s*(From module|From procedure|To module|To procedure|Statement|Message|Cause|Recovery|Technical description)\s*[. ]*:\s*(.*)$/i.exec(line);
    if (kv) {
      const k = kv[1].toLowerCase(); const v = kv[2].trim();
      if (k === 'from module') { cur.fromModule = v; side = 'from'; } else if (k === 'from procedure') { cur.fromProc = v; side = 'from'; }
      else if (k === 'to module') { cur.toModule = v; side = 'to'; } else if (k === 'to procedure') { cur.toProc = v; side = 'to'; }
      else if (k === 'statement') { if (side === 'from') { cur.fromStmt = v.split(/\s+/)[0]; } else { cur.toStmt = v.split(/\s+/)[0]; } }
      else if (k === 'message') { cur.text = v; field = 'text'; continue; }
      else { cur.help = `${cur.help ? cur.help + '\n' : ''}${kv[1]}: ${v}`; field = 'help'; continue; }
      field = ''; continue;
    }
    const cont = line.trim();
    if (cont && field === 'text') { cur.text += ' ' + cont; } else if (cont && field === 'help') { cur.help += ' ' + cont; }
  }
  return out;
}

/** Tables a query reads (FROM / JOIN), qualified or not; IBM i catalog and services are left out. */
export function tablesInSql(sql: string): { library?: string; name: string }[] {
  const clean = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, ' ');
  const ctes = new Set([...clean.matchAll(/(?:\bWITH|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi)].map(m => m[1].toUpperCase()));
  const out = new Map<string, { library?: string; name: string }>();
  for (const m of clean.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+("?[A-Za-z$#@][A-Za-z0-9_$#@]*"?)(?:\s*([./])\s*("?[A-Za-z$#@][A-Za-z0-9_$#@]*"?))?/gi)) {
    const a = m[1].replace(/"/g, '').toUpperCase(); const b = m[3]?.replace(/"/g, '').toUpperCase();
    const t = b ? { library: a, name: b } : { name: a };
    if (!b && (ctes.has(a) || /^(TABLE|LATERAL|SELECT|FINAL|NEW|OLD)$/.test(a))) { continue; }
    if (t.library && /^(QSYS2|SYSIBM|SYSIBMADM|SYSTOOLS|QSYS)$/.test(t.library)) { continue; }
    out.set(`${t.library ?? ''}/${t.name}`, t);
  }
  return [...out.values()].slice(0, 10);
}

/** Lines changed on or after a source date (YYMMDD), with context lines, marked >> — the IBM i way to see "what I changed". */
export function datedChanges(lines: string[], dates: number[], since: number, context = 3, maxLines = 600): string {
  const changed = lines.map((_, i) => ((dates[i] ?? 0) >= since ? i : -1)).filter(i => i >= 0);
  if (!changed.length) { return ''; }
  const keep = new Set<number>();
  for (const i of changed) { for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) { keep.add(k); } }
  const out: string[] = []; let last = -2;
  for (const i of [...keep].sort((a, b) => a - b).slice(0, maxLines)) {
    if (i !== last + 1) { out.push(`@@ line ${i + 1} @@`); }
    out.push(`${changed.includes(i) ? '>>' : '  '}${String(i + 1).padStart(5)}| ${lines[i]}`);
    last = i;
  }
  return out.join('\n');
}
