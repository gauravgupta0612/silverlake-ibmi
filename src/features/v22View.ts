import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { assertSystemName, parseMemberPath, sqlString } from '../core/util';
import { replyCommand, validReplies } from '../core/extras';
import {
  ColDef, DATA_AUTHORITIES, DEFAULT_ALLOWED_LIBRARIES, alterScript, chgautCommand, chgjrnCommand, chgownCommand, compareStructure, findHardcodedLibraries,
  parsePtfIds, removeMessageCommand, sendMessageCommand, strjrnlibCommand, unusedRpg,
} from '../core/v22';
import { MEMBER_SCHEME } from './fileSystems';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const pick = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { if (r && r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') { return String(r[k]).trim(); } } return ''; };
const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);
const ALLOWED = new Set(['vanthrex.installedSoftware', 'vanthrex.journals', 'vanthrex.journals.row', 'vanthrex.ifsPermissions', 'vanthrex.ifsPermissions.row', 'vanthrex.compareStructure',
  'vanthrex.compareStructure.script', 'vanthrex.unusedCode', 'vanthrex.hardcodedLibraries', 'vanthrex.codeMetrics.open', 'vanthrex.messageQueue', 'vanthrex.messageQueue.row',
  'vanthrex.messageQueue.send', 'vanthrex.ptfLookup', 'vanthrex.explainMessage', 'vanthrex.jobLog', 'vanthrex.v22.gotoLine']);

async function run(conn: IbmiConnection, cmd: string, warn = ''): Promise<boolean> {
  const p = await vscode.window.showWarningMessage(cmd, { modal: true, detail: warn || undefined }, vscode.l10n.t('Run'));
  if (p !== vscode.l10n.t('Run')) { return false; }
  const r = await progress(cmd.split(' ')[0], () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  return true;
}

// ================================================================ 1. installed software & licenses

async function installedSoftware(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const [prods, lic] = await progress(vscode.l10n.t('Reading installed software…'), () => Promise.all([
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

// ================================================================ 2. PTF lookup

async function ptfLookup(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Is this PTF installed?'), prompt: vscode.l10n.t('One or more PTF IDs, e.g. SI84519 SI84521 — paste them from an IBM support page'), ignoreFocusOut: true });
  if (!v) { return; }
  const ids = parsePtfIds(v);
  if (!ids.length) { throw new Error(vscode.l10n.t('No PTF ID found (two letters and five digits, like SI12345).')); }
  const rows = await conn.rows<Row>(`SELECT PTF_IDENTIFIER AS ID, PTF_PRODUCT_ID AS PROD, PTF_LOADED_STATUS AS ST, COALESCE(PTF_IPL_ACTION, '') AS IPL, COALESCE(PTF_SUPERSEDED_BY_PTF, '') AS SUP, ` +
    `VARCHAR_FORMAT(PTF_STATUS_TIMESTAMP, 'YYYY-MM-DD') AS D FROM QSYS2.PTF_INFO WHERE PTF_IDENTIFIER IN (${ids.map(sqlString).join(', ')})`, 500);
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

// ================================================================ 3. journals

async function journals(manager: ConnectionManager, x?: unknown): Promise<void> {
  const conn = manager.require();
  const lib = typeof x === 'string' ? x : (x as { library?: string } | undefined)?.library;
  const rows = await progress(vscode.l10n.t('Reading journals…'), () => conn.rows<Row>(`SELECT * FROM QSYS2.JOURNAL_INFO${lib ? ` WHERE JOURNAL_LIBRARY = ${sqlString(lib)}` : ` WHERE JOURNAL_LIBRARY NOT LIKE 'Q%'`} ORDER BY JOURNAL_LIBRARY, JOURNAL_NAME`, 2000));
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
  const objs = await conn.rows<Row>(`SELECT * FROM QSYS2.JOURNALED_OBJECTS WHERE JOURNAL_LIBRARY = ${sqlString(lib)} AND JOURNAL_NAME = ${sqlString(jrn)} ORDER BY OBJECT_LIBRARY, OBJECT_NAME FETCH FIRST 5000 ROWS ONLY`, 5000);
  showReport('journalObjs', {
    title: vscode.l10n.t('Objects journaled to {0}/{1}', lib, jrn), subtitle: vscode.l10n.t('{0} object(s).', objs.length),
    actions: [{ label: vscode.l10n.t('All journals'), command: 'vanthrex.journals' }],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: ['Library', 'Object', 'Type', 'Images', 'Omit open/close'],
      rows: objs.map(r => [pick(r, 'OBJECT_LIBRARY'), pick(r, 'OBJECT_NAME'), pick(r, 'OBJECT_TYPE'), pick(r, 'JOURNAL_IMAGES'), pick(r, 'OMIT_JOURNAL_ENTRY')]) }],
  }, ALLOWED);
}

// ================================================================ 4. IFS permissions

async function ifsPermissions(manager: ConnectionManager, n?: { path?: string; isDirectory?: boolean }): Promise<void> {
  const conn = manager.require();
  const path = n?.path ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('IFS permissions'), prompt: vscode.l10n.t('Path'), value: conn.profile.ifsHome ?? '/home', ignoreFocusOut: true }))?.trim();
  if (!path) { return; }
  const rows = await conn.rows<Row>(`SELECT * FROM TABLE(QSYS2.IFS_OBJECT_PRIVILEGES(PATH_NAME => ${sqlString(path)})) X`, 500);
  const owner = await conn.rows<Row>(`SELECT * FROM TABLE(QSYS2.IFS_OBJECT_STATISTICS(START_PATH_NAME => ${sqlString(path)}, SUBTREE_DIRECTORIES => 'NO')) X WHERE PATH_NAME = ${sqlString(path)}`, 1).catch(() => []);
  const isDir = n?.isDirectory ?? /DIR/i.test(pick(owner[0], 'OBJECT_TYPE'));
  showReport('ifsPerm', {
    title: vscode.l10n.t('Permissions — {0}', path), subtitle: `Owner ${pick(owner[0], 'OBJECT_OWNER') || '?'}${pick(owner[0], 'PRIMARY_GROUP') ? `, primary group ${pick(owner[0], 'PRIMARY_GROUP')}` : ''}. Click a line to change it.`,
    actions: [{ label: vscode.l10n.t('Give someone access…'), command: 'vanthrex.ifsPermissions.row', args: [path, '', isDir] }, { label: vscode.l10n.t('Change owner…'), command: 'vanthrex.ifsPermissions.row', args: [path, '*OWNER', isDir] },
      { label: vscode.l10n.t('Refresh'), command: 'vanthrex.ifsPermissions', args: [{ path, isDirectory: isDir }] }],
    tables: [{ title: vscode.l10n.t('Who has access'), columns: ['User / group', 'Data authority', 'Object authorities'],
      rows: rows.map(r => [pick(r, 'AUTHORIZATION_NAME', 'AUTHORIZATION_USER'), pick(r, 'DATA_AUTHORITY'),
        ['OBJECT_EXISTENCE', 'OBJECT_MANAGEMENT', 'OBJECT_ALTER', 'OBJECT_REFERENCE'].filter(k => s(r, k) === 'YES').map(k => k.replace('OBJECT_', '').toLowerCase()).join(', ')]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Change…'), command: 'vanthrex.ifsPermissions.row', args: [path, pick(r, 'AUTHORIZATION_NAME', 'AUTHORIZATION_USER'), isDir] })) }],
    note: vscode.l10n.t('*RWX = read, write, execute (for a folder: list, create, enter). On a folder, Vanthrex can apply the change to everything below it too (SUBTREE(*ALL)).'),
  }, ALLOWED);
}

async function ifsPermissionRow(manager: ConnectionManager, path: string, user: string, isDir: boolean): Promise<void> {
  const conn = manager.require();
  const sub = async () => (isDir ? (await vscode.window.showQuickPick([{ label: vscode.l10n.t('Only this folder'), v: false }, { label: vscode.l10n.t('This folder and everything below it'), v: true }], { title: vscode.l10n.t('Apply to') }))?.v : false);
  if (user === '*OWNER') {
    const o = (await vscode.window.showInputBox({ title: vscode.l10n.t('New owner of {0}', path), ignoreFocusOut: true }))?.trim().toUpperCase();
    if (!o) { return; }
    const st = await sub(); if (st === undefined) { return; }
    if (await run(conn, chgownCommand(path, o, st))) { await ifsPermissions(manager, { path, isDirectory: isDir }); }
    return;
  }
  const u = user || (await vscode.window.showInputBox({ title: vscode.l10n.t('User, group or *PUBLIC'), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!u) { return; }
  const a = await vscode.window.showQuickPick(DATA_AUTHORITIES, { title: vscode.l10n.t('Data authority of {0} on {1}', u, path) });
  if (!a) { return; }
  const st = await sub(); if (st === undefined) { return; }
  if (await run(conn, chgautCommand(path, u, a, st))) { await ifsPermissions(manager, { path, isDirectory: isDir }); }
}

// ================================================================ 5. table structure compare

let lastAlter = '';

async function compareStructureCmd(manager: ConnectionManager, o?: { library?: string; name?: string }): Promise<void> {
  const a = manager.require();
  let lib = o?.library; let tbl = o?.name;
  if (!lib || !tbl) {
    const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Compare table structure'), prompt: 'LIBRARY/TABLE', ignoreFocusOut: true });
    if (!v?.includes('/')) { return; }
    [lib, tbl] = v.trim().toUpperCase().split('/');
  }
  lib = assertSystemName(lib, 'library'); tbl = assertSystemName(tbl, 'table');
  const others = manager.openConnections.filter(c => c !== a);
  let b = a;
  if (others.length) {
    const p = await vscode.window.showQuickPick([{ label: a.profile.name, description: vscode.l10n.t('this system'), c: a }, ...others.map(c => ({ label: c.profile.name, description: c.profile.host, c }))], { title: vscode.l10n.t('Compare with the table on which system?') });
    if (!p) { return; } b = p.c;
  }
  const libB = (await vscode.window.showInputBox({ title: vscode.l10n.t('Library of the other copy on {0}', b.profile.name), value: b === a ? '' : lib, ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!libB) { return; }
  const q = (l: string) => `SELECT COLUMN_NAME AS N, DATA_TYPE AS T, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS S, IS_NULLABLE AS NL, COALESCE(COLUMN_DEFAULT, '') AS D, COALESCE(COLUMN_TEXT, '') AS X ` +
    `FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(l)} AND SYSTEM_TABLE_NAME = ${sqlString(tbl!)} ORDER BY ORDINAL_POSITION`;
  const iq = (l: string) => `SELECT I.SYSTEM_INDEX_NAME AS N, LISTAGG(K.COLUMN_NAME, ', ') WITHIN GROUP (ORDER BY K.ORDINAL_POSITION) AS K FROM QSYS2.SYSINDEXES I JOIN QSYS2.SYSKEYS K ON K.INDEX_SCHEMA = I.INDEX_SCHEMA AND K.INDEX_NAME = I.INDEX_NAME ` +
    `WHERE I.SYSTEM_TABLE_SCHEMA = ${sqlString(l)} AND I.SYSTEM_TABLE_NAME = ${sqlString(tbl!)} GROUP BY I.SYSTEM_INDEX_NAME`;
  const [ra, rb, ia, ib] = await progress(vscode.l10n.t('Reading both definitions…'), () => Promise.all([a.rows<Row>(q(lib!), 2000), b.rows<Row>(q(libB), 2000), a.rows<Row>(iq(lib!), 500).catch(() => []), b.rows<Row>(iq(libB), 500).catch(() => [])]));
  if (!ra.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', lib, tbl)); }
  if (!rb.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found on {2}.', libB, tbl, b.profile.name)); }
  const cols = (rs: Row[]): ColDef[] => rs.map(r => ({ name: s(r, 'N'), type: s(r, 'T'), length: Number(r.L), scale: Number(r.S), nullable: s(r, 'NL') === 'Y', dflt: s(r, 'D') || undefined, text: s(r, 'X') }));
  const ca = cols(ra); const cb = cols(rb);
  const diffs = compareStructure(ca, cb);
  const keysA = new Set(ia.map(r => s(r, 'K'))); const keysB = new Set(ib.map(r => s(r, 'K')));
  const idx = [...ia.filter(r => !keysB.has(s(r, 'K'))).map(r => [s(r, 'N'), s(r, 'K'), `only in ${lib}`]), ...ib.filter(r => !keysA.has(s(r, 'K'))).map(r => [s(r, 'N'), s(r, 'K'), `only in ${libB}`])];
  lastAlter = alterScript(libB, tbl, ca, diffs);
  const A = `${lib} (${a.profile.name})`; const B = `${libB} (${b.profile.name})`;
  showReport('structCompare', {
    title: `${tbl}: ${A} ↔ ${B}`, subtitle: diffs.length || idx.length ? `${diffs.length} column difference(s), ${idx.length} index difference(s).` : 'The two tables have the same columns and indexes.',
    actions: diffs.length ? [{ label: vscode.l10n.t('Open ALTER script for {0}', libB), command: 'vanthrex.compareStructure.script' }] : [],
    tables: [
      { title: vscode.l10n.t('Columns'), columns: ['Column', 'Status', A, B], rows: diffs.map(d => [d.column, d.status, d.a ?? '—', d.b ?? '—']), rowClass: diffs.map(d => (d.status === 'different' ? 'different' : d.status === 'only in A' ? 'onlyA' : 'onlyB')), empty: vscode.l10n.t('Same columns.') },
      { title: vscode.l10n.t('Indexes (by key columns)'), columns: ['Index', 'Keys', 'Where'], rows: idx, empty: vscode.l10n.t('Same keys.') },
    ],
    note: vscode.l10n.t('The ALTER script makes the second copy match the first; columns that exist only in the second copy are listed as comments, never dropped automatically.'),
  }, ALLOWED);
}

// ================================================================ 6–7. unused code & hard-coded libraries

async function unusedCode(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { throw new Error(vscode.l10n.t('Open an RPG source first.')); }
  const items = unusedRpg(ed.document.getText());
  const name = ed.document.uri.scheme === MEMBER_SCHEME ? parseMemberPath(ed.document.uri.path).member : ed.document.fileName.split(/[\\/]/).pop();
  showReport('unused', {
    title: vscode.l10n.t('Unused code — {0}', String(name)), subtitle: items.length ? `${items.length} definition(s) nothing refers to in this source. Click one to go to it.` : 'Everything defined in this source is used.',
    tables: [{ title: vscode.l10n.t('Unused definitions'), columns: ['Name', 'Kind', 'Line'], rows: items.map(i => [i.name, i.kind, i.line + 1]),
      rowActions: items.map(i => ({ label: 'Go to', command: 'vanthrex.v22.gotoLine', args: [ed.document.uri.toString(), i.line] })), empty: vscode.l10n.t('None.') }],
    note: vscode.l10n.t('Only this source is checked: exported procedures are skipped, and something used only through a /COPY member or by another program can still show here. Removing dead code makes programs easier to read and to modernize.'),
  }, ALLOWED);
}

async function hardcodedLibraries(manager: ConnectionManager, n?: { library?: string; file?: string }): Promise<void> {
  const conn = manager.require();
  const allowed = [...DEFAULT_ALLOWED_LIBRARIES, ...vscode.workspace.getConfiguration('vanthrex').get<string[]>('scan.allowedLibraries', [])];
  if (!n?.library || !n.file) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { throw new Error(vscode.l10n.t('Open a source, or right-click a source file.')); }
    const hits = findHardcodedLibraries(ed.document.getText(), allowed);
    showReport('hardcoded', {
      title: vscode.l10n.t('Hard-coded libraries'), subtitle: vscode.l10n.t('{0} place(s) in this source name a library explicitly.', hits.length),
      tables: [{ title: vscode.l10n.t('Places'), columns: ['Line', 'Library', 'Object', 'Code'], rows: hits.map(h => [h.line + 1, h.library, h.object, h.text]),
        rowActions: hits.map(h => ({ label: 'Go to', command: 'vanthrex.v22.gotoLine', args: [ed.document.uri.toString(), h.line] })), empty: vscode.l10n.t('None.') }],
    }, ALLOWED);
    return;
  }
  const members = await conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(n.library)} AND SYSTEM_TABLE_NAME = ${sqlString(n.file)} ORDER BY 1`, 5000);
  const hits: (ReturnType<typeof findHardcodedLibraries>[number] & { member: string; type: string })[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Scanning {0}/{1}…', n.library, n.file), cancellable: true }, async (p, token) => {
    for (const m of members.slice(0, 1000)) {
      if (token.isCancellationRequested) { break; }
      p.report({ message: s(m, 'M'), increment: 100 / Math.min(1000, members.length) });
      try { findHardcodedLibraries(await conn.readMember(n.library!, n.file!, s(m, 'M')), allowed).forEach(h => hits.push({ ...h, member: s(m, 'M'), type: s(m, 'T') })); } catch (e) { log(`Scan ${s(m, 'M')}: ${errorMessage(e)}`); }
    }
  });
  const byLib = new Map<string, number>(); hits.forEach(h => byLib.set(h.library, (byLib.get(h.library) ?? 0) + 1));
  showReport('hardcoded', {
    title: vscode.l10n.t('Hard-coded libraries — {0}/{1}', n.library, n.file),
    subtitle: vscode.l10n.t('{0} place(s) in {1} member(s) name a library explicitly. These break when code moves from DEV to TEST to PROD.', hits.length, new Set(hits.map(h => h.member)).size),
    facts: [...byLib.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([l, c]) => [l, c] as [string, number]),
    tables: [{ title: vscode.l10n.t('Places'), filter: true, columns: ['Member', 'Line', 'Library', 'Object', 'Code'], rows: hits.map(h => [h.member, h.line + 1, h.library, h.object, h.text]),
      rowActions: hits.map(h => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.codeMetrics.open', args: [n.library, n.file, h.member, h.type || 'mbr'] })), empty: vscode.l10n.t('None — good.') }],
    note: vscode.l10n.t('IBM libraries (QSYS2, SYSTOOLS…) and QTEMP are ignored; add your own shared libraries to vanthrex.scan.allowedLibraries. Use the library list (*LIBL) or a variable instead.'),
  }, ALLOWED);
}

// ================================================================ 8. any message queue

async function messageQueue(manager: ConnectionManager, q?: string): Promise<void> {
  const conn = manager.require();
  const v = (q ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Message queue'), prompt: 'LIBRARY/MSGQ', value: 'QSYS/QSYSOPR', ignoreFocusOut: true })))?.trim().toUpperCase();
  if (!v?.includes('/')) { return; }
  const [lib, mq] = v.split('/');
  const rows = await progress(vscode.l10n.t('Reading {0}…', v), () => conn.rows<Row>(
    `SELECT HEX(MESSAGE_KEY) AS K, COALESCE(MESSAGE_ID, '') AS ID, MESSAGE_TYPE AS T, COALESCE(SEVERITY, 0) AS SEV, VARCHAR_FORMAT(MESSAGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS') AS TS, ` +
    `COALESCE(MESSAGE_TEXT, '') AS TXT, COALESCE(FROM_USER, '') AS USR, COALESCE(FROM_JOB, '') AS JOB, HEX(ASSOCIATED_MESSAGE_KEY) AS AK FROM QSYS2.MESSAGE_QUEUE_INFO ` +
    `WHERE MESSAGE_QUEUE_LIBRARY = ${sqlString(lib)} AND MESSAGE_QUEUE_NAME = ${sqlString(mq)} ORDER BY MESSAGE_TIMESTAMP DESC FETCH FIRST 1000 ROWS ONLY`, 1000));
  const answered = new Set(rows.filter(r => s(r, 'T') === 'REPLY').map(r => s(r, 'AK')));
  const shown = rows.filter(r => s(r, 'T') !== 'REPLY');
  const waiting = shown.filter(r => s(r, 'T') === 'INQUIRY' && !answered.has(s(r, 'K')));
  showReport('msgq', {
    title: vscode.l10n.t('Message queue {0}', v), subtitle: vscode.l10n.t('{0} message(s), newest first; {1} inquiry message(s) waiting for a reply.', shown.length, waiting.length),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.messageQueue', args: [v] }, { label: vscode.l10n.t('Send a message…'), command: 'vanthrex.messageQueue.send', args: [v] }],
    tables: [{ title: vscode.l10n.t('Messages'), filter: true, columns: ['Time', 'Message', 'Type', 'Sev', 'Text', 'From user', 'From job'],
      rows: shown.map(r => [s(r, 'TS'), s(r, 'ID'), s(r, 'T') === 'INQUIRY' && !answered.has(s(r, 'K')) ? 'INQUIRY — waiting' : s(r, 'T'), s(r, 'SEV'), s(r, 'TXT'), s(r, 'USR'), s(r, 'JOB')]),
      rowActions: shown.map(r => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.messageQueue.row', args: [v, { key: s(r, 'K'), id: s(r, 'ID'), text: s(r, 'TXT'), job: s(r, 'JOB'), waiting: s(r, 'T') === 'INQUIRY' && !answered.has(s(r, 'K')) }] })),
      rowClass: shown.map(r => (s(r, 'T') === 'INQUIRY' && !answered.has(s(r, 'K')) ? 'bad' : Number(r.SEV) >= 40 ? 'different' : undefined)) }],
  }, ALLOWED);
}

async function messageRow(manager: ConnectionManager, q: string, m: { key: string; id: string; text: string; job: string; waiting: boolean }): Promise<void> {
  const conn = manager.require();
  const [lib, mq] = q.split('/');
  const opts = [
    ...(m.waiting ? [{ label: vscode.l10n.t('$(reply) Reply…'), v: 'reply' }] : []),
    ...(m.id ? [{ label: vscode.l10n.t('$(question) Explain {0}', m.id), v: 'explain' }] : []),
    ...(m.job ? [{ label: vscode.l10n.t('$(output) Job log of the sender'), v: 'log' }] : []),
    { label: vscode.l10n.t('$(trash) Remove'), v: 'remove' },
  ];
  const p = await vscode.window.showQuickPick(opts, { title: m.text.slice(0, 120) });
  if (!p) { return; }
  if (p.v === 'explain') { await vscode.commands.executeCommand('vanthrex.explainMessage', m.id); return; }
  if (p.v === 'log') { await vscode.commands.executeCommand('vanthrex.jobLog', { job: m.job }); return; }
  if (p.v === 'reply') {
    const valid = validReplies(m.text);
    let reply = valid.length ? await vscode.window.showQuickPick([...valid, vscode.l10n.t('Other…')], { title: m.text.slice(0, 120) }) : undefined;
    if (!reply || !valid.includes(reply)) { reply = await vscode.window.showInputBox({ title: vscode.l10n.t('Reply'), ignoreFocusOut: true }); }
    if (reply && await run(conn, replyCommand(m.key, lib, mq, reply))) { await messageQueue(manager, q); }
    return;
  }
  if (await run(conn, removeMessageCommand(lib, mq, m.key))) { await messageQueue(manager, q); }
}

// ================================================================ registration

export function registerV22(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.installedSoftware', guard(() => installedSoftware(manager))),
    vscode.commands.registerCommand('vanthrex.ptfLookup', guard(() => ptfLookup(manager))),
    vscode.commands.registerCommand('vanthrex.journals', guard((x?: unknown) => journals(manager, x))),
    vscode.commands.registerCommand('vanthrex.journals.row', guard((l: string, j: string) => journalRow(manager, l, j))),
    vscode.commands.registerCommand('vanthrex.ifsPermissions', guard((n?: { path?: string; isDirectory?: boolean }) => ifsPermissions(manager, n))),
    vscode.commands.registerCommand('vanthrex.ifsPermissions.row', guard((p: string, u: string, d: boolean) => ifsPermissionRow(manager, p, u, !!d))),
    vscode.commands.registerCommand('vanthrex.compareStructure', guard((o?: { library?: string; name?: string }) => compareStructureCmd(manager, o))),
    vscode.commands.registerCommand('vanthrex.compareStructure.script', guard(async () => {
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: lastAlter });
      await vscode.window.showTextDocument(doc, { preview: false });
    })),
    vscode.commands.registerCommand('vanthrex.unusedCode', guard(() => unusedCode())),
    vscode.commands.registerCommand('vanthrex.hardcodedLibraries', guard((n?: { library?: string; file?: string }) => hardcodedLibraries(manager, n))),
    vscode.commands.registerCommand('vanthrex.messageQueue', guard((q?: string) => messageQueue(manager, typeof q === 'string' ? q : undefined))),
    vscode.commands.registerCommand('vanthrex.messageQueue.row', guard((q: string, m: { key: string; id: string; text: string; job: string; waiting: boolean }) => messageRow(manager, q, m))),
    vscode.commands.registerCommand('vanthrex.messageQueue.send', guard(async (q: string) => {
      const conn = manager.require();
      const [lib, mq] = q.split('/');
      const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Message to {0}', q), ignoreFocusOut: true });
      if (!text) { return; }
      const r = await conn.runCL(sendMessageCommand(lib, mq, text, false));
      if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
      await messageQueue(manager, q);
    })),
    vscode.commands.registerCommand('vanthrex.v22.gotoLine', guard(async (uri: string, line: number) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(line, 0, line, 0) });
    })),
  );
}
