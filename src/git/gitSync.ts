import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError, showLog } from '../core/log';
import { assertSystemName, clString, memberPath, parseMemberPath, shDoubleQuote, shSingleQuote, sqlString } from '../core/util';
import { MEMBER_SCHEME, memberUri } from '../features/fileSystems';
import {
  MemberRef, STATE_FILE, SyncState, emptyState, normaliseSource, parseGitLog, parseRepoPath, planDownload, planUpload,
  repoPath, textHash,
} from './gitMap';

const GIT_SCHEME = 'vanthrex-git';

// ---------------------------------------------------------------- git helpers

function gitPath(): string {
  const p = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
  return (Array.isArray(p) ? p[0] : p) || 'git';
}

/** Run git in a folder. Optional author settings are applied to commits only. */
export function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(gitPath(), args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error((stderr || err.message).trim())); } else { resolve(stdout); }
    });
    if (input !== undefined) { child.stdin?.end(input); }
  });
}

async function hasGit(): Promise<boolean> {
  try { await git(process.cwd(), ['--version']); return true; } catch { return false; }
}

async function isRepo(dir: string): Promise<boolean> {
  try { return (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; } catch { return false; }
}

function authorArgs(): string[] {
  const cfg = vscode.workspace.getConfiguration('vanthrex');
  const name = cfg.get<string>('git.authorName', '').trim();
  const email = cfg.get<string>('git.authorEmail', '').trim();
  return [...(name ? ['-c', `user.name=${name}`] : []), ...(email ? ['-c', `user.email=${email}`] : [])];
}

// ---------------------------------------------------------------- sync state

async function readState(root: vscode.Uri): Promise<SyncState | undefined> {
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, STATE_FILE))).toString('utf8');
    const s = JSON.parse(raw) as SyncState;
    return s && s.version === 1 ? s : undefined;
  } catch { return undefined; }
}

async function writeState(root: vscode.Uri, state: SyncState): Promise<void> {
  const sorted: SyncState = { ...state, libraries: [...new Set(state.libraries)].sort(), members: {} };
  for (const k of Object.keys(state.members).sort()) { sorted.members[k] = state.members[k]; }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.vanthrex'));
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, STATE_FILE), Buffer.from(JSON.stringify(sorted, null, 2) + '\n', 'utf8'));
}

/** Workspace folders that hold an IBM i source export. */
async function syncRoots(): Promise<vscode.Uri[]> {
  const roots: vscode.Uri[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (await readState(f.uri)) { roots.push(f.uri); }
  }
  return roots;
}

async function pickSyncRoot(): Promise<vscode.Uri | undefined> {
  const roots = await syncRoots();
  if (!roots.length) {
    const c = await vscode.window.showInformationMessage(
      vscode.l10n.t('No IBM i source repository is open. Export a library to a Git repository first (or open the folder of an earlier export).'),
      vscode.l10n.t('Export a Library…'), vscode.l10n.t('Open Folder…'));
    if (c === vscode.l10n.t('Export a Library…')) { await vscode.commands.executeCommand('vanthrex.git.export'); }
    if (c === vscode.l10n.t('Open Folder…')) { await vscode.commands.executeCommand('vscode.openFolder'); }
    return undefined;
  }
  if (roots.length === 1) { return roots[0]; }
  const pick = await vscode.window.showQuickPick(roots.map(r => ({ label: path.basename(r.fsPath), description: r.fsPath, r })), { title: vscode.l10n.t('Which repository?') });
  return pick?.r;
}

// ---------------------------------------------------------------- IBM i side

interface RemoteMember extends MemberRef { changed: string; text?: string; }

async function listMembers(conn: IbmiConnection, lib: string, files?: string[]): Promise<RemoteMember[]> {
  const fileFilter = files?.length ? `AND SYSTEM_TABLE_NAME IN (${files.map(sqlString).join(', ')})` : '';
  const srcFiles = (await conn.rows<{ F: string }>(
    `SELECT SYSTEM_TABLE_NAME AS F FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND FILE_TYPE = 'S' ${fileFilter}`, 1000))
    .map(r => String(r.F).trim());
  if (!srcFiles.length) { return []; }
  const rows = await conn.rows<Record<string, unknown>>(
    `SELECT SYSTEM_TABLE_NAME AS F, SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T, ` +
    `VARCHAR(COALESCE(LAST_SOURCE_UPDATE_TIMESTAMP, LAST_CHANGE_TIMESTAMP)) AS C FROM QSYS2.SYSPARTITIONSTAT ` +
    `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME IN (${srcFiles.map(sqlString).join(', ')}) ORDER BY 1, 2`, 200000);
  return rows.map(r => ({
    lib, file: String(r.F).trim(), member: String(r.M).trim(), type: String(r.T ?? '').trim() || 'MBR', changed: String(r.C ?? '').trim(),
  }));
}

/** Copy many members to stream files in one QSH job per batch, then read them over SFTP. */
async function downloadMembers(conn: IbmiConnection, members: RemoteMember[], progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken): Promise<RemoteMember[]> {
  const dir = conn.tempPath('_git');
  await conn.mkdir(dir);
  const out: RemoteMember[] = [];
  const batch = 40;
  try {
    for (let i = 0; i < members.length; i += batch) {
      if (token.isCancellationRequested) { throw new Error(vscode.l10n.t('Cancelled.')); }
      const part = members.slice(i, i + batch);
      const script = part.map((m, j) =>
        `system ${shDoubleQuote(`CPYTOSTMF FROMMBR(${clString(memberPath(m.lib, m.file, m.member))}) TOSTMF(${clString(`${dir}/${i + j}.txt`)}) ` +
          'STMFOPT(*REPLACE) STMFCCSID(1208) ENDLINFMT(*LF)')} >/dev/null 2>&1 || echo "FAILED ${i + j}"`).join('\n');
      const r = await conn.qsh(script);
      const failed = new Set((r.stdout.match(/FAILED (\d+)/g) ?? []).map(f => Number(f.split(' ')[1])));
      for (let j = 0; j < part.length; j++) {
        const m = part[j];
        if (failed.has(i + j)) { log(`Git export: could not copy ${m.lib}/${m.file}(${m.member})`); continue; }
        try {
          const text = (await conn.readStreamFile(`${dir}/${i + j}.txt`)).toString('utf8');
          out.push({ ...m, text: normaliseSource(text) });
        } catch (e) { log(`Git export: ${m.lib}/${m.file}(${m.member}): ${errorMessage(e)}`); }
      }
      progress.report({ message: `${Math.min(i + batch, members.length)} of ${members.length} members`, increment: (part.length / members.length) * 100 });
    }
  } finally {
    conn.exec(`rm -rf ${shSingleQuote(dir)}`).catch(() => undefined);
  }
  return out;
}

async function ensureMember(conn: IbmiConnection, m: MemberRef): Promise<void> {
  const exists = await conn.rows(`SELECT 1 AS X FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(m.lib)} ` +
    `AND SYSTEM_TABLE_NAME = ${sqlString(m.file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(m.member)}`, 1);
  if (exists.length) { return; }
  const file = await conn.rows(`SELECT 1 AS X FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(m.lib)} AND SYSTEM_TABLE_NAME = ${sqlString(m.file)}`, 1);
  if (!file.length) {
    const r = await conn.runCL(`CRTSRCPF FILE(${m.lib}/${m.file}) RCDLEN(112)`);
    if (!r.ok) { throw new Error(vscode.l10n.t('Could not create source file {0}/{1}: {2}', m.lib, m.file, (r.stderr || r.stdout).trim())); }
  }
  const r = await conn.runCL(`ADDPFM FILE(${m.lib}/${m.file}) MBR(${m.member}) SRCTYPE(${m.type === 'MBR' ? '*NONE' : m.type})`);
  if (!r.ok) { throw new Error(vscode.l10n.t('Could not add member {0}/{1}({2}): {3}', m.lib, m.file, m.member, (r.stderr || r.stdout).trim())); }
}

async function memberChanged(conn: IbmiConnection, m: MemberRef): Promise<string> {
  const r = await conn.rows<{ C: string }>(
    `SELECT VARCHAR(COALESCE(LAST_SOURCE_UPDATE_TIMESTAMP, LAST_CHANGE_TIMESTAMP)) AS C FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(m.lib)} ` +
    `AND SYSTEM_TABLE_NAME = ${sqlString(m.file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(m.member)}`, 1);
  return String(r[0]?.C ?? '').trim();
}

// ---------------------------------------------------------------- local side

async function localFiles(root: vscode.Uri, libs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const lib of libs) {
    const libUri = vscode.Uri.joinPath(root, lib.toLowerCase());
    let files: [string, vscode.FileType][] = [];
    try { files = await vscode.workspace.fs.readDirectory(libUri); } catch { continue; }
    for (const [f, ft] of files) {
      if (ft !== vscode.FileType.Directory) { continue; }
      for (const [m, mt] of await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(libUri, f))) {
        if (mt !== vscode.FileType.File) { continue; }
        const rel = `${lib.toLowerCase()}/${f}/${m}`;
        if (!parseRepoPath(rel)) { continue; }
        const text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel))).toString('utf8');
        out.set(rel, textHash(text));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- commands

async function exportToGit(manager: ConnectionManager, arg?: { library?: string; file?: string }): Promise<void> {
  const conn = manager.require();
  if (!(await hasGit())) {
    throw new Error(vscode.l10n.t('Git is not installed (or not on the PATH). Install Git from https://git-scm.com and try again.'));
  }
  let lib = arg?.library;
  if (!lib) {
    const libs = [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean) as string[])];
    const pick = await vscode.window.showQuickPick([...libs, '$(edit) Other library…'], { title: vscode.l10n.t('Export which library to Git?') });
    if (!pick) { return; }
    lib = pick.startsWith('$(') ? await vscode.window.showInputBox({ title: vscode.l10n.t('Library') }) : pick;
  }
  if (!lib) { return; }
  lib = assertSystemName(lib, 'library');

  let files = arg?.file ? [arg.file.toUpperCase()] : undefined;
  if (!files) {
    const all = (await conn.rows<{ F: string; T: string }>(
      `SELECT SYSTEM_TABLE_NAME AS F, COALESCE(TABLE_TEXT, '') AS T FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND FILE_TYPE = 'S' ORDER BY 1`, 1000));
    if (!all.length) { throw new Error(vscode.l10n.t('{0} has no source files.', lib)); }
    const picks = await vscode.window.showQuickPick(all.map(f => ({ label: String(f.F).trim(), description: String(f.T).trim(), picked: true })),
      { title: vscode.l10n.t('Source files of {0} to export', lib), canPickMany: true });
    if (!picks?.length) { return; }
    files = picks.map(p => p.label);
  }

  // Where: an open workspace folder or a folder the user picks.
  const folders = vscode.workspace.workspaceFolders ?? [];
  type Dest = vscode.QuickPickItem & { uri?: vscode.Uri };
  const dests: Dest[] = [...folders.map(f => ({ label: vscode.l10n.t('$(folder) {0}', f.name), description: f.uri.fsPath, uri: f.uri })), { label: vscode.l10n.t('$(folder-opened) Choose a folder…') }];
  const dest = dests.length === 1 ? dests[0] : await vscode.window.showQuickPick(dests, { title: vscode.l10n.t('Export into which folder (Git repository)?') });
  if (!dest) { return; }
  let root = dest.uri;
  if (!root) {
    const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Export here', title: vscode.l10n.t('Folder for the Git repository') });
    root = chosen?.[0];
  }
  if (!root) { return; }

  const members = await listMembers(conn, lib, files);
  if (!members.length) { throw new Error(vscode.l10n.t('No members found in {0} ({1}).', lib, files.join(', '))); }

  const state = (await readState(root)) ?? emptyState(conn.profile.host, conn.profile.name);
  const fetched = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Exporting {0} to Git', lib), cancellable: true },
    (progress, token) => downloadMembers(conn, members, progress, token));
  for (const m of fetched) {
    const rel = repoPath(m);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, rel), Buffer.from(m.text ?? '', 'utf8'));
    state.members[rel] = { lib: m.lib, file: m.file, member: m.member, type: m.type, changed: m.changed, hash: textHash(m.text ?? '') };
  }
  state.libraries.push(lib);
  await writeState(root, state);
  await writeRepoFiles(root);
  log(`Exported ${fetched.length} member(s) of ${lib} to ${root.fsPath}`);

  const repo = await isRepo(root.fsPath);
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Exported {0} of {1} member(s) from {2} to {3}.', fetched.length, members.length, lib, path.basename(root.fsPath)),
    ...(repo ? [vscode.l10n.t('Commit…'), vscode.l10n.t('Open Source Control')] : [vscode.l10n.t('Create Git Repository & Commit')]),
    ...(folders.some(f => f.uri.toString() === root!.toString()) ? [] : [vscode.l10n.t('Open Folder')]));
  if (choice === vscode.l10n.t('Create Git Repository & Commit')) {
    await git(root.fsPath, ['init', '-b', 'main']).catch(() => git(root!.fsPath, ['init']));
    await commitAll(root.fsPath, `Import ${lib} from ${conn.profile.name}`);
    const next = await vscode.window.showInformationMessage(vscode.l10n.t('Git repository created with a first commit.'), vscode.l10n.t('Publish to GitHub…'), vscode.l10n.t('Open Folder'));
    if (next === vscode.l10n.t('Publish to GitHub…')) { await publish(root); }
    if (next === vscode.l10n.t('Open Folder')) { await vscode.commands.executeCommand('vscode.openFolder', root, { forceNewWindow: false }); }
  } else if (choice === vscode.l10n.t('Commit…')) {
    await commitAndPush(root);
  } else if (choice === vscode.l10n.t('Open Source Control')) {
    await vscode.commands.executeCommand('workbench.view.scm');
  } else if (choice === vscode.l10n.t('Open Folder')) {
    await vscode.commands.executeCommand('vscode.openFolder', root, { forceNewWindow: false });
  }
}

async function writeRepoFiles(root: vscode.Uri): Promise<void> {
  const write = async (name: string, text: string) => {
    const uri = vscode.Uri.joinPath(root, name);
    try { await vscode.workspace.fs.stat(uri); } catch { await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8')); }
  };
  await write('.gitattributes', '# IBM i source: keep LF line endings so members round-trip exactly\n* text=auto eol=lf\n');
  await write('README.md', '# IBM i source\n\nExported with **Vanthrex for IBM i**. Layout: `<library>/<source file>/<member>.<type>`.\n\n' +
    '- **Vanthrex: Git — Get Changes from IBM i** brings members changed on the IBM i into this folder.\n' +
    '- **Vanthrex: Git — Upload Changed Files to IBM i** sends files you changed here back to their members.\n' +
    '- `.vanthrex/sync.json` remembers what was last exchanged; commit it with the source.\n');
}

async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, ['add', '-A']);
  const status = await git(cwd, ['status', '--porcelain']);
  if (!status.trim()) { return false; }
  await git(cwd, [...authorArgs(), 'commit', '-m', message]);
  return true;
}

async function publish(root: vscode.Uri): Promise<void> {
  const remotes = (await git(root.fsPath, ['remote']).catch(() => '')).trim();
  if (remotes) {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing to the remote repository…') },
      () => git(root.fsPath, ['push', '-u', remotes.split('\n')[0], 'HEAD']));
    vscode.window.showInformationMessage(vscode.l10n.t('Pushed.'));
    return;
  }
  const url = await vscode.window.showInputBox({
    title: vscode.l10n.t('Publish to a remote repository'), prompt: vscode.l10n.t('URL of an empty repository (GitHub, GitLab, Azure DevOps…). Leave empty to use VS Code\'s "Publish to GitHub".'),
    placeHolder: vscode.l10n.t('https://github.com/you/ibmi-source.git'), ignoreFocusOut: true,
  });
  if (url === undefined) { return; }
  if (!url.trim()) {
    await vscode.commands.executeCommand('vscode.openFolder', root, { forceNewWindow: false });
    await vscode.commands.executeCommand('github.publish').then(undefined, () => vscode.commands.executeCommand('git.publish'));
    return;
  }
  await git(root.fsPath, ['remote', 'add', 'origin', url.trim()]);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing to the remote repository…') },
    () => git(root.fsPath, ['push', '-u', 'origin', 'HEAD']));
  vscode.window.showInformationMessage(vscode.l10n.t('Published to {0}.', url.trim()));
}

async function commitAndPush(root?: vscode.Uri): Promise<void> {
  root ??= await pickSyncRoot();
  if (!root) { return; }
  if (!(await isRepo(root.fsPath))) {
    const c = await vscode.window.showInformationMessage(vscode.l10n.t('{0} is not a Git repository yet.', path.basename(root.fsPath)), vscode.l10n.t('Create It'));
    if (c !== vscode.l10n.t('Create It')) { return; }
    await git(root.fsPath, ['init', '-b', 'main']).catch(() => git(root!.fsPath, ['init']));
  }
  const status = (await git(root.fsPath, ['status', '--porcelain'])).trim();
  if (!status) {
    const c = await vscode.window.showInformationMessage(vscode.l10n.t('Nothing to commit — the repository is up to date.'), vscode.l10n.t('Push Anyway'));
    if (c) { await publish(root); }
    return;
  }
  const count = status.split('\n').length;
  const message = await vscode.window.showInputBox({ title: vscode.l10n.t('Commit {0} changed file(s)', count), prompt: vscode.l10n.t('Commit message'), ignoreFocusOut: true,
    validateInput: v => v.trim() ? undefined : 'Enter a message' });
  if (!message) { return; }
  await commitAll(root.fsPath, message.trim());
  const c = await vscode.window.showInformationMessage(vscode.l10n.t('Committed {0} file(s).', count), vscode.l10n.t('Push'), vscode.l10n.t('Open Source Control'));
  if (c === vscode.l10n.t('Push')) { await publish(root); }
  if (c === vscode.l10n.t('Open Source Control')) { await vscode.commands.executeCommand('workbench.view.scm'); }
}

async function downloadChanges(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const root = await pickSyncRoot();
  if (!root) { return; }
  const state = (await readState(root))!;
  if (state.host !== conn.profile.host) {
    const c = await vscode.window.showWarningMessage(vscode.l10n.t('This repository was exported from {0} ({1}), but you are connected to {2}.', state.system, state.host, conn.profile.name),
      { modal: true }, vscode.l10n.t('Continue'));
    if (c !== vscode.l10n.t('Continue')) { return; }
  }
  const remote = new Map<string, RemoteMember>();
  for (const lib of state.libraries) {
    const files = [...new Set(Object.values(state.members).filter(m => m.lib === lib).map(m => m.file))];
    for (const m of await listMembers(conn, lib, files)) { remote.set(repoPath(m), m); }
  }
  const local = await localFiles(root, state.libraries);
  const plan = planDownload(state, remote, local);
  const todo = [...plan.added, ...plan.changed];
  if (plan.conflicts.length) {
    const pick = await vscode.window.showQuickPick(plan.conflicts.map(rel => ({ label: rel, picked: false })), {
      title: vscode.l10n.t('{0} file(s) changed both here and on the IBM i — tick the ones to overwrite with the IBM i version', plan.conflicts.length), canPickMany: true,
    });
    if (pick) { todo.push(...pick.map(p => p.label)); }
  }
  if (!todo.length) {
    vscode.window.showInformationMessage(`Up to date — no member changed on ${conn.profile.name} since the last sync.` +
      (plan.removed.length ? ` (${plan.removed.length} member(s) no longer exist there.)` : ''));
    return;
  }
  const fetched = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Getting changes from IBM i'), cancellable: true },
    (progress, token) => downloadMembers(conn, todo.map(rel => remote.get(rel)!).filter(Boolean), progress, token));
  for (const m of fetched) {
    const rel = repoPath(m);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, rel), Buffer.from(m.text ?? '', 'utf8'));
    state.members[rel] = { lib: m.lib, file: m.file, member: m.member, type: m.type, changed: m.changed, hash: textHash(m.text ?? '') };
  }
  await writeState(root, state);
  const c = await vscode.window.showInformationMessage(
    `Brought ${fetched.length} member(s) from ${conn.profile.name} into ${path.basename(root.fsPath)}` +
    (plan.removed.length ? `; ${plan.removed.length} member(s) were deleted on the IBM i (kept here).` : '.'),
    vscode.l10n.t('Commit…'), vscode.l10n.t('Open Source Control'));
  if (c === vscode.l10n.t('Commit…')) { await commitAndPush(root); }
  if (c === vscode.l10n.t('Open Source Control')) { await vscode.commands.executeCommand('workbench.view.scm'); }
}

async function uploadChanges(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const root = await pickSyncRoot();
  if (!root) { return; }
  const state = (await readState(root))!;
  if (state.host !== conn.profile.host) {
    const c = await vscode.window.showWarningMessage(
      vscode.l10n.t('This repository was exported from {0} ({1}), but the active system is {2} ({3}).', state.system, state.host, conn.profile.name, conn.profile.host),
      { modal: true, detail: vscode.l10n.t('Uploading would write these members to the active system.') }, `Upload to ${conn.profile.name}`);
    if (!c) { return; }
  }
  // Libraries present as folders, also ones added by hand.
  const dirs = (await vscode.workspace.fs.readDirectory(root)).filter(([n, t]) => t === vscode.FileType.Directory && /^[a-z$#@][a-z0-9$#@_.]{0,9}$/i.test(n) && !n.startsWith('.'));
  const libs = [...new Set([...state.libraries, ...dirs.map(([n]) => n.toUpperCase())])];
  const local = await localFiles(root, libs);
  const remoteChanged = new Map<string, string>();
  for (const rel of local.keys()) {
    const known = state.members[rel];
    if (known && known.hash !== local.get(rel)) { remoteChanged.set(rel, await memberChanged(conn, known).catch(() => '')); }
  }
  const plan = planUpload(state, local, remoteChanged);
  type Item = vscode.QuickPickItem & { rel: string };
  const items: Item[] = [
    ...plan.changed.map(rel => ({ label: vscode.l10n.t('$(edit) {0}', rel), description: 'changed', picked: true, rel })),
    ...plan.added.map(rel => ({ label: vscode.l10n.t('$(add) {0}', rel), description: 'new member', picked: true, rel })),
    ...plan.conflicts.map(rel => ({ label: vscode.l10n.t('$(warning) {0}', rel), description: 'also changed on the IBM i — will overwrite', picked: false, rel })),
  ];
  if (!items.length) { vscode.window.showInformationMessage(vscode.l10n.t('Nothing to upload — no file changed since the last sync.')); return; }
  const picks = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Upload to {0}', conn.profile.name), canPickMany: true, placeHolder: vscode.l10n.t('Untick files you do not want to send') });
  if (!picks?.length) { return; }

  // Same libraries, or redirect everything into one (e.g. a development library).
  const target = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(arrow-right) Into the libraries they came from'), value: '' },
    { label: vscode.l10n.t('$(library) Into another library…'), description: 'for example your development library', value: 'other' },
  ], { title: vscode.l10n.t('Where should the members go?') });
  if (!target) { return; }
  let intoLib = '';
  if (target.value) {
    intoLib = assertSystemName((await vscode.window.showInputBox({ title: vscode.l10n.t('Target library'), value: conn.profile.currentLibrary ?? '' })) ?? '', 'library');
  }

  let done = 0;
  const failures: string[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Uploading to IBM i') }, async progress => {
    for (const p of picks) {
      const ref = parseRepoPath(p.rel)!;
      const m = { ...ref, lib: intoLib || ref.lib };
      progress.report({ message: `${m.lib}/${m.file}(${m.member})`, increment: 100 / picks.length });
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, p.rel))).toString('utf8');
        await ensureMember(conn, m);
        await conn.writeMember(m.lib, m.file, m.member, normaliseSource(text));
        if (!intoLib) { state.members[p.rel] = { ...m, changed: await memberChanged(conn, m), hash: textHash(text) }; }
        done++;
      } catch (e) { failures.push(`${p.rel}: ${errorMessage(e)}`); logError(e); }
    }
  });
  if (!intoLib) { await writeState(root, state); }
  if (failures.length) {
    const c = await vscode.window.showErrorMessage(vscode.l10n.t('Uploaded {0} file(s); {1} failed: {2}', done, failures.length, failures[0]), vscode.l10n.t('Show Log'));
    if (c) { showLog(); }
  } else {
    vscode.window.showInformationMessage(vscode.l10n.t('Uploaded {0} file(s) to {1} on {2}.', done, intoLib || 'their libraries', conn.profile.name));
  }
}

/** Repository + relative path that hold a member, from the export state of open folders. */
async function findInRepos(m: MemberRef): Promise<{ root: vscode.Uri; rel: string } | undefined> {
  for (const root of await syncRoots()) {
    const rel = repoPath(m);
    const state = await readState(root);
    if (state?.members[rel]) { return { root, rel }; }
    // Same member exported from another library (e.g. PROD export while editing in DEV).
    const other = Object.keys(state?.members ?? {}).find(k => k.endsWith(`/${m.file.toLowerCase()}/${m.member.toLowerCase()}.${(m.type || 'mbr').toLowerCase()}`));
    if (other) { return { root, rel: other }; }
  }
  return undefined;
}

async function memberHistory(manager: ConnectionManager, arg?: vscode.Uri | { library?: string; file?: string; member?: string; type?: string }): Promise<void> {
  let m: MemberRef | undefined;
  let uri: vscode.Uri | undefined;
  if (arg instanceof vscode.Uri) { uri = arg; }
  else if (arg?.library && arg.file && arg.member) { uri = memberUri(arg.library, arg.file, arg.member, arg.type || 'mbr'); }
  else { uri = vscode.window.activeTextEditor?.document.uri; }
  if (uri?.scheme === MEMBER_SCHEME) {
    const p = parseMemberPath(uri.path);
    m = { lib: p.library, file: p.file, member: p.member, type: p.extension.toUpperCase() };
  }
  // A file inside an exported repository works too.
  let found: { root: vscode.Uri; rel: string } | undefined;
  if (m) { found = await findInRepos(m); }
  else if (uri?.scheme === 'file') {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      const rel = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
      const ref = parseRepoPath(rel);
      if (ref) { found = { root: folder.uri, rel }; m = ref; uri = memberUri(ref.lib, ref.file, ref.member, ref.type); }
    }
  }
  if (!m || !found) {
    vscode.window.showInformationMessage(vscode.l10n.t('This member is not in an exported Git repository that is open in VS Code. Use "Export Source to a Git Repository…" first.'));
    return;
  }
  if (!(await isRepo(found.root.fsPath))) { throw new Error(vscode.l10n.t('{0} is not a Git repository yet — commit the export first.', found.root.fsPath)); }
  const commits = parseGitLog(await git(found.root.fsPath, ['log', '--follow', '-n', '200', '--format=%H%x09%an%x09%ad%x09%s', '--date=format:%Y-%m-%d %H:%M', '--', found.rel]));
  if (!commits.length) { vscode.window.showInformationMessage(vscode.l10n.t('{0} has no commits yet.', found.rel)); return; }
  const pick = await vscode.window.showQuickPick(commits.map((c, i) => ({
    label: vscode.l10n.t('$(git-commit) {0}', c.subject), description: `${c.sha.substring(0, 8)} · ${c.author} · ${c.date}${i === 0 ? ' · latest' : ''}`, c,
  })), { title: vscode.l10n.t('Git history of {0}/{1}({2})', m.lib, m.file, m.member), matchOnDescription: true, placeHolder: vscode.l10n.t('Pick a version') });
  if (!pick) { return; }
  const version = vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${found.rel}`, query: JSON.stringify({ root: found.root.fsPath, sha: pick.c.sha }) });
  const connected = !!manager.connection;
  const actions = [
    ...(connected ? ['$(diff) Compare this version with the member on IBM i'] : []),
    '$(file) Open this version (read-only)',
    '$(diff) Compare with the previous version',
    ...(connected ? ['$(discard) Restore this version into the member editor'] : []),
  ];
  const action = await vscode.window.showQuickPick(actions, { title: `${pick.c.sha.substring(0, 8)} — ${pick.c.subject}` });
  if (!action) { return; }
  const short = pick.c.sha.substring(0, 8);
  if (action.includes('member on IBM i')) {
    await vscode.commands.executeCommand('vscode.diff', version, uri, `${m.member}: ${short} ↔ IBM i`);
  } else if (action.includes('Open this version')) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(version), { preview: true });
  } else if (action.includes('previous')) {
    const prev = vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${found.rel}`, query: JSON.stringify({ root: found.root.fsPath, sha: `${pick.c.sha}~1` }) });
    await vscode.commands.executeCommand('vscode.diff', prev, version, `${m.member}: before ↔ ${short}`);
  } else {
    const text = await git(found.root.fsPath, ['show', `${pick.c.sha}:${found.rel}`]);
    const editor = await vscode.window.showTextDocument(uri!);
    await editor.edit(e => e.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), text));
    vscode.window.showInformationMessage(vscode.l10n.t('Version {0} restored in the editor. Save (Ctrl+S) to write it to the IBM i.', short));
  }
}

class GitVersionProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, sha } = JSON.parse(uri.query) as { root: string; sha: string };
    if (!/^[0-9a-f]{7,40}(~1)?$/i.test(String(sha))) { return ''; }
    try { return await git(root, ['show', `${sha}:${uri.path.replace(/^\//, '')}`]); }
    catch { return ''; } // file did not exist in that version
  }
}

export function registerGit(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]) => {
    try { await fn(...a); } catch (e) {
      logError(e);
      const c = await vscode.window.showErrorMessage(errorMessage(e), vscode.l10n.t('Show Log'));
      if (c) { showLog(); }
    }
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitVersionProvider()),
    vscode.commands.registerCommand('vanthrex.git.export', guard((n?: { library?: string; file?: string }) => exportToGit(manager, n))),
    vscode.commands.registerCommand('vanthrex.git.download', guard(() => downloadChanges(manager))),
    vscode.commands.registerCommand('vanthrex.git.upload', guard(() => uploadChanges(manager))),
    vscode.commands.registerCommand('vanthrex.git.commitPush', guard(() => commitAndPush())),
    vscode.commands.registerCommand('vanthrex.git.memberHistory', guard((a?: vscode.Uri | { library?: string }) => memberHistory(manager, a as never))),
  );
}
