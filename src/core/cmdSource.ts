// Command definition source (.cmd: CMD, PARM, QUAL, ELEM, DEP statements): what the F4 prompt will look like and the
// mistakes CRTCMD would complain about, before compiling. Pure (no vscode import), unit tested.

import { clParam, clStatements } from './clLanguage';
import { ClCommandDef, ClParm } from './clCommand';

export interface CmdProblem { line: number; severity: 'error' | 'warning'; message: string }
export interface CmdPreview { def: ClCommandDef; problems: CmdProblem[]; lines: Record<string, number> }

const unq = (v: string | undefined) => (v ?? '').trim().replace(/^'(.*)'$/s, '$1').replace(/''/g, "'");
const KW = /^[A-Z][A-Z0-9]{0,9}$/;
const TYPES = new Set(['*DEC', '*LGL', '*CHAR', '*NAME', '*SNAME', '*CNAME', '*PNAME', '*GENERIC', '*HEX', '*ZEROELEM', '*INT2', '*INT4', '*UINT2', '*UINT4', '*DATE', '*TIME', '*VARNAME', '*NULL', '*CMDSTR', '*X']);

/** Values of a list parameter such as VALUES(A B 'C D') or SPCVAL((*ALL) (*NONE X)). */
function listValues(v: string | undefined): string[] {
  if (!v) { return []; }
  const out: string[] = []; let cur = ''; let depth = 0; let inString = false;
  for (const c of v) {
    if (c === "'") { inString = !inString; cur += c; continue; }
    if (!inString && c === '(') { depth++; if (depth === 1) { cur = ''; continue; } }
    if (!inString && c === ')') { depth--; if (depth === 0) { if (cur.trim()) { out.push(cur.trim().split(/\s+/)[0]); } cur = ''; continue; } }
    if (!inString && depth === 0 && /\s/.test(c)) { if (cur.trim()) { out.push(cur.trim()); } cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) { out.push(cur.trim().split(/\s+/)[0]); }
  return out.map(x => unq(x));
}

export function previewCommand(source: string, name = 'COMMAND'): CmdPreview {
  const problems: CmdProblem[] = [];
  const stmts = clStatements(source);
  const labels = new Map<string, { kind: 'QUAL' | 'ELEM'; parts: { prompt: string; type: string; line: number }[] }>();
  // Labelled QUAL / ELEM statements first (a PARM refers to them by label).
  let lastLabel: string | undefined;
  for (const s of stmts) {
    if (s.command === 'QUAL' || s.command === 'ELEM') {
      const label = s.label ?? lastLabel;
      if (!label) { problems.push({ line: s.line, severity: 'error', message: `${s.command} needs a label (the TYPE of the PARM or ELEM that uses it).` }); continue; }
      if (s.label) { lastLabel = s.label; if (labels.has(s.label)) { problems.push({ line: s.line, severity: 'error', message: `Label ${s.label} is defined twice.` }); } labels.set(s.label, { kind: s.command, parts: [] }); }
      const g = labels.get(label)!;
      const type = (clParam(s.text, 'TYPE') ?? '').toUpperCase();
      g.parts.push({ prompt: unq(clParam(s.text, 'PROMPT')) || (s.command === 'QUAL' ? (g.parts.length ? 'Library' : 'Name') : `Element ${g.parts.length + 1}`), type, line: s.line });
    } else { lastLabel = undefined; }
  }
  let prompt = ''; let cmdLine = -1;
  const parms: ClParm[] = []; const lines: Record<string, number> = {};
  for (const s of stmts) {
    if (s.command === 'CMD') { prompt = unq(clParam(s.text, 'PROMPT')); cmdLine = s.line; continue; }
    if (s.command !== 'PARM') { continue; }
    const kwd = (clParam(s.text, 'KWD') ?? '').toUpperCase();
    if (!kwd) { problems.push({ line: s.line, severity: 'error', message: 'PARM without KWD.' }); continue; }
    if (!KW.test(kwd)) { problems.push({ line: s.line, severity: 'error', message: `Keyword ${kwd} must be 1-10 letters and digits, starting with a letter.` }); }
    if (lines[kwd] !== undefined) { problems.push({ line: s.line, severity: 'error', message: `Keyword ${kwd} is defined twice (first on line ${lines[kwd] + 1}).` }); }
    lines[kwd] = s.line;
    const type = (clParam(s.text, 'TYPE') ?? '*CHAR').toUpperCase();
    const ref = labels.get(type);
    if (!type.startsWith('*') && !ref) { problems.push({ line: s.line, severity: 'error', message: `TYPE(${type}) refers to no QUAL or ELEM label.` }); }
    if (type.startsWith('*') && !TYPES.has(type)) { problems.push({ line: s.line, severity: 'warning', message: `TYPE(${type}) is not a known parameter type.` }); }
    const min = Number(clParam(s.text, 'MIN') ?? 0) || 0; const max = Number(clParam(s.text, 'MAX') ?? 1) || 1;
    if (min > max) { problems.push({ line: s.line, severity: 'error', message: `${kwd}: MIN(${min}) is larger than MAX(${max}).` }); }
    const dft = clParam(s.text, 'DFT');
    if (min > 0 && dft !== undefined) { problems.push({ line: s.line, severity: 'error', message: `${kwd}: a required parameter (MIN(${min})) cannot have DFT.` }); }
    const values = [...listValues(clParam(s.text, 'SPCVAL')), ...listValues(clParam(s.text, 'SNGVAL')), ...listValues(clParam(s.text, 'VALUES'))];
    const rstd = (clParam(s.text, 'RSTD') ?? '').toUpperCase() === '*YES';
    if (rstd && !values.length) { problems.push({ line: s.line, severity: 'error', message: `${kwd}: RSTD(*YES) needs VALUES, SPCVAL or SNGVAL.` }); }
    if (rstd && dft && !dft.startsWith('&') && !values.map(v => v.toUpperCase()).includes(unq(dft).toUpperCase())) {
      problems.push({ line: s.line, severity: 'warning', message: `${kwd}: DFT(${dft}) is not one of the allowed values.` });
    }
    const pr = unq(clParam(s.text, 'PROMPT'));
    if (!pr && !/\*NOPROMPT|PMTCTL/i.test(s.text) && (clParam(s.text, 'CONSTANT') === undefined)) { problems.push({ line: s.line, severity: 'warning', message: `${kwd} has no PROMPT text: F4 shows only the keyword.` }); }
    const len = clParam(s.text, 'LEN');
    if (/^\*(CHAR|NAME|SNAME|CNAME|DEC|HEX)$/.test(type) && len === undefined && !ref) { problems.push({ line: s.line, severity: 'warning', message: `${kwd}: no LEN given, the default length of ${type} applies.` }); }
    parms.push({ kwd, prompt: pr || kwd, type: ref ? (ref.kind === 'QUAL' ? 'QUAL' : 'ELEM') : type, min, max, len, dft: dft !== undefined ? unq(dft) : undefined, values, parts: ref ? ref.parts.map(p => p.prompt) : [] });
  }
  if (cmdLine < 0) { problems.push({ line: 0, severity: 'error', message: 'There is no CMD statement.' }); }
  else if (!prompt) { problems.push({ line: cmdLine, severity: 'warning', message: 'CMD has no PROMPT: the F4 screen has no title.' }); }
  if (parms.length > 75) { problems.push({ line: 0, severity: 'error', message: `A command can have at most 75 parameters (${parms.length}).` }); }
  for (const s of stmts.filter(x => x.command === 'DEP')) {
    for (const ref of (s.text.toUpperCase().match(/&([A-Z][A-Z0-9]{0,9})/g) ?? [])) {
      if (lines[ref.slice(1)] === undefined) { problems.push({ line: s.line, severity: 'error', message: `DEP refers to ${ref}, which is not a parameter.` }); }
    }
  }
  return { def: { name: name.toUpperCase(), library: '', prompt, parms }, problems: problems.sort((a, b) => a.line - b.line), lines };
}
