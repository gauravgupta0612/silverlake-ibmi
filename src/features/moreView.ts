import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { assertSystemName, shSingleQuote, sqlString } from '../core/util';
import { dateToSrcDate, mergeRecords, SourceRecord } from '../core/sourceDates';
import {
  LibrarySet, ReplaceOptions, TableColumn, buildPattern, formatSql, jobPhase, parseLibraryList, replaceLines, rpgForTable, sbmjobCommand, submittedJob,
} from '../core/moreTools';
import { memberUri } from './fileSystems';
import { spoolUri } from './spool';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
const ALLOWED = new Set(['vanthrex.replaceInSourceFile', 'vanthrex.replaceInSourceFile.apply', 'vanthrex.codeMetrics.open']);

// ================================================================ RPG code from a table

async function rpgFromTable(manager: ConnectionManager, o?: { library: string; name: string }): Promise<void> {
  const conn = manager.require();
  let lib = o?.library; let tbl = o?.name;
  if (!lib || !tbl) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Generate RPG code for a table'), prompt: 'LIBRARY/TABLE', ignoreFocusOut: true });
    if (!v?.includes('/')) { return; }
    [lib, tbl] = v.trim().toUpperCase().split('/');
  }
  lib = assertSystemName(lib, 'library'); tbl = assertSystemName(tbl, 'table');
  const [cols, pk] = await Promise.all([
    conn.rows<Row>(`SELECT COLUMN_NAME AS N, SYSTEM_COLUMN_NAME AS SN, DATA_TYPE AS T, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS S, IS_NULLABLE AS NL, COALESCE(COLUMN_TEXT, '') AS TXT ` +
      `FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(tbl)} ORDER BY ORDINAL_POSITION`, 2000),
    conn.rows<Row>(`SELECT K.COLUMN_NAME AS C FROM QSYS2.SYSCST C JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
      `WHERE C.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND C.SYSTEM_TABLE_NAME = ${sqlString(tbl)} AND C.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE') ORDER BY C.CONSTRAINT_TYPE DESC, K.ORDINAL_POSITION`, 50).catch(() => []),
  ]);
  if (!cols.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', lib, tbl)); }
  const columns: TableColumn[] = cols.map(c => ({ name: s(c, 'N'), system: s(c, 'SN'), type: s(c, 'T'), length: Number(c.L), scale: Number(c.S), nullable: s(c, 'NL') === 'Y', text: s(c, 'TXT') }));
  let keys = [...new Set(pk.map(p => s(p, 'C')))];
  if (!keys.length) {
    const picked = await vscode.window.showQuickPick(columns.map(c => ({ label: c.name, description: c.text })), { canPickMany: true, title: vscode.l10n.t('{0} has no primary key — pick the key columns', tbl) });
    if (!picked?.length) { return; }
    keys = picked.map(p => p.label);
  }
  const doc = await vscode.workspace.openTextDocument({ language: 'rpgle', content: rpgForTable(lib, tbl, columns, keys) });
  await vscode.window.showTextDocument(doc, { preview: false });
}

// ================================================================ SQL formatter

function sqlFormatter(): vscode.DocumentFormattingEditProvider & vscode.DocumentRangeFormattingEditProvider {
  const edit = (doc: vscode.TextDocument, range: vscode.Range) => [vscode.TextEdit.replace(range, formatSql(doc.getText(range)).replace(/\n$/, range.end.line === doc.lineCount - 1 ? '\n' : ''))];
  return {
    provideDocumentFormattingEdits: doc => edit(doc, new vscode.Range(0, 0, doc.lineCount, 0)),
    provideDocumentRangeFormattingEdits: (doc, range) => edit(doc, range),
  };
}

// ================================================================ submit & watch

class Watcher implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  private readonly jobs = new Map<string, { started: number; phase: string; conn: IbmiConnection }>();
  private timer: NodeJS.Timeout | undefined;

  watch(conn: IbmiConnection, job: string): void {
    this.jobs.set(job, { started: Date.now(), phase: 'queued', conn });
    this.refresh();
    if (!this.timer) { this.timer = setInterval(() => void this.poll(), 5000); }
    void this.poll();
  }

  private refresh(): void {
    if (!this.jobs.size) { this.item.hide(); return; }
    const [first] = this.jobs.keys();
    this.item.text = `$(sync~spin) ${first.split('/')[2]}${this.jobs.size > 1 ? ` +${this.jobs.size - 1}` : ''}`;
    this.item.tooltip = [...this.jobs.entries()].map(([j, v]) => `${j}: ${v.phase}`).join('\n');
    this.item.command = { command: 'vanthrex.jobLog', title: vscode.l10n.t('Job log'), arguments: [{ job: first }] };
    this.item.show();
  }

  private async poll(): Promise<void> {
    for (const [job, w] of [...this.jobs.entries()]) {
      try {
        const [num, user] = job.split('/');
        const r = await w.conn.rows<Row>(`SELECT * FROM TABLE(QSYS2.JOB_INFO(JOB_USER_FILTER => ${sqlString(user)}, JOB_STATUS_FILTER => '*ALL')) X WHERE JOB_NAME = ${sqlString(job)}`, 1);
        const phase = jobPhase(s(r[0], 'JOB_STATUS'));
        w.phase = phase;
        if (phase === 'ended' || Date.now() - w.started > 12 * 3600 * 1000) {
          this.jobs.delete(job);
          let ok = !/ABNORMAL/i.test(s(r[0], 'COMPLETION_STATUS'));
          const end = await w.conn.rows<Row>(`SELECT MESSAGE_TEXT AS T FROM TABLE(QSYS2.HISTORY_LOG_INFO(START_TIME => CURRENT TIMESTAMP - 1 DAY)) X WHERE MESSAGE_ID = 'CPF1164' AND FROM_JOB = ${sqlString(job)} FETCH FIRST 1 ROW ONLY`, 1).catch(() => []);
          const code = /end code\s+(\d+)/i.exec(s(end[0], 'T'))?.[1];
          if (code !== undefined) { ok = Number(code) < 10; }
          const mins = Math.max(1, Math.round((Date.now() - w.started) / 60000));
          const msg = ok ? vscode.l10n.t('Job {0} ended normally (about {1} min).', job, mins) : vscode.l10n.t('Job {0} ended abnormally{1}.', job, code !== undefined ? ` (end code ${code})` : '');
          const buttons = [vscode.l10n.t('Job Log'), ...(ok ? [] : [vscode.l10n.t('Analyze')])];
          const c = await (ok ? vscode.window.showInformationMessage(msg, ...buttons) : vscode.window.showErrorMessage(msg, ...buttons));
          if (c === vscode.l10n.t('Job Log')) { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); }
          if (c === vscode.l10n.t('Analyze')) { await vscode.commands.executeCommand('vanthrex.analyzeJobLog', job); }
          void vscode.commands.executeCommand('vanthrex.refreshSpool');
        } else { void num; }
      } catch (e) { log(`Watch ${job}: ${errorMessage(e)}`); }
    }
    this.refresh();
    if (!this.jobs.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  dispose(): void { if (this.timer) { clearInterval(this.timer); } this.item.dispose(); }
}

async function submitAndWatch(manager: ConnectionManager, watcher: Watcher, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const command = await vscode.window.showInputBox({ title: vscode.l10n.t('Submit to batch and watch (1/3)'), prompt: vscode.l10n.t('Command to run in batch'), value: state.get<string>('vanthrex.sbm.last', ''), placeHolder: 'CALL PGM(APPLIB/NIGHTLY)', ignoreFocusOut: true });
  if (!command) { return; }
  const job = await vscode.window.showInputBox({ title: vscode.l10n.t('Submit to batch and watch (2/3)'), prompt: vscode.l10n.t('Job name'), value: (/PGM\(([^)]*\/)?([\w$#@]+)\)/i.exec(command)?.[2] ?? 'VTXBATCH').slice(0, 10).toUpperCase(), ignoreFocusOut: true });
  if (!job) { return; }
  const jobq = await vscode.window.showInputBox({ title: vscode.l10n.t('Submit to batch and watch (3/3)'), prompt: vscode.l10n.t('Job queue (empty = your job description\'s)'), ignoreFocusOut: true });
  if (jobq === undefined) { return; }
  await state.update('vanthrex.sbm.last', command);
  const r = await conn.runCL(sbmjobCommand(command, job, jobq));
  if (!r.ok) { throw new Error(vscode.l10n.t('SBMJOB failed: {0}', (r.stderr || r.stdout).trim())); }
  const id = submittedJob(r.stdout + r.stderr);
  if (!id) { vscode.window.showWarningMessage(vscode.l10n.t('The job was submitted, but its number could not be read — watch it in Active Jobs.')); return; }
  watcher.watch(conn, id);
  vscode.window.showInformationMessage(vscode.l10n.t('{0} submitted — you will be told when it ends.', id));
}

// ================================================================ search & replace across a source file

interface Planned { member: string; type: string; records?: SourceRecord[]; text?: string; newLines: string[]; changed: number[] }
let plan: { lib: string; file: string; find: string; replace: string; members: Planned[] } | undefined;

async function replaceInSourceFile(manager: ConnectionManager, n?: { library?: string; file?: string }): Promise<void> {
  const conn = manager.require();
  let lib = n?.library; let file = n?.file;
  if (!lib || !file) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Find and replace in a source file'), prompt: 'LIBRARY/SOURCEFILE', ignoreFocusOut: true });
    if (!v?.includes('/')) { return; }
    [lib, file] = v.trim().toUpperCase().split('/');
  }
  const find = await vscode.window.showInputBox({ title: vscode.l10n.t('Find in {0}/{1}', lib, file), ignoreFocusOut: true });
  if (!find) { return; }
  const replace = await vscode.window.showInputBox({ title: vscode.l10n.t('Replace "{0}" with', find), ignoreFocusOut: true });
  if (replace === undefined) { return; }
  const optPick = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('Match case'), key: 'matchCase' }, { label: vscode.l10n.t('Whole word'), key: 'wholeWord', picked: true }, { label: vscode.l10n.t('Regular expression'), key: 'regex' },
  ], { canPickMany: true, title: vscode.l10n.t('Options') });
  if (!optPick) { return; }
  const o: ReplaceOptions = { matchCase: optPick.some(p => p.key === 'matchCase'), wholeWord: optPick.some(p => p.key === 'wholeWord'), regex: optPick.some(p => p.key === 'regex') };
  const re = buildPattern(find, o);
  const members = await conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib!)} ` +
    `AND SYSTEM_TABLE_NAME = ${sqlString(file!)} ORDER BY SYSTEM_TABLE_MEMBER`, 5000);
  const keepDates = await conn.canKeepSourceDates();
  const maxLen = await conn.sourceLineLength(lib!, file!).catch(() => 0);
  const planned: Planned[] = []; const tooLong: string[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Searching {0}/{1}…', lib, file), cancellable: true }, async (p, token) => {
    for (const m of members.slice(0, 1000)) {
      if (token.isCancellationRequested) { break; }
      p.report({ message: s(m, 'M'), increment: 100 / Math.min(1000, members.length) });
      try {
        const records = keepDates ? await conn.readMemberRecords(lib!, file!, s(m, 'M')) : undefined;
        const text = records ? undefined : await conn.readMember(lib!, file!, s(m, 'M'));
        const lines = records ? records.map(r => r.text) : text!.split('\n');
        const r = replaceLines(lines, re, replace, maxLen);
        r.tooLong.forEach(i => tooLong.push(`${s(m, 'M')} line ${i + 1}`));
        if (r.changed.length) { planned.push({ member: s(m, 'M'), type: s(m, 'T'), records, text, newLines: r.lines, changed: r.changed }); }
      } catch (e) { log(`Replace ${s(m, 'M')}: ${errorMessage(e)}`); }
    }
  });
  plan = { lib: lib!, file: file!, find, replace, members: planned };
  const total = planned.reduce((a, x) => a + x.changed.length, 0);
  const rows: (string | number)[][] = []; const acts: { label: string; command: string; args: unknown[] }[] = [];
  for (const pm of planned) {
    for (const i of pm.changed.slice(0, 50)) {
      const before = pm.records ? pm.records[i].text : pm.text!.split('\n')[i];
      rows.push([pm.member, i + 1, before.trim(), pm.newLines[i].trim()]);
      acts.push({ label: vscode.l10n.t('Open'), command: 'vanthrex.codeMetrics.open', args: [lib, file, pm.member, pm.type] });
    }
  }
  showReport('replace', {
    title: vscode.l10n.t('Replace in {0}/{1}', lib, file), subtitle: vscode.l10n.t('"{0}" → "{1}": {2} line(s) in {3} member(s). Nothing is changed until you click Apply.', find, replace, total, planned.length),
    facts: [['Source dates', keepDates ? 'kept; changed lines get today\'s date' : 'not kept (needs the Mapepire SQL engine)'], ['Lines skipped (would be too long)', tooLong.length ? tooLong.slice(0, 20).join(', ') : 'none']],
    actions: planned.length ? [{ label: vscode.l10n.t('Apply to {0} member(s)…', planned.length), command: 'vanthrex.replaceInSourceFile.apply' }] : [],
    tables: [{ title: vscode.l10n.t('Changes (first 50 per member)'), filter: true, columns: ['Member', 'Line', 'Before', 'After'], rows, rowActions: acts, empty: vscode.l10n.t('No match.') }],
    note: vscode.l10n.t('Members that someone else has open (locked) are skipped when applying. Each member keeps its version history in Vanthrex\'s local history.'),
  }, ALLOWED);
}

async function applyReplace(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const p = plan;
  if (!p?.members.length) { throw new Error(vscode.l10n.t('Run Find and Replace first.')); }
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Change {0} member(s) in {1}/{2}?', p.members.length, p.lib, p.file), { modal: true }, vscode.l10n.t('Apply'));
  if (ok !== vscode.l10n.t('Apply')) { return; }
  const done: string[] = []; const skipped: string[] = [];
  const today = dateToSrcDate(new Date());
  await progress(vscode.l10n.t('Applying…'), async () => {
    for (const m of p.members) {
      try {
        const st = await conn.memberState(p.lib, p.file, m.member);
        if (st.locks.length) { skipped.push(`${m.member} (in use by ${st.locks[0].user})`); continue; }
        if (m.records) { await conn.writeMemberRecords(p.lib, p.file, m.member, mergeRecords(m.records, m.newLines, today)); }
        else { await conn.writeMember(p.lib, p.file, m.member, m.newLines.join('\n')); }
        done.push(m.member);
      } catch (e) { skipped.push(`${m.member} (${errorMessage(e).split('\n')[0]})`); }
    }
  });
  plan = undefined;
  vscode.window.showInformationMessage(vscode.l10n.t('Changed {0} member(s).{1}', done.length, skipped.length ? ' ' + vscode.l10n.t('Skipped: {0}', skipped.join(', ')) : ''));
}

// ================================================================ compare two spooled files

async function compareSpool(manager: ConnectionManager, n: { name: string; job: string; number: number }): Promise<void> {
  const conn = manager.require();
  const rows = await conn.rows<Row>(`SELECT SPOOLED_FILE_NAME AS N, JOB_NAME AS J, FILE_NUMBER AS F, VARCHAR_FORMAT(CREATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS T, COALESCE(USER_DATA, '') AS U ` +
    `FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE USER_NAME = ${sqlString(conn.user)} ORDER BY CASE WHEN SPOOLED_FILE_NAME = ${sqlString(n.name)} THEN 0 ELSE 1 END, CREATE_TIMESTAMP DESC FETCH FIRST 300 ROWS ONLY`, 300);
  const pick = await vscode.window.showQuickPick(rows.filter(r => !(s(r, 'J') === n.job && Number(r.F) === n.number)).map(r => ({ label: s(r, 'N'), description: `${s(r, 'T')} · ${s(r, 'J')} #${s(r, 'F')}`, detail: s(r, 'U'), r })),
    { title: vscode.l10n.t('Compare {0} ({1}) with…', n.name, n.job), matchOnDescription: true });
  if (!pick) { return; }
  const other = { name: s(pick.r, 'N'), job: s(pick.r, 'J'), number: Number(pick.r.F) };
  await vscode.commands.executeCommand('vscode.diff', spoolUri(other), spoolUri(n), `${other.name} #${other.number} ↔ ${n.name} #${n.number}`);
}

// ================================================================ follow an IFS file

const TAIL = 'vanthrex-tail';
class TailProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly manager: ConnectionManager) {
    this.timer = setInterval(() => {
      for (const ed of vscode.window.visibleTextEditors) { if (ed.document.uri.scheme === TAIL) { this.emitter.fire(ed.document.uri); } }
    }, 2000);
  }
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const conn = this.manager.connection;
    if (!conn) { return vscode.l10n.t('Not connected.'); }
    const lines = Number(vscode.workspace.getConfiguration('vanthrex.ifs').get<number>('followLines', 500));
    const r = await conn.exec(`tail -n ${Math.max(10, Math.min(20000, lines))} ${shSingleQuote(uri.path)} 2>&1`);
    return r.stdout;
  }
  dispose(): void { if (this.timer) { clearInterval(this.timer); } this.emitter.dispose(); }
}

// ================================================================ library list sets

async function librarySets(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const key = `vanthrex.librarySets.${conn.profile.id}`;
  const sets = state.get<LibrarySet[]>(key, []);
  const pick = await vscode.window.showQuickPick([
    ...sets.map(x => ({ label: vscode.l10n.t('$(library) {0}', x.name), description: `${x.currentLibrary ? `*CURLIB ${x.currentLibrary} · ` : ''}${x.libraries.join(' ')}`, set: x, action: 'use' })),
    { label: vscode.l10n.t('$(save) Save the current library list as a set…'), action: 'save' },
    { label: vscode.l10n.t('$(add) New set…'), action: 'new' },
    ...(sets.length ? [{ label: vscode.l10n.t('$(trash) Delete a set…'), action: 'delete' }] : []),
  ], { title: vscode.l10n.t('Library list sets for {0} — current: {1}', conn.profile.name, conn.profile.libraries.join(' ') || '(empty)') });
  if (!pick) { return; }
  if (pick.action === 'use' && 'set' in pick && pick.set) {
    const set = pick.set;
    await manager.updateActiveProfile(p => { p.libraries = [...set.libraries]; p.currentLibrary = set.currentLibrary; });
    vscode.window.showInformationMessage(vscode.l10n.t('Library list set "{0}" is now active.', set.name));
    return;
  }
  if (pick.action === 'delete') {
    const d = await vscode.window.showQuickPick(sets.map(x => x.name), { title: vscode.l10n.t('Delete which set?') });
    if (d) { await state.update(key, sets.filter(x => x.name !== d)); }
    return;
  }
  const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Name of the set'), placeHolder: vscode.l10n.t('DEV, TEST, Project X…'), ignoreFocusOut: true });
  if (!name) { return; }
  let libraries = conn.profile.libraries; let cur = conn.profile.currentLibrary;
  if (pick.action === 'new') {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Libraries of "{0}", top first', name), ignoreFocusOut: true, validateInput: x => { try { parseLibraryList(x); return undefined; } catch (e) { return errorMessage(e); } } });
    if (v === undefined) { return; }
    libraries = parseLibraryList(v);
    cur = (await vscode.window.showInputBox({ title: vscode.l10n.t('Current library (optional)'), value: libraries[0] ?? '', ignoreFocusOut: true }))?.trim().toUpperCase() || undefined;
  }
  await state.update(key, [...sets.filter(x => x.name !== name), { name, libraries: [...libraries], currentLibrary: cur }]);
  vscode.window.showInformationMessage(vscode.l10n.t('Saved library list set "{0}".', name));
}

// ================================================================ registration

export function registerMore(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const watcher = new Watcher();
  const tail = new TailProvider(manager);
  const fmt = sqlFormatter();
  context.subscriptions.push(
    watcher, tail,
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'sql' }, fmt),
    vscode.languages.registerDocumentRangeFormattingEditProvider({ language: 'sql' }, fmt),
    vscode.workspace.registerTextDocumentContentProvider(TAIL, tail),
    vscode.commands.registerCommand('vanthrex.generateRpgForTable', guard((o?: { library: string; name: string }) => rpgFromTable(manager, o?.library ? o : undefined))),
    vscode.commands.registerCommand('vanthrex.formatSql', guard(async () => { await vscode.commands.executeCommand('editor.action.formatDocument'); })),
    vscode.commands.registerCommand('vanthrex.submitAndWatch', guard(() => submitAndWatch(manager, watcher, context.globalState))),
    vscode.commands.registerCommand('vanthrex.watchJob', guard(async (n?: { job?: string }) => {
      const conn = manager.require();
      const job = n?.job ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Watch a job'), prompt: vscode.l10n.t('Qualified job name (number/user/name)'), ignoreFocusOut: true }))?.trim().toUpperCase();
      if (job) { watcher.watch(conn, job); vscode.window.showInformationMessage(vscode.l10n.t('Watching {0} — you will be told when it ends.', job)); }
    })),
    vscode.commands.registerCommand('vanthrex.replaceInSourceFile', guard((n?: { library?: string; file?: string }) => replaceInSourceFile(manager, n))),
    vscode.commands.registerCommand('vanthrex.replaceInSourceFile.apply', guard(() => applyReplace(manager))),
    vscode.commands.registerCommand('vanthrex.spoolCompare', guard(async (n: { name: string; job: string; number: number }) => {
      if (!n?.name) { throw new Error(vscode.l10n.t('Right-click a spooled file in the Spooled Files view.')); }
      await compareSpool(manager, n);
    })),
    vscode.commands.registerCommand('vanthrex.followIfsFile', guard(async (n?: { path?: string; isDirectory?: boolean }) => {
      const path = n?.path && !n.isDirectory ? n.path : (await vscode.window.showInputBox({ title: vscode.l10n.t('Follow an IFS file'), prompt: vscode.l10n.t('Path of the file'), placeHolder: vscode.l10n.t('/home/user/app.log'), ignoreFocusOut: true }))?.trim();
      if (!path) { return; }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: TAIL, path }));
      const ed = await vscode.window.showTextDocument(doc, { preview: false });
      const toEnd = () => ed.revealRange(new vscode.Range(doc.lineCount, 0, doc.lineCount, 0));
      toEnd();
      const sub = vscode.workspace.onDidChangeTextDocument(e => { if (e.document === doc && vscode.window.activeTextEditor?.document === doc) { toEnd(); } });
      const close = vscode.workspace.onDidCloseTextDocument(d => { if (d === doc) { sub.dispose(); close.dispose(); } });
    })),
    vscode.commands.registerCommand('vanthrex.librarySets', guard(() => librarySets(manager, context.globalState))),
  );

}
