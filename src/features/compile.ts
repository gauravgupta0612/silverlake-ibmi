import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, log, logError, showLog } from '../core/log';
import { parseEvfEvent, parseQsysPath, EvfError } from '../core/evfevent';
import { objectNameFromFile, parseMemberPath, substituteVariables, CompileVariables } from '../core/util';
import { IFS_SCHEME, MEMBER_SCHEME, ifsUri, memberUri } from './fileSystems';

export interface CompileAction {
  name: string;
  command: string;
  extensions: string[];
  source?: 'member' | 'ifs' | 'both';
}

const LAST_ACTION_KEY = 'silverlake.lastCompileAction';

export class Compiler {
  readonly diagnostics = vscode.languages.createDiagnosticCollection('IBM i');

  constructor(private readonly manager: ConnectionManager, private readonly state: vscode.Memento) {}

  async compile(target?: vscode.Uri | { resourceUri?: vscode.Uri; path?: string; kind?: string }, alwaysAsk = false): Promise<void> {
    const uri = this.resolveUri(target);
    if (!uri) {
      vscode.window.showWarningMessage('Open a source member or IFS source file to compile.');
      return;
    }
    if (uri.scheme !== MEMBER_SCHEME && uri.scheme !== IFS_SCHEME) {
      vscode.window.showWarningMessage('Compile works on members and IFS files opened from the Silverlake views.');
      return;
    }
    const conn = this.manager.require();

    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (doc?.isDirty) { await doc.save(); }

    const isMember = uri.scheme === MEMBER_SCHEME;
    const vars: CompileVariables = { CURLIB: conn.profile.currentLibrary || 'QGPL', USER: conn.user };
    let ext: string;
    if (isMember) {
      const m = parseMemberPath(uri.path);
      ext = m.extension;
      Object.assign(vars, {
        LIB: m.library, SRCFILE: m.file, NAME: m.member, EXT: ext,
        OBJLIB: conn.profile.objectLibrary || m.library,
      });
    } else {
      const fileName = uri.path.split('/').pop() ?? '';
      ext = (fileName.split('.').pop() ?? '').toLowerCase();
      Object.assign(vars, {
        NAME: objectNameFromFile(fileName), EXT: ext, FULLPATH: uri.path,
        OBJLIB: conn.profile.objectLibrary || conn.profile.currentLibrary || 'QGPL',
        LIB: conn.profile.currentLibrary || 'QGPL',
      });
    }

    const action = await this.pickAction(ext, isMember ? 'member' : 'ifs', alwaysAsk);
    if (!action) { return; }
    const command = substituteVariables(action.command, vars);

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Compiling ${vars.NAME}…`, cancellable: false },
      () => conn.runCL(command));

    // Collect inline errors from the events file when the compiler wrote one.
    let errors: EvfError[] = [];
    if (/\*EVENTF/i.test(command) && vars.OBJLIB && vars.NAME) {
      try {
        const evf = await conn.readMember(vars.OBJLIB, 'EVFEVENT', vars.NAME);
        errors = parseEvfEvent(evf);
      } catch (e) {
        log(`No events file found for ${vars.OBJLIB}/${vars.NAME}: ${errorMessage(e)}`);
      }
    }
    this.publish(uri, ext, errors);

    const errorCount = errors.filter(e => e.severity >= 30).length;
    const warnCount = errors.filter(e => e.severity >= 20 && e.severity < 30).length;
    if (result.ok) {
      const extra = warnCount ? ` with ${warnCount} warning(s)` : '';
      vscode.window.showInformationMessage(`✔ ${vars.NAME} compiled into ${vars.OBJLIB}${extra}.`,
        ...(warnCount ? ['Show Problems'] : []))
        .then(c => { if (c) { vscode.commands.executeCommand('workbench.actions.view.problems'); } });
    } else {
      const summary = errorCount ? `${errorCount} error(s)` : (result.messages.slice(-1)[0] ?? 'see log');
      const choice = await vscode.window.showErrorMessage(`✖ ${vars.NAME} failed to compile: ${summary}.`,
        'Show Problems', 'Show Log');
      if (choice === 'Show Problems') { vscode.commands.executeCommand('workbench.actions.view.problems'); }
      if (choice === 'Show Log') { showLog(); }
    }
  }

  private resolveUri(target?: vscode.Uri | { resourceUri?: vscode.Uri; path?: string; kind?: string }): vscode.Uri | undefined {
    if (target instanceof vscode.Uri) { return target; }
    if (target && 'kind' in target && target.kind === 'member') {
      const m = target as unknown as { library: string; file: string; member: string; type: string };
      return memberUri(m.library, m.file, m.member, m.type);
    }
    if (target && 'path' in target && typeof target.path === 'string' && !('kind' in target)) {
      return ifsUri(target.path);
    }
    return vscode.window.activeTextEditor?.document.uri;
  }

  private async pickAction(ext: string, source: 'member' | 'ifs', alwaysAsk: boolean): Promise<CompileAction | undefined> {
    const all = vscode.workspace.getConfiguration('silverlake').get<CompileAction[]>('compileActions', []);
    const candidates = all.filter(a =>
      a.extensions.map(x => x.toLowerCase()).includes(ext) &&
      ((a.source ?? 'member') === source || a.source === 'both'));
    if (!candidates.length) {
      const choice = await vscode.window.showWarningMessage(
        `No compile action is defined for ".${ext}" ${source === 'ifs' ? 'IFS files' : 'members'}.`, 'Open Settings');
      if (choice) { vscode.commands.executeCommand('workbench.action.openSettings', 'silverlake.compileActions'); }
      return undefined;
    }
    const lastMap = this.state.get<Record<string, string>>(LAST_ACTION_KEY, {});
    const key = `${source}:${ext}`;
    if (!alwaysAsk) {
      if (candidates.length === 1) { return candidates[0]; }
      const last = candidates.find(c => c.name === lastMap[key]);
      if (last) { return last; }
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map(a => ({ label: a.name, detail: a.command, action: a })),
      { title: `Compile .${ext}`, placeHolder: 'Choose how to compile (your choice is remembered)' });
    if (!pick) { return undefined; }
    await this.state.update(LAST_ACTION_KEY, { ...lastMap, [key]: pick.action.name });
    return pick.action;
  }

  private publish(sourceUri: vscode.Uri, ext: string, errors: EvfError[]): void {
    this.diagnostics.delete(sourceUri);
    const byUri = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
    const add = (uri: vscode.Uri, d: vscode.Diagnostic) => {
      const k = uri.toString();
      if (!byUri.has(k)) { byUri.set(k, { uri, list: [] }); }
      byUri.get(k)!.list.push(d);
    };

    for (const e of errors) {
      if (e.severity === 0 && /^RNF7031|^RNF7066|^RNF7086/.test(e.messageId)) { continue; } // "not referenced" noise
      let uri = sourceUri;
      let line = Math.max(0, e.line - 1);
      let message = e.message;
      if (e.generated) {
        line = 0;
        message = `${message} (reported on generated source line ${e.line})`;
      } else if (!e.isMainFile && e.file) {
        const m = parseQsysPath(e.file);
        if (m) { uri = memberUri(m.library, m.file, m.member, ext === 'sqlrpgle' ? 'rpgleinc' : ext); }
        else if (e.file.startsWith('/')) { uri = ifsUri(e.file); }
      }
      const startCol = Math.max(0, e.column - 1);
      const endCol = e.endColumn > 0 && e.endLine === e.line ? Math.max(startCol + 1, e.endColumn) : startCol + 1;
      const range = new vscode.Range(line, startCol, Math.max(line, e.generated ? 0 : e.endLine - 1), endCol);
      const d = new vscode.Diagnostic(range, message, toSeverity(e.severity));
      d.code = e.messageId;
      d.source = `IBM i (sev ${e.severity})`;
      add(uri, d);
    }
    for (const { uri, list } of byUri.values()) {
      this.diagnostics.set(uri, list);
    }
  }

  dispose(): void { this.diagnostics.dispose(); }
}

function toSeverity(sev: number): vscode.DiagnosticSeverity {
  if (sev >= 30) { return vscode.DiagnosticSeverity.Error; }
  if (sev >= 20) { return vscode.DiagnosticSeverity.Warning; }
  if (sev >= 10) { return vscode.DiagnosticSeverity.Information; }
  return vscode.DiagnosticSeverity.Hint;
}

export function registerCompile(context: vscode.ExtensionContext, manager: ConnectionManager): Compiler {
  const compiler = new Compiler(manager, context.globalState);
  const run = (alwaysAsk: boolean) => async (target?: never) => {
    try { await compiler.compile(target, alwaysAsk); }
    catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    compiler,
    vscode.commands.registerCommand('silverlake.compile', run(false)),
    vscode.commands.registerCommand('silverlake.compileWith', run(true)),
  );
  return compiler;
}
