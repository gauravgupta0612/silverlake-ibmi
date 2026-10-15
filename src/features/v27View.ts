// 2.3 stability: connection health in the status bar, kept saves replayed after a reconnect, editors that could
// not be read reopened when the system is back, and Copy to Another System.

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { parseMemberPath, sqlString } from '../core/util';
import { addMemberIfMissing, latencyState, lineDiffSummary } from '../core/v27';
import { createSourceFileCommand } from '../core/v26';
import { IFS_SCHEME, MEMBER_SCHEME } from './fileSystems';
import { forget, initPendingSaves, pendingChanged, pendingContent, pendingList } from './pendingSaves';

// ================================================================ connection health

class HealthMonitor implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private busy = false;

  constructor(private readonly manager: ConnectionManager) {
    this.item.command = 'vanthrex.connection.health';
    this.restart();
  }

  restart(): void {
    if (this.timer) { clearInterval(this.timer); }
    this.failures = 0; this.item.hide();
    const sec = vscode.workspace.getConfiguration('vanthrex').get<number>('connections.healthCheckSeconds', 60);
    if (sec > 0) { this.timer = setInterval(() => { void this.check(); }, Math.max(15, sec) * 1000); }
  }

  /** A tiny query, timed; two misses in a row mean the connection is dead even if SSH did not notice. */
  async check(show = false): Promise<number | undefined> {
    const c = this.manager.connection;
    if (!c || this.busy) { this.item.hide(); return undefined; }
    this.busy = true;
    const t0 = Date.now();
    let ms: number | undefined;
    try {
      await Promise.race([c.rows('VALUES 1', 1), new Promise((_, rej) => setTimeout(() => rej(new Error(vscode.l10n.t('No response from server within 15 s'))), 15000))]);
      ms = Date.now() - t0; this.failures = 0;
    } catch (e) {
      this.failures++;
      log(`Health check of ${c.profile.name} failed (${this.failures}): ${errorMessage(e)}`);
    } finally { this.busy = false; }
    const st = latencyState(ms, this.failures);
    if (st.state === 'down') {
      this.item.text = `$(debug-disconnect) ${c.profile.name}: ${vscode.l10n.t('not answering')}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.tooltip = vscode.l10n.t('The system did not answer twice in a row. Click to reconnect.');
      this.item.show();
      if (vscode.workspace.getConfiguration('vanthrex').get<boolean>('connections.autoReconnect', true)) { this.manager.forceReconnect(c.profile.id); this.failures = 0; }
    } else if (st.state === 'slow' || st.state === 'bad' || show) {
      this.item.text = `$(pulse) ${st.text || '…'}`;
      this.item.backgroundColor = st.state === 'bad' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      this.item.tooltip = vscode.l10n.t('Response time of {0}: {1}. Click to check again.', c.profile.name, st.text);
      this.item.show();
    } else {
      this.item.hide();
    }
    return ms;
  }

  dispose(): void { if (this.timer) { clearInterval(this.timer); } this.item.dispose(); }
}

// ================================================================ kept saves

async function offerPending(manager: ConnectionManager): Promise<void> {
  const conn = manager.connection;
  const list = pendingList().filter(p => !p.system || p.system === conn?.profile.name);
  if (!conn || !list.length) { return; }
  const save = vscode.l10n.t('Save Now'); const show = vscode.l10n.t('Show'); const drop = vscode.l10n.t('Discard');
  const c = await vscode.window.showWarningMessage(vscode.l10n.t('{0} change(s) could not be saved on {1} when the connection dropped. They were kept on this computer.', list.length, conn.profile.name), save, show, drop);
  if (c === show) { await vscode.commands.executeCommand('vanthrex.pendingSaves'); return; }
  if (c === drop) {
    const sure = vscode.l10n.t('Discard');
    if (await vscode.window.showWarningMessage(vscode.l10n.t('Throw away {0} kept change(s)?', list.length), { modal: true }, sure) === sure) { for (const p of list) { await forget(p.uri); } }
    return;
  }
  if (c !== save) { return; }
  await savePending(list);
}

async function savePending(list: ReturnType<typeof pendingList>): Promise<void> {
  let ok = 0; const failed: string[] = [];
  for (const p of list) {
    const uri = vscode.Uri.parse(p.uri);
    try {
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === p.uri);
      if (open?.isDirty) {
        // The editor still holds the change: saving it goes through the normal checks (conflicts, locks).
        if (!(await open.save())) { throw new Error(vscode.l10n.t('not saved')); }
      } else {
        await vscode.workspace.fs.writeFile(uri, await pendingContent(p));
      }
      await forget(p.uri); ok++;
    } catch (e) { logError(e); failed.push(`${uri.path}: ${errorMessage(e).split('\n')[0]}`); }
  }
  if (failed.length) { vscode.window.showErrorMessage(vscode.l10n.t('{0} saved, {1} not: {2}', ok, failed.length, failed.join('; '))); }
  else { vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) {0} kept change(s) saved', ok), 5000); }
}

async function showPending(): Promise<void> {
  const list = pendingList();
  if (!list.length) { vscode.window.showInformationMessage(vscode.l10n.t('No kept changes: everything was saved.')); return; }
  type Item = vscode.QuickPickItem & { p: typeof list[number] };
  const pickd = await vscode.window.showQuickPick<Item>(list.map(p => ({ p, label: vscode.Uri.parse(p.uri).path, description: `${p.system ?? ''} · ${new Date(p.at).toLocaleString()}` })),
    { title: vscode.l10n.t('Changes kept while the connection was down'), canPickMany: true, placeHolder: vscode.l10n.t('Pick the ones to save now (connect first)') });
  if (!pickd?.length) { return; }
  await savePending(pickd.map(x => x.p));
}

// ================================================================ editors that could not be read

/** After a (re)connect, reopen member and IFS tabs that VS Code could not read while offline. */
async function reopenFailedTabs(): Promise<void> {
  const loaded = new Set(vscode.workspace.textDocuments.map(d => d.uri.toString()));
  let n = 0;
  for (const g of vscode.window.tabGroups.all) {
    for (const tab of g.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      const uri = input?.uri;
      if (!uri || (uri.scheme !== MEMBER_SCHEME && uri.scheme !== IFS_SCHEME) || loaded.has(uri.toString())) { continue; }
      try { await vscode.window.showTextDocument(uri, { viewColumn: g.viewColumn, preserveFocus: true, preview: tab.isPreview }); n++; } catch (e) { logError(e); }
    }
  }
  if (n) { log(`Reopened ${n} remote editor(s) after connecting`); }
}

// ================================================================ copy to another system

async function copyToSystem(manager: ConnectionManager, a?: unknown): Promise<void> {
  const from = manager.require();
  const others = manager.openConnections.filter(c => c.profile.id !== from.profile.id);
  if (!others.length) { throw new Error(vscode.l10n.t('Connect to a second system first (Connections view), then copy.')); }
  const n = a as { kind?: string; library?: string; file?: string; member?: string; type?: string; text?: string; path?: string; isDirectory?: boolean } | vscode.Uri | undefined;
  let uri: vscode.Uri | undefined = n instanceof vscode.Uri ? n : undefined;
  if (!uri && n && !(n instanceof vscode.Uri)) {
    if (n.kind === 'member') { uri = vscode.Uri.from({ scheme: MEMBER_SCHEME, path: `/${n.library}/${n.file}/${n.member}.${(n.type || 'mbr').toLowerCase()}` }); }
    else if (n.path && n.isDirectory === false) { uri = vscode.Uri.from({ scheme: IFS_SCHEME, path: n.path }); }
  }
  uri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || (uri.scheme !== MEMBER_SCHEME && uri.scheme !== IFS_SCHEME)) { throw new Error(vscode.l10n.t('Right-click a member or an IFS file (or open one) to copy it.')); }
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri!.toString());
  if (doc?.isDirty) { throw new Error(vscode.l10n.t('Save it first: the copy is taken from the IBM i.')); }
  const to = others.length === 1 ? others[0] : (await vscode.window.showQuickPick(others.map(c => ({ label: c.profile.name, description: c.profile.protection && c.profile.protection !== 'none' ? vscode.l10n.t('protected') : '', c })), { title: vscode.l10n.t('Copy to which system?') }))?.c;
  if (!to) { return; }
  if (uri.scheme === MEMBER_SCHEME) { await copyMember(from, to, uri); } else { await copyIfs(from, to, uri); }
}

async function copyMember(from: IbmiConnection, to: IbmiConnection, uri: vscode.Uri): Promise<void> {
  const m = parseMemberPath(uri.path);
  const target = (await vscode.window.showInputBox({ title: vscode.l10n.t('Copy to {0} as (LIBRARY/FILE/MEMBER)', to.profile.name), value: `${m.library}/${m.file}/${m.member}`, ignoreFocusOut: true,
    validateInput: v => (/^[A-Za-z$#@][\w$#@.]{0,9}\/[A-Za-z$#@][\w$#@.]{0,9}\/[A-Za-z$#@][\w$#@.]{0,9}$/.test(v.trim()) ? undefined : 'LIBRARY/FILE/MEMBER') }))?.trim().toUpperCase();
  if (!target) { return; }
  const [tl, tf, tm] = target.split('/');
  const [src, info, fileThere, mbrThere] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading…') }, () => Promise.all([
    from.readMember(m.library, m.file, m.member),
    from.rows<Record<string, unknown>>(`SELECT COALESCE(PARTITION_TEXT, '') AS X, COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(m.library)} AND SYSTEM_TABLE_NAME = ${sqlString(m.file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(m.member)}`, 1),
    to.rows(`SELECT 1 AS X FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(tl)} AND SYSTEM_TABLE_NAME = ${sqlString(tf)}`, 1),
    to.rows(`SELECT 1 AS X FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(tl)} AND SYSTEM_TABLE_NAME = ${sqlString(tf)} AND SYSTEM_TABLE_MEMBER = ${sqlString(tm)}`, 1),
  ]));
  const text = String(info[0]?.X ?? '').trim(); const type = String(info[0]?.T ?? '').trim() || m.extension;
  let detail = vscode.l10n.t('New member on {0}.', to.profile.name);
  if (mbrThere.length) {
    const there = await to.readMember(tl, tf, tm);
    const d = lineDiffSummary(src, there);
    if (d.same) { vscode.window.showInformationMessage(vscode.l10n.t('{0} on {1} is already identical.', target, to.profile.name)); return; }
    detail = vscode.l10n.t('It already exists on {0}: {1} line(s) would be added and {2} removed.', to.profile.name, d.added, d.removed);
  }
  const yes = vscode.l10n.t('Copy');
  if (await vscode.window.showWarningMessage(vscode.l10n.t('Copy {0}/{1}({2}) from {3} to {4} on {5}?', m.library, m.file, m.member, from.profile.name, target, to.profile.name), { modal: true, detail }, yes) !== yes) { return; }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Copying to {0}…', to.profile.name) }, async () => {
    const run = async (cmd: string) => { const r = await to.runCL(cmd); if (!r.ok) { throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || cmd); } };
    if (!fileThere.length) { await run(createSourceFileCommand(tl, tf, '')); }
    if (!mbrThere.length) { await run(addMemberIfMissing(tl, tf, tm, type, text)); }
    await to.writeMember(tl, tf, tm, src);
  });
  vscode.window.showInformationMessage(vscode.l10n.t('Copied to {0} on {1}.', target, to.profile.name));
}

async function copyIfs(from: IbmiConnection, to: IbmiConnection, uri: vscode.Uri): Promise<void> {
  const target = (await vscode.window.showInputBox({ title: vscode.l10n.t('Copy to {0} as (full path)', to.profile.name), value: uri.path, ignoreFocusOut: true,
    validateInput: v => (v.trim().startsWith('/') ? undefined : vscode.l10n.t('Start the path with /')) }))?.trim();
  if (!target) { return; }
  const data = await from.readStreamFile(uri.path);
  const there = await to.readStreamFile(target).catch(() => undefined);
  if (there && Buffer.compare(there, data) === 0) { vscode.window.showInformationMessage(vscode.l10n.t('{0} on {1} is already identical.', target, to.profile.name)); return; }
  const detail = there ? (() => { const d = lineDiffSummary(data.toString('utf8'), there.toString('utf8')); return vscode.l10n.t('It already exists on {0}: {1} line(s) would be added and {2} removed.', to.profile.name, d.added, d.removed); })()
    : vscode.l10n.t('New file on {0}.', to.profile.name);
  const yes = vscode.l10n.t('Copy');
  if (await vscode.window.showWarningMessage(vscode.l10n.t('Copy {0} from {1} to {2} on {3}?', uri.path, from.profile.name, target, to.profile.name), { modal: true, detail }, yes) !== yes) { return; }
  const parent = target.replace(/\/[^/]*$/, '') || '/';
  if (!(await to.stat(parent).then(() => true, () => false))) { await to.mkdir(parent); }
  await to.writeStreamFile(target, data);
  if (!there) { await to.exec(`/QOpenSys/usr/bin/setccsid 1208 '${target.replace(/'/g, `'\\''`)}'`).catch(e => logError(e)); }
  vscode.window.showInformationMessage(vscode.l10n.t('Copied to {0} on {1}.', target, to.profile.name));
}

export function registerV27(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  initPendingSaves(context.globalStorageUri, context.globalState);
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const health = new HealthMonitor(manager);
  let lastActive: string | undefined;
  context.subscriptions.push(
    health,
    manager.onDidChange(c => {
      if (c && c.profile.id !== lastActive) { void reopenFailedTabs(); void offerPending(manager); void health.check(); }
      lastActive = c?.profile.id;
    }),
    manager.onDidReconnect(() => { void reopenFailedTabs(); void offerPending(manager); }),
    pendingChanged.event(n => { if (n) { vscode.window.setStatusBarMessage(vscode.l10n.t('$(warning) {0} change(s) kept until the connection is back', n), 8000); } }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vanthrex.connections.healthCheckSeconds')) { health.restart(); } }),
    vscode.commands.registerCommand('vanthrex.connection.health', guard(async () => {
      const ms = await health.check(true);
      const c = manager.connection;
      const again = vscode.l10n.t('Reconnect Now');
      const pick = await vscode.window.showInformationMessage(c ? (ms !== undefined ? vscode.l10n.t('{0} answered in {1} ms.', c.profile.name, ms) : vscode.l10n.t('{0} is not answering.', c.profile.name)) : vscode.l10n.t('Not connected.'), again);
      if (pick === again) { manager.forceReconnect(); }
    })),
    vscode.commands.registerCommand('vanthrex.connection.reconnectNow', () => manager.forceReconnect()),
    vscode.commands.registerCommand('vanthrex.pendingSaves', guard(() => showPending())),
    vscode.commands.registerCommand('vanthrex.copyToSystem', guard((a?: unknown) => copyToSystem(manager, a))),
  );
}
