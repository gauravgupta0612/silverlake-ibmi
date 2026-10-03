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

let manager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(initLog());
  log(`Silverlake ${context.extension?.packageJSON?.version ?? ""} starting (VS Code ${vscode.version}, ${process.platform})`);
  vscode.commands.executeCommand('setContext', 'silverlake.connected', false);

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
    vscode.window.registerTreeDataProvider('silverlake.connections', new ConnectionTreeProvider(m)),
    vscode.window.createTreeView('silverlake.libraries', { treeDataProvider: libraries, showCollapseAll: true }),
    vscode.window.createTreeView('silverlake.ifs', { treeDataProvider: ifs, showCollapseAll: true }),
    vscode.window.registerTreeDataProvider('silverlake.spool', spool),
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

  if (failures.length) {
    vscode.window.showErrorMessage(`Silverlake started with problems: ${failures.join(' | ')}`, 'Show Log')
      .then(c => { if (c) { showLog(); } });
  } else {
    log('Silverlake ready');
  }

  // First run: open the walkthrough so new users know where to start.
  if (!context.globalState.get<boolean>('silverlake.welcomed')) {
    context.globalState.update('silverlake.welcomed', true);
    if (!profiles.list().length) {
      vscode.commands.executeCommand('silverlake.openWalkthrough');
    }
  }

  // Optional auto-reconnect to the last used system.
  if (vscode.workspace.getConfiguration('silverlake').get<boolean>('autoConnectLast')) {
    const last = profiles.lastUsed && profiles.get(profiles.lastUsed);
    if (last) { m.connect(last); }
  }
}

export async function deactivate(): Promise<void> {
  await manager?.disconnect();
}
