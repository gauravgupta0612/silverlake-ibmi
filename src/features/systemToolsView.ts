// System tools: CL command finder, installed software, PTFs, journals, network test, web API calls, library lists from
// job descriptions, system values on two systems and Create Library.
import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { LibrarySet, parseLibrarySetInput } from '../core/librarySets';
import { errorMessage, log, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { httpOptions, httpStatus, parseHeaders, parsePing, pingCommand, prettyBody } from '../core/network';
import { createSourceFileCommand, STANDARD_SOURCE_FILES } from '../core/objectCommands';
import { createLibraryCommand } from '../core/pdm';
import {
  chgjrnCommand, diffSystemValues, EXPECTED_DIFFERENT, libraryListChange, parseLibraryList, parsePtfIds, strjrnlibCommand,
} from '../core/systemCommands';
import { sqlString } from '../core/util';
import { readLibraries } from './libraryLookup';
import { reportProgress, showReport } from './reportPanel';

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vanthrex.installedSoftware', 'vanthrex.journals', 'vanthrex.journals.row', 'vanthrex.ptfLookup', 'vanthrex.pdm',
]);

type Row = Record<string, unknown>;

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function findCommand(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const q = await vscode.window.showInputBox({ title: vscode.l10n.t('Find a CL command'), prompt: vscode.l10n.t('A word from its name or description, e.g. "journal", "spool", "user"'), ignoreFocusOut: true });
  if (!q?.trim()) { return; }
  const like = sqlString(`%${q.trim().toUpperCase().replace(/[%_]/g, '')}%`);
  const rows = await progress(vscode.l10n.t('Searching commands…'), () => conn.rows<Row>(
    `SELECT OBJNAME AS N, OBJLIB AS L, COALESCE(OBJTEXT, '') AS T FROM TABLE(QSYS2.OBJECT_STATISTICS('*LIBL', '*CMD')) X ` +
    `WHERE OBJNAME LIKE ${like} OR UPPER(OBJTEXT) LIKE ${like} ORDER BY CASE WHEN OBJNAME LIKE ${like} THEN 0 ELSE 1 END, OBJNAME FETCH FIRST 300 ROWS ONLY`, 300));
  if (!rows.length) { vscode.window.showInformationMessage(vscode.l10n.t('No command matches "{0}".', q)); return; }
  const pick = await vscode.window.showQuickPick(rows.map(r => ({ label: s(r, 'N'), description: s(r, 'L'), detail: s(r, 'T') })), { title: vscode.l10n.t('{0} command(s) — pick one to prompt it (F4)', rows.length), matchOnDetail: true });
  if (pick) { await vscode.commands.executeCommand('vanthrex.promptCl', pick.label); }
}

const pick = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { if (r && r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') { return String(r[k]).trim(); } } return ''; };

async function run(conn: IbmiConnection, cmd: string, warn = ''): Promise<boolean> {
  const p = await vscode.window.showWarningMessage(cmd, { modal: true, detail: warn || undefined }, vscode.l10n.t('Run'));
  if (p !== vscode.l10n.t('Run')) { return false; }
  const r = await progress(cmd.split(' ')[0], () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  return true;
}

async function installedSoftware(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const [prods, lic] = await reportProgress('software', vscode.l10n.t('Reading installed software…'), () => Promise.all([
    conn.rows<Row>(`SELECT * FROM QSYS2.SOFTWARE_PRODUCT_INFO ORDER BY PRODUCT_ID, PRODUCT_OPTION`, 5000).catch(e => { log(errorMessage(e)); return [] as Row[]; }),
    conn.rows<Row>(`SELECT * FROM QSYS2.LICENSE_INFO`, 2000).catch(e => { log(errorMessage(e)); return [] as Row[]; }),
  ]));
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const exp = (r: Row) => pick(r, 'LICENSE_EXPIRATION_DATE', 'EXPIRATION_DATE').slice(0, 10);
  const licRows = lic.map(r => ({ r, exp: exp(r) })).sort((a, b) => (a.exp || '9999').localeCompare(b.exp || '9999'));
  showReport('software', {
    title: vscode.l10n.t('Installed software and licenses'), subtitle: vscode.l10n.t('{0} product option(s) installed; {1} license(s) expire within 60 days.', prods.length, licRows.filter(x => x.exp && x.exp < soon).length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.installedSoftware' }, { label: vscode.l10n.t('Look up PTFs…'), command: 'vanthrex.ptfLookup' }],
    tables: [
      { title: vscode.l10n.t('License keys'), filter: true, columns: ['Product', 'Term', 'Feature', 'Usage limit', 'In use', 'Peak', 'Expires'],
        rows: licRows.map(({ r, exp: e }) => [pick(r, 'LICENSED_PROGRAM', 'PRODUCT_ID'), pick(r, 'LICENSED_PROGRAM_TERM', 'RELEASE_LEVEL'), pick(r, 'FEATURE'), pick(r, 'USAGE_LIMIT'), pick(r, 'USAGE_COUNT'), pick(r, 'PEAK_USAGE'), e || '*NONE']),
        rowClass: licRows.map(x => (x.exp && x.exp < today ? 'bad' : x.exp && x.exp < soon ? 'different' : undefined)), empty: vscode.l10n.t('Not available (QSYS2.LICENSE_INFO).') },
      { title: vscode.l10n.t('Products'), filter: true, columns: ['Product', 'Option', 'Release', 'State', 'Description'],
        rows: prods.map(r => [pick(r, 'PRODUCT_ID'), pick(r, 'PRODUCT_OPTION'), pick(r, 'RELEASE_LEVEL'), pick(r, 'LOAD_STATE', 'INSTALLED'), pick(r, 'TEXT_DESCRIPTION')]), empty: vscode.l10n.t('Not available (QSYS2.SOFTWARE_PRODUCT_INFO).') },
    ],
    note: vscode.l10n.t('Expired or soon-expiring keys are highlighted. Usage limits that are reached block new users of that product.'),
  }, ALLOWED);
}

async function ptfLookup(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Is this PTF installed?'), prompt: vscode.l10n.t('One or more PTF IDs, e.g. SI84519 SI84521 — paste them from an IBM support page'), ignoreFocusOut: true });
  if (!v) { return; }
  const ids = parsePtfIds(v);
  if (!ids.length) { throw new Error(vscode.l10n.t('No PTF ID found (two letters and five digits, like SI12345).')); }
  const rows = await reportProgress('ptfLookup', vscode.l10n.t('Reading from the IBM i…'), () => conn.rows<Row>(`SELECT PTF_IDENTIFIER AS ID, PTF_PRODUCT_ID AS PROD, PTF_LOADED_STATUS AS ST, COALESCE(PTF_IPL_ACTION, '') AS IPL, COALESCE(PTF_SUPERSEDED_BY_PTF, '') AS SUP, ` +
    `VARCHAR_FORMAT(PTF_STATUS_TIMESTAMP, 'YYYY-MM-DD') AS D FROM QSYS2.PTF_INFO WHERE PTF_IDENTIFIER IN (${ids.map(sqlString).join(', ')})`, 500));
  const by = new Map(rows.map(r => [s(r, 'ID'), r]));
  showReport('ptfLookup', {
    title: vscode.l10n.t('PTF lookup — {0}', conn.profile.name), subtitle: vscode.l10n.t('{0} of {1} applied (or superseded by a newer one).', ids.filter(i => /APPLIED|SUPERSEDED/i.test(s(by.get(i), 'ST'))).length, ids.length),
    actions: [{ label: vscode.l10n.t('Look up others'), command: 'vanthrex.ptfLookup' }],
    tables: [{ title: 'PTFs', columns: ['PTF', 'Status', 'Product', 'Pending IPL action', 'Superseded by', 'Since'],
      rows: ids.map(i => { const r = by.get(i); return [i, r ? s(r, 'ST') : 'NOT ON THE SYSTEM', s(r, 'PROD'), s(r, 'IPL'), s(r, 'SUP'), s(r, 'D')]; }),
      rowClass: ids.map(i => { const st = s(by.get(i), 'ST'); return !st ? 'bad' : /APPLIED|SUPERSEDED/i.test(st) ? undefined : 'different'; }) }],
    note: vscode.l10n.t('"Not on the system" means the PTF was never loaded — order it (SNDPTFORD) or check whether a PTF group that contains it is installed.'),
  }, ALLOWED);
}

async function journals(manager: ConnectionManager, x?: unknown): Promise<void> {
  const conn = manager.require();
  const lib = typeof x === 'string' ? x : (x as { library?: string } | undefined)?.library;
  const rows = await reportProgress('journals', vscode.l10n.t('Reading journals…'), () => conn.rows<Row>(`SELECT * FROM QSYS2.JOURNAL_INFO${lib ? ` WHERE JOURNAL_LIBRARY = ${sqlString(lib)}` : ` WHERE JOURNAL_LIBRARY NOT LIKE 'Q%'`} ORDER BY JOURNAL_LIBRARY, JOURNAL_NAME`, 2000));
  const kb = (r: Row) => Number(pick(r, 'TOTAL_SIZE_JOURNAL_RECEIVERS') || 0);
  showReport('journals', {
    title: `Journals${lib ? ` in ${lib}` : ''}`, subtitle: vscode.l10n.t('{0} journal(s). Click one to change its receiver or see what it journals.', rows.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.journals', args: [lib] }],
    tables: [{ title: vscode.l10n.t('Journals'), filter: true, columns: ['Journal', 'State', 'Attached receiver', 'Receivers', 'Receivers size (MB)', 'Objects journaled', 'Manage receivers', 'Delete receivers', 'Description'],
      rows: rows.map(r => [`${s(r, 'JOURNAL_LIBRARY')}/${s(r, 'JOURNAL_NAME')}`, pick(r, 'JOURNAL_STATE'), `${pick(r, 'ATTACHED_JOURNAL_RECEIVER_LIBRARY')}/${pick(r, 'ATTACHED_JOURNAL_RECEIVER_NAME')}`,
        pick(r, 'NUMBER_JOURNAL_RECEIVERS'), Math.round(kb(r) / 1024).toLocaleString(), pick(r, 'NUMBER_JOURNALED_OBJECTS'), pick(r, 'MANAGE_RECEIVER_OPTION'), pick(r, 'DELETE_RECEIVER_OPTION'), pick(r, 'TEXT_DESCRIPTION')]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.journals.row', args: [s(r, 'JOURNAL_LIBRARY'), s(r, 'JOURNAL_NAME')] })),
      rowClass: rows.map(r => (/INACTIVE|STANDBY/i.test(pick(r, 'JOURNAL_STATE')) ? 'different' : undefined)) }],
    note: vscode.l10n.t('Journals with *USER receiver management need someone to change receivers and delete old ones (the Storage & cleanup advisor lists those older than 30 days).'),
  }, ALLOWED);
}

async function journalRow(manager: ConnectionManager, lib: string, jrn: string): Promise<void> {
  const conn = manager.require();
  const p = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(list-unordered) Objects journaled to it'), v: 'objs' }, { label: vscode.l10n.t('$(refresh) Change receiver now (CHGJRN *GEN)'), v: 'chg' },
    { label: vscode.l10n.t('$(add) Journal every new table in a library to it (STRJRNLIB)…'), v: 'lib' },
  ], { title: `${lib}/${jrn}` });
  if (!p) { return; }
  if (p.v === 'chg') { await run(conn, chgjrnCommand(lib, jrn), vscode.l10n.t('A new receiver is attached; the old one can then be saved and deleted.')); return; }
  if (p.v === 'lib') {
    const l = (await vscode.window.showInputBox({ title: vscode.l10n.t('Library whose objects should be journaled to {0}/{1}', lib, jrn), value: lib, ignoreFocusOut: true }))?.trim().toUpperCase();
    if (l) { await run(conn, strjrnlibCommand(l, lib, jrn), vscode.l10n.t('Tables, data areas and data queues created in the library from now on are journaled automatically (with before and after images).')); }
    return;
  }
  const objs = await reportProgress('journalObjs', vscode.l10n.t('Reading from the IBM i…'), () => conn.rows<Row>(`SELECT * FROM QSYS2.JOURNALED_OBJECTS WHERE JOURNAL_LIBRARY = ${sqlString(lib)} AND JOURNAL_NAME = ${sqlString(jrn)} ORDER BY OBJECT_LIBRARY, OBJECT_NAME FETCH FIRST 5000 ROWS ONLY`, 5000));
  showReport('journalObjs', {
    title: vscode.l10n.t('Objects journaled to {0}/{1}', lib, jrn), subtitle: vscode.l10n.t('{0} object(s).', objs.length),
    actions: [{ label: vscode.l10n.t('All journals'), command: 'vanthrex.journals' }],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: ['Library', 'Object', 'Type', 'Images', 'Omit open/close'],
      rows: objs.map(r => [pick(r, 'OBJECT_LIBRARY'), pick(r, 'OBJECT_NAME'), pick(r, 'OBJECT_TYPE'), pick(r, 'JOURNAL_IMAGES'), pick(r, 'OMIT_JOURNAL_ENTRY')]) }],
  }, ALLOWED);
}

async function networkTest(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const host = (await vscode.window.showInputBox({ title: vscode.l10n.t('Can the IBM i reach this host?'), prompt: vscode.l10n.t('Host name or IP address (tested from the IBM i, not from your PC)'), ignoreFocusOut: true }))?.trim();
  if (!host) { return; }
  const r = await progress(vscode.l10n.t('Pinging {0} from {1}…', host, conn.profile.name), () => conn.runCL(pingCommand(host)));
  const p = parsePing(r.stdout + '\n' + r.stderr);
  const msg = p.sent ? vscode.l10n.t('{0}: {1} of {2} answers{3}.', host, p.received ?? 0, p.sent, p.avgMs !== undefined ? `, ${p.avgMs} ms` : '') : vscode.l10n.t('{0} did not answer.', host);
  const c = await (p.ok ? vscode.window.showInformationMessage(msg, vscode.l10n.t('Call a Web API…')) : vscode.window.showWarningMessage(msg, { modal: false, detail: p.text } as vscode.MessageOptions, vscode.l10n.t('Details')));
  if (c === vscode.l10n.t('Details')) { await vscode.window.showInformationMessage(p.text || msg, { modal: true }); }
  if (c === vscode.l10n.t('Call a Web API…')) { await vscode.commands.executeCommand('vanthrex.callWebApi'); }
}

async function callWebApi(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const url = (await vscode.window.showInputBox({ title: vscode.l10n.t('Call a web API from the IBM i (1/3)'), prompt: vscode.l10n.t('https://…'), value: state.get<string>('vanthrex.http.lastUrl', 'https://'), ignoreFocusOut: true,
    validateInput: v => (/^https?:\/\/\S+$/i.test(v.trim()) ? undefined : 'http(s)://…') }))?.trim();
  if (!url) { return; }
  await state.update('vanthrex.http.lastUrl', url);
  const method = await vscode.window.showQuickPick(['GET', 'POST'], { title: vscode.l10n.t('Call a web API from the IBM i (2/3): method') });
  if (!method) { return; }
  const hdrText = await vscode.window.showInputBox({ title: vscode.l10n.t('Call a web API from the IBM i (3/3): headers (optional)'), prompt: vscode.l10n.t('Accept: application/json; Authorization: Bearer …'), value: state.get<string>('vanthrex.http.lastHeaders', 'Accept: application/json'), ignoreFocusOut: true });
  if (hdrText === undefined) { return; }
  await state.update('vanthrex.http.lastHeaders', /authorization/i.test(hdrText) ? '' : hdrText);
  let body = '';
  if (method === 'POST') { const b = await vscode.window.showInputBox({ title: vscode.l10n.t('Request body'), value: '{}', ignoreFocusOut: true }); if (b === undefined) { return; } body = b; }
  const opts = httpOptions(parseHeaders(hdrText), { timeoutSeconds: 30 });
  const sql = method === 'GET'
    ? `SELECT * FROM TABLE(QSYS2.HTTP_GET_VERBOSE(${sqlString(url)}, ${sqlString(opts)})) X`
    : `SELECT * FROM TABLE(QSYS2.HTTP_POST_VERBOSE(${sqlString(url)}, ${sqlString(body)}, ${sqlString(opts)})) X`;
  const started = Date.now();
  const rows = await progress(vscode.l10n.t('Calling {0} from {1}…', url, conn.profile.name), () => conn.rows<Row>(sql, 1));
  const ms = Date.now() - started;
  const r = rows[0] ?? {};
  const hdr = pick(r, 'RESPONSE_HTTP_HEADER', 'RESPONSE_HEADER');
  const resp = pick(r, 'RESPONSE_MESSAGE', 'RESPONSE');
  const status = httpStatus(hdr);
  const pretty = prettyBody(resp);
  const doc = await vscode.workspace.openTextDocument({ language: pretty.language, content: pretty.text });
  await vscode.window.showTextDocument(doc, { preview: false });
  vscode.window.showInformationMessage(vscode.l10n.t('{0} {1} → HTTP {2} in {3} ms (called from {4}).', method, url, status ?? '?', ms, conn.profile.name), vscode.l10n.t('Show Headers')).then(async c => {
    if (c) { const d = await vscode.workspace.openTextDocument({ language: 'json', content: prettyBody(hdr).text }); await vscode.window.showTextDocument(d, { preview: true }); }
  });
}

const NAME = /^[A-Za-z$#@][A-Za-z0-9$#@_.]{0,9}$/;

const nameCheck = (v: string) => (NAME.test(v.trim()) ? undefined : vscode.l10n.t('1–10 characters, starting with a letter, $, # or @.'));

async function runOk(conn: IbmiConnection, cmd: string): Promise<void> {
  const r = await conn.runCL(cmd);
  if (!r.ok) { throw new Error((r.stderr || r.stdout).trim().split('\n').filter(l => /[A-Z]{3}[0-9A-F]{4}/.test(l)).pop() || (r.stderr || r.stdout).trim().split('\n').pop() || cmd); }
}

async function libraryListFromJobd(manager: ConnectionManager, preset?: string): Promise<void> {
  const conn = manager.require();
  const given = typeof preset === 'string' && /^[^/]+\/[^/]+$/.test(preset) ? preset.toUpperCase().split('/') : undefined;
  const how = given ? { k: 'given' } : await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(person) From a user profile'), detail: vscode.l10n.t('Uses the job description of the profile (yours by default)'), k: 'user' },
    { label: vscode.l10n.t('$(briefcase) From a job description'), detail: 'LIBRARY/JOBD', k: 'jobd' },
  ], { title: vscode.l10n.t('Library list from…') });
  if (!how) { return; }
  let jl = ''; let jn = '';
  if (given) { [jl, jn] = given; } else if (how.k === 'user') {
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

async function compareSystemValues(manager: ConnectionManager): Promise<void> {
  const a = manager.require();
  const others = manager.openConnections.filter(c => c.profile.id !== a.profile.id);
  if (!others.length) { throw new Error(vscode.l10n.t('Connect to a second system first (Connections view), then compare.')); }
  const b = others.length === 1 ? others[0] : (await vscode.window.showQuickPick(others.map(c => ({ label: c.profile.name, c })), { title: vscode.l10n.t('Compare {0} with…', a.profile.name) }))?.c;
  if (!b) { return; }
  const sql = `SELECT SYSTEM_VALUE_NAME AS N, COALESCE(CURRENT_CHARACTER_VALUE, VARCHAR(CURRENT_NUMERIC_VALUE), '') AS V FROM QSYS2.SYSTEM_VALUE_INFO`;
  const [ra, rb] = await reportProgress('compareSysval', vscode.l10n.t('Reading system values…'), () => Promise.all([a.rows<Row>(sql, 2000), b.rows<Row>(sql, 2000)]));
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
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Libraries of "{0}", top first', name), ignoreFocusOut: true, validateInput: x => { try { parseLibrarySetInput(x); return undefined; } catch (e) { return errorMessage(e); } } });
    if (v === undefined) { return; }
    libraries = parseLibrarySetInput(v);
    cur = (await vscode.window.showInputBox({ title: vscode.l10n.t('Current library (optional)'), value: libraries[0] ?? '', ignoreFocusOut: true }))?.trim().toUpperCase() || undefined;
  }
  await state.update(key, [...sets.filter(x => x.name !== name), { name, libraries: [...libraries], currentLibrary: cur }]);
  vscode.window.showInformationMessage(vscode.l10n.t('Saved library list set "{0}".', name));
}

// ================================================================ registration

export function registerSystemTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.findCommand', guard(() => findCommand(manager))),
    vscode.commands.registerCommand('vanthrex.installedSoftware', guard(() => installedSoftware(manager))),
    vscode.commands.registerCommand('vanthrex.ptfLookup', guard(() => ptfLookup(manager))),
    vscode.commands.registerCommand('vanthrex.journals', guard((x?: unknown) => journals(manager, x))),
    vscode.commands.registerCommand('vanthrex.journals.row', guard((l: string, j: string) => journalRow(manager, l, j))),
    vscode.commands.registerCommand('vanthrex.networkTest', guard(() => networkTest(manager))),
    vscode.commands.registerCommand('vanthrex.callWebApi', guard(() => callWebApi(manager, context.globalState))),
    vscode.commands.registerCommand('vanthrex.libraryListFromJobd', guard((preset?: string) => libraryListFromJobd(manager, preset))),
    vscode.commands.registerCommand('vanthrex.compareSystemValues', guard(() => compareSystemValues(manager))),
    vscode.commands.registerCommand('vanthrex.createLibrary', guard((a?: unknown) => createLibrary(manager, a))),
    vscode.commands.registerCommand('vanthrex.librarySets', guard(() => librarySets(manager, context.globalState))),
  );
}
