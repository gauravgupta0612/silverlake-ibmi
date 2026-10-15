// 2.3 batch 3: Call Program with typed parameters, Who Is Signed On, and member notes (local or shared through
// an IFS file).

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { parseMemberPath, sqlString } from '../core/util';
import {
  Note, Parm, ParmKind, breakMessageCommand, callCommand, callLiteral, connectionKind, describeParm, endJobCommand, noteKey, programParameters, relocate,
} from '../core/v28';
import { MEMBER_SCHEME } from './fileSystems';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const pick = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { const v = s(r, k); if (v) { return v; } } return ''; };

// ================================================================ call with typed parameters

async function findSource(conn: IbmiConnection, lib: string, pgm: string): Promise<{ lib: string; file: string; member: string; type: string } | undefined> {
  const info = (await conn.rows<Row>(`SELECT * FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} AND PROGRAM_NAME = ${sqlString(pgm)} AND OBJECT_TYPE = '*PGM'`, 1).catch(() => [] as Row[]))[0];
  let src = { lib: pick(info, 'SOURCE_FILE_LIBRARY'), file: pick(info, 'SOURCE_FILE'), member: pick(info, 'SOURCE_FILE_MEMBER') };
  if (!src.member) {
    const pepLib = pick(info, 'PROGRAM_ENTRY_PROCEDURE_MODULE_LIBRARY'); const pep = pick(info, 'PROGRAM_ENTRY_PROCEDURE_MODULE');
    const mod = (await conn.rows<Row>(`SELECT * FROM QSYS2.BOUND_MODULE_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} AND PROGRAM_NAME = ${sqlString(pgm)}` +
      (pep ? ` AND BOUND_MODULE = ${sqlString(pep)}${pepLib ? ` AND BOUND_MODULE_LIBRARY = ${sqlString(pepLib)}` : ''}` : ''), 1).catch(() => [] as Row[]))[0];
    src = { lib: pick(mod, 'SOURCE_FILE_LIBRARY'), file: pick(mod, 'SOURCE_FILE'), member: pick(mod, 'SOURCE_FILE_MEMBER') };
  }
  if (!src.member) { return undefined; }
  const t = (await conn.rows<Row>(`SELECT COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(src.lib)} AND SYSTEM_TABLE_NAME = ${sqlString(src.file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(src.member)}`, 1).catch(() => [] as Row[]))[0];
  return { ...src, type: s(t, 'T') || pick(info, 'PROGRAM_ATTRIBUTE', 'OBJECT_ATTRIBUTE') };
}

async function askParmsByHand(): Promise<Parm[] | undefined> {
  const out: Parm[] = [];
  for (;;) {
    const kind = await vscode.window.showQuickPick([
      { label: vscode.l10n.t('$(check) Done — {0} parameter(s)', out.length), k: 'done' },
      { label: vscode.l10n.t('char(n)'), k: 'char' }, { label: vscode.l10n.t('packed(p:s)'), k: 'packed' }, { label: vscode.l10n.t('zoned(p:s)'), k: 'zoned' }, { label: vscode.l10n.t('int(10)'), k: 'int' }, { label: vscode.l10n.t('ind'), k: 'ind' },
      { label: vscode.l10n.t('Other (type the CL literal yourself)'), k: 'other' },
    ], { title: vscode.l10n.t('The source was not found: describe parameter {0}', out.length + 1) });
    if (!kind) { return undefined; }
    if (kind.k === 'done') { return out; }
    let length = 0; let decimals = 0;
    if (kind.k === 'char' || kind.k === 'packed' || kind.k === 'zoned') {
      const v = await vscode.window.showInputBox({ title: kind.k === 'char' ? vscode.l10n.t('Length') : vscode.l10n.t('Digits and decimals, e.g. 9 2'), validateInput: x => (/^\d+(\s+\d+)?$/.test(x.trim()) ? undefined : '9 2') });
      if (!v) { return undefined; }
      [length, decimals] = v.trim().split(/\s+/).map(Number); decimals = decimals || 0;
    }
    out.push({ name: `PARM${out.length + 1}`, kind: kind.k as ParmKind, length: kind.k === 'int' ? 10 : kind.k === 'ind' ? 1 : length, decimals, raw: '' });
  }
}

async function callTyped(manager: ConnectionManager, state: vscode.Memento, a?: unknown): Promise<void> {
  const conn = manager.require();
  const n = a as { library?: string; name?: string } | string | undefined;
  let lib = typeof n === 'object' ? n?.library?.toUpperCase() : undefined; let pgm = typeof n === 'object' ? n?.name?.toUpperCase() : undefined;
  if (typeof n === 'string' && n.includes('/')) { [lib, pgm] = n.toUpperCase().split('/'); }
  if (!pgm) {
    const v = (await vscode.window.showInputBox({ title: vscode.l10n.t('Call program'), prompt: 'LIBRARY/PROGRAM', ignoreFocusOut: true }))?.trim().toUpperCase();
    if (!v) { return; }
    [lib, pgm] = v.includes('/') ? v.split('/') : ['*LIBL', v];
  }
  if (!lib || lib === '*LIBL') {
    const r = (await conn.rows<Row>(`SELECT OBJLIB AS L FROM TABLE(QSYS2.OBJECT_STATISTICS('*LIBL', '*PGM', ${sqlString(pgm!)})) X`, 1).catch(() => [] as Row[]))[0];
    lib = s(r, 'L') || '*LIBL';
  }
  const src = lib !== '*LIBL' ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Reading the parameters of {0}…', pgm!) }, () => findSource(conn, lib!, pgm!)) : undefined;
  let parms: Parm[] | undefined;
  let from = '';
  if (src) {
    try { parms = programParameters(await conn.readMember(src.lib, src.file, src.member), src.type); from = `${src.lib}/${src.file}(${src.member})`; } catch (e) { logError(e); }
  }
  if (!parms) { parms = await askParmsByHand(); if (!parms) { return; } }
  const key = `vanthrex.call.${conn.profile.name}.${lib}/${pgm}`;
  const last = state.get<string[]>(key, []);
  const values: string[] = []; const literals: string[] = [];
  for (let i = 0; i < parms.length; i++) {
    const p = parms[i];
    const v = await vscode.window.showInputBox({
      title: vscode.l10n.t('{0} — parameter {1}/{2}: {3} {4}', pgm!, i + 1, parms.length, p.name, describeParm(p)),
      prompt: p.kind === 'other' ? vscode.l10n.t('Type the CL literal yourself (e.g. \'ABC\' or X\'00F1\')') : from ? vscode.l10n.t('From {0}', from) : undefined,
      value: last[i] ?? '', ignoreFocusOut: true,
      validateInput: x => { try { callLiteral(p, x); return undefined; } catch (e) { return errorMessage(e); } },
    });
    if (v === undefined) { return; }
    values.push(v); literals.push(callLiteral(p, v));
  }
  await state.update(key, values);
  const cmd = callCommand(lib, pgm!, literals);
  const run = vscode.l10n.t('Run'); const batch = vscode.l10n.t('Submit to Batch'); const copy = vscode.l10n.t('Copy');
  const c = await vscode.window.showInformationMessage(cmd, {
    modal: true, detail: parms.length ? parms.map((p, i) => `${p.name} ${describeParm(p)} = ${values[i]} → ${literals[i]}`).join('\n') : vscode.l10n.t('No parameters.'),
  }, run, batch, copy);
  if (c === copy) { await vscode.env.clipboard.writeText(cmd); return; }
  if (c === batch) {
    const r = await conn.runCL(`SBMJOB CMD(${cmd}) JOB(${pgm})`);
    vscode.window.showInformationMessage(r.ok ? vscode.l10n.t('Submitted: {0}', (r.stdout + r.stderr).match(/\d{6}\/\S+\/\S+/)?.[0] ?? pgm!) : (r.stderr || r.stdout).trim());
    return;
  }
  if (c !== run) { return; }
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Calling {0}…', pgm!) }, () => conn.runCL(cmd));
  const text = `${r.stdout}\n${r.stderr}`.split('\n').map(x => x.trim()).filter(Boolean).slice(-5).join('\n');
  if (r.ok) { vscode.window.showInformationMessage(vscode.l10n.t('{0} ended normally.', pgm!), { modal: true, detail: text || vscode.l10n.t('No messages.') }); }
  else { vscode.window.showErrorMessage(vscode.l10n.t('{0} ended with an error: {1}', pgm!, text.split('\n').pop() ?? '')); }
}

// ================================================================ who is signed on

const SIGNED_ALLOWED = new Set(['vanthrex.signedOn', 'vanthrex.signedOn.row', 'vanthrex.signedOn.broadcast']);

async function signedOn(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const [inter, servers] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Who is signed on…') }, () => Promise.all([
    conn.rows<Row>(`SELECT JOB_NAME AS J, AUTHORIZATION_NAME AS U, SUBSYSTEM AS S, JOB_STATUS AS ST, COALESCE(FUNCTION, '') AS F, ELAPSED_CPU_PERCENTAGE AS C ` +
      `FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X WHERE JOB_TYPE = 'INT' ORDER BY AUTHORIZATION_NAME`, 2000),
    conn.rows<Row>(`SELECT JOB_NAME AS J, AUTHORIZATION_NAME AS U, COALESCE(FUNCTION, '') AS F FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X ` +
      `WHERE JOB_TYPE IN ('PJ', 'BCI') AND AUTHORIZATION_NAME NOT IN ('QUSER', 'QSYS', 'QTCP')`, 5000).catch(() => [] as Row[]),
  ]));
  const groups = new Map<string, number>();
  for (const r of servers) { const k = `${s(r, 'U')}|${connectionKind(s(r, 'J'), s(r, 'F'))}`; groups.set(k, (groups.get(k) ?? 0) + 1); }
  const g = [...groups.entries()].map(([k, n]) => { const [u, kind] = k.split('|'); return [u, kind, n] as [string, string, number]; }).sort((a, b) => a[0].localeCompare(b[0]) || b[2] - a[2]);
  showReport('signedOn', {
    title: vscode.l10n.t('Who is signed on — {0}', conn.profile.name),
    subtitle: vscode.l10n.t('{0} 5250 session(s) and {1} server connection(s) from {2} user(s).', inter.length, servers.length, new Set([...inter, ...servers].map(r => s(r, 'U'))).size),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.signedOn' }, ...(inter.length ? [{ label: vscode.l10n.t('Message everyone signed on…'), command: 'vanthrex.signedOn.broadcast', args: [inter.map(r => s(r, 'J'))] }] : [])],
    tables: [
      { title: vscode.l10n.t('5250 sessions'), filter: true, columns: [vscode.l10n.t('User'), vscode.l10n.t('Job'), vscode.l10n.t('Subsystem'), vscode.l10n.t('Status'), vscode.l10n.t('Doing'), 'CPU %'],
        rows: inter.map(r => [s(r, 'U'), s(r, 'J'), s(r, 'S'), s(r, 'ST'), s(r, 'F'), s(r, 'C')]), rowClass: inter.map(r => (s(r, 'ST') === 'MSGW' ? 'bad' : undefined)),
        rowActions: inter.map(r => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.signedOn.row', args: [s(r, 'J')] })), empty: vscode.l10n.t('Nobody is signed on to a 5250 session.') },
      { title: vscode.l10n.t('Server connections by user'), filter: true, columns: [vscode.l10n.t('User'), vscode.l10n.t('Kind'), vscode.l10n.t('Jobs')], rows: g, empty: vscode.l10n.t('None.') },
    ],
    note: vscode.l10n.t('Click a session for details, job log, a break message or ending it (asked first).'),
  }, SIGNED_ALLOWED);
}

async function signedOnRow(manager: ConnectionManager, job: string): Promise<void> {
  const conn = manager.require();
  const o = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(info) Details'), k: 'details' }, { label: vscode.l10n.t('$(output) Job log'), k: 'log' },
    { label: vscode.l10n.t('$(comment) Send a break message…'), k: 'msg' }, { label: vscode.l10n.t('$(debug-stop) End the session (controlled, 30 s)'), k: 'end' },
    { label: vscode.l10n.t('$(close) End the session now'), k: 'endnow' },
  ], { title: job });
  if (!o) { return; }
  if (o.k === 'details') { await vscode.commands.executeCommand('vanthrex.jobDetails', job); return; }
  if (o.k === 'log') { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); return; }
  if (o.k === 'msg') { await broadcast(manager, [job]); return; }
  const cmd = endJobCommand(job, o.k === 'endnow');
  const yes = vscode.l10n.t('End It');
  if (await vscode.window.showWarningMessage(vscode.l10n.t('End {0}?', job), { modal: true, detail: vscode.l10n.t('Unsaved work in that session is lost.') + `\n${cmd}` }, yes) !== yes) { return; }
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || cmd); }
  vscode.window.setStatusBarMessage(`✓ ${cmd}`, 4000);
  await signedOn(manager);
}

async function broadcast(manager: ConnectionManager, jobs: string[]): Promise<void> {
  const conn = manager.require();
  const text = await vscode.window.showInputBox({ title: jobs.length > 1 ? vscode.l10n.t('Message to {0} session(s)', jobs.length) : vscode.l10n.t('Message to {0}', jobs[0]), ignoreFocusOut: true, placeHolder: vscode.l10n.t('The system will be down at 18:00 — please save your work') });
  if (!text?.trim()) { return; }
  let ok = 0; const failed: string[] = [];
  for (const j of jobs) {
    const dev = j.split('/')[2];
    try { const r = await conn.runCL(breakMessageCommand(text, dev)); if (r.ok) { ok++; } else { failed.push(dev); } } catch { failed.push(dev); }
  }
  vscode.window.showInformationMessage(failed.length ? vscode.l10n.t('Sent to {0}; not sent to {1}.', ok, failed.join(', ')) : vscode.l10n.t('Sent to {0} session(s).', ok));
}

// ================================================================ member notes

class NotesStore {
  private cache?: { at: number; data: Record<string, Note[]> };
  readonly changed = new vscode.EventEmitter<void>();
  constructor(private readonly manager: ConnectionManager, private readonly state: vscode.Memento) {}

  private shared(): string { return (vscode.workspace.getConfiguration('vanthrex').get<string>('notes.sharedFile', '') ?? '').trim(); }

  async all(fresh = false): Promise<Record<string, Note[]>> {
    const path = this.shared(); const conn = this.manager.connection;
    if (!path || !conn) { return this.state.get<Record<string, Note[]>>('vanthrex.notes', {}); }
    if (!fresh && this.cache && Date.now() - this.cache.at < 60_000) { return this.cache.data; }
    let data: Record<string, Note[]> = {};
    try { data = JSON.parse((await conn.readStreamFile(path)).toString('utf8') || '{}'); } catch (e) { if (!/no such file|ENOENT|not found/i.test(errorMessage(e))) { logError(e); } }
    this.cache = { at: Date.now(), data };
    return data;
  }

  async update(key: string, change: (list: Note[]) => Note[]): Promise<void> {
    const path = this.shared(); const conn = this.manager.connection;
    if (!path || !conn) {
      const all = { ...this.state.get<Record<string, Note[]>>('vanthrex.notes', {}) };
      all[key] = change(all[key] ?? []); if (!all[key].length) { delete all[key]; }
      await this.state.update('vanthrex.notes', all);
    } else {
      const all = await this.all(true);            // read-modify-write, so teammates' notes are kept
      all[key] = change(all[key] ?? []); if (!all[key].length) { delete all[key]; }
      await conn.writeStreamFile(path, Buffer.from(JSON.stringify(all, null, 1), 'utf8'));
      this.cache = { at: Date.now(), data: all };
    }
    this.changed.fire();
  }
}

function keyOf(manager: ConnectionManager, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== MEMBER_SCHEME || !manager.connection) { return undefined; }
  const m = parseMemberPath(uri.path);
  return noteKey(manager.connection.profile.name, m.library, m.file, m.member);
}

export function registerV28(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const notes = new NotesStore(manager, context.globalState);
  const deco = vscode.window.createTextEditorDecorationType({ after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' }, overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right });
  const render = async (ed?: vscode.TextEditor) => {
    if (!ed) { return; }
    const key = keyOf(manager, ed.document.uri);
    if (!key) { return; }
    const list = (await notes.all())[key] ?? [];
    const lines = Array.from({ length: ed.document.lineCount }, (_, i) => ed.document.lineAt(i).text);
    ed.setDecorations(deco, list.map(n => ({ n, line: relocate(n, lines) })).filter(x => x.line !== undefined).map(x => ({
      range: new vscode.Range(x.line!, Number.MAX_SAFE_INTEGER, x.line!, Number.MAX_SAFE_INTEGER),
      renderOptions: { after: { contentText: `📝 ${x.n.text.split('\n')[0].slice(0, 80)} — ${x.n.by}` } },
      hoverMessage: new vscode.MarkdownString(`**📝 ${x.n.by}** · ${new Date(x.n.at).toLocaleString()}\n\n${x.n.text}`),
    })));
  };
  const renderAll = () => { for (const ed of vscode.window.visibleTextEditors) { void render(ed); } };
  const lensEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    deco, notes.changed, lensEmitter,
    notes.changed.event(() => { renderAll(); lensEmitter.fire(); }),
    vscode.window.onDidChangeVisibleTextEditors(() => renderAll()),
    vscode.workspace.onDidSaveTextDocument(d => { if (d.uri.scheme === MEMBER_SCHEME) { renderAll(); } }),
    manager.onDidChange(() => renderAll()),
    vscode.languages.registerCodeLensProvider({ scheme: MEMBER_SCHEME }, {
      onDidChangeCodeLenses: lensEmitter.event,
      provideCodeLenses: async doc => {
        const key = keyOf(manager, doc.uri);
        const n = key ? ((await notes.all())[key] ?? []).length : 0;
        return n ? [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: vscode.l10n.t('📝 {0} note(s)', n), command: 'vanthrex.notes.show', arguments: [doc.uri] })] : [];
      },
    }),
    vscode.commands.registerCommand('vanthrex.callTyped', guard((a?: unknown) => callTyped(manager, context.globalState, a))),
    vscode.commands.registerCommand('vanthrex.signedOn', guard(() => signedOn(manager))),
    vscode.commands.registerCommand('vanthrex.signedOn.row', guard((job: string) => signedOnRow(manager, job))),
    vscode.commands.registerCommand('vanthrex.signedOn.broadcast', guard((jobs: string[]) => broadcast(manager, jobs))),
    vscode.commands.registerCommand('vanthrex.notes.add', guard(async () => {
      const ed = vscode.window.activeTextEditor;
      const key = ed && keyOf(manager, ed.document.uri);
      if (!ed || !key) { throw new Error(vscode.l10n.t('Open a source member first.')); }
      const line = ed.selection.active.line;
      const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Note on line {0}', line + 1), prompt: ed.document.lineAt(line).text.trim().slice(0, 80), ignoreFocusOut: true });
      if (!text?.trim()) { return; }
      await notes.update(key, list => [...list, { id: `${Date.now()}`, line, snippet: ed.document.lineAt(line).text, text: text.trim(), by: manager.require().user, at: new Date().toISOString() }]);
    })),
    vscode.commands.registerCommand('vanthrex.notes.show', guard(async (uri?: vscode.Uri) => {
      const u = uri ?? vscode.window.activeTextEditor?.document.uri;
      const key = u && keyOf(manager, u);
      if (!u || !key) { throw new Error(vscode.l10n.t('Open a source member first.')); }
      const list = (await notes.all(true))[key] ?? [];
      const doc = await vscode.workspace.openTextDocument(u);
      const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);
      type Item = vscode.QuickPickItem & { n: Note };
      const delBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Delete note') };
      const qp = vscode.window.createQuickPick<Item>();
      qp.title = vscode.l10n.t('Notes on {0}', u.path.split('/').slice(-1)[0]);
      qp.items = list.map(n => { const l = relocate(n, lines); return { n, label: `📝 ${n.text.split('\n')[0]}`, description: `${n.by} · ${new Date(n.at).toLocaleDateString()}`, detail: l === undefined ? vscode.l10n.t('(the line was changed or removed)') : vscode.l10n.t('Line {0}: {1}', l + 1, lines[l].trim().slice(0, 100)), buttons: [delBtn] }; });
      qp.onDidTriggerItemButton(async e => { await notes.update(key, l => l.filter(x => x.id !== e.item.n.id)); qp.items = qp.items.filter(i => i !== e.item); });
      qp.onDidAccept(async () => {
        const n = qp.selectedItems[0]?.n; qp.hide();
        const l = n ? relocate(n, lines) : undefined;
        if (l !== undefined) { await vscode.window.showTextDocument(u, { selection: new vscode.Range(l, 0, l, 0) }); }
      });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    })),
    vscode.commands.registerCommand('vanthrex.notes.all', guard(async () => {
      const sys = manager.require().profile.name.toUpperCase();
      const all = await notes.all(true);
      const items = Object.entries(all).filter(([k]) => k.startsWith(`${sys}|`)).flatMap(([k, list]) => list.map(n => ({ k, n })));
      if (!items.length) { vscode.window.showInformationMessage(vscode.l10n.t('No notes yet: right-click a line in a member → Add Note.')); return; }
      const p = await vscode.window.showQuickPick(items.map(x => ({ x, label: `📝 ${x.n.text.split('\n')[0]}`, description: x.k.split('|')[1], detail: `${x.n.by} · ${new Date(x.n.at).toLocaleString()}` })), { title: vscode.l10n.t('All notes on {0}', sys), matchOnDescription: true, matchOnDetail: true });
      if (!p) { return; }
      const m = /^[^|]+\|([^/]+)\/([^(]+)\(([^)]+)\)$/.exec(p.x.k);
      if (!m) { return; }
      const rows = await manager.require().rows<Row>(`SELECT COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(m[1])} AND SYSTEM_TABLE_NAME = ${sqlString(m[2])} AND SYSTEM_TABLE_MEMBER = ${sqlString(m[3])}`, 1);
      const uri = vscode.Uri.from({ scheme: MEMBER_SCHEME, path: `/${m[1]}/${m[2]}/${m[3]}.${(s(rows[0], 'T') || 'mbr').toLowerCase()}` });
      await vscode.commands.executeCommand('vanthrex.notes.show', uri);
    })),
  );
  renderAll();
}
