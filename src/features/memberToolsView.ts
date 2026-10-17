// Member tools: batch compile, objects out of sync, change reports, member templates, Find Member Anywhere, objects
// built from a source, compile on save, the member status bar, compile history and changes since the last compile.
import * as vscode from 'vscode';
import { ChangeItem, changeReportMarkdown, syncStatus } from '../core/changeTracking';
import { addCompile, CompileRecord, compileSummary, lastCompileDay, latestPerSource } from '../core/compileHistory';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import {
  builtFromSql, BuiltObject, builtObjects, CompileOnSave, compileOnSaveAction, findMemberSql, libraryRank, statusText,
} from '../core/memberLookup';
import { renderTemplate, Template, TEMPLATES } from '../core/memberTemplates';
import { dateToSrcDate, mergeRecords, SourceRecord } from '../core/sourceDates';
import { buildPattern, replaceLines, ReplaceOptions } from '../core/sourceReplace';
import { assertSystemName, clString, parseMemberPath, sqlString, substituteVariables } from '../core/util';
import { compileFinished } from './compile';
import { MEMBER_SCHEME, memberUri } from './fileSystems';
import { showReport } from './reportPanel';

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vanthrex.codeMetrics.open', 'vanthrex.compile', 'vanthrex.batchCompile', 'vanthrex.objectInfo', 'vanthrex.outOfSync',
  'vanthrex.changeReport', 'vanthrex.changeReport.copy', 'vanthrex.builtFrom', 'vanthrex.pdm', 'vanthrex.changedSinceCompile',
  'vanthrex.compileHistory', 'vanthrex.compileHistory.open', 'vanthrex.compileHistory.recompileBroken', 'vanthrex.compileHistory.clear',
  'vanthrex.replaceInSourceFile', 'vanthrex.replaceInSourceFile.apply',
]);

type Row = Record<string, unknown>;

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

async function batchCompile(manager: ConnectionManager, n?: { library?: string; file?: string }): Promise<void> {
  const conn = manager.require();
  if (!n?.library || !n.file) { throw new Error(vscode.l10n.t('Right-click a source file in the Libraries view.')); }
  const lib = n.library; const file = n.file;
  const when = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('Changed today'), days: 1 }, { label: vscode.l10n.t('Changed in the last 7 days'), days: 7 }, { label: vscode.l10n.t('Changed in the last 30 days'), days: 30 },
    { label: vscode.l10n.t('Pick members…'), days: 0 },
  ], { title: vscode.l10n.t('Compile members of {0}/{1}', lib, file) });
  if (!when) { return; }
  const all = await conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T, VARCHAR_FORMAT(LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS C FROM QSYS2.SYSPARTITIONSTAT ` +
    `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(file)}` +
    `${when.days ? ` AND LAST_SOURCE_UPDATE_TIMESTAMP > CURRENT TIMESTAMP - ${when.days} DAYS` : ''} ORDER BY LAST_SOURCE_UPDATE_TIMESTAMP`, 5000);
  let members = all;
  if (!when.days) {
    const p = await vscode.window.showQuickPick(all.map(r => ({ label: s(r, 'M'), description: `${s(r, 'T')} · ${s(r, 'C')}`, r })), { canPickMany: true, title: vscode.l10n.t('Members to compile') });
    if (!p?.length) { return; }
    members = p.map(x => x.r);
  }
  if (!members.length) { vscode.window.showInformationMessage(vscode.l10n.t('No member changed in that period.')); return; }
  const actions = vscode.workspace.getConfiguration('vanthrex').get<{ name: string; extensions: string[]; source?: string; command: string }[]>('compileActions', []);
  const results: { m: Row; ok: boolean | undefined; cmd: string; msgs: string }[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Compiling {0} member(s)…', members.length), cancellable: true }, async (p, token) => {
    for (const m of members) {
      if (token.isCancellationRequested) { break; }
      p.report({ message: s(m, 'M'), increment: 100 / members.length });
      const ext = s(m, 'T').toLowerCase();
      const action = actions.find(a => a.extensions.map(x => x.toLowerCase()).includes(ext) && (a.source ?? 'member') !== 'ifs');
      if (!action) { results.push({ m, ok: undefined, cmd: '', msgs: vscode.l10n.t('No compile action for .{0}', ext) }); continue; }
      const cmd = substituteVariables(action.command, { LIB: lib, SRCFILE: file, NAME: s(m, 'M'), EXT: ext, OBJLIB: conn.profile.objectLibrary || lib, CURLIB: conn.profile.currentLibrary || 'QGPL', USER: conn.user });
      try {
        const r = await conn.runCL(cmd);
        results.push({ m, ok: r.ok, cmd, msgs: r.messages.filter(x => !/^CPC/.test(x)).join(' ') || (r.ok ? '' : (r.stderr || r.stdout).trim().split('\n').pop() ?? '') });
      } catch (e) { results.push({ m, ok: false, cmd, msgs: errorMessage(e).split('\n')[0] }); }
    }
  });
  const failed = results.filter(r => r.ok === false).length;
  showReport('batchCompile', {
    title: vscode.l10n.t('Compile {0}/{1}', lib, file), subtitle: vscode.l10n.t('{0} compiled, {1} failed, {2} skipped. Click a member to open it; compile it there (Ctrl+Alt+C) to see the errors inline.', results.filter(r => r.ok).length, failed, results.filter(r => r.ok === undefined).length),
    actions: [{ label: vscode.l10n.t('Compile again'), command: 'vanthrex.batchCompile', args: [{ library: lib, file }] }],
    tables: [{ title: vscode.l10n.t('Members'), filter: true, columns: ['Member', 'Type', 'Changed', 'Result', 'Messages', 'Command'],
      rows: results.sort((a, b) => Number(a.ok ?? 2) - Number(b.ok ?? 2)).map(r => [s(r.m, 'M'), s(r.m, 'T'), s(r.m, 'C'), r.ok === undefined ? 'skipped' : r.ok ? '✔ compiled' : '✘ failed', r.msgs, r.cmd]),
      rowActions: results.map(r => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.codeMetrics.open', args: [lib, file, s(r.m, 'M'), s(r.m, 'T')] })),
      rowClass: results.map(r => (r.ok === false ? 'bad' : r.ok === undefined ? 'dim' : undefined)) }],
    note: vscode.l10n.t('Members are compiled one after the other with the first compile action that matches their type (setting vanthrex.compileActions). Build order matters: compile modules and service programs before the programs that use them.'),
  }, ALLOWED);
}

const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function askLib(title: string, x?: unknown, conn?: IbmiConnection): Promise<string | undefined> {
  const lib = typeof x === 'string' ? x : (x as { library?: string } | undefined)?.library;
  const v = lib ?? (await vscode.window.showInputBox({ title, prompt: vscode.l10n.t('Library'), value: conn?.profile.currentLibrary ?? '', ignoreFocusOut: true }));
  return v ? assertSystemName(v, 'library') : undefined;
}

async function outOfSync(manager: ConnectionManager, x?: unknown): Promise<void> {
  const conn = manager.require();
  const lib = await askLib(vscode.l10n.t('Objects out of sync with their source'), x, conn);
  if (!lib) { return; }
  const rows = await progress(vscode.l10n.t('Comparing objects of {0} with their source…', lib), () => conn.rows<Row>(
    `SELECT O.OBJNAME AS N, O.OBJTYPE AS T, COALESCE(O.OBJATTRIBUTE, '') AS A, COALESCE(O.SOURCE_LIBRARY, '') AS SL, COALESCE(O.SOURCE_FILE, '') AS SF, COALESCE(O.SOURCE_MEMBER, '') AS SM, ` +
    `VARCHAR_FORMAT(O.SOURCE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS COMPILED_FROM, VARCHAR_FORMAT(O.CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS OBJCHG, ` +
    `VARCHAR_FORMAT(P.LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS MBRCHG, P.SYSTEM_TABLE_MEMBER AS PM, COALESCE(P.SOURCE_TYPE, '') AS ST ` +
    `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*PGM *SRVPGM *MODULE *CMD *FILE')) O ` +
    `LEFT JOIN QSYS2.SYSPARTITIONSTAT P ON P.SYSTEM_TABLE_SCHEMA = O.SOURCE_LIBRARY AND P.SYSTEM_TABLE_NAME = O.SOURCE_FILE AND P.SYSTEM_TABLE_MEMBER = O.SOURCE_MEMBER ` +
    `WHERE NOT (O.OBJTYPE = '*FILE' AND O.SOURCE_FILE IS NULL) ORDER BY O.OBJNAME`, 20000));
  const items = rows.map(r => ({ r, status: syncStatus({ sourceFile: s(r, 'SF'), sourceMember: s(r, 'SM'), compiledFrom: s(r, 'COMPILED_FROM'), memberChanged: s(r, 'MBRCHG'), memberExists: !!s(r, 'PM') }) }));
  const bad = items.filter(i => i.status === 'source newer' || i.status === 'source missing');
  const order: Record<string, number> = { 'source newer': 0, 'source missing': 1, 'no source info': 2, 'in sync': 3 };
  items.sort((a, b) => order[a.status] - order[b.status]);
  showReport('outOfSync', {
    title: vscode.l10n.t('Source vs objects — {0}', lib),
    subtitle: vscode.l10n.t('{0} object(s) whose source changed after the last compile, {1} whose source member is gone, {2} in sync. Click one to open its source.', items.filter(i => i.status === 'source newer').length, items.filter(i => i.status === 'source missing').length, items.filter(i => i.status === 'in sync').length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.outOfSync', args: [lib] }],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: ['Object', 'Type', 'Attribute', 'Status', 'Source', 'Source at compile', 'Source now', 'Object changed'],
      rows: items.map(({ r, status }) => [s(r, 'N'), s(r, 'T'), s(r, 'A'), status, s(r, 'SF') ? `${s(r, 'SL')}/${s(r, 'SF')}(${s(r, 'SM')})` : '', s(r, 'COMPILED_FROM'), s(r, 'MBRCHG'), s(r, 'OBJCHG')]),
      rowActions: items.map(({ r }) => (s(r, 'PM') ? { label: vscode.l10n.t('Open the source'), command: 'vanthrex.codeMetrics.open', args: [s(r, 'SL'), s(r, 'SF'), s(r, 'SM'), s(r, 'ST') || 'mbr'] } : undefined)),
      rowClass: items.map(i => (i.status === 'source newer' ? 'different' : i.status === 'source missing' ? 'bad' : i.status === 'in sync' ? 'dim' : undefined)) }],
    note: bad.length ? 'Objects marked "source newer" run code that is not what the source shows — recompile them (right-click the source file → Compile Changed Members) or check who changed the source. "Source missing" objects cannot be rebuilt from source.' : 'Every object with source information matches its source.',
  }, ALLOWED);
}

let lastReport = '';

async function changeReport(manager: ConnectionManager, x?: unknown): Promise<void> {
  const conn = manager.require();
  const lib = await askLib(vscode.l10n.t('What changed in a library'), x, conn);
  if (!lib) { return; }
  const days = Number(await vscode.window.showQuickPick(['1', '7', '14', '30', '90'], { title: vscode.l10n.t('Changes of the last how many days?') }) ?? 0);
  if (!days) { return; }
  const [objs, mbrs] = await progress(vscode.l10n.t('Reading changes in {0}…', lib), () => Promise.all([
    conn.rows<Row>(`SELECT OBJNAME AS N, OBJTYPE AS T, VARCHAR_FORMAT(CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS C, COALESCE(OBJTEXT, '') AS X FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*ALL')) O ` +
      `WHERE CHANGE_TIMESTAMP > CURRENT TIMESTAMP - ${days} DAYS AND NOT (OBJTYPE = '*FILE' AND OBJATTRIBUTE = 'PF' AND SOURCE_FILE IS NULL AND OBJTEXT LIKE '%source%') ORDER BY CHANGE_TIMESTAMP DESC`, 20000),
    conn.rows<Row>(`SELECT P.SYSTEM_TABLE_NAME AS F, P.SYSTEM_TABLE_MEMBER AS M, COALESCE(P.SOURCE_TYPE, '') AS T, VARCHAR_FORMAT(P.LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI') AS C, COALESCE(P.PARTITION_TEXT, '') AS X ` +
      `FROM QSYS2.SYSPARTITIONSTAT P JOIN QSYS2.SYSTABLES T ON T.SYSTEM_TABLE_SCHEMA = P.SYSTEM_TABLE_SCHEMA AND T.SYSTEM_TABLE_NAME = P.SYSTEM_TABLE_NAME AND T.FILE_TYPE = 'S' ` +
      `WHERE P.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND P.LAST_SOURCE_UPDATE_TIMESTAMP > CURRENT TIMESTAMP - ${days} DAYS ORDER BY P.LAST_SOURCE_UPDATE_TIMESTAMP DESC`, 20000),
  ]));
  const items: ChangeItem[] = [
    ...mbrs.map(r => ({ kind: 'member' as const, name: s(r, 'M'), type: s(r, 'T'), where: s(r, 'F'), changed: s(r, 'C'), text: s(r, 'X') })),
    ...objs.map(r => ({ kind: 'object' as const, name: s(r, 'N'), type: s(r, 'T'), where: lib, changed: s(r, 'C'), text: s(r, 'X') })),
  ];
  lastReport = changeReportMarkdown(lib, days, items);
  showReport('changeReport', {
    title: vscode.l10n.t('Changes in {0} — last {1} day(s)', lib, days), subtitle: vscode.l10n.t('{0} source member(s) and {1} object(s) changed. Use it for release notes or a code review.', mbrs.length, objs.length),
    actions: [{ label: vscode.l10n.t('Copy as Markdown (release notes)'), command: 'vanthrex.changeReport.copy' }, { label: vscode.l10n.t('Another period'), command: 'vanthrex.changeReport', args: [lib] }],
    tables: [
      { title: vscode.l10n.t('Source members'), filter: true, columns: ['Member', 'Type', 'Source file', 'Changed', 'Description'], rows: mbrs.map(r => [s(r, 'M'), s(r, 'T'), s(r, 'F'), s(r, 'C'), s(r, 'X')]),
        rowActions: mbrs.map(r => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.codeMetrics.open', args: [lib, s(r, 'F'), s(r, 'M'), s(r, 'T') || 'mbr'] })), empty: vscode.l10n.t('None.') },
      { title: vscode.l10n.t('Objects'), filter: true, columns: ['Object', 'Type', 'Changed', 'Description'], rows: objs.map(r => [s(r, 'N'), s(r, 'T'), s(r, 'C'), s(r, 'X')]), empty: vscode.l10n.t('None.') },
    ],
  }, ALLOWED);
}

async function newFromTemplate(manager: ConnectionManager, n?: { library?: string; file?: string }): Promise<void> {
  const conn = manager.require();
  let lib = n?.library; let file = n?.file;
  if (!lib || !file) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('New member from a template'), prompt: 'LIBRARY/SOURCEFILE', ignoreFocusOut: true });
    if (!v?.includes('/')) { return; }
    [lib, file] = v.trim().toUpperCase().split('/');
  }
  const own = vscode.workspace.getConfiguration('vanthrex').get<Template[]>('templates', []);
  const pick = await vscode.window.showQuickPick([...own, ...TEMPLATES].map(t => ({ label: t.name, description: t.type, detail: t.description, t })), { title: vscode.l10n.t('Template'), matchOnDetail: true });
  if (!pick) { return; }
  const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('Member name'), ignoreFocusOut: true, validateInput: v => (/^[A-Za-z$#@][\w$#@]{0,9}$/.test(v.trim()) ? undefined : vscode.l10n.t('1–10 characters, a valid name')) }))?.trim().toUpperCase();
  if (!name) { return; }
  const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Description'), ignoreFocusOut: true });
  if (text === undefined) { return; }
  const r = await conn.runCL(`ADDPFM FILE(${lib}/${file}) MBR(${name}) SRCTYPE(${pick.t.type}) TEXT(${clString(text || ' ')})`);
  if (!r.ok) { throw new Error(vscode.l10n.t('Could not add member {0}: {1}', name, (r.stderr || r.stdout).trim())); }
  await conn.writeMember(lib, file, name, renderTemplate(pick.t.text, { name, text, user: conn.user }));
  await vscode.window.showTextDocument(memberUri(lib, file, name, pick.t.type.toLowerCase()));
  void vscode.commands.executeCommand('vanthrex.refreshLibraries');
}

function libraryList(conn: IbmiConnection): string[] {
  const p = conn.profile;
  return [...new Set([p.currentLibrary, ...p.libraries].filter(Boolean).map(l => String(l).toUpperCase()))];
}

/** The member a command is about: a URI, a tree / PDM node, or the active editor. */
export function memberOf(a?: unknown): { library: string; file: string; member: string; type: string; uri: vscode.Uri } | undefined {
  const n = a as { library?: string; file?: string; member?: string; type?: string; scheme?: string; path?: string } | undefined;
  let uri: vscode.Uri | undefined;
  if (a instanceof vscode.Uri) { uri = a; } else if (n?.library && n.file && n.member) { uri = memberUri(n.library, n.file, n.member, n.type ?? ''); }
  uri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== MEMBER_SCHEME) { return undefined; }
  const m = parseMemberPath(uri.path);
  return { library: m.library, file: m.file, member: m.member, type: m.extension, uri };
}

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

export async function loadBuilt(conn: IbmiConnection, m: { library: string; file: string; member: string }): Promise<{ objects: BuiltObject[]; changed: string; lockedBy: string }> {
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
    actions: [{ label: vscode.l10n.t('Compile now'), command: 'vanthrex.compile', args: [{ resourceUri: m.uri }] }, { label: vscode.l10n.t('My changes since the last compile'), command: 'vanthrex.changedSinceCompile', args: [m.uri] }, { label: vscode.l10n.t('Refresh'), command: 'vanthrex.builtFrom', args: [m.uri] }],
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

const HISTORY_KEY = 'vanthrex.compileHistory';

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

// ================================================================ registration

export function registerMemberTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const bar = new MemberStatusBar(manager);
  let neverThisSession = false;
  const state = context.globalState;
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.batchCompile', guard((n?: { library?: string; file?: string }) => batchCompile(manager, n))),
    vscode.commands.registerCommand('vanthrex.outOfSync', guard((x?: unknown) => outOfSync(manager, x))),
    vscode.commands.registerCommand('vanthrex.changeReport', guard((x?: unknown) => changeReport(manager, x))),
    vscode.commands.registerCommand('vanthrex.changeReport.copy', guard(async () => { await vscode.env.clipboard.writeText(lastReport); vscode.window.showInformationMessage(vscode.l10n.t('Release notes copied as Markdown.')); })),
    vscode.commands.registerCommand('vanthrex.newFromTemplate', guard((n?: { library?: string; file?: string }) => newFromTemplate(manager, n))),
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
    vscode.commands.registerCommand('vanthrex.replaceInSourceFile', guard((n?: { library?: string; file?: string }) => replaceInSourceFile(manager, n))),
    vscode.commands.registerCommand('vanthrex.replaceInSourceFile.apply', guard(() => applyReplace(manager))),
  );
  bar.schedule();
}
