import * as vscode from 'vscode';
import { errorMessage, initLog, log, logError, showLog } from './core/log';
import { ProfileStore } from './core/profiles';
import { ConnectionManager } from './core/manager';
import { ConnectionTreeProvider } from './views/connectionTree';
import { LibraryTreeProvider } from './views/libraryTree';
import { IfsTreeProvider } from './views/ifsTree';
import { SpoolTreeProvider } from './views/spoolTree';
import { IFS_SCHEME, IfsFileSystem, MEMBER_SCHEME, MEMBER_VIEW_SCHEME, MemberFileSystem } from './features/fileSystems';
import { registerBrowseCommands } from './features/browseCommands';
import { registerCompile } from './features/compile';
import { registerSql } from './features/sqlRunner';
import { registerSpool } from './features/spool';
import { registerRpgFeatures } from './rpg/rpgFeatures';
import { registerRpgNavigation } from './rpg/navigation';
import { registerRpgLint } from './rpg/lintProvider';
import { registerDashboard } from './features/dashboard';
import { registerJobs } from './features/jobs';
import { registerDataEditor } from './features/dataEditor';
import { registerSearch } from './features/search';
import { registerSqlAssist } from './features/sqlAssist';
import { registerHistory } from './features/history';
import { registerSourceDates } from './features/sourceDatesView';
import { registerLocks } from './features/locks';
import { registerPrompters } from './features/prompter';
import { registerObjectTools } from './features/objectTools';
import { registerSqlTools } from './features/sqlTools';
import { registerProcedureTools } from './rpg/procCommands';
import { registerDebugger } from './features/debugger';
import { registerSqlExplain } from './features/sqlExplain';
import { registerCallGraph } from './features/callGraphView';
import { registerProcedureCallers } from './features/procedureCallers';
import { registerSqlQueryPanel } from './features/sqlQueryPanel';
import { registerGit } from './git/gitSync';
import { registerAi } from './ai/assistant';
import { registerInsights } from './features/insightsView';
import { registerAdmin } from './features/adminView';
import { registerWorkWith } from './features/workWithView';

import { registerDataTransfer } from './features/dataTransferView';
import { registerPerfMonitor } from './features/perfMonitor';
import { registerCodeTools } from './features/codeToolsView';
import { registerRpgUnit } from './features/rpgUnit';
import { registerProtection, registerSelfCheck } from './features/selfCheck';
import { registerDspfPreview } from './features/dspfPreview';
import { registerErd } from './features/erdView';
import { registerCrossSystem } from './features/crossSystem';
import { registerSpoolExtras } from './features/spoolExtras';
import { registerSecadm } from './features/secadmView';
import { registerPdm } from './features/pdmView';
import { registerTracker } from './features/trackerView';
import { registerGreenScreen } from './features/greenScreenView';
import { registerActiveJobs } from './features/activeJobsView';
import { registerPrinterFile } from './features/printerFileView';
import { registerObjectCopy } from './features/objectCopyView';
import { registerDatabaseTools } from './features/databaseToolsView';
import { registerJobTools } from './features/jobToolsView';
import { registerIfsTools } from './features/ifsToolsView';
import { registerSystemTools } from './features/systemToolsView';
import { registerMemberTools } from './features/memberToolsView';
import { registerBindingTools } from './features/bindingToolsView';
import { registerSecurityTools } from './features/securityToolsView';
import { registerSourceAnalysis } from './features/sourceAnalysisView';
import { registerPinned } from './features/pinnedView';
import { registerConnectionStability } from './features/connectionStabilityView';
import { registerProgramCall } from './features/programCallView';
import { registerMemberNotes } from './features/memberNotesView';
import { registerOperations } from './features/operationsView';
import { registerSqlFormat } from './features/sqlFormatView';
import { registerLocalDev } from './features/localDevView';
import { registerTerminal } from './features/terminalView';
import { registerNotebooks } from './features/notebookView';
import { registerSqlErrorLog } from './features/sqlErrorLogView';
import { registerSchema } from './features/schemaView';
import { registerEditorAssist } from './features/editorAssistView';
import { ifsDropController, registerIfsTransfer } from './features/ifsTransferView';
import type { Compiler } from './features/compile';
import { registerClAssist } from './features/clAssistView';
import { registerCompileFixes } from './features/compileFixesView';
import { registerSqlLens } from './features/sqlLensView';
import { registerCodeGen } from './features/codeGenView';
import { registerTableTools } from './features/tableToolsView';
import { registerCmdPreview } from './features/cmdPreviewView';
import { registerIfsSync } from './features/ifsSyncView';
import { registerWorkExtras } from './features/workExtrasView';

let manager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(initLog());
  log(`Vanthrex ${context.extension?.packageJSON?.version ?? ""} starting (VS Code ${vscode.version}, ${process.platform})`);
  vscode.commands.executeCommand('setContext', 'vanthrex.connected', false);

  // Each feature starts on its own: if one fails, the others (and the error report) still work.
  const failures: string[] = [];
  const startedAt = Date.now();
  const slowSteps: string[] = [];
  const step = (name: string, fn: () => void) => {
    const t0 = Date.now();
    try { fn(); }
    catch (e) { failures.push(`${name}: ${errorMessage(e)}`); logError(e); }
    const ms = Date.now() - t0;
    if (ms >= 50) { slowSteps.push(`${name} ${ms} ms`); }
  };

  const profiles = new ProfileStore(context);
  manager = new ConnectionManager(profiles);
  context.subscriptions.push(manager);
  const m = manager;

  const libraries = new LibraryTreeProvider(m);
  const ifs = new IfsTreeProvider(m);
  const spool = new SpoolTreeProvider(m);

  step('commands', () => registerBrowseCommands(context, m, libraries, ifs));
  step('views', () => context.subscriptions.push(
    vscode.window.registerTreeDataProvider('vanthrex.connections', new ConnectionTreeProvider(m)),
    vscode.window.createTreeView('vanthrex.libraries', { treeDataProvider: libraries, showCollapseAll: true }),
    vscode.window.createTreeView('vanthrex.ifs', { treeDataProvider: ifs, showCollapseAll: true, dragAndDropController: ifsDropController(m, ifs), canSelectMany: false }),
    vscode.window.registerTreeDataProvider('vanthrex.spool', spool),
  ));
  step('file systems', () => context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(MEMBER_SCHEME, new MemberFileSystem(m), { isCaseSensitive: false }),
    vscode.workspace.registerFileSystemProvider(MEMBER_VIEW_SCHEME, new MemberFileSystem(m), { isCaseSensitive: false,
      isReadonly: new vscode.MarkdownString(vscode.l10n.t('Opened for display (PDM option 5). Use option 2 to edit.')) }),
    // A member opened for editing must never stay read-only: earlier builds marked members read-only for the session
    // when they were displayed with PDM option 5, which made later edits impossible to save (issue #3).
    vscode.window.onDidChangeActiveTextEditor(ed => {
      if (ed?.document.uri.scheme === MEMBER_SCHEME) { void vscode.commands.executeCommand('workbench.action.files.resetActiveEditorReadonlyInSession').then(undefined, () => undefined); }
    }),
    vscode.workspace.registerFileSystemProvider(IFS_SCHEME, new IfsFileSystem(m), { isCaseSensitive: true }),
  ));
  let compiler: Compiler | undefined;
  step('compile', () => { compiler = registerCompile(context, m); });
  step('sql', () => registerSql(context, m));
  step('spool', () => registerSpool(context, m, spool));
  step('rpg', () => registerRpgFeatures(context));
  step('rpg navigation', () => registerRpgNavigation(context, m));
  step('rpg checks', () => registerRpgLint(context));
  step('dashboard', () => registerDashboard(context, m));
  step('jobs & messages', () => registerJobs(context, m));
  step('data editor', () => registerDataEditor(context, m));
  step('search', () => registerSearch(context, m));
  step('sql assist', () => registerSqlAssist(context, m));
  step('local history', () => registerHistory(context, m));
  step('source dates', () => registerSourceDates(context));
  step('member locks', () => registerLocks(context, m));
  step('prompters', () => registerPrompters(context, m));
  step('object tools', () => registerObjectTools(context, m));
  step('sql tools', () => registerSqlTools(context, m));
  step('procedure tools', () => registerProcedureTools(context, m));
  step('debugger', () => registerDebugger(context, m));
  step('sql explain', () => registerSqlExplain(context, m));
  step('call graph', () => registerCallGraph(context, m));
  step('procedure callers', () => registerProcedureCallers(context, m));
  step('sql query panel', () => registerSqlQueryPanel(context, m));
  step('git', () => registerGit(context, m));
  step('ai assistant', () => registerAi(context, m));
  step('insights', () => registerInsights(context, m));
  step('system tools', () => registerAdmin(context, m));
  step('work with', () => registerWorkWith(context, m));
  step('data transfer', () => registerDataTransfer(context, m));
  step('performance', () => registerPerfMonitor(context, m));
  step('code tools', () => registerCodeTools(context, m));
  step('rpgunit', () => registerRpgUnit(context, m));
  step('self-check', () => registerSelfCheck(context, m));
  step('protection', () => registerProtection(context, m));
  step('screen preview', () => registerDspfPreview(context));
  step('database diagram', () => registerErd(context, m));
  step('cross-system compare', () => registerCrossSystem(context, m));
  step('spool pdf & e-mail', () => registerSpoolExtras(context, m));
  step('security admin', () => registerSecadm(context, m));
  step('PDM', () => registerPdm(context, m));
  step('System Tracker', () => registerTracker(context, m));
  step('green screen', () => registerGreenScreen(context, m));
  step('work with active jobs', () => registerActiveJobs(context, m));
  step('printer file preview', () => registerPrinterFile(context, m));
  step('copy objects and members', () => registerObjectCopy(context, m));
  step('database tools', () => registerDatabaseTools(context, m));
  step('job tools', () => registerJobTools(context, m));
  step('IFS tools', () => registerIfsTools(context, m));
  step('system tools (more)', () => registerSystemTools(context, m));
  step('member tools', () => registerMemberTools(context, m));
  step('binding tools', () => registerBindingTools(context, m));
  step('security tools', () => registerSecurityTools(context, m));
  step('source analysis', () => registerSourceAnalysis(context, m));
  step('pinned view', () => registerPinned(context, m));
  step('connection stability', () => registerConnectionStability(context, m));
  step('call program', () => registerProgramCall(context, m));
  step('member notes', () => registerMemberNotes(context, m));
  step('operations', () => registerOperations(context, m));
  step('SQL formatter', () => registerSqlFormat(context, m));
  step('local development', () => { if (compiler) { registerLocalDev(context, m, compiler); } });
  step('PASE terminal', () => registerTerminal(context, m));
  step('notebooks', () => registerNotebooks(context, m));
  step('SQL error log', () => registerSqlErrorLog(context, m));
  step('schema browser', () => registerSchema(context, m));
  step('editor assist', () => registerEditorAssist(context, m));
  step('IFS transfer', () => registerIfsTransfer(context, m, ifs));
  step('CL command help', () => registerClAssist(context, m));
  step('compile quick fixes', () => registerCompileFixes(context, m));
  step('SQL code lens', () => registerSqlLens(context, m));
  step('code generators', () => registerCodeGen(context, m));
  step('table tools', () => registerTableTools(context, m));
  step('command source preview', () => registerCmdPreview(context, m));
  step('IFS sync', () => registerIfsSync(context, m));
  step('work extras', () => registerWorkExtras(context, m));

  if (failures.length) {
    vscode.window.showErrorMessage(vscode.l10n.t('Vanthrex started with problems: {0}', failures.join(' | ')), vscode.l10n.t('Show Log'))
      .then(c => { if (c) { showLog(); } });
  } else {
    log(`Vanthrex ready in ${Date.now() - startedAt} ms${slowSteps.length ? ` (slowest: ${slowSteps.join(', ')})` : ''}`);
  }

  // First run: open the walkthrough so new users know where to start.
  if (!context.globalState.get<boolean>('vanthrex.welcomed')) {
    context.globalState.update('vanthrex.welcomed', true);
    if (!profiles.list().length) {
      vscode.commands.executeCommand('vanthrex.openWalkthrough');
    }
  }

  // Optional auto-reconnect to the last used system.
  if (vscode.workspace.getConfiguration('vanthrex').get<boolean>('autoConnectLast')) {
    const last = profiles.lastUsed && profiles.get(profiles.lastUsed);
    if (last) { m.connect(last); }
  }
}

export async function deactivate(): Promise<void> {
  await manager?.disconnectAll(false);
}
