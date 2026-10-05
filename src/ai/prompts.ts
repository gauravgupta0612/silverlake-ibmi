// Prompt building for the IBM i AI assistant (pure module, unit tested — no vscode import).

export type AiCommand = 'explain' | 'document' | 'sql' | 'fix' | 'modernize' | 'test' | 'object' | 'review';

export const COMMAND_HELP: Record<AiCommand, string> = {
  explain: 'Explain the selected code or the open source in plain language',
  document: 'Write documentation comments for the procedures and the program',
  sql: 'Write Db2 for i SQL from a description (looks up real tables and columns)',
  fix: 'Explain and fix the compile errors of the open source',
  modernize: 'Rewrite fixed-format / old-style code as modern free-form RPG',
  test: 'Generate RPGUnit unit tests for a procedure',
  object: 'Explain an object: LIB/NAME *TYPE — what it is, where it is used, what it touches',
  review: 'Review the code for bugs, performance and maintainability issues',
};

const BASE = [
  'You are Vanthrex, an expert IBM i (AS/400, iSeries) developer assistant inside VS Code.',
  'You know RPG IV (fixed format and **FREE), CL, DDS, COBOL, Db2 for i SQL (system naming LIB/FILE and SQL naming LIB.FILE),',
  'IBM i services (QSYS2, SYSTOOLS), ILE concepts (modules, service programs, binding directories, activation groups) and IBM i operations.',
  'Be concise and practical. Use the exact object names from the context; never invent tables, columns or programs —',
  'when you need facts about the system (columns of a table, what an object is, data), call the vanthrex tools if they are available.',
  'You may only read data. Never suggest running a statement that deletes or changes data without saying so clearly.',
  'Put code in fenced blocks tagged rpgle, clle, sql, dds or cobol. Prefer fully free-form RPG (**FREE) for new code.',
].join(' ');

const BY_COMMAND: Record<AiCommand, string> = {
  explain: 'Explain what the code does for a developer new to it: purpose, inputs and outputs, files and programs used, main flow, and anything surprising. Use short sections and bullet points. Refer to line numbers when useful.',
  document: 'Write documentation comments for the code: a header comment block for the program/module (purpose, parameters, files used, change history placeholder) and a comment above each procedure (purpose, each parameter, return value, errors). Return the complete code with the comments added, in one fenced block, without changing any logic.',
  sql: 'Write a Db2 for i SQL statement for the request. First look up the real tables and columns with the tools (search objects, describe the table) instead of guessing. Use the library names from the library list when unqualified. Return the statement in one ```sql block, then explain it in two or three lines. Prefer SELECT; if the request needs a change (UPDATE/DELETE/INSERT) write it but warn clearly and include a WHERE clause.',
  fix: 'The compiler reported the errors listed. For each error explain the cause in one or two sentences, then give the corrected code. When the fix is local, show only the changed lines with their line numbers; otherwise show the corrected procedure.',
  modernize: 'Rewrite the code as modern, fully free-form RPG (**FREE): dcl-s/dcl-ds/dcl-pr/dcl-pi declarations, BIFs instead of MOVE/MOVEL, %found/%eof instead of indicators, qualified data structures, procedures instead of subroutines where it helps, and embedded SQL where it clearly simplifies native I/O. Keep the behaviour identical. Return the full rewritten source in one block, then list behaviour points the developer should check.',
  test: 'Write RPGUnit tests (TESTCASE service program, **FREE) for the procedure(s) in the code: setUp/tearDown when useful, one test per behaviour, assert with aEqual/iEqual/nEqual/assert, and mock data clearly marked. Also give the RUCRTRPG command to build it.',
  object: 'Explain the IBM i object described in the context: what it is, what it is for (from its text, source and references), who uses it and what it uses, and any risks (e.g. last used long ago, large size, journaling). Use the tools to look up more if needed.',
  review: 'Review the code like a senior IBM i developer: correctness bugs, error handling (MONITOR, %error, SQLSTATE), performance (I/O in loops, SQL), security (dynamic SQL injection, *ALLOBJ assumptions), and maintainability. Give a prioritised list with line references and concrete fixes.',
};

export interface PromptContext {
  command?: AiCommand;
  question: string;
  system?: { name: string; user: string; libraries: string[]; currentLibrary?: string; osRelease?: string };
  source?: { label: string; language: string; text: string; startLine: number; selection: boolean };
  diagnostics?: { line: number; message: string; code?: string }[];
  extra?: string[];
}

/** Keep the source within budget: whole lines, with a note when it was cut. */
export function clampSource(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) { return { text, truncated: false }; }
  const cut = text.lastIndexOf('\n', maxChars);
  return { text: text.substring(0, cut > 0 ? cut : maxChars), truncated: true };
}

/** Prefix lines with their numbers so the model can refer to them. */
export function numberLines(text: string, start = 1): string {
  const lines = text.split('\n');
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width, ' ')}| ${l}`).join('\n');
}

export function instructions(command?: AiCommand): string {
  return command ? `${BASE}\n\nTask: ${BY_COMMAND[command]}` : BASE;
}

/** The user message: context first, then the request. */
export function buildUserMessage(ctx: PromptContext, maxChars = 60000): string {
  const parts: string[] = [];
  if (ctx.system) {
    const s = ctx.system;
    parts.push(`Connected IBM i: ${s.name}${s.osRelease ? ` (IBM i ${s.osRelease})` : ''}, user ${s.user}, ` +
      `library list ${s.libraries.join(', ') || '(empty)'}${s.currentLibrary ? `, current library ${s.currentLibrary}` : ''}.`);
  } else {
    parts.push('No IBM i system is connected right now (tools that read the system will not work).');
  }
  if (ctx.source) {
    const c = clampSource(ctx.source.text, maxChars);
    parts.push(`${ctx.source.selection ? 'Selected code' : 'Source'} from ${ctx.source.label} (${ctx.source.language}${ctx.source.selection ? `, starting at line ${ctx.source.startLine}` : ''}):\n` +
      '```' + ctx.source.language + '\n' + numberLines(c.text, ctx.source.startLine) + '\n```' +
      (c.truncated ? '\n(The source was cut to fit; ask for a specific part if needed.)' : ''));
  }
  if (ctx.diagnostics?.length) {
    parts.push('Compiler messages:\n' + ctx.diagnostics.slice(0, 50).map(d => `- line ${d.line}: ${d.code ? d.code + ' ' : ''}${d.message}`).join('\n'));
  }
  for (const e of ctx.extra ?? []) { parts.push(e); }
  parts.push(`Request: ${ctx.question.trim() || defaultQuestion(ctx.command)}`);
  return parts.join('\n\n');
}

export function defaultQuestion(command?: AiCommand): string {
  switch (command) {
    case 'explain': return 'Explain this code.';
    case 'document': return 'Document this code.';
    case 'fix': return 'Fix the compile errors.';
    case 'modernize': return 'Modernize this code.';
    case 'test': return 'Write unit tests for this code.';
    case 'review': return 'Review this code.';
    case 'sql': return 'Write the SQL.';
    case 'object': return 'Explain this object.';
    default: return 'Help me with this.';
  }
}

/** First fenced code block of a language (or any language) in a markdown answer. */
export function firstCodeBlock(markdown: string, languages?: string[]): string | undefined {
  const re = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    if (!languages || languages.includes(m[1].toLowerCase())) { return m[2].replace(/\n$/, ''); }
  }
  return undefined;
}

/** "MYLIB/ORDENTRY *PGM" -> parts (type optional). */
export function parseObjectRef(text: string): { library: string; name: string; type?: string } | undefined {
  const m = text.trim().toUpperCase().match(/([A-Z$#@][A-Z0-9$#@_.]{0,9})\/([A-Z$#@][A-Z0-9$#@_.]{0,9})(?:\s+(\*[A-Z]+))?/);
  return m ? { library: m[1], name: m[2], type: m[3] } : undefined;
}

/** Format query rows as a compact markdown-ish table for the model. */
export function rowsToText(columns: string[], rows: Record<string, unknown>[], maxCell = 200): string {
  if (!rows.length) { return 'No rows.'; }
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? 'NULL' : String(v).replace(/\s+/g, ' ').trim();
    return s.length > maxCell ? s.substring(0, maxCell) + '…' : s;
  };
  return [columns.join(' | '), ...rows.map(r => columns.map(c => cell(r[c])).join(' | '))].join('\n');
}
