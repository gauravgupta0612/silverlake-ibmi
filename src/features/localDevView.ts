// Local development: keep source in a local (Git) folder, deploy changed files to an IFS folder, compile a local file
// there with errors shown on the local file, and run a project build command (makei, gmake, Bob…) in PASE.
import * as vscode from 'vscode';
import { Compiler } from './compile';
import { ifsUri } from './fileSystems';
import {
  buildProblems, buildShellCommand, DEFAULT_IGNORE, deployDirectory, DeployState, foldersToCreate, LocalFile, matchesIgnore, planDeploy, remotePathFor,
} from '../core/localDev';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { shSingleQuote } from '../core/util';

const STATE_KEY = 'vanthrex.deployState';
const cfg = () => vscode.workspace.getConfiguration('vanthrex.deploy');
let output: vscode.OutputChannel | undefined;
const out = () => (output ??= vscode.window.createOutputChannel('Vanthrex Build'));

async function pickFolder(uri?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
  const f = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  if (f) { return f; }
  const active = vscode.window.activeTextEditor?.document.uri;
  const fromEditor = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    const open = vscode.l10n.t('Open Folder…');
    if (await vscode.window.showWarningMessage(vscode.l10n.t('Open the local folder with your source first (File → Open Folder).'), open) === open) {
      void vscode.commands.executeCommand('vscode.openFolder');
    }
    return undefined;
  }
  if (fromEditor) { return fromEditor; }
  if (folders.length === 1) { return folders[0]; }
  return vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Which folder?') });
}

function directoryFor(conn: IbmiConnection, folder: vscode.WorkspaceFolder): string {
  return deployDirectory(vscode.workspace.getConfiguration('vanthrex.deploy', folder.uri).get<string>('directory', ''),
    { home: conn.homeDirectory, user: conn.user, folder: folder.name });
}

function ignoreList(folder: vscode.WorkspaceFolder): string[] {
  return vscode.workspace.getConfiguration('vanthrex.deploy', folder.uri).get<string[]>('ignore', DEFAULT_IGNORE);
}

async function listFiles(root: vscode.Uri, ignore: string[]): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  const walk = async (dir: vscode.Uri, rel: string, depth: number): Promise<void> => {
    if (depth > 30 || files.length > 50000) { return; }
    for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
      const r = rel ? `${rel}/${name}` : name;
      const uri = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) {
        if (!matchesIgnore(r + '/', ignore)) { await walk(uri, r, depth + 1); }
      } else if (type & vscode.FileType.File) {
        const st = await vscode.workspace.fs.stat(uri);
        files.push({ rel: r, size: st.size, mtimeMs: st.mtime });
      }
    }
  };
  await walk(root, '', 0);
  return files;
}

function stateKey(conn: IbmiConnection, dir: string): string { return `${conn.profile.id}|${dir}`; }

/** Upload new and changed files (or only `only`) to the deploy folder. Returns the folder. */
async function deploy(context: vscode.ExtensionContext, manager: ConnectionManager, folder: vscode.WorkspaceFolder, opts: { all?: boolean; only?: string[]; quiet?: boolean } = {}): Promise<string> {
  const conn = manager.require();
  const dir = directoryFor(conn, folder);
  const ignore = ignoreList(folder);
  const all = context.workspaceState.get<Record<string, DeployState>>(STATE_KEY, {});
  const state = all[stateKey(conn, dir)] ?? {};
  const files = await listFiles(folder.uri, ignore);
  const plan = opts.only ? { upload: opts.only, unchanged: 0, removed: [] as string[] } : planDeploy(files, state, ignore, opts.all);
  if (!plan.upload.length) {
    if (!opts.quiet) { vscode.window.showInformationMessage(vscode.l10n.t('Nothing to deploy: all {0} file(s) in {1} are up to date.', plan.unchanged, dir)); }
    return dir;
  }
  const ccsid = cfg().get<number>('ccsid', 1208);
  await conn.withChangesAllowed(vscode.l10n.t('Deploy {0} file(s) to {1}', plan.upload.length, dir), async () => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Deploying to {0}', dir), cancellable: true }, async (progress, token) => {
      const folders = [dir, ...foldersToCreate(dir, plan.upload)];
      for (let i = 0; i < folders.length; i += 100) {
        const r = await conn.exec(`mkdir -p ${folders.slice(i, i + 100).map(shSingleQuote).join(' ')}`);
        if (r.code !== 0) { throw new Error(r.stderr || vscode.l10n.t('Could not create {0}', dir)); }
      }
      let done = 0;
      for (const rel of plan.upload) {
        if (token.isCancellationRequested) { break; }
        const local = vscode.Uri.joinPath(folder.uri, ...rel.split('/'));
        const data = await vscode.workspace.fs.readFile(local);
        await conn.writeStreamFile(remotePathFor(dir, rel), data);
        const st = await vscode.workspace.fs.stat(local);
        state[rel] = { size: st.size, mtimeMs: st.mtime };
        done++;
        progress.report({ message: `${done}/${plan.upload.length} ${rel}`, increment: 100 / plan.upload.length });
      }
      if (ccsid > 0) {
        const paths = plan.upload.slice(0, done).map(r => shSingleQuote(remotePathFor(dir, r)));
        for (let i = 0; i < paths.length; i += 100) { await conn.exec(`/QOpenSys/usr/bin/setccsid ${ccsid} ${paths.slice(i, i + 100).join(' ')}`); }
      }
      if (done < plan.upload.length) { vscode.window.showWarningMessage(vscode.l10n.t('Deploy stopped: {0} of {1} file(s) uploaded.', done, plan.upload.length)); }
    });
  });
  all[stateKey(conn, dir)] = state;
  await context.workspaceState.update(STATE_KEY, all);
  if (!opts.quiet) {
    const msg = vscode.l10n.t('Deployed {0} file(s) to {1} ({2} unchanged).', plan.upload.length, dir, plan.unchanged);
    const extra = plan.removed.length ? ' ' + vscode.l10n.t('{0} file(s) deleted locally are still in the IFS folder.', plan.removed.length) : '';
    const open = vscode.l10n.t('Show in IFS'); const build = vscode.l10n.t('Build');
    void vscode.window.showInformationMessage(msg + extra, open, build).then(c => {
      if (c === open) { void vscode.commands.executeCommand('vanthrex.ifsChangeRoot', dir); }
      if (c === build) { void vscode.commands.executeCommand('vanthrex.build', folder.uri); }
    });
  }
  return dir;
}

async function compileLocal(context: vscode.ExtensionContext, manager: ConnectionManager, compiler: Compiler, uri: vscode.Uri | undefined, alwaysAsk: boolean): Promise<void> {
  uri ??= vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'file') { vscode.window.showWarningMessage(vscode.l10n.t('Open a local source file to compile.')); return; }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) { vscode.window.showWarningMessage(vscode.l10n.t('The file must be inside an open folder (it is deployed relative to it).')); return; }
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri!.toString());
  if (doc?.isDirty) { await doc.save(); }
  const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  // The file itself, plus every changed include/copybook in the folder (so /COPY and /INCLUDE find the latest version).
  if (cfg().get<boolean>('compileDeploysChanges', true)) { await deploy(context, manager, folder, { quiet: true }); }
  const dir = await deploy(context, manager, folder, { quiet: true, only: [rel] });
  await compiler.compile(ifsUri(remotePathFor(dir, rel)), alwaysAsk, { uri, root: folder.uri, dir });
}

async function build(context: vscode.ExtensionContext, manager: ConnectionManager, uri?: vscode.Uri): Promise<void> {
  const folder = await pickFolder(uri);
  if (!folder) { return; }
  const conn = manager.require();
  const settings = vscode.workspace.getConfiguration('vanthrex.deploy', folder.uri);
  let command = settings.get<string>('buildCommand', '').trim();
  if (!command) {
    const picked = await vscode.window.showQuickPick([
      { label: 'makei build', detail: vscode.l10n.t('IBM i Project Explorer / Bob (iproj.json)') },
      { label: 'gmake', detail: vscode.l10n.t('GNU make with your own makefile') },
      { label: 'makei compile -f ', detail: vscode.l10n.t('Compile one file with Bob') },
    ], { title: vscode.l10n.t('Build command for {0}', folder.name), placeHolder: vscode.l10n.t('Choose or type the command (saved in the folder settings)') });
    const typed = picked ? await vscode.window.showInputBox({ title: vscode.l10n.t('Build command'), value: picked.label, prompt: vscode.l10n.t('Runs in PASE in the deploy folder, with /QOpenSys/pkgs/bin on the PATH.') }) : undefined;
    if (!typed?.trim()) { return; }
    command = typed.trim();
    await settings.update('buildCommand', command, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  const dir = await deploy(context, manager, folder, { quiet: true });
  const line = buildShellCommand(command, dir, { curlib: conn.profile.currentLibrary, libl: conn.profile.libraries });
  const ch = out();
  ch.clear(); ch.show(true);
  ch.appendLine(`$ ${command}    (${dir} on ${conn.profile.name})`);
  const started = Date.now();
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Building {0}…', folder.name) },
    () => conn.withChangesAllowed(vscode.l10n.t('Build: {0}', command), () => conn.exec(line)));
  if (r.stdout) { ch.append(r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n'); }
  if (r.stderr) { ch.append(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n'); }
  const p = buildProblems(r.stdout + '\n' + r.stderr);
  const secs = Math.round((Date.now() - started) / 100) / 10;
  ch.appendLine(`--- ${r.code === 0 && !p.failed ? 'OK' : `FAILED (exit code ${r.code})`} in ${secs} s${p.messages.length ? ` · messages: ${p.messages.join(', ')}` : ''}`);
  if (r.code === 0 && !p.failed) {
    vscode.window.showInformationMessage(vscode.l10n.t('✔ Build of {0} finished in {1} s.', folder.name, secs));
  } else {
    const show = vscode.l10n.t('Show Output');
    void vscode.window.showErrorMessage(vscode.l10n.t('✖ Build of {0} failed (exit code {1}).', folder.name, r.code), show).then(c => { if (c) { ch.show(); } });
  }
}

async function setDeployFolder(manager: ConnectionManager, uri?: vscode.Uri): Promise<void> {
  const folder = await pickFolder(uri);
  if (!folder) { return; }
  const conn = manager.connection;
  const settings = vscode.workspace.getConfiguration('vanthrex.deploy', folder.uri);
  const current = settings.get<string>('directory', '') || '${home}/builds/${folder}';
  const value = await vscode.window.showInputBox({
    title: vscode.l10n.t('IFS deploy folder for {0}', folder.name), value: current,
    prompt: vscode.l10n.t('${home}, ${user} and ${folder} are replaced. Now: {0}', conn ? directoryFor(conn, folder) : '—'),
    validateInput: v => { try { deployDirectory(v, { home: '/home/x', user: 'x', folder: 'x' }); return undefined; } catch (e) { return errorMessage(e); } },
  });
  if (value === undefined) { return; }
  await settings.update('directory', value, vscode.ConfigurationTarget.WorkspaceFolder);
}

export function registerLocalDev(context: vscode.ExtensionContext, manager: ConnectionManager, compiler: Compiler): void {
  const wrap = (fn: (...a: never[]) => Promise<unknown>) => async (...a: never[]) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.deploy', wrap(async (uri?: vscode.Uri) => { const f = await pickFolder(uri); if (f) { await deploy(context, manager, f); } })),
    vscode.commands.registerCommand('vanthrex.deployAll', wrap(async (uri?: vscode.Uri) => { const f = await pickFolder(uri); if (f) { await deploy(context, manager, f, { all: true }); } })),
    vscode.commands.registerCommand('vanthrex.compileLocal', wrap((uri?: vscode.Uri, alwaysAsk?: boolean) => compileLocal(context, manager, compiler, uri, alwaysAsk === true))),
    vscode.commands.registerCommand('vanthrex.build', wrap((uri?: vscode.Uri) => build(context, manager, uri))),
    vscode.commands.registerCommand('vanthrex.deployFolder', wrap((uri?: vscode.Uri) => setDeployFolder(manager, uri))),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.scheme !== 'file' || !cfg().get<boolean>('onSave', false) || !manager.connection) { return; }
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (!folder || matchesIgnore(vscode.workspace.asRelativePath(doc.uri, false), ignoreList(folder))) { return; }
      void deploy(context, manager, folder, { quiet: true, only: [vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/')] })
        .catch(e => { logError(e); vscode.window.setStatusBarMessage(vscode.l10n.t('Deploy on save failed: {0}', errorMessage(e)), 8000); });
    }),
  );
}
