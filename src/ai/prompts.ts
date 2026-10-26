// Prompt building for the IBM i AI assistant (pure module, unit tested — no vscode import).

import { UNTRUSTED_RULE, untrusted } from '../core/aiGuard';

export type AiCommand = 'explain' | 'document' | 'sql' | 'fix' | 'modernize' | 'test' | 'object' | 'review' | 'errors' | 'depends' | 'joblog'
  | 'tune' | 'sqlio' | 'cl' | 'data' | 'health' | 'security' | 'changes' | 'spool';

export const COMMAND_HELP: Record<AiCommand, string> = {
  explain: 'Explain the selected code or the open source in plain language',
  document: 'Write documentation comments for the procedures and the program',
  sql: 'Write Db2 for i SQL from a description (looks up real tables and columns)',
  fix: 'Explain and fix the compile errors of the open source',
  modernize: 'Rewrite fixed-format / old-style code as modern free-form RPG',
  test: 'Generate RPGUnit unit tests for a procedure',
  object: 'Explain an object: LIB/NAME *TYPE — what it is, where it is used, what it touches',
  review: 'Review the code for bugs, performance and maintainability issues',
  errors: 'Explain the compile errors of the open source in plain language, with the IBM help text and the lines involved',
  depends: 'Explain the dependencies of a program: LIB/PGM — modules, service programs, files, called programs and who uses it',
  joblog: 'Find why a job failed and recommend a fix: number/user/name — reads the job log and the failing source statement',
  tune: 'Make the SQL statement at the cursor faster: table sizes, existing indexes and the optimizer\'s index advice are read first',
  sqlio: 'Convert native record I/O (CHAIN, READ, SETLL, WRITE, UPDATE…) to embedded SQL',
  cl: 'Write a CL program or command from a description, with the real command definitions of the system',
  data: 'Write realistic test data (INSERT statements) for a table: LIB/TABLE — only its structure is read, never its rows',
  health: 'Check the health of the system now and say what needs attention',
  security: 'Review who can use an object or a library: LIB/OBJ *TYPE or LIB — authorities, *PUBLIC, owner, adopted authority',
  changes: 'Review only what you changed in the open source (not the whole member)',
  spool: 'Explain the open spooled file (a dump, a report, a compile listing, a job log)',
};

const BASE = [
  'You are Vanthrex, an expert IBM i (AS/400, iSeries) developer assistant inside VS Code.',
  'You know RPG IV (fixed format and **FREE), CL, DDS, COBOL, Db2 for i SQL (system naming LIB/FILE and SQL naming LIB.FILE),',
  'IBM i services (QSYS2, SYSTOOLS), ILE concepts (modules, service programs, binding directories, activation groups) and IBM i operations.',
  'Be concise and practical. Use the exact object names from the context; never invent tables, columns or programs —',
  'when you need facts about the system (columns of a table, what an object is, data), call the vanthrex tools if they are available.',
  'You may only read data. Never suggest running a statement that deletes or changes data without saying so clearly.',
  'Put code in fenced blocks tagged rpgle, clle, sql, dds or cobol. Prefer fully free-form RPG (**FREE) for new code.',
  UNTRUSTED_RULE,
].join(' ');

const BY_COMMAND: Record<AiCommand, string> = {
  explain: 'Explain what the code does for a developer new to it: purpose, inputs and outputs, files and programs used, main flow, and anything surprising. Use short sections and bullet points. Refer to line numbers when useful.',
  document: 'Write documentation comments for the code: a header comment block for the program/module (purpose, parameters, files used and how — use the real dependency facts when they are given —, programs called, change history placeholder) and a comment above each procedure and subroutine (purpose, each parameter, return value, errors). Use the comment style of the source (// in free form, * in column 7 in fixed form). Return the complete code with the comments added, in one fenced block, without changing any logic. After the block, add a short Markdown summary of the program that can go into a wiki.',
  sql: 'Write a Db2 for i SQL statement for the request. First look up the real tables and columns with the tools (search objects, describe the table) instead of guessing. Use the library names from the library list when unqualified. Return the statement in one ```sql block, then explain it in two or three lines. Prefer SELECT; if the request needs a change (UPDATE/DELETE/INSERT) write it but warn clearly and include a WHERE clause.',
  fix: 'The compiler reported the errors listed. For each error explain the cause in one or two sentences, then give the corrected code. When the fix is local, show only the changed lines with their line numbers; otherwise show the corrected procedure.',
  modernize: 'Rewrite the code as modern, fully free-form RPG (**FREE): dcl-s/dcl-ds/dcl-pr/dcl-pi declarations, BIFs instead of MOVE/MOVEL, %found/%eof instead of indicators, qualified data structures, procedures instead of subroutines where it helps, and embedded SQL where it clearly simplifies native I/O. Keep the behaviour identical. Return the full rewritten source in one block, then list behaviour points the developer should check.',
  test: 'Suggest and write RPGUnit tests (TESTCASE service program, **FREE) for the procedure(s) in the code. First list the behaviours worth testing for each procedure (normal cases, boundaries, error paths, each IF/SELECT branch), using the procedure signatures and data structure layouts given. Then write the test source: the prototypes (or the /COPY that has them), setUp/tearDown when useful, one test procedure per behaviour named after it, assertions with aEqual/iEqual/nEqual/assert, and test data clearly marked; procedures that read files or call programs need a note on the data to prepare. Also give the RUCRTRPG command to build it and RUCALLTST to run it.',
  object: 'Explain the IBM i object described in the context: what it is, what it is for (from its text, source and references), who uses it and what it uses, and any risks (e.g. last used long ago, large size, journaling). Use the tools to look up more if needed.',
  errors: 'The compiler reported the errors listed, with the source lines around each one (marked >>) and IBM\'s help text. For each error, worst first: say in plain words what the compiler is complaining about, why it happens at that line (refer to the line numbers and names), and the smallest change that fixes it, as a short code snippet. Group errors that have the same cause (one missing definition often causes many errors) and say which errors will disappear when the first one is fixed. Do not rewrite the whole source.',
  depends: 'Explain the dependencies of the program described in the context, for a developer who has to change or move it: what it is, how it is built (modules and their sources, service programs, binding directories, activation group), which files it reads or updates, which programs and data areas it calls or uses, and who uses it. Then list the impact of typical changes: what must be recompiled or re-bound if a file or a service program it uses changes, and what to promote together. Base everything on the facts given; say when something is unknown. Finish with a small text diagram of the main call / use relationships.',
  joblog: 'A job failed. You get the job log (the most likely cause first, grouped errors, the last messages in order) and, when it was found, the source of the failing program with the failing statement marked >>. Explain what happened in order, the root cause (not just the last message), and recommend a concrete fix: the code change at the failing statement (with line numbers), or the operational fix (authority, library list, lock, data, recompile after a level check). If the statement mapping is approximate, say so. End with how to prevent it (MONITOR, error handling, checks).',
  tune: 'Make the SQL statement faster. You get the statement and, for each table it reads, its size, its indexes (with how often queries used them) and the optimizer\'s index advice. Explain what is slow and why, then give: the rewritten statement when a rewrite helps (in one ```sql block), the CREATE INDEX statements worth creating (names, key columns in the right order, ON the real tables — warn about the cost on large tables), and what to check in Visual Explain. Never suggest dropping an index without saying what uses it.',
  sqlio: 'Convert the native record I/O of the code (CHAIN, READ, READE, READP, SETLL, SETGT, WRITE, UPDATE, DELETE, %FOUND, %EOF, F-specs / DCL-F) to embedded SQL in **FREE RPG: cursors for loops, SELECT INTO for single reads, SQLSTATE checks instead of %found/%eof, host data structures (EXTNAME) for the rows, and SET OPTION COMMIT = *NONE where files are not journaled. Keep the behaviour identical (key positioning, read order, locking: mention where FOR UPDATE is needed). Return the converted source in one block, then list behaviour points to test.',
  cl: 'Write the CL the user asks for (a program, a command source, or a one-off command), in modern CLLE: DCL with TYPE and LEN, MONMSG for expected errors with a clear message, comments. Use only commands and parameters that exist — look them up with the command tool when unsure. Return it in one ```clle block, then explain how to compile it (CRTBNDCL) and run it, and any authority it needs.',
  data: 'Write realistic but invented test data for the table described (columns, types, keys, constraints): INSERT statements that respect the lengths, types, keys (unique values), foreign keys (only values that can exist) and nullability, with varied and plausible values (names, dates, amounts) — never real personal data. Default 20 rows unless asked. Use the table name exactly as given and add WITH NC. Return one ```sql block.',
  health: 'You get the current status of the IBM i (CPU, storage, jobs waiting for a reply, top CPU jobs, QSYSOPR messages, subsystems). Say in a few lines whether the system is healthy, then list what needs attention now, most urgent first, each with why and the exact next step (the Vanthrex screen or the CL command to use). Do not invent numbers that are not in the data.',
  security: 'You get the authorities of an IBM i object or of the objects of a library (private and *PUBLIC authority, owner, authorization list, adopted authority). Review them like an IBM i security officer: who can read, change or delete what, *PUBLIC exposure (especially *CHANGE / *ALL), programs that adopt a powerful owner, objects owned by individual users instead of a group profile. Give a prioritised list of findings with the exact GRTOBJAUT / RVKOBJAUT / CHGOBJOWN commands to fix each one, and warn about what each change could break.',
  changes: 'You get only the lines that changed in a source (a diff: - removed, + added, with line numbers and a few unchanged lines around each change). Review the change like a careful colleague before it is compiled or promoted: bugs introduced, missing error handling, side effects on code outside the diff that you can infer, naming and style consistent with the surrounding lines. Be specific with line numbers. If the change looks good, say so briefly.',
  spool: 'Explain the spooled file: what kind of output it is (a program dump, a job log, a compile listing, a report, a DSPxxx listing), what it says in plain words, and what to do about it. For a dump or a job log, find the error and its cause; for a compile listing, the errors; for a report, what it shows and anything unusual. Quote the important lines.',
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
    parts.push(untrusted(ctx.source.label, `${ctx.source.selection ? 'Selected code' : 'Source'} from ${ctx.source.label} (${ctx.source.language}${ctx.source.selection ? `, starting at line ${ctx.source.startLine}` : ''}):\n` +
      '```' + ctx.source.language + '\n' + numberLines(c.text, ctx.source.startLine) + '\n```' +
      (c.truncated ? '\n(The source was cut to fit; ask for a specific part if needed.)' : '')));
  }
  if (ctx.diagnostics?.length) {
    parts.push('Compiler messages:\n' + ctx.diagnostics.slice(0, 50).map(d => `- line ${d.line}: ${d.code ? d.code + ' ' : ''}${d.message}`).join('\n'));
  }
  for (const e of ctx.extra ?? []) { parts.push(untrusted('system', e)); }
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
    case 'errors': return 'Explain the compile errors.';
    case 'depends': return 'Explain the dependencies of this program.';
    case 'joblog': return 'Why did this job fail, and how do I fix it?';
    case 'tune': return 'Make this SQL faster.';
    case 'sqlio': return 'Convert the native I/O of this code to embedded SQL.';
    case 'cl': return 'Write the CL.';
    case 'data': return 'Write 20 rows of test data.';
    case 'health': return 'Is the system healthy? What needs attention?';
    case 'security': return 'Review the authorities.';
    case 'changes': return 'Review my changes.';
    case 'spool': return 'Explain this spooled file.';
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
