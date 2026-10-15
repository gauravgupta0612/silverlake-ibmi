// 2.3: source quality report, library list from a job description, *PUBLIC authority scan, system values on two
// systems, and Create Library / Create IFS folder or file from anywhere.

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { sqlString } from '../core/util';
import { createLibraryCommand } from '../core/pdm';
import { tagCcsidCommand } from '../core/v23';
import {
  EXPECTED_DIFFERENT, STANDARD_SOURCE_FILES, SourceHealth, checkIfsPath, checkMode, createSourceFileCommand, diffSystemValues, grade, isRpgType,
  libraryListChange, parseLibraryList, publicRisk, setPublicCommand, sourceHealth,
} from '../core/v26';
import { ifsUri, memberUri } from './fileSystems';
import { readLibraries } from './libraryLookup';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const pick = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { const v = s(r, k); if (v) { return v; } } return ''; };
const ALLOWED = new Set(['vanthrex.compileHistory.open', 'vanthrex.publicAuthority.set', 'vanthrex.sourceQuality', 'vanthrex.publicAuthorityScan', 'vanthrex.objectInfo', 'vanthrex.convertToFree', 'vanthrex.pdm']);
const NAME = /^[A-Za-z$#@][A-Za-z0-9$#@_.]{0,9}$/;
const nameCheck = (v: string) => (NAME.test(v.trim()) ? undefined : vscode.l10n.t('1–10 characters, starting with a letter, $, # or @.'));

async function runOk(conn: IbmiConnection, cmd: string): Promise<void> {
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim().split('\n').filter(l => /[A-Z]{3}[0-9A-F]{4}/.test(l)).pop() || (r.stderr || r.stdout).trim().split('\n').pop() || cmd); }
}

// ================================================================ source quality report

async function sourceQuality(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  const n = a as { library?: string; file?: string } | undefined;
  let lib = n?.library?.toUpperCase(); let file = n?.file?.toUpperCase();
  if (!lib || !file) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Source quality report'), prompt: 'LIBRARY/FILE', placeHolder: 'MYLIB/QRPGLESRC', ignoreFocusOut: true });
    if (!v?.includes('/')) { return; }
    [lib, file] = v.trim().toUpperCase().split('/');
  }
  const members = (await conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T, COALESCE(PARTITION_TEXT, '') AS X FROM QSYS2.SYSPARTITIONSTAT ` +
    `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(file)} ORDER BY 1`, 5000)).filter(r => isRpgType(s(r, 'T')));
  if (!members.length) { vscode.window.showInformationMessage(vscode.l10n.t('No RPG members in {0}/{1}.', lib, file)); return; }
  const results: { m: Row; h?: SourceHealth; error?: string }[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking {0} member(s)…', members.length), cancellable: true }, async (p, tok) => {
    let i = 0;
    const worker = async () => {
      while (i < members.length && !tok.isCancellationRequested) {
        const m = members[i++];
        p.report({ message: s(m, 'M'), increment: 100 / members.length });
        try { results.push({ m, h: sourceHealth(await conn.readMember(lib!, file!, s(m, 'M'))) }); } catch (e) { results.push({ m, error: errorMessage(e).split('\n')[0] }); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  });
  const ok = results.filter(r => r.h).sort((x, y) => x.h!.score - y.h!.score);
  const avg = ok.length ? Math.round(ok.reduce((t, r) => t + r.h!.score, 0) / ok.length) : 0;
  const code = ok.reduce((t, r) => t + r.h!.code, 0); const fixed = ok.reduce((t, r) => t + r.h!.fixed, 0);
  const rules: Record<string, number> = {};
  for (const r of ok) { for (const [k, v] of Object.entries(r.h!.rules)) { rules[k] = (rules[k] ?? 0) + v; } }
  const grades = ['A', 'B', 'C', 'D', 'E'].map(g => `${g}: ${ok.filter(r => grade(r.h!.score) === g).length}`).join('  ');
  const open = (m: Row) => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.compileHistory.open', args: [memberUri(lib!, file!, s(m, 'M'), s(m, 'T')).toString()] });
  showReport('sourceQuality', {
    title: vscode.l10n.t('Source quality — {0}/{1}', lib, file),
    subtitle: vscode.l10n.t('{0} RPG member(s) checked, average score {1} ({2}). Lowest scores first.', ok.length, avg, grade(avg)),
    facts: [[vscode.l10n.t('Grades'), grades], [vscode.l10n.t('Lines of code'), code.toLocaleString()], [vscode.l10n.t('Still in fixed format'), code ? `${Math.round(100 * fixed / code)}%` : '—'],
      [vscode.l10n.t('Code check findings'), ok.reduce((t, r) => t + r.h!.errors + r.h!.warnings + r.h!.infos, 0)], [vscode.l10n.t('GOTO / CABxx'), ok.reduce((t, r) => t + r.h!.gotos, 0)],
      [vscode.l10n.t('Not read'), results.length - ok.length]],
    tables: [
      { title: vscode.l10n.t('Members'), filter: true,
        columns: [vscode.l10n.t('Member'), vscode.l10n.t('Type'), vscode.l10n.t('Grade'), vscode.l10n.t('Score'), vscode.l10n.t('Code lines'), vscode.l10n.t('Fixed %'), vscode.l10n.t('Errors'), vscode.l10n.t('Warnings'), vscode.l10n.t('Indicators'), 'GOTO', vscode.l10n.t('Subroutines'), vscode.l10n.t('Procedures'), vscode.l10n.t('Text')],
        rows: ok.map(r => [s(r.m, 'M'), s(r.m, 'T'), grade(r.h!.score), r.h!.score, r.h!.code, r.h!.fixedPct, r.h!.errors, r.h!.warnings, r.h!.indicators, r.h!.gotos, r.h!.subroutines, r.h!.procedures, s(r.m, 'X')]),
        rowClass: ok.map(r => (r.h!.score < 40 ? 'bad' : r.h!.score < 60 ? 'different' : undefined)), rowActions: ok.map(r => open(r.m)) },
      { title: vscode.l10n.t('Most frequent code checks'), columns: [vscode.l10n.t('Check'), vscode.l10n.t('Findings')],
        rows: Object.entries(rules).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, v]), empty: vscode.l10n.t('No findings. 👍') },
      ...(results.some(r => r.error) ? [{ title: vscode.l10n.t('Could not be read'), columns: [vscode.l10n.t('Member'), vscode.l10n.t('Reason')], rows: results.filter(r => r.error).map(r => [s(r.m, 'M'), r.error!]) }] : []),
    ],
    note: vscode.l10n.t('Score: 100, minus errors, warnings per 1,000 lines, GOTOs, numbered indicators and the share of fixed format. A: 90+, B: 75+, C: 60+, D: 40+, E: below 40.'),
  }, ALLOWED);
}

// ================================================================ library list from a job description or user profile

async function libraryListFromJobd(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const how = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(person) From a user profile'), detail: vscode.l10n.t('Uses the job description of the profile (yours by default)'), k: 'user' },
    { label: vscode.l10n.t('$(briefcase) From a job description'), detail: 'LIBRARY/JOBD', k: 'jobd' },
  ], { title: vscode.l10n.t('Library list from…') });
  if (!how) { return; }
  let jl = ''; let jn = '';
  if (how.k === 'user') {
    const u = (await vscode.window.showInputBox({ title: vscode.l10n.t('User profile'), value: conn.user, validateInput: nameCheck, ignoreFocusOut: true }))?.trim().toUpperCase();
    if (!u) { return; }
    const r = (await conn.rows<Row>(`SELECT JOB_DESCRIPTION_LIBRARY_NAME AS L, JOB_DESCRIPTION_NAME AS N FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = ${sqlString(u)}`, 1))[0];
    if (!r) { throw new Error(vscode.l10n.t('User profile {0} was not found (or you are not authorized to it).', u)); }
    jl = s(r, 'L') || '*LIBL'; jn = s(r, 'N');
  } else {
    const v = (await vscode.window.showInputBox({ title: vscode.l10n.t('Job description'), prompt: 'LIBRARY/JOBD', ignoreFocusOut: true }))?.trim().toUpperCase();
    if (!v?.includes('/')) { return; }
    [jl, jn] = v.split('/');
  }
  const libFilter = jl && jl !== '*LIBL' ? `JOB_DESCRIPTION_LIBRARY = ${sqlString(jl)} AND ` : '';
  const jd = (await conn.rows<Row>(`SELECT JOB_DESCRIPTION_LIBRARY AS L, JOB_DESCRIPTION AS N, COALESCE(LIBRARY_LIST, '') AS LL FROM QSYS2.JOB_DESCRIPTION_INFO WHERE ${libFilter}JOB_DESCRIPTION = ${sqlString(jn)}`, 1))[0];
  if (!jd) { throw new Error(vscode.l10n.t('Job description {0}/{1} was not found.', jl, jn)); }
  let parsed = parseLibraryList(s(jd, 'LL'));
  if (parsed.special === '*SYSVAL') {
    const sv = (await conn.rows<Row>(`SELECT CURRENT_CHARACTER_VALUE AS V FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME = 'QUSRLIBL'`, 1))[0];
    parsed = parseLibraryList(s(sv, 'V'));
  }
  const next = parsed.libraries;
  const ch = libraryListChange(conn.profile.libraries, next);
  if (ch.same) { vscode.window.showInformationMessage(vscode.l10n.t('Your library list is already the one of {0}/{1}.', s(jd, 'L'), s(jd, 'N'))); return; }
  const replace = vscode.l10n.t('Replace my library list'); const add = vscode.l10n.t('Add the missing libraries');
  const go = await vscode.window.showInformationMessage(vscode.l10n.t('{0}/{1}: {2}', s(jd, 'L'), s(jd, 'N'), next.join(' ') || '(empty)'), {
    modal: true, detail: [ch.added.length ? vscode.l10n.t('New: {0}', ch.added.join(' ')) : '', ch.removed.length ? vscode.l10n.t('Not in it: {0}', ch.removed.join(' ')) : ''].filter(Boolean).join('\n'),
  }, replace, add);
  if (!go) { return; }
  await manager.updateActiveProfile(p => { p.libraries = go === replace ? [...next] : [...p.libraries, ...ch.added]; });
  vscode.window.setStatusBarMessage(vscode.l10n.t('Library list updated'), 3000);
}

// ================================================================ *PUBLIC authority scan

async function publicAuthorityScan(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  const lib = ((a as { library?: string } | undefined)?.library ?? (typeof a === 'string' ? a : undefined)
    ?? await vscode.window.showInputBox({ title: vscode.l10n.t('*PUBLIC authority scan'), prompt: vscode.l10n.t('Library'), validateInput: nameCheck, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!lib) { return; }
  const rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading *PUBLIC authority in {0}…', lib) }, () =>
    conn.rows<Row>(`SELECT * FROM QSYS2.OBJECT_PRIVILEGES WHERE SYSTEM_OBJECT_SCHEMA = ${sqlString(lib)} AND AUTHORIZATION_NAME = '*PUBLIC'`, 20000));
  const list = rows.map(r => {
    const aut = pick(r, 'OBJECT_AUTHORITY'); const autl = pick(r, 'AUTHORIZATION_LIST');
    return { name: pick(r, 'SYSTEM_OBJECT_NAME', 'OBJECT_NAME'), type: pick(r, 'OBJECT_TYPE'), aut, autl, owner: pick(r, 'OWNER'), risk: publicRisk(aut, autl) };
  });
  const order = { bad: 0, warn: 1, info: 2, ok: 3 };
  list.sort((x, y) => order[x.risk] - order[y.risk] || x.name.localeCompare(y.name));
  const fix = (o: typeof list[number]) => {
    try {
      return { label: vscode.l10n.t('Set *PUBLIC *USE'), command: 'vanthrex.publicAuthority.set', args: [setPublicCommand(lib, o.name, o.type, '*USE'), lib] };
    } catch { return undefined; }
  };
  const bad = list.filter(o => o.risk === 'bad').length; const warn = list.filter(o => o.risk === 'warn').length;
  showReport('publicAuthority', {
    title: vscode.l10n.t('*PUBLIC authority — {0}', lib),
    subtitle: bad || warn ? vscode.l10n.t('{0} object(s) give *ALL and {1} give *CHANGE to everybody (*PUBLIC). Riskiest first.', bad, warn) : vscode.l10n.t('No object gives *ALL or *CHANGE to *PUBLIC. 👍'),
    facts: [[vscode.l10n.t('Objects'), list.length], ['*ALL', bad], ['*CHANGE', warn], ['*USE', list.filter(o => o.aut === '*USE').length], ['*EXCLUDE', list.filter(o => o.aut === '*EXCLUDE').length],
      [vscode.l10n.t('Secured by an authorization list'), list.filter(o => o.autl).length]],
    actions: [{ label: vscode.l10n.t('Scan again'), command: 'vanthrex.publicAuthorityScan', args: [lib] }],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: [vscode.l10n.t('Object'), vscode.l10n.t('Type'), vscode.l10n.t('*PUBLIC authority'), vscode.l10n.t('Authorization list'), vscode.l10n.t('Owner')],
      rows: list.map(o => [o.name, o.type, o.aut, o.autl, o.owner]), rowClass: list.map(o => (o.risk === 'bad' ? 'bad' : o.risk === 'warn' ? 'different' : undefined)),
      rowActions: list.map(o => (o.risk === 'bad' || o.risk === 'warn' ? fix(o) : undefined)) }],
    note: vscode.l10n.t('Click a risky row to set *PUBLIC to *USE (asked first). Check that programs and users still work: some objects need *CHANGE on purpose.'),
  }, ALLOWED);
}

// ================================================================ system values on two systems

async function compareSystemValues(manager: ConnectionManager): Promise<void> {
  const a = manager.require();
  const others = manager.openConnections.filter(c => c.profile.id !== a.profile.id);
  if (!others.length) { throw new Error(vscode.l10n.t('Connect to a second system first (Connections view), then compare.')); }
  const b = others.length === 1 ? others[0] : (await vscode.window.showQuickPick(others.map(c => ({ label: c.profile.name, c })), { title: vscode.l10n.t('Compare {0} with…', a.profile.name) }))?.c;
  if (!b) { return; }
  const sql = `SELECT SYSTEM_VALUE_NAME AS N, COALESCE(CURRENT_CHARACTER_VALUE, VARCHAR(CURRENT_NUMERIC_VALUE), '') AS V FROM QSYS2.SYSTEM_VALUE_INFO`;
  const [ra, rb] = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading system values…') }, () => Promise.all([a.rows<Row>(sql, 2000), b.rows<Row>(sql, 2000)]));
  const toMap = (rows: Row[]) => Object.fromEntries(rows.map(r => [s(r, 'N'), s(r, 'V')]));
  const diff = diffSystemValues(toMap(ra), toMap(rb));
  const real = diff.filter(d => !d.same && !EXPECTED_DIFFERENT.test(d.name));
  const expected = diff.filter(d => !d.same && EXPECTED_DIFFERENT.test(d.name));
  showReport('compareSysval', {
    title: vscode.l10n.t('System values — {0} ↔ {1}', a.profile.name, b.profile.name),
    subtitle: vscode.l10n.t('{0} system value(s) differ ({1} more differ on purpose: dates, serial numbers, devices…).', real.length, expected.length),
    tables: [
      { title: vscode.l10n.t('Different'), filter: true, columns: [vscode.l10n.t('System value'), a.profile.name, b.profile.name], rows: real.map(d => [d.name, d.a, d.b]), rowClass: real.map(() => 'different'), empty: vscode.l10n.t('Identical. 👍') },
      { title: vscode.l10n.t('Different on purpose'), columns: [vscode.l10n.t('System value'), a.profile.name, b.profile.name], rows: expected.map(d => [d.name, d.a, d.b]) },
      { title: vscode.l10n.t('Identical'), filter: true, columns: [vscode.l10n.t('System value'), vscode.l10n.t('Value')], rows: diff.filter(d => d.same).map(d => [d.name, d.a]) },
    ],
  }, ALLOWED);
}

// ================================================================ create library / IFS

async function createLibrary(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('Create library (1/4): name'), value: typeof a === 'string' ? a : '', validateInput: nameCheck, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!name) { return; }
  if ((await readLibraries(conn, [name], 1)).rows.length) { throw new Error(vscode.l10n.t('Library {0} already exists.', name)); }
  const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Create library (2/4): text (optional)'), ignoreFocusOut: true });
  if (text === undefined) { return; }
  const type = await vscode.window.showQuickPick([{ label: '*TEST', description: vscode.l10n.t('development: changes allowed while debugging') }, { label: '*PROD', description: vscode.l10n.t('production') }], { title: vscode.l10n.t('Create library (3/4): type') });
  if (!type) { return; }
  const extras = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('Add it to my library list'), k: 'libl', picked: true },
    { label: vscode.l10n.t('Make it my current library'), k: 'curlib' },
    ...STANDARD_SOURCE_FILES.map(f => ({ label: vscode.l10n.t('Create source file {0}', f.file), description: f.text, k: `src:${f.file}`, picked: ['QRPGLESRC', 'QCLLESRC', 'QDDSSRC', 'QSQLSRC'].includes(f.file) })),
  ], { title: vscode.l10n.t('Create library (4/4): also…'), canPickMany: true });
  if (!extras) { return; }
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating {0}…', name) }, async p => {
    await runOk(conn, createLibraryCommand(name, text, type.label === '*TEST'));
    for (const e of extras.filter(x => x.k.startsWith('src:'))) {
      const f = e.k.slice(4); p.report({ message: f });
      await runOk(conn, createSourceFileCommand(name, f, STANDARD_SOURCE_FILES.find(x => x.file === f)?.text ?? ''));
    }
  });
  if (extras.some(x => x.k === 'libl' || x.k === 'curlib')) {
    await manager.updateActiveProfile(p => {
      if (extras.some(x => x.k === 'libl') && !p.libraries.map(l => l.toUpperCase()).includes(name)) { p.libraries = [name, ...p.libraries]; }
      if (extras.some(x => x.k === 'curlib')) { p.currentLibrary = name; }
    });
  }
  void vscode.commands.executeCommand('vanthrex.refreshLibraries');
  const pdm = vscode.l10n.t('Open in PDM');
  if (await vscode.window.showInformationMessage(vscode.l10n.t('Library {0} created.', name), pdm) === pdm) { await vscode.commands.executeCommand('vanthrex.pdm', { level: 'objects', library: name }); }
}

async function createIfs(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  const node = a as { path?: string; isDirectory?: boolean } | undefined;
  const base = node?.path ? (node.isDirectory === false ? node.path.replace(/\/[^/]*$/, '') || '/' : node.path) : `/home/${conn.user.toLowerCase()}`;
  const kind = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(new-folder) Folder'), k: 'dir', detail: vscode.l10n.t('Creates the missing parent folders too') },
    { label: vscode.l10n.t('$(new-file) File (UTF-8)'), k: 'file', detail: vscode.l10n.t('Empty file tagged CCSID 1208, opened in the editor') },
  ], { title: vscode.l10n.t('Create in the IFS') });
  if (!kind) { return; }
  const raw = await vscode.window.showInputBox({ title: kind.k === 'dir' ? vscode.l10n.t('New folder (full path)') : vscode.l10n.t('New file (full path)'), value: `${base.replace(/\/$/, '')}/`, ignoreFocusOut: true,
    validateInput: v => { try { checkIfsPath(v); return undefined; } catch (e) { return errorMessage(e); } } });
  if (!raw) { return; }
  const path = checkIfsPath(raw);
  const exists = await conn.stat(path).then(() => true, () => false);
  if (exists) { throw new Error(vscode.l10n.t('{0} already exists.', path)); }
  const mode = await vscode.window.showInputBox({ title: vscode.l10n.t('Permissions (optional)'), prompt: vscode.l10n.t('Octal, e.g. 755 for a folder or 644 for a file; empty keeps the default'), ignoreFocusOut: true,
    validateInput: v => { if (!v.trim()) { return undefined; } try { checkMode(v); return undefined; } catch (e) { return errorMessage(e); } } });
  if (mode === undefined) { return; }
  if (kind.k === 'dir') {
    await conn.mkdir(path);
  } else {
    const parent = path.replace(/\/[^/]*$/, '') || '/';
    if (!(await conn.stat(parent).then(() => true, () => false))) { await conn.mkdir(parent); }
    await conn.writeStreamFile(path, new Uint8Array());
    await conn.runCL(tagCcsidCommand(path, 1208, false)).catch(e => logError(e));
  }
  if (mode.trim()) {
    const r = await conn.exec(`chmod ${checkMode(mode)} '${path.replace(/'/g, `'\\''`)}'`);
    if (r.code !== 0) { vscode.window.showWarningMessage(vscode.l10n.t('Created, but the permissions could not be set: {0}', (r.stderr || r.stdout).trim())); }
  }
  void vscode.commands.executeCommand('vanthrex.refreshIfs');
  if (kind.k === 'file') { await vscode.window.showTextDocument(ifsUri(path), { preview: false }); }
  else { vscode.window.setStatusBarMessage(vscode.l10n.t('Folder {0} created', path), 4000); }
}

export function registerV26(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.sourceQuality', guard((a?: unknown) => sourceQuality(manager, a))),
    vscode.commands.registerCommand('vanthrex.libraryListFromJobd', guard(() => libraryListFromJobd(manager))),
    vscode.commands.registerCommand('vanthrex.publicAuthorityScan', guard((a?: unknown) => publicAuthorityScan(manager, a))),
    vscode.commands.registerCommand('vanthrex.publicAuthority.set', guard(async (cmd: string, lib: string) => {
      if (!/^(GRTOBJAUT|RVKOBJAUT) OBJ\([A-Z0-9$#@_.]+\/[A-Z0-9$#@_.]+\) OBJTYPE\(\*[A-Z]+\) USER\(\*PUBLIC\) AUT\(\*[A-Z]+\)( REPLACE\(\*YES\))?$/.test(cmd)) { throw new Error(vscode.l10n.t('Not allowed here: {0}', cmd)); }
      const yes = vscode.l10n.t('Run');
      if (await vscode.window.showWarningMessage(vscode.l10n.t('Run {0}?', cmd), { modal: true, detail: vscode.l10n.t('Programs or users that need more than *USE through *PUBLIC will get "not authorized".') }, yes) !== yes) { return; }
      await runOk(manager.require(), cmd);
      await publicAuthorityScan(manager, lib);
    })),
    vscode.commands.registerCommand('vanthrex.compareSystemValues', guard(() => compareSystemValues(manager))),
    vscode.commands.registerCommand('vanthrex.createLibrary', guard((a?: unknown) => createLibrary(manager, a))),
    vscode.commands.registerCommand('vanthrex.createIfs', guard((a?: unknown) => createIfs(manager, a))),
  );
}
