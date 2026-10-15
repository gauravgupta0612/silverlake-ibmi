// 2.2 editing helpers: Find Member Anywhere, Objects Built from This Source, Compile on Save and the member status bar.

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { parseMemberPath, sqlString } from '../core/util';
import { BuiltObject, CompileOnSave, builtFromSql, builtObjects, compileOnSaveAction, findMemberSql, libraryRank, statusText } from '../core/v24';
import { MEMBER_SCHEME, memberUri } from './fileSystems';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const ALLOWED = new Set(['vanthrex.objectInfo', 'vanthrex.compile', 'vanthrex.builtFrom', 'vanthrex.pdm']);

function libraryList(conn: IbmiConnection): string[] {
  const p = conn.profile;
  return [...new Set([p.currentLibrary, ...p.libraries].filter(Boolean).map(l => String(l).toUpperCase()))];
}

/** The member a command is about: a URI, a tree / PDM node, or the active editor. */
function memberOf(a?: unknown): { library: string; file: string; member: string; type: string; uri: vscode.Uri } | undefined {
  const n = a as { library?: string; file?: string; member?: string; type?: string; scheme?: string; path?: string } | undefined;
  let uri: vscode.Uri | undefined;
  if (a instanceof vscode.Uri) { uri = a; } else if (n?.library && n.file && n.member) { uri = memberUri(n.library, n.file, n.member, n.type ?? ''); }
  uri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== MEMBER_SCHEME) { return undefined; }
  const m = parseMemberPath(uri.path);
  return { library: m.library, file: m.file, member: m.member, type: m.extension, uri };
}

// ================================================================ find a member anywhere

async function findMember(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const input = await vscode.window.showInputBox({
    title: vscode.l10n.t('Find member'), value: state.get<string>('vanthrex.findMember.last', ''), ignoreFocusOut: true,
    prompt: vscode.l10n.t('Member name or generic name (ORD*, *CUST*), optionally followed by a source type: ORD* RPGLE'),
  });
  if (!input?.trim()) { return; }
  await state.update('vanthrex.findMember.last', input.trim());
  const [name, type] = input.trim().split(/\s+/);
  const scope = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(list-ordered) My library list'), all: false },
    { label: vscode.l10n.t('$(globe) All user libraries (slower)'), all: true },
  ], { title: vscode.l10n.t('Where to look') });
  if (!scope) { return; }
  const libl = libraryList(conn);
  const rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Looking for {0}…', name.toUpperCase()) },
    () => conn.rows<Row>(findMemberSql(name, scope.all ? [] : libl, type), 1000));
  if (!rows.length) { vscode.window.showInformationMessage(vscode.l10n.t('No member matches {0}.', input.trim())); return; }
  rows.sort((a, b) => libraryRank(s(a, 'L'), libl) - libraryRank(s(b, 'L'), libl) || s(b, 'C').localeCompare(s(a, 'C')));
  const pdmBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('list-selection'), tooltip: vscode.l10n.t('Open the source file in PDM') };
  const builtBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('package'), tooltip: vscode.l10n.t('Objects built from this source') };
  type Item = vscode.QuickPickItem & { r: Row };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = vscode.l10n.t('{0} member(s) found{1}', rows.length, rows.length >= 1000 ? vscode.l10n.t(' (first 1000)') : '');
  qp.matchOnDescription = true; qp.matchOnDetail = true;
  qp.items = rows.map(r => {
    const rank = libraryRank(s(r, 'L'), libl);
    return { r, label: vscode.l10n.t('$(file-code) {0}/{1}({2})', s(r, 'L'), s(r, 'F'), s(r, 'M')), description: `${s(r, 'T')} · ${s(r, 'C').slice(0, 16)}${rank === 0 && libl.length ? ' · ' + vscode.l10n.t('first in library list') : ''}`,
      detail: s(r, 'X') || undefined, buttons: [pdmBtn, builtBtn] };
  });
  qp.onDidTriggerItemButton(async e => {
    const r = e.item.r;
    if (e.button === pdmBtn) { await vscode.commands.executeCommand('vanthrex.pdm', { level: 'members', library: s(r, 'L'), file: s(r, 'F'), name: s(r, 'M') }); }
    else { await vscode.commands.executeCommand('vanthrex.builtFrom', memberUri(s(r, 'L'), s(r, 'F'), s(r, 'M'), s(r, 'T'))); }
    qp.hide();
  });
  qp.onDidAccept(async () => {
    const r = qp.selectedItems[0]?.r;
    qp.hide();
    if (r) { await vscode.window.showTextDocument(memberUri(s(r, 'L'), s(r, 'F'), s(r, 'M'), s(r, 'T')), { preview: false }); }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

// ================================================================ objects built from this source

async function loadBuilt(conn: IbmiConnection, m: { library: string; file: string; member: string }): Promise<{ objects: BuiltObject[]; changed: string; lockedBy: string }> {
  const libs = [...libraryList(conn), m.library, (conn.profile.objectLibrary ?? '').toUpperCase()].filter(Boolean);
  const [mem, pgms, mods, locks] = await Promise.all([
    conn.rows<Row>(`SELECT VARCHAR(COALESCE(LAST_SOURCE_UPDATE_TIMESTAMP, LAST_CHANGE_TIMESTAMP)) AS C FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(m.library)} ` +
      `AND SYSTEM_TABLE_NAME = ${sqlString(m.file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(m.member)}`, 1).catch(() => [] as Row[]),
    conn.rows<Row>(builtFromSql('PROGRAM_INFO', m.library, m.file, m.member, libs), 200).catch(e => { logError(e); return [] as Row[]; }),
    conn.rows<Row>(builtFromSql('BOUND_MODULE_INFO', m.library, m.file, m.member, libs), 200).catch(e => { logError(e); return [] as Row[]; }),
    conn.lockHolders(m.library, m.file, '*FILE', m.member).catch(() => [] as { JOB: string }[]),
  ]);
  const changed = s(mem[0], 'C');
  const mine = new Set([conn.user]);
  return { objects: builtObjects(pgms, mods, changed), changed, lockedBy: locks.map(l => l.JOB).find(j => !mine.has(j.split('/')[1] ?? '')) ?? '' };
}

async function builtFrom(manager: ConnectionManager, a?: unknown): Promise<void> {
  const m = memberOf(a);
  if (!m) { throw new Error(vscode.l10n.t('Open a source member (or right-click one) first.')); }
  const conn = manager.require();
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Looking for objects built from {0}…', m.member) }, () => loadBuilt(conn, m));
  const stale = r.objects.filter(o => o.status === 'stale').length;
  showReport('builtFrom', {
    title: vscode.l10n.t('Objects built from {0}/{1}({2})', m.library, m.file, m.member),
    subtitle: !r.objects.length ? vscode.l10n.t('No program or service program in your library list was compiled from this member.')
      : stale ? vscode.l10n.t('{0} of {1} were compiled before the last change of the source — recompile them.', stale, r.objects.length)
      : vscode.l10n.t('{0} object(s), all compiled from the current source.', r.objects.length),
    facts: [[vscode.l10n.t('Source last changed'), r.changed], [vscode.l10n.t('In use by'), r.lockedBy || '—']],
    actions: [{ label: vscode.l10n.t('Compile now'), command: 'vanthrex.compile', args: [{ resourceUri: m.uri }] }, { label: vscode.l10n.t('Refresh'), command: 'vanthrex.builtFrom', args: [m.uri] }],
    tables: [{
      title: vscode.l10n.t('Objects'), columns: [vscode.l10n.t('Object'), vscode.l10n.t('Type'), vscode.l10n.t('Module'), vscode.l10n.t('Compiled'), vscode.l10n.t('Source at compile'), vscode.l10n.t('Status')],
      rows: r.objects.map(o => [`${o.library}/${o.name}`, o.type, o.module ?? '', (o.created ?? '').slice(0, 19), (o.sourceAtCompile ?? '').slice(0, 19),
        o.status === 'stale' ? vscode.l10n.t('⚠ source changed since') : o.status === 'current' ? vscode.l10n.t('✓ up to date') : '?']),
      rowClass: r.objects.map(o => (o.status === 'stale' ? 'bad' : undefined)),
      rowActions: r.objects.map(o => ({ label: vscode.l10n.t('Object information'), command: 'vanthrex.objectInfo', args: [{ library: o.library, name: o.name, type: o.type.startsWith('*') ? o.type : '*PGM' }] })),
      empty: vscode.l10n.t('Nothing found. Programs compiled from a copy of this source in another library are not shown.'),
    }],
  }, ALLOWED);
}

// ================================================================ status bar + compile on save

class MemberStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  private timer?: NodeJS.Timeout;
  private readonly cache = new Map<string, { at: number; text: ReturnType<typeof statusText> }>();
  private seq = 0;

  constructor(private readonly manager: ConnectionManager) {
    this.item.command = 'vanthrex.builtFrom';
  }

  schedule(force = false): void {
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { void this.update(force); }, 600);
  }

  private async update(force: boolean): Promise<void> {
    const on = vscode.workspace.getConfiguration('vanthrex').get<boolean>('memberStatusBar', true);
    const m = memberOf();
    const conn = this.manager.connection;
    if (!on || !m || !conn) { this.item.hide(); return; }
    const key = m.uri.toString();
    const hit = this.cache.get(key);
    const mine = ++this.seq;
    if (hit && !force && Date.now() - hit.at < 60_000) { this.show(hit.text); return; }
    try {
      const r = await loadBuilt(conn, m);
      if (mine !== this.seq) { return; }
      const t = statusText({ lockedBy: r.lockedBy, changed: r.changed, objects: r.objects });
      this.cache.set(key, { at: Date.now(), text: t });
      this.show(t);
    } catch (e) { logError(e); this.item.hide(); }
  }

  private show(t: ReturnType<typeof statusText>): void {
    this.item.text = t.text;
    this.item.tooltip = `${t.tooltip}\n${vscode.l10n.t('Click for details')}`;
    this.item.backgroundColor = t.warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  dispose(): void { this.item.dispose(); if (this.timer) { clearTimeout(this.timer); } }
}

export function registerV24(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const bar = new MemberStatusBar(manager);
  let neverThisSession = false;
  context.subscriptions.push(
    bar,
    vscode.commands.registerCommand('vanthrex.findMember', guard(() => findMember(manager, context.globalState))),
    vscode.commands.registerCommand('vanthrex.builtFrom', guard((a?: unknown) => builtFrom(manager, a))),
    vscode.window.onDidChangeActiveTextEditor(() => bar.schedule()),
    manager.onDidChange(() => bar.schedule(true)),
    vscode.workspace.onDidSaveTextDocument(async doc => {
      if (doc.uri.scheme !== MEMBER_SCHEME) { return; }
      bar.schedule(true);
      const cfg = vscode.workspace.getConfiguration('vanthrex');
      const action = compileOnSaveAction(parseMemberPath(doc.uri.path).extension, cfg.get<CompileOnSave>('compileOnSave', 'off'), cfg.get<string[]>('compileOnSave.types', []));
      if (action === 'none' || neverThisSession) { return; }
      if (action === 'ask') {
        const yes = vscode.l10n.t('Compile'); const always = vscode.l10n.t('Always'); const never = vscode.l10n.t('Not now');
        const c = await vscode.window.showInformationMessage(vscode.l10n.t('Saved. Compile {0}?', doc.uri.path.split('/').pop() ?? ''), yes, always, never);
        if (c === always) { await cfg.update('compileOnSave', 'always', vscode.ConfigurationTarget.Global); }
        if (c === never) { neverThisSession = true; return; }
        if (c !== yes && c !== always) { return; }
      }
      await vscode.commands.executeCommand('vanthrex.compile', doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vanthrex.memberStatusBar')) { bar.schedule(true); } }),
  );
  bar.schedule();
}
