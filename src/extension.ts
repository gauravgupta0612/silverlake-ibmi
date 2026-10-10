import * as vscode from 'vscode';
import { errorMessage, initLog, log, logError, showLog } from './core/log';
import { ProfileStore } from './core/profiles';
import { ConnectionManager } from './core/manager';
import { ConnectionTreeProvider } from './views/connectionTree';
import { LibraryTreeProvider } from './views/libraryTree';
import { IfsTreeProvider } from './views/ifsTree';
import { SpoolTreeProvider } from './views/spoolTree';
import { IFS_SCHEME, IfsFileSystem, MEMBER_SCHEME, MemberFileSystem } from './features/fileSystems';
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

let manager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(initLog());
  log(`Vanthrex ${context.extension?.packageJSON?.version ?? ""} starting (VS Code ${vscode.version}, ${process.platform})`);
  vscode.commands.executeCommand('setContext', 'vanthrex.connected', false);

  // Each feature starts on its own: if one fails, the others (and the error report) still work.
  const failures: string[] = [];
  const step = (name: string, fn: () => void) => {
    try { fn(); }
    catch (e) { failures.push(`${name}: ${errorMessage(e)}`); logError(e); }
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
    vscode.window.createTreeView('vanthrex.ifs', { treeDataProvider: ifs, showCollapseAll: true }),
    vscode.window.registerTreeDataProvider('vanthrex.spool', spool),
  ));
  step('file systems', () => context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(MEMBER_SCHEME, new MemberFileSystem(m), { isCaseSensitive: false }),
    vscode.workspace.registerFileSystemProvider(IFS_SCHEME, new IfsFileSystem(m), { isCaseSensitive: true }),
  ));
  step('compile', () => registerCompile(context, m));
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

  if (failures.length) {
    vscode.window.showErrorMessage(`Vanthrex started with problems: ${failures.join(' | ')}`, 'Show Log')
      .then(c => { if (c) { showLog(); } });
  } else {
    log('Vanthrex ready');
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
  await manager?.disconnectAll();
}
