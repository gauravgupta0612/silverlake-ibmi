// 2.2 batch 2: compile history, changes since the last compile, live job log and the Pinned view.

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, logError } from '../core/log';
import {
  CompileRecord, JobLogMessage, Pin, addCompile, compileSummary, isAlarming, jobLogLine, jobLogSql, lastCompileDay, latestPerSource,
  movePin, pinDescription, pinKey, pinLabel, togglePin,
} from '../core/v25';
import { compileFinished } from './compile';
import { ifsUri, memberUri } from './fileSystems';
import { showReport } from './reportPanel';
import { loadBuilt, memberOf } from './v24View';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const HISTORY_KEY = 'vanthrex.compileHistory';
const ALLOWED = new Set(['vanthrex.compileHistory', 'vanthrex.compileHistory.open', 'vanthrex.compileHistory.recompileBroken', 'vanthrex.compileHistory.clear']);

// ================================================================ compile history

function showHistory(state: vscode.Memento): void {
  const list = state.get<CompileRecord[]>(HISTORY_KEY, []);
  const sum = compileSummary(list);
  const broken = latestPerSource(list).filter(r => !r.ok);
  const when = (r: CompileRecord) => new Date(r.at).toLocaleString();
  const row = (r: CompileRecord) => [when(r), r.name, r.object, r.ok ? (r.warnings ? vscode.l10n.t('✓ {0} warning(s)', r.warnings) : '✓') : vscode.l10n.t('✗ {0} error(s)', r.errors), r.message ?? '', r.system];
  const cols = [vscode.l10n.t('When'), vscode.l10n.t('Source'), vscode.l10n.t('Object'), vscode.l10n.t('Result'), vscode.l10n.t('Message'), vscode.l10n.t('System')];
  showReport('compileHistory', {
    title: vscode.l10n.t('Compile history'),
    subtitle: sum.total ? vscode.l10n.t('{0} compile(s), {1}% successful. {2} source(s) are broken right now.', sum.total, sum.rate, sum.brokenNow) : vscode.l10n.t('Nothing compiled yet.'),
    actions: [
      ...(broken.length ? [{ label: vscode.l10n.t('Recompile the {0} broken source(s)', broken.length), command: 'vanthrex.compileHistory.recompileBroken' }] : []),
      { label: vscode.l10n.t('Refresh'), command: 'vanthrex.compileHistory' }, { label: vscode.l10n.t('Clear history'), command: 'vanthrex.compileHistory.clear' },
    ],
    tables: [
      { title: vscode.l10n.t('Broken right now'), columns: cols, rows: broken.map(row), rowClass: broken.map(() => 'bad'),
        rowActions: broken.map(r => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.compileHistory.open', args: [r.uri] })), empty: vscode.l10n.t('Nothing — every source compiled the last time you tried.') },
      { title: vscode.l10n.t('All compiles (newest first)'), filter: true, columns: cols, rows: list.map(row), rowClass: list.map(r => (r.ok ? undefined : 'bad')),
        rowActions: list.map(r => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.compileHistory.open', args: [r.uri] })) },
    ],
    note: vscode.l10n.t('Kept on this computer (last {0} compiles), for every system you connect to.', 200),
  }, ALLOWED);
}

// ================================================================ changes since the last compile

async function changedSinceCompile(manager: ConnectionManager, a?: unknown): Promise<void> {
  const m = memberOf(a);
  if (!m) { throw new Error(vscode.l10n.t('Open a source member first.')); }
  const editor = await vscode.window.showTextDocument(m.uri, { preview: false });
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Finding the last compile…') }, () => loadBuilt(manager.require(), m));
  const day = lastCompileDay(r.objects);
  if (!day) {
    vscode.window.showInformationMessage(vscode.l10n.t('{0} was never compiled into a program in your library list, so every line is new.', m.member));
    return;
  }
  await vscode.commands.executeCommand('vanthrex.changedSince', day, vscode.l10n.t('Changed since the last compile ({0})', day));
  void editor;
}

// ================================================================ live job log

const live = new Map<string, { channel: vscode.OutputChannel; timer: NodeJS.Timeout; stop: () => void }>();

async function jobLogLive(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  const job = (typeof a === 'string' ? a : (a as { job?: string } | undefined)?.job)
    ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Live job log'), prompt: vscode.l10n.t('Qualified job name (number/user/name)'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!job) { return; }
  jobLogSql(job, 0);   // validates the name
  if (live.has(job)) { live.get(job)!.channel.show(true); return; }
  const channel = vscode.window.createOutputChannel(vscode.l10n.t('Job log {0}', job), 'log');
  channel.show(true);
  channel.appendLine(vscode.l10n.t('Following the job log of {0} — new messages appear here every few seconds. Stop with "Vanthrex: Stop Live Job Log".', job));
  let last = 0; let polls = 0; let busy = false; let lastAlarm = 0;
  const started = Date.now();
  const stop = (why: string) => {
    const l = live.get(job);
    if (!l) { return; }
    clearInterval(l.timer); live.delete(job);
    channel.appendLine(`— ${why} —`);
  };
  const tick = async () => {
    if (busy) { return; }
    busy = true;
    try {
      if (!manager.connection) { stop(vscode.l10n.t('disconnected')); return; }
      const rows = await conn.rows<Row>(jobLogSql(job, last), 2000);
      for (const r of rows) {
        const msg: JobLogMessage = { pos: Number(r.P), time: s(r, 'T'), id: s(r, 'I'), type: s(r, 'Y'), severity: Number(r.S ?? 0), text: s(r, 'X'), from: s(r, 'F') };
        last = Math.max(last, msg.pos);
        channel.appendLine(jobLogLine(msg));
        if (polls > 0 && isAlarming(msg) && Date.now() - lastAlarm > 15_000) {
          lastAlarm = Date.now();
          const explain = vscode.l10n.t('Explain');
          void vscode.window.showWarningMessage(`${job}: ${msg.id} ${msg.text}`.slice(0, 300), explain, vscode.l10n.t('Show')).then(c => {
            if (c === explain && msg.id) { void vscode.commands.executeCommand('vanthrex.explainMessage', msg.id); } else if (c) { channel.show(true); }
          });
        }
      }
      polls++;
      if (polls % 5 === 0) {
        const name = job.split('/')[2];
        const act = await conn.rows<Row>(`SELECT JOB_STATUS AS S FROM TABLE(QSYS2.ACTIVE_JOB_INFO(JOB_NAME_FILTER => '${name}')) A WHERE JOB_NAME = '${job}'`, 1).catch(() => [{ S: '?' }] as Row[]);
        if (!act.length) { stop(vscode.l10n.t('the job ended')); }
      }
      if (Date.now() - started > 2 * 3600_000) { stop(vscode.l10n.t('stopped after 2 hours')); }
    } catch (e) {
      logError(e);
      channel.appendLine(`✗ ${errorMessage(e).split('\n')[0]}`);
      if (polls === 0) { stop(vscode.l10n.t('could not read the job log')); }
      polls++;
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 3000);
  live.set(job, { channel, timer, stop: () => stop(vscode.l10n.t('stopped')) });
  await tick();
}

async function stopLive(): Promise<void> {
  if (!live.size) { vscode.window.showInformationMessage(vscode.l10n.t('No live job log is running.')); return; }
  const all = vscode.l10n.t('All');
  const p = await vscode.window.showQuickPick([...live.keys(), ...(live.size > 1 ? [all] : [])], { title: vscode.l10n.t('Stop following which job log?') });
  if (!p) { return; }
  for (const [k, v] of [...live]) { if (p === all || p === k) { v.stop(); } }
}

// ================================================================ pinned items

class PinnedTree implements vscode.TreeDataProvider<Pin> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly manager: ConnectionManager, private readonly state: vscode.Memento) {}

  private key(): string { return `vanthrex.pins.${this.manager.connection?.profile.name ?? ''}`; }
  get list(): Pin[] { return this.state.get<Pin[]>(this.key(), []); }
  async save(list: Pin[]): Promise<void> { await this.state.update(this.key(), list); this.refresh(); }
  refresh(): void { this.emitter.fire(); }

  getTreeItem(p: Pin): vscode.TreeItem {
    const item = new vscode.TreeItem(pinLabel(p), vscode.TreeItemCollapsibleState.None);
    item.description = pinDescription(p);
    item.contextValue = `pin.${p.kind}`;
    const icons: Record<string, string> = { member: 'file-code', srcfile: 'list-selection', library: 'library', object: 'package', ifs: 'file' };
    item.iconPath = new vscode.ThemeIcon(icons[p.kind] ?? 'pin');
    item.command = { command: 'vanthrex.pin.open', title: vscode.l10n.t('Open'), arguments: [p] };
    if (p.kind === 'member') { item.resourceUri = memberUri(p.library!, p.file!, p.name!, p.type ?? ''); }
    item.tooltip = `${pinLabel(p)}\n${pinDescription(p)}`;
    return item;
  }

  getChildren(p?: Pin): Pin[] {
    if (p || !this.manager.connection) { return []; }
    return this.list;
  }
}

/** Turn whatever was right-clicked (library tree node, IFS node, PDM row, editor) into a pin. */
function toPin(a?: unknown): Pin | undefined {
  const n = a as { kind?: string; library?: string; file?: string; member?: string; name?: string; type?: string; text?: string; path?: string; isDirectory?: boolean } | undefined;
  if (n?.kind === 'member') { return { kind: 'member', library: n.library, file: n.file, name: n.member, type: n.type, text: n.text }; }
  if (n?.kind === 'srcfile') { return { kind: 'srcfile', library: n.library, file: n.file, text: n.text }; }
  if (n?.kind === 'library') { return { kind: 'library', library: n.library }; }
  if (n?.kind === 'object') { return { kind: 'object', library: n.library, name: n.name, type: n.type, text: n.text }; }
  if (n?.path && typeof n.isDirectory === 'boolean') { return { kind: 'ifs', path: n.path, type: n.isDirectory ? 'dir' : 'file' }; }
  const m = memberOf(a instanceof vscode.Uri ? a : undefined);
  if (m) { return { kind: 'member', library: m.library, file: m.file, name: m.member, type: m.type }; }
  return undefined;
}

async function openPin(p: Pin): Promise<void> {
  switch (p.kind) {
    case 'member': await vscode.window.showTextDocument(memberUri(p.library!, p.file!, p.name!, p.type ?? ''), { preview: false }); break;
    case 'srcfile': await vscode.commands.executeCommand('vanthrex.pdm', { level: 'members', library: p.library, file: p.file }); break;
    case 'library': await vscode.commands.executeCommand('vanthrex.pdm', { level: 'objects', library: p.library }); break;
    case 'object': await vscode.commands.executeCommand('vanthrex.objectInfo', { library: p.library, name: p.name, type: p.type }); break;
    case 'ifs':
      if (p.type === 'dir') { await vscode.commands.executeCommand('vanthrex.pin.ifsDir', p.path); } else { await vscode.window.showTextDocument(ifsUri(p.path!), { preview: false }); }
      break;
  }
}

export function registerV25(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const state = context.globalState;
  const pins = new PinnedTree(manager, state);
  context.subscriptions.push(
    compileFinished.event(r => {
      void state.update(HISTORY_KEY, addCompile(state.get<CompileRecord[]>(HISTORY_KEY, []), {
        at: new Date().toISOString(), system: r.system, uri: r.uri.toString(), name: r.name, object: r.object, ok: r.ok, errors: r.errors, warnings: r.warnings, command: r.command, message: r.message,
      }));
    }),
    vscode.commands.registerCommand('vanthrex.compileHistory', guard(async () => showHistory(state))),
    vscode.commands.registerCommand('vanthrex.compileHistory.open', guard(async (uri: string) => { await vscode.window.showTextDocument(vscode.Uri.parse(uri), { preview: false }); })),
    vscode.commands.registerCommand('vanthrex.compileHistory.clear', guard(async () => { await state.update(HISTORY_KEY, []); showHistory(state); })),
    vscode.commands.registerCommand('vanthrex.compileHistory.recompileBroken', guard(async () => {
      const broken = latestPerSource(state.get<CompileRecord[]>(HISTORY_KEY, [])).filter(r => !r.ok && r.system === manager.require().profile.name);
      if (!broken.length) { vscode.window.showInformationMessage(vscode.l10n.t('Nothing broken on this system.')); return; }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Recompiling {0} source(s)…', broken.length), cancellable: true }, async (p, tok) => {
        for (const r of broken) {
          if (tok.isCancellationRequested) { break; }
          p.report({ message: r.name, increment: 100 / broken.length });
          await vscode.commands.executeCommand('vanthrex.compile', vscode.Uri.parse(r.uri));
        }
      });
      showHistory(state);
    })),
    vscode.commands.registerCommand('vanthrex.changedSinceCompile', guard((a?: unknown) => changedSinceCompile(manager, a))),
    vscode.commands.registerCommand('vanthrex.jobLogLive', guard((a?: unknown) => jobLogLive(manager, a))),
    vscode.commands.registerCommand('vanthrex.jobLogLive.stop', guard(() => stopLive())),
    vscode.window.registerTreeDataProvider('vanthrex.pinned', pins),
    vscode.commands.registerCommand('vanthrex.pin', guard(async (a?: unknown) => {
      manager.require();
      const p = toPin(a);
      if (!p) { throw new Error(vscode.l10n.t('Right-click a member, source file, library, object or IFS file to pin it.')); }
      const r = togglePin(pins.list, p);
      await pins.save(r.list);
      vscode.window.setStatusBarMessage(r.pinned ? vscode.l10n.t('📌 {0} pinned', pinLabel(p)) : vscode.l10n.t('{0} unpinned', pinLabel(p)), 3000);
    })),
    vscode.commands.registerCommand('vanthrex.unpin', guard(async (p: Pin) => { await pins.save(pins.list.filter(x => pinKey(x) !== pinKey(p))); })),
    vscode.commands.registerCommand('vanthrex.pin.open', guard((p: Pin) => openPin(p))),
    vscode.commands.registerCommand('vanthrex.pin.moveUp', guard(async (p: Pin) => { await pins.save(movePin(pins.list, pinKey(p), -1)); })),
    vscode.commands.registerCommand('vanthrex.pin.moveDown', guard(async (p: Pin) => { await pins.save(movePin(pins.list, pinKey(p), 1)); })),
    vscode.commands.registerCommand('vanthrex.pin.ifsDir', guard(async (path: string) => {
      await vscode.commands.executeCommand('workbench.view.extension.vanthrex');
      await vscode.commands.executeCommand('vanthrex.ifsChangeRoot', path);
    })),
    manager.onDidChange(() => pins.refresh()),
    { dispose: () => { for (const v of live.values()) { v.stop(); } } },
  );
}
