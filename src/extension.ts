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
import { registerInsights } from './features/insightsView';
import { registerAdmin } from './features/adminView';
import { registerWorkWith } from './features/workWithView';
import { registerExtras } from './features/extrasView';
import { registerDataTransfer } from './features/dataTransferView';
import { registerPerfMonitor } from './features/perfMonitor';
import { registerCodeTools } from './features/codeToolsView';
import { registerRpgUnit } from './features/rpgUnit';
import { registerProtection, registerSelfCheck } from './features/selfCheck';
import { registerDspfPreview } from './features/dspfPreview';
import { registerErd } from './features/erdView';
import { registerCrossSystem } from './features/crossSystem';
import { registerSpoolExtras } from './features/spoolExtras';
import { registerMore } from './features/moreView';
import { registerV2 } from './features/v2View';
import { registerSecadm } from './features/secadmView';
import { registerV21 } from './features/v21View';
import { registerV22 } from './features/v22View';
import { registerV23 } from './features/v23View';
import { registerPdm } from './features/pdmView';

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
  step('insights', () => registerInsights(context, m));
  step('system tools', () => registerAdmin(context, m));
  step('work with', () => registerWorkWith(context, m));
  step('extras', () => registerExtras(context, m));
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
  step('more tools', () => registerMore(context, m));
  step('2.0 tools', () => registerV2(context, m));
  step('security admin', () => registerSecadm(context, m));
  step('2.1 tools', () => registerV21(context, m));
  step('2.1 more tools', () => registerV22(context, m));
  step('2.1 batch 4', () => registerV23(context, m));
  step('PDM', () => registerPdm(context, m));

  if (failures.length) {
    vscode.window.showErrorMessage(vscode.l10n.t('Vanthrex started with problems: {0}', failures.join(' | ')), vscode.l10n.t('Show Log'))
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
