import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { parseMemberPath, sqlString } from '../core/util';
import { IFS_SCHEME, MEMBER_SCHEME } from '../features/fileSystems';
import {
  AiCommand, COMMAND_HELP, PromptContext, buildUserMessage, firstCodeBlock, instructions, parseObjectRef, rowsToText,
} from './prompts';
import { registerAiTools } from './tools';

const PARTICIPANT = 'vanthrex.assistant';
const LANGS = new Set(['rpgle', 'cl', 'dds', 'sql', 'cobol', 'clle']);

function cfg() { return vscode.workspace.getConfiguration('vanthrex'); }

/** Code the user pointed at from a command (the editor may lose focus when the chat opens). */
let pending: { uri: vscode.Uri; range?: vscode.Range; at: number } | undefined;

const releases = new WeakMap<IbmiConnection, string>();
async function osRelease(conn: IbmiConnection): Promise<string | undefined> {
  if (releases.has(conn)) { return releases.get(conn); }
  try {
    const r = await conn.rows<{ V: string; R: string }>('SELECT OS_VERSION AS V, OS_RELEASE AS R FROM SYSIBMADM.ENV_SYS_INFO', 1);
    const v = r[0] ? `${String(r[0].V).trim()}.${String(r[0].R).trim()}` : '';
    releases.set(conn, v);
    return v || undefined;
  } catch { releases.set(conn, ''); return undefined; }
}

function label(uri: vscode.Uri): string {
  if (uri.scheme === MEMBER_SCHEME) { const m = parseMemberPath(uri.path); return `${m.library}/${m.file}(${m.member})`; }
  if (uri.scheme === IFS_SCHEME) { return uri.path; }
  return vscode.workspace.asRelativePath(uri);
}

/** The code to talk about: explicit #references, the code the command was run on, or the active editor. */
async function sourceContext(request: vscode.ChatRequest): Promise<PromptContext['source'] & { uri?: vscode.Uri } | undefined> {
  for (const ref of request.references ?? []) {
    const v = ref.value;
    if (v instanceof vscode.Location || v instanceof vscode.Uri) {
      const uri = v instanceof vscode.Location ? v.uri : v;
      const doc = await vscode.workspace.openTextDocument(uri);
      const range = v instanceof vscode.Location && !v.range.isEmpty ? v.range : undefined;
      return { uri, label: label(uri), language: doc.languageId, text: doc.getText(range), startLine: (range?.start.line ?? 0) + 1, selection: !!range };
    }
  }
  let uri: vscode.Uri | undefined;
  let range: vscode.Range | undefined;
  if (pending && Date.now() - pending.at < 120_000) { ({ uri, range } = pending); }
  else {
    const e = vscode.window.activeTextEditor;
    if (e && (LANGS.has(e.document.languageId) || e.document.uri.scheme.startsWith('vanthrex'))) {
      uri = e.document.uri;
      range = e.selection.isEmpty ? undefined : new vscode.Range(e.selection.start.line, 0, e.selection.end.line, e.document.lineAt(e.selection.end.line).text.length);
    }
  }
  pending = undefined;
  if (!uri) { return undefined; }
  const doc = await vscode.workspace.openTextDocument(uri);
  return { uri, label: label(uri), language: doc.languageId, text: doc.getText(range), startLine: (range?.start.line ?? 0) + 1, selection: !!range };
}

function compileDiagnostics(uri?: vscode.Uri): PromptContext['diagnostics'] {
  if (!uri) { return []; }
  return vscode.languages.getDiagnostics(uri)
    .filter(d => String(d.source ?? '').startsWith('IBM i') || d.severity === vscode.DiagnosticSeverity.Error)
    .map(d => ({ line: d.range.start.line + 1, message: d.message, code: typeof d.code === 'object' ? String(d.code.value) : d.code !== undefined ? String(d.code) : undefined }));
}

async function objectContext(conn: IbmiConnection | undefined, prompt: string): Promise<string[]> {
  const ref = parseObjectRef(prompt);
  if (!ref || !conn) { return []; }
  const out: string[] = [];
  try {
    const rows = await conn.rows<Record<string, unknown>>(
      `SELECT OBJNAME, OBJTYPE, OBJATTRIBUTE, OBJTEXT, OBJOWNER, OBJSIZE, VARCHAR(OBJCREATED) AS CREATED, VARCHAR(LAST_USED_TIMESTAMP) AS LAST_USED, DAYS_USED_COUNT, ` +
      `SOURCE_LIBRARY, SOURCE_FILE, SOURCE_MEMBER, JOURNALED FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(ref.library)}, ${sqlString(ref.type ?? '*ALL')}, ${sqlString(ref.name)}))`, 5);
    if (rows.length) { out.push(`Object ${ref.library}/${ref.name}:\n${rowsToText(Object.keys(rows[0]), rows)}`); }
    const r = rows[0];
    const lib = String(r?.SOURCE_LIBRARY ?? '').trim(), file = String(r?.SOURCE_FILE ?? '').trim(), mbr = String(r?.SOURCE_MEMBER ?? '').trim();
    if (lib && file && mbr) {
      const text = await conn.readMember(lib, file, mbr).catch(() => '');
      if (text) { out.push(`Its source ${lib}/${file}(${mbr}) (first part):\n\`\`\`\n${text.substring(0, 20000)}\n\`\`\``); }
    }
  } catch (e) { out.push(`(Could not look up the object: ${errorMessage(e)})`); }
  return out;
}

function historyMessages(context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  for (const turn of context.history.slice(-10)) {
    if (turn instanceof vscode.ChatRequestTurn) {
      out.push(vscode.LanguageModelChatMessage.User(`${turn.command ? '/' + turn.command + ' ' : ''}${turn.prompt}`));
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response.map(p => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : '')).join('');
      if (text) { out.push(vscode.LanguageModelChatMessage.Assistant(text)); }
    }
  }
  return out;
}

async function handle(manager: ConnectionManager, request: vscode.ChatRequest, chat: vscode.ChatContext,
  stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
  if (!cfg().get<boolean>('ai.enabled', true)) {
    stream.markdown('The Vanthrex AI assistant is turned off (setting `vanthrex.ai.enabled`).');
    return {};
  }
  const command = (request.command as AiCommand | undefined) ?? undefined;
  const conn = manager.connection;
  const needsSource = command && ['explain', 'document', 'fix', 'modernize', 'test', 'review'].includes(command);
  const source = await sourceContext(request);
  if (needsSource && !source) {
    stream.markdown('Open an RPG, CL, DDS or SQL source (or select some code) first, then ask again. You can also attach a file with **#**.');
    return {};
  }
  const ctx: PromptContext = {
    command, question: request.prompt,
    system: conn ? {
      name: conn.profile.name, user: conn.user, libraries: conn.profile.libraries, currentLibrary: conn.profile.currentLibrary,
      osRelease: await osRelease(conn),
    } : undefined,
    source: source && (needsSource || command === undefined || command === 'sql') ? source : undefined,
    diagnostics: command === 'fix' ? compileDiagnostics(source?.uri) : undefined,
    extra: command === 'object' ? await objectContext(conn, request.prompt) : [],
  };
  if (command === 'fix' && !ctx.diagnostics?.length) {
    stream.markdown('No compile errors are listed for this source. Compile it first (**Ctrl+Alt+C**), then ask again — or describe the problem.\n\n');
  }

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(instructions(command)),
    ...historyMessages(chat),
    vscode.LanguageModelChatMessage.User(buildUserMessage(ctx, cfg().get<number>('ai.maxSourceChars', 60000))),
  ];
  const tools = conn && cfg().get<boolean>('ai.useTools', true) ? vscode.lm.tools.filter(t => t.name.startsWith('vanthrex_')) : [];
  if (source?.uri) { stream.reference(source.uri); }

  let answer = '';
  for (let round = 0; round < 8; round++) {
    const response = await request.model.sendRequest(messages, { tools, justification: 'Vanthrex uses the language model to answer IBM i questions.' }, token);
    const calls: vscode.LanguageModelToolCallPart[] = [];
    let text = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) { stream.markdown(part.value); text += part.value; }
      else if (part instanceof vscode.LanguageModelToolCallPart) { calls.push(part); }
    }
    answer += text;
    if (!calls.length) { break; }
    messages.push(vscode.LanguageModelChatMessage.Assistant([...(text ? [new vscode.LanguageModelTextPart(text)] : []), ...calls]));
    for (const call of calls) {
      stream.progress(`Using ${call.name.replace('vanthrex_', '')}…`);
      let result: vscode.LanguageModelToolResult;
      try {
        result = await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: request.toolInvocationToken }, token);
      } catch (e) {
        result = new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Tool failed: ${errorMessage(e)}`)]);
      }
      messages.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, result.content)]));
    }
  }

  const sql = firstCodeBlock(answer, ['sql']);
  if (sql && (command === 'sql' || !command)) {
    stream.button({ command: 'vanthrex.ai.openSql', title: '$(database) Open in SQL scratchpad', arguments: [sql] });
    if (/^\s*(select|with|values)\b/i.test(sql)) {
      stream.button({ command: 'vanthrex.explainSql', title: '$(pulse) Explain performance', arguments: [sql] });
    }
  }
  return { metadata: { command } };
}

function openChat(query: string, partial = false): Thenable<unknown> {
  return vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: partial })
    .then(undefined, async () => {
      const c = await vscode.window.showWarningMessage(
        'The AI assistant needs a chat provider in VS Code, such as GitHub Copilot Chat.', 'Install GitHub Copilot Chat');
      if (c) { await vscode.commands.executeCommand('workbench.extensions.search', 'GitHub.copilot-chat'); }
    });
}

function rememberEditor(): void {
  const e = vscode.window.activeTextEditor;
  if (!e) { pending = undefined; return; }
  pending = {
    uri: e.document.uri, at: Date.now(),
    range: e.selection.isEmpty ? undefined : new vscode.Range(e.selection.start.line, 0, e.selection.end.line, e.document.lineAt(e.selection.end.line).text.length),
  };
}

/** Light bulb on IBM i compile errors: "Ask AI to fix". */
class FixWithAi implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];
  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    if (!cfg().get<boolean>('ai.enabled', true)) { return []; }
    const ibmi = ctx.diagnostics.filter(d => String(d.source ?? '').startsWith('IBM i'));
    if (!ibmi.length) { return []; }
    const a = new vscode.CodeAction('$(sparkle) Ask AI to explain and fix this compile error', vscode.CodeActionKind.QuickFix);
    a.command = { command: 'vanthrex.ai.fix', title: 'Ask AI to fix', arguments: [doc.uri] };
    a.diagnostics = ibmi;
    return [a];
  }
}

export function registerAi(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  registerAiTools(context, manager);
  if (!vscode.chat?.createChatParticipant) { log('Chat API not available in this VS Code — @vanthrex disabled'); return; }

  const participant = vscode.chat.createChatParticipant(PARTICIPANT, (req, chat, stream, token) =>
    handle(manager, req, chat, stream, token).catch(e => {
      logError(e);
      if (e instanceof vscode.LanguageModelError) {
        stream.markdown(`The language model could not answer: ${e.message}`);
      } else {
        stream.markdown(`Something went wrong: ${errorMessage(e)}`);
      }
      return {};
    }));
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  participant.followupProvider = {
    provideFollowups(result: vscode.ChatResult) {
      const cmd = (result.metadata as { command?: AiCommand } | undefined)?.command;
      const f: vscode.ChatFollowup[] = [];
      if (cmd === 'explain') { f.push({ prompt: 'Document this code', command: 'document', label: 'Write documentation comments' }, { prompt: '', command: 'review', label: 'Review it for problems' }); }
      if (cmd === 'review') { f.push({ prompt: '', command: 'modernize', label: 'Modernize to free-form RPG' }); }
      if (cmd === 'modernize' || cmd === 'document') { f.push({ prompt: '', command: 'test', label: 'Write unit tests' }); }
      if (cmd === 'sql') { f.push({ prompt: 'Make it faster and explain which index would help', label: 'Tune this query' }); }
      return f;
    },
  };

  const ask = (cmd: AiCommand) => () => { rememberEditor(); return openChat(`@vanthrex /${cmd} `); };
  context.subscriptions.push(
    participant,
    vscode.languages.registerCodeActionsProvider([{ language: 'rpgle' }, { language: 'cl' }, { language: 'dds' }, { language: 'sql' }, { language: 'cobol' }],
      new FixWithAi(), { providedCodeActionKinds: FixWithAi.kinds }),
    vscode.commands.registerCommand('vanthrex.ai.open', (query?: string) => openChat(`@vanthrex ${query ?? ''}`, !query)),
    vscode.commands.registerCommand('vanthrex.ai.explain', ask('explain')),
    vscode.commands.registerCommand('vanthrex.ai.document', ask('document')),
    vscode.commands.registerCommand('vanthrex.ai.review', ask('review')),
    vscode.commands.registerCommand('vanthrex.ai.modernize', ask('modernize')),
    vscode.commands.registerCommand('vanthrex.ai.test', ask('test')),
    vscode.commands.registerCommand('vanthrex.ai.fix', async (uri?: vscode.Uri) => {
      if (uri) { pending = { uri, at: Date.now() }; } else { rememberEditor(); }
      return openChat('@vanthrex /fix ');
    }),
    vscode.commands.registerCommand('vanthrex.ai.sql', async () => {
      const what = await vscode.window.showInputBox({ title: 'Describe the data you want', prompt: 'For example: customers in Paris with orders over 1000 last month', ignoreFocusOut: true });
      if (what?.trim()) { pending = undefined; return openChat(`@vanthrex /sql ${what.trim()}`); }
    }),
    vscode.commands.registerCommand('vanthrex.ai.explainObject', (n?: { library: string; name: string; type?: string }) =>
      openChat(n?.library ? `@vanthrex /object ${n.library}/${n.name} ${n.type ?? ''}` : '@vanthrex /object ', !n?.library)),
    vscode.commands.registerCommand('vanthrex.ai.openSql', async (sql: string) => {
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `-- Written by the Vanthrex AI assistant. Check it, then run with Ctrl+Enter.\n${sql.trim()}\n` });
      await vscode.window.showTextDocument(doc);
    }),
  );
  log(`AI assistant ready (@vanthrex: ${Object.keys(COMMAND_HELP).map(c => '/' + c).join(' ')})`);
}
