// RPG code checks (pure, unit tested). Returns findings; the extension turns them into diagnostics.
import { findOccurrences, isFixedLine, maskLine, parseRpg } from './parser';

export type LintSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface LintFinding {
  rule: string;
  message: string;
  severity: LintSeverity;
  line: number;
  start: number;
  end: number;
}

export interface LintOptions {
  rules?: Partial<Record<LintRule, boolean>>;
  maxProcedureLines?: number;
  /** /COPY members: declarations are used elsewhere and there is no main program. */
  isInclude?: boolean;
}

export type LintRule =
  | 'unused-definition' | 'goto' | 'program-end' | 'long-procedure'
  | 'numbered-indicator' | 'empty-on-error' | 'select-star' | 'mixed-format' | 'tag';

export const LINT_RULES: Record<LintRule, string> = {
  'unused-definition': 'Variables, constants and subroutines that are declared but never used',
  'goto': 'GOTO usage',
  'tag': 'TAG labels',
  'program-end': 'Main program without *INLR = *ON or RETURN',
  'long-procedure': 'Procedures longer than the configured number of lines',
  'numbered-indicator': 'Numbered indicators (*IN01-*IN99)',
  'empty-on-error': 'ON-ERROR blocks that silently swallow errors',
  'select-star': 'SELECT * in embedded SQL',
  'mixed-format': 'Fixed-format calculation specs in a free-format source',
};

export function lintRpg(text: string, options: LintOptions = {}): LintFinding[] {
  const enabled = (r: LintRule) => options.rules?.[r] !== false &&
    !(options.isInclude && (r === 'unused-definition' || r === 'program-end'));
  const maxProc = options.maxProcedureLines ?? 200;
  const parse = parseRpg(text);
  const lines = text.split(/\r?\n/);
  const masked = lines.map(l => maskLine(l, parse.fullyFree));
  const findings: LintFinding[] = [];
  const push = (rule: LintRule, severity: LintSeverity, line: number, start: number, end: number, message: string) => {
    if (enabled(rule)) { findings.push({ rule, severity, line, start, end: Math.max(end, start + 1), message }); }
  };

  // Unused standalone fields, constants and subroutines.
  if (enabled('unused-definition')) {
    for (const d of parse.definitions) {
      if (!['variable', 'constant', 'subroutine'].includes(d.kind)) { continue; }
      if (/\b(export|import)\b/i.test(d.detail)) { continue; }
      const uses = findOccurrences(text, d.name).filter(o => o.line !== d.line);
      if (uses.length === 0) {
        const what = d.kind === 'subroutine' ? 'Subroutine' : d.kind === 'constant' ? 'Constant' : 'Variable';
        push('unused-definition', 'hint', d.line, d.column, d.column + d.name.length, `${what} "${d.name}" is never used.`);
      }
    }
  }

  let fixedCalcs = 0;
  let freeStatements = 0;
  let firstFixedCalc = -1;
  for (let i = 0; i < lines.length; i++) {
    const code = masked[i];
    const upper = code.toUpperCase();
    const fixed = isFixedLine(lines[i], parse.fullyFree);
    if (fixed && lines[i][5].toUpperCase() === 'C') {
      fixedCalcs++;
      if (firstFixedCalc < 0) { firstFixedCalc = i; }
      const op = lines[i].substring(25, 35).trim().toUpperCase();
      if (op === 'GOTO') { push('goto', 'warning', i, 25, 35, 'GOTO makes the flow hard to follow; use a loop, LEAVE/ITER or a subprocedure.'); }
      if (op === 'TAG') { push('tag', 'info', i, 25, 35, 'TAG label (target of GOTO).'); }
    } else if (!fixed && code.trim()) {
      freeStatements++;
      const g = upper.match(/^\s*GOTO\b/);
      if (g) { push('goto', 'warning', i, upper.search(/GOTO/), upper.search(/GOTO/) + 4, 'GOTO makes the flow hard to follow; use a loop, LEAVE/ITER or a subprocedure.'); }
    }

    const ind = /\*IN(\d\d)\b/g;
    let m: RegExpExecArray | null;
    while ((m = ind.exec(upper))) {
      push('numbered-indicator', 'info', i, m.index, m.index + m[0].length,
        `Numbered indicator *IN${m[1]}: a named indicator (dcl-s name ind) is easier to read.`);
    }

    if (/\bEXEC\s+SQL\b/.test(upper)) {
      // Look at the rest of the statement (until ';') for SELECT *.
      let stmt = '';
      for (let j = i; j < Math.min(lines.length, i + 30); j++) { stmt += ' ' + lines[j]; if (masked[j].includes(';')) { break; } }
      if (/\bSELECT\s+\*\s+(INTO\b|FROM\b)/i.test(stmt)) {
        const at = upper.indexOf('EXEC');
        push('select-star', 'info', i, at, at + 8, 'SELECT * breaks when columns are added; list the columns you need.');
      }
    }

    if (/^\s*ON-ERROR\b/.test(upper)) {
      let j = i + 1;
      while (j < lines.length && !masked[j].trim()) { j++; }
      if (j < lines.length && /^\s*ENDMON\b/i.test(masked[j])) {
        const at = upper.search(/ON-ERROR/);
        push('empty-on-error', 'warning', i, at, at + 8, 'Empty ON-ERROR block: the error is silently ignored. Log it or handle it.');
      }
    }
  }

  if (enabled('mixed-format') && !parse.fullyFree && fixedCalcs > 0 && freeStatements > 0 && firstFixedCalc >= 0) {
    push('mixed-format', 'info', firstFixedCalc, 5, 35,
      `${fixedCalcs} fixed-format C-spec line(s) mixed with free format. Right-click → "Convert Fixed-Format C-Specs to Free".`);
  }

  for (const p of parse.procedures) {
    const len = p.end - p.start + 1;
    if (len > maxProc) {
      const col = Math.max(0, lines[p.start].toUpperCase().indexOf(p.name.toUpperCase()));
      push('long-procedure', 'info', p.start, col, col + p.name.length,
        `Procedure ${p.name} is ${len} lines long (limit ${maxProc}). Consider splitting it.`);
    }
  }

  // Main program must end: *INLR = *ON, RETURN, or a linear-main / NOMAIN module.
  if (enabled('program-end')) {
    const all = masked.join('\n').toUpperCase();
    const inProc = (i: number) => parse.procedures.some(p => i >= p.start && i <= p.end);
    const linearOrNoMain = /CTL-OPT[^;]*\b(NOMAIN|MAIN\s*\()/.test(all) ||
      lines.some((l, i) => isFixedLine(l, parse.fullyFree) && l[5].toUpperCase() === 'H' && /\b(NOMAIN|MAIN\s*\()/.test(masked[i].toUpperCase()));
    let mainCalcs = 0;
    let ends = false;
    for (let i = 0; i < lines.length; i++) {
      if (inProc(i)) { continue; }
      const u = masked[i].toUpperCase();
      if (isFixedLine(lines[i], parse.fullyFree)) {
        if (lines[i][5].toUpperCase() !== 'C') { continue; }
        mainCalcs++;
        const op = lines[i].substring(25, 35).trim().toUpperCase();
        if (op === 'RETURN' || (op === 'SETON' && /LR/.test(lines[i].substring(70, 76).toUpperCase())) || /\*INLR\s*=\s*\*ON/.test(u)) { ends = true; }
      } else if (u.trim() && !/^\s*(\*\*FREE|DCL-|END-|CTL-OPT|\/)/.test(u) && !/^\s*[\w$#@]+\s+(CHAR|VARCHAR|PACKED|ZONED|INT|UNS|IND|DATE|TIME|TIMESTAMP|LIKE|LIKEDS|POINTER)\b/.test(u)) {
        mainCalcs++;
        if (/\*INLR\s*=\s*\*ON\b/.test(u) || /^\s*RETURN\b/.test(u)) { ends = true; }
      }
    }
    if (!linearOrNoMain && mainCalcs > 0 && !ends) {
      push('program-end', 'warning', 0, 0, Math.max(1, lines[0].length),
        'The main program never sets *INLR = *ON or RETURNs, so it may not end the way you expect.');
    }
  }

  return findings;
}
