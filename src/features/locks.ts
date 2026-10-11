import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import type { MemberLock } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { clString, parseMemberPath } from '../core/util';
import { MEMBER_SCHEME, describeLock, memberLocks, memberLocksChanged } from './fileSystems';

function memberLabel(uri: vscode.Uri): string {
  const m = parseMemberPath(uri.path);
  return `${m.library}/${m.file}(${m.member})`;
}

/**
 * Shows who has a member locked (banner at the top of the editor + notification) and offers
 * ways to get the lock released: message the person, get notified when it is free, or end their job.
 */
export function registerLocks(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const lensChanged = new vscode.EventEmitter<void>();
  const watching = new Set<string>();

  const refresh = async (uri: vscode.Uri): Promise<MemberLock[]> => {
    const m = parseMemberPath(uri.path);
    const state = await manager.require().memberState(m.library, m.file, m.member);
    memberLocks.set(uri.toString(), state.locks);
    lensChanged.fire();
    return state.locks;
  };

  const askRelease = async (uri: vscode.Uri, lock: MemberLock) => {
    const conn = manager.require();
    const text = await vscode.window.showInputBox({
      title: vscode.l10n.t('Message {0}', lock.userText || lock.user),
      value: `Hi, I need to edit ${memberLabel(uri)}. Could you please close it when you can? Thanks — ${conn.user}`,
      prompt: vscode.l10n.t('This message pops up on their screen (break message) or goes to their message queue.'),
      ignoreFocusOut: true,
    });
    if (!text?.trim()) { return; }
    // A break message reaches an interactive (5250) session directly; otherwise use the user's queue.
    let r = await conn.runCL(`SNDBRKMSG MSG(${clString(text.trim())}) TOMSGQ(${lock.jobName})`);
    if (!r.ok) { r = await conn.runCL(`SNDMSG MSG(${clString(text.trim())}) TOUSR(${lock.user})`); }
    if (!r.ok) { throw new Error(vscode.l10n.t('Could not send the message: {0}', (r.stderr || r.stdout).trim())); }
    const next = await vscode.window.showInformationMessage(vscode.l10n.t('Message sent to {0}.', lock.userText || lock.user), vscode.l10n.t('Notify Me When Free'));
    if (next) { waitForRelease(uri); }
  };

  const waitForRelease = (uri: vscode.Uri) => {
    const key = uri.toString();
    if (watching.has(key)) { vscode.window.showInformationMessage(vscode.l10n.t('Already watching this member.')); return; }
    watching.add(key);
    vscode.window.setStatusBarMessage(`$(watch) Watching ${memberLabel(uri)} — you'll be told when it is free`, 5000);
    const started = Date.now();
    const tick = async () => {
      if (!watching.has(key)) { return; }
      try {
        const locks = await refresh(uri);
        if (!locks.length) {
          watching.delete(key);
          const c = await vscode.window.showInformationMessage(vscode.l10n.t('🔓 {0} is free now — you can save your changes.', memberLabel(uri)), vscode.l10n.t('Open'));
          if (c) { vscode.window.showTextDocument(uri); }
          return;
        }
      } catch (e) { logError(e); }
      if (Date.now() - started > 30 * 60_000) {
        watching.delete(key);
        vscode.window.showWarningMessage(vscode.l10n.t('{0} is still locked after 30 minutes. Stopped watching.', memberLabel(uri)));
        return;
      }
      setTimeout(tick, 15_000);
    };
    setTimeout(tick, 15_000);
  };

  const endTheirJob = async (uri: vscode.Uri, lock: MemberLock) => {
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t('End job {0} of {1}?', lock.job, lock.userText || lock.user),
      { modal: true, detail: `This releases the lock on ${memberLabel(uri)}, but ${lock.userText || lock.user} loses any unsaved work in that session. ` +
        'You need *JOBCTL authority. Only do this when you have agreed it with them.' },
      vscode.l10n.t('End Their Job'));
    if (ok !== vscode.l10n.t('End Their Job')) { return; }
    const r = await manager.require().runCL(`ENDJOB JOB(${lock.job}) OPTION(*CNTRLD) DELAY(30)`);
    if (!r.ok) { throw new Error(vscode.l10n.t('ENDJOB failed: {0}', (r.stderr || r.stdout).trim())); }
    vscode.window.showInformationMessage(vscode.l10n.t('Ending {0} (controlled, up to 30 s). You\'ll be told when the member is free.', lock.job));
    waitForRelease(uri);
  };

  const guard = (fn: (...a: any[]) => Promise<unknown> | unknown) => async (...a: any[]) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const activeMember = (uri?: vscode.Uri) => {
    const u = uri ?? vscode.window.activeTextEditor?.document.uri;
    return u && u.scheme === MEMBER_SCHEME ? u : undefined;
  };
  const pickLock = async (uri: vscode.Uri, lock?: MemberLock) => {
    if (lock) { return lock; }
    const locks = memberLocks.get(uri.toString()) ?? await refresh(uri);
    if (!locks.length) { vscode.window.showInformationMessage(vscode.l10n.t('{0} is not locked by anyone else.', memberLabel(uri))); return undefined; }
    if (locks.length === 1) { return locks[0]; }
    return (await vscode.window.showQuickPick(locks.map(l => ({ label: l.userText || l.user, description: `${l.job} · ${l.state}`, l })),
      { title: vscode.l10n.t('Which job?') }))?.l;
  };

  context.subscriptions.push(
    lensChanged,
    memberLocksChanged.event(async ({ uri, onOpen }) => {
      lensChanged.fire();
      const locks = memberLocks.get(uri.toString()) ?? [];
      if (!onOpen || !locks.length) { return; }
      const who = locks.map(describeLock).join(', ');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('🔒 {0} is locked by {1} ({2}). You can read it, but saving may fail until they close it.', memberLabel(uri), who, locks[0].state),
        vscode.l10n.t('Ask to Release'), vscode.l10n.t('Notify Me When Free'), vscode.l10n.t('More…'));
      if (choice === vscode.l10n.t('Ask to Release')) { vscode.commands.executeCommand('vanthrex.lockAskRelease', uri, locks[0]); }
      if (choice === vscode.l10n.t('Notify Me When Free')) { waitForRelease(uri); }
      if (choice === vscode.l10n.t('More…')) { vscode.commands.executeCommand('vanthrex.lockActions', uri); }
    }),

    // Banner on the first line of a locked member.
    vscode.languages.registerCodeLensProvider({ scheme: MEMBER_SCHEME }, {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses(doc) {
        const locks = memberLocks.get(doc.uri.toString()) ?? [];
        if (!locks.length) { return []; }
        const top = new vscode.Range(0, 0, 0, 0);
        const lenses = locks.map(l => new vscode.CodeLens(top, {
          title: `🔒 Locked by ${l.userText ? `${l.userText} (${l.user})` : l.user} · job ${l.job} · ${l.state}`,
          command: 'vanthrex.lockActions', arguments: [doc.uri, l],
          tooltip: 'Someone else has this member open. Click for options.',
        }));
        lenses.push(
          new vscode.CodeLens(top, { title: vscode.l10n.t('✉ Ask to release'), command: 'vanthrex.lockAskRelease', arguments: [doc.uri, locks[0]] }),
          new vscode.CodeLens(top, { title: watching.has(doc.uri.toString()) ? '⏳ Watching…' : '🔔 Notify me when free', command: 'vanthrex.lockWatch', arguments: [doc.uri] }),
          new vscode.CodeLens(top, { title: vscode.l10n.t('↻ Refresh'), command: 'vanthrex.lockRefresh', arguments: [doc.uri] }),
        );
        return lenses;
      },
    }),

    vscode.commands.registerCommand('vanthrex.lockActions', guard(async (uri?: vscode.Uri, lock?: MemberLock) => {
      const u = activeMember(uri);
      if (!u) { return; }
      const l = await pickLock(u, lock);
      if (!l) { return; }
      const pick = await vscode.window.showQuickPick([
        { label: vscode.l10n.t('$(mail) Ask them to release it…'), detail: vscode.l10n.t('Sends a message that pops up on their screen'), run: () => askRelease(u, l) },
        { label: vscode.l10n.t('$(bell) Notify me when it is free'), detail: vscode.l10n.t('Checks every 15 seconds for up to 30 minutes'), run: () => waitForRelease(u) },
        { label: vscode.l10n.t('$(output) Show their job log'), run: () => vscode.commands.executeCommand('vanthrex.jobLog', { job: l.job }) },
        { label: vscode.l10n.t('$(refresh) Check again'), run: () => refresh(u) },
        { label: vscode.l10n.t('$(stop-circle) End their job…'), detail: vscode.l10n.t('Releases the lock — they lose unsaved work. Needs *JOBCTL.'), run: () => endTheirJob(u, l) },
      ], { title: vscode.l10n.t('{0} is locked by {1} ({2})', memberLabel(u), describeLock(l), l.state) });
      if (pick) { await pick.run(); }
    })),
    vscode.commands.registerCommand('vanthrex.lockAskRelease', guard(async (uri?: vscode.Uri, lock?: MemberLock) => {
      const u = activeMember(uri);
      const l = u && await pickLock(u, lock);
      if (u && l) { await askRelease(u, l); }
    })),
    vscode.commands.registerCommand('vanthrex.lockWatch', guard((uri?: vscode.Uri) => {
      const u = activeMember(uri);
      if (u) { waitForRelease(u); lensChanged.fire(); }
    })),
    vscode.commands.registerCommand('vanthrex.lockRefresh', guard(async (uri?: vscode.Uri) => {
      const u = activeMember(uri);
      if (!u) { return; }
      const locks = await refresh(u);
      vscode.window.setStatusBarMessage(locks.length ? `🔒 Still locked by ${locks.map(describeLock).join(', ')}` : `🔓 ${memberLabel(u)} is free`, 5000);
    })),
    vscode.commands.registerCommand('vanthrex.lockEndJob', guard(async (uri?: vscode.Uri, lock?: MemberLock) => {
      const u = activeMember(uri);
      const l = u && await pickLock(u, lock);
      if (u && l) { await endTheirJob(u, l); }
    })),
  );
}
