// Database tools: table statistics, test data, row locks, table structure compare and table dependents.
import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { Column, insertStatements } from '../core/dataTransfer';
import { errorMessage, log, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { rpgForTable, TableColumn } from '../core/rpgFromTable';
import { formatBytes } from '../core/storage';
import { alterScript, ColDef, compareStructure } from '../core/tableCompare';
import { testRows } from '../core/testData';
import { assertSystemName, sqlString } from '../core/util';
import { reportProgress, showReport } from './reportPanel';

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vanthrex.jobLog', 'vanthrex.generateTestData.run', 'vanthrex.tableStatistics', 'vanthrex.editData', 'vanthrex.rowLocks',
  'vanthrex.rowLocks.row', 'vanthrex.compareStructure', 'vanthrex.compareStructure.script', 'vanthrex.tableDependents', 'vanthrex.whereUsed',
]);

type Row = Record<string, unknown>;

type Obj = { library: string; name: string; type?: string };

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function askTable(title: string, o?: Obj): Promise<Obj | undefined> {
  if (o?.library && o?.name) { return o; }
  const v = await vscode.window.showInputBox({ title, prompt: 'LIBRARY/TABLE', ignoreFocusOut: true });
  if (!v?.includes('/')) { return undefined; }
  const [l, t] = v.trim().toUpperCase().split('/');
  return { library: assertSystemName(l, 'library'), name: assertSystemName(t, 'table') };
}

async function columnsOf(conn: IbmiConnection, t: Obj): Promise<(Column & { pk: boolean })[]> {
  const [cols, pk] = await Promise.all([
    conn.rows<Row>(`SELECT COLUMN_NAME AS N, DATA_TYPE AS T, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS S, IS_NULLABLE AS NL, HAS_DEFAULT AS D, COALESCE(IS_IDENTITY, 'NO') AS ID FROM QSYS2.SYSCOLUMNS ` +
      `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(t.library)} AND SYSTEM_TABLE_NAME = ${sqlString(t.name)} ORDER BY ORDINAL_POSITION`, 2000),
    conn.rows<Row>(`SELECT K.COLUMN_NAME AS C FROM QSYS2.SYSCST C JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
      `WHERE C.SYSTEM_TABLE_SCHEMA = ${sqlString(t.library)} AND C.SYSTEM_TABLE_NAME = ${sqlString(t.name)} AND C.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE') ORDER BY C.CONSTRAINT_TYPE DESC, K.ORDINAL_POSITION`, 50).catch(() => []),
  ]);
  if (!cols.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', t.library, t.name)); }
  const pks = new Set(pk.map(p => s(p, 'C')));
  return cols.filter(c => s(c, 'ID') !== 'YES').map(c => ({ name: s(c, 'N'), type: s(c, 'T'), length: Number(c.L), scale: Number(c.S), nullable: s(c, 'NL') === 'Y', pk: pks.has(s(c, 'N')) }));
}

async function tableStatistics(manager: ConnectionManager, lib?: string): Promise<void> {
  const conn = manager.require();
  const l = lib ?? (await vscode.window.showInputBox({ title: vscode.l10n.t('Table statistics'), prompt: vscode.l10n.t('Library'), value: conn.profile.currentLibrary ?? '', ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!l) { return; }
  const rows = await reportProgress('tablestats', vscode.l10n.t('Reading table statistics of {0}…', l), () => conn.rows<Row>(`SELECT * FROM QSYS2.SYSTABLESTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(assertSystemName(l, 'library'))} ORDER BY DATA_SIZE DESC`, 5000));
  const n = (r: Row, k: string) => Number(r[k] ?? 0) || 0;
  const date = (r: Row, k: string) => s(r, k).replace(/\.\d+$/, '').slice(0, 16);
  showReport('tablestats', {
    title: vscode.l10n.t('Table statistics — {0}', l), subtitle: vscode.l10n.t('{0} table(s), {1} rows, {2}.', rows.length, rows.reduce((a, r) => a + n(r, 'NUMBER_ROWS'), 0).toLocaleString(), formatBytes(rows.reduce((a, r) => a + n(r, 'DATA_SIZE'), 0))),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.tableStatistics', args: [l] }],
    tables: [{ title: vscode.l10n.t('Tables (biggest first)'), filter: true, columns: ['Table', 'Rows', 'Deleted rows', 'Data size', 'Members', 'Last changed', 'Last used', 'Days used'],
      rows: rows.map(r => [s(r, 'SYSTEM_TABLE_NAME'), n(r, 'NUMBER_ROWS').toLocaleString(), n(r, 'NUMBER_DELETED_ROWS').toLocaleString(), formatBytes(n(r, 'DATA_SIZE')),
        n(r, 'NUMBER_PARTITIONS') || '', date(r, 'LAST_CHANGE_TIMESTAMP'), date(r, 'LAST_USED_TIMESTAMP'), n(r, 'DAYS_USED_COUNT') || '']),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Edit data'), command: 'vanthrex.editData', args: [{ library: l, name: s(r, 'SYSTEM_TABLE_NAME') }] })),
      rowClass: rows.map(r => (n(r, 'NUMBER_DELETED_ROWS') > n(r, 'NUMBER_ROWS') * 0.2 && n(r, 'NUMBER_DELETED_ROWS') > 1000 ? 'different' : undefined)) }],
    note: vscode.l10n.t('Highlighted tables have more than 20 % deleted rows — the Storage & cleanup advisor can reorganize them.'),
  }, ALLOWED);
}

let pendingTest: { t: Obj; cols: (Column & { pk: boolean })[]; rows: (string | null)[][] } | undefined;

async function generateTestData(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  const t = await askTable(vscode.l10n.t('Generate test data'), o);
  if (!t) { return; }
  const cols = await columnsOf(conn, t);
  const count = Number(await vscode.window.showInputBox({ title: vscode.l10n.t('How many rows?'), value: '100', validateInput: v => (/^\d+$/.test(v) && Number(v) > 0 && Number(v) <= 100000 ? undefined : '1–100000') }));
  if (!count) { return; }
  const pk = cols.filter(c => c.pk);
  let start = 0;
  if (pk.length === 1 && /DEC|NUM|INT/i.test(pk[0].type)) {
    const m = await reportProgress('testdata', vscode.l10n.t('Reading from the IBM i…'), () => conn.rows<Row>(`SELECT COALESCE(MAX("${pk[0].name}"), 0) AS M FROM ${t.library}/${t.name}`, 1).catch(() => []));
    start = Number(m[0]?.M ?? 0) || 0;
  }
  const rows = testRows(cols, count, start, Date.now() % 100000);
  pendingTest = { t, cols, rows };
  const names = cols.map(c => c.name);
  showReport('testdata', {
    title: vscode.l10n.t('Test data for {0}/{1}', t.library, t.name), subtitle: `${count} row(s) ready${pk.length ? `, keys ${pk.map(p => p.name).join(', ')} continue after ${start}` : ''}. Nothing is written until you click Insert.`,
    actions: [{ label: vscode.l10n.t('Insert {0} row(s)…', count), command: 'vanthrex.generateTestData.run' }],
    tables: [{ title: vscode.l10n.t('Preview (first 20 rows)'), columns: names, rows: rows.slice(0, 20).map(r => r.map(v => v ?? '∅')) }],
    note: vscode.l10n.t('Values follow each column\'s type and length; numeric keys continue after the highest existing key. Identity columns are left to Db2. Use this only on test systems.'),
  }, ALLOWED);
}

async function insertTestData(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const p = pendingTest;
  if (!p) { throw new Error(vscode.l10n.t('Generate test data first.')); }
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Insert {0} test row(s) into {1}/{2}?', p.rows.length, p.t.library, p.t.name), { modal: true }, vscode.l10n.t('Insert'));
  if (ok !== vscode.l10n.t('Insert')) { return; }
  const { sql, errors } = insertStatements(p.t.library, p.t.name, p.cols, p.cols.map((_, i) => i), p.rows);
  await progress(vscode.l10n.t('Inserting…'), async () => { for (const st of sql) { await conn.sql(st, 1); } });
  pendingTest = undefined;
  const c = await vscode.window.showInformationMessage(vscode.l10n.t('Inserted {0} row(s).{1}', p.rows.length - errors.length, errors.length ? ` ${errors.length} skipped.` : ''), vscode.l10n.t('Open the Data'));
  if (c) { await vscode.commands.executeCommand('vanthrex.editData', p.t); }
}

async function run(conn: IbmiConnection, cmd: string, warn = ''): Promise<boolean> {
  const p = await vscode.window.showWarningMessage(cmd, { modal: true, detail: warn || undefined }, vscode.l10n.t('Run'));
  if (p !== vscode.l10n.t('Run')) { return false; }
  const r = await progress(cmd.split(' ')[0], () => conn.runCL(cmd));
  if (!r.ok) { throw new Error(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); }
  vscode.window.showInformationMessage(vscode.l10n.t('Done.'));
  return true;
}

async function rowLocks(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  if (!o?.library || !o.name) { throw new Error(vscode.l10n.t('Right-click a file in the Libraries view.')); }
  const rows = await reportProgress('rowLocks', vscode.l10n.t('Reading row locks…'), () => conn.rows<Row>(
    `SELECT SYSTEM_TABLE_MEMBER AS MBR, RELATIVE_RECORD_NUMBER AS RRN, LOCK_STATE AS STATE, LOCK_STATUS AS STATUS, COALESCE(LOCK_TYPE, '') AS TYPE, JOB_NAME AS JOB ` +
    `FROM QSYS2.RECORD_LOCK_INFO WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(o.library)} AND SYSTEM_TABLE_NAME = ${sqlString(o.name)} ORDER BY RELATIVE_RECORD_NUMBER`, 2000));
  const sample = await Promise.all(rows.slice(0, 15).map(r => conn.rows<Row>(`SELECT * FROM ${o.library}/${o.name} X WHERE RRN(X) = ${Number(r.RRN)}`, 1).catch(() => [])));
  const preview = (i: number) => { const x = sample[i]?.[0]; return x ? Object.values(x).slice(0, 4).map(v => String(v ?? '').trim()).join(' · ') : ''; };
  showReport('rowLocks', {
    title: vscode.l10n.t('Row locks — {0}/{1}', o.library, o.name), subtitle: rows.length ? `${rows.length} row lock(s), held or waited for by ${new Set(rows.map(r => s(r, 'JOB'))).size} job(s). Click one for its job.` : 'No row is locked right now.',
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.rowLocks', args: [o] }],
    tables: [{ title: vscode.l10n.t('Locked rows'), filter: true, columns: ['RRN', 'Member', 'Lock', 'Status', 'Job', 'Row (first columns)'],
      rows: rows.map((r, i) => [s(r, 'RRN'), s(r, 'MBR'), s(r, 'STATE'), s(r, 'STATUS'), s(r, 'JOB'), preview(i)]),
      rowActions: rows.map(r => ({ label: vscode.l10n.t('Job options…'), command: 'vanthrex.rowLocks.row', args: [s(r, 'JOB')] })),
      rowClass: rows.map(r => (/WAIT/i.test(s(r, 'STATUS')) ? 'bad' : undefined)), empty: vscode.l10n.t('None.') }],
    note: vscode.l10n.t('A job waiting for a row (status WAITING) is blocked by the job that holds it. Ending a job releases its locks but rolls back its uncommitted work.'),
  }, ALLOWED);
}

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
  const [ra, rb, ia, ib] = await reportProgress('structCompare', vscode.l10n.t('Reading both definitions…'), () => Promise.all([a.rows<Row>(q(lib!), 2000), b.rows<Row>(q(libB), 2000), a.rows<Row>(iq(lib!), 500).catch(() => []), b.rows<Row>(iq(libB), 500).catch(() => [])]));
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

const pick = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { if (r && r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') { return String(r[k]).trim(); } } return ''; };

async function q(conn: IbmiConnection, sql: string, n = 500): Promise<Row[]> {
  try { return await conn.rows<Row>(sql, n); } catch (e) { log(`${sql.slice(0, 80)}…: ${errorMessage(e)}`); return []; }
}

async function tableDependents(manager: ConnectionManager, o?: { library?: string; name?: string }): Promise<void> {
  const conn = manager.require();
  if (!o?.library || !o.name) { throw new Error(vscode.l10n.t('Right-click a file in the Libraries view.')); }
  const lib = assertSystemName(o.library, 'library'); const f = assertSystemName(o.name, 'file');
  if (conn.sqlKeepsJob) { await conn.sql(`CALL QSYS2.QCMDEXC('DSPDBR FILE(${lib}/${f}) OUTPUT(*OUTFILE) OUTFILE(QTEMP/VTXDBR)')`, 1).catch(e => log(errorMessage(e))); }
  const [dbr, idx, views, cst, trg] = await reportProgress('dependents', vscode.l10n.t('Finding what depends on {0}/{1}…', lib, f), () => Promise.all([
    conn.sqlKeepsJob ? q(conn, `SELECT WHRELI AS L, WHREFI AS F, COALESCE(WHTYPE, '') AS T FROM QTEMP/VTXDBR WHERE WHREFI <> ' '`, 2000) : Promise.resolve([] as Row[]),
    q(conn, `SELECT SYSTEM_INDEX_SCHEMA AS L, SYSTEM_INDEX_NAME AS N, COALESCE(IS_UNIQUE, '') AS U FROM QSYS2.SYSINDEXES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f)}`, 500),
    q(conn, `SELECT DISTINCT SYSTEM_VIEW_SCHEMA AS L, SYSTEM_VIEW_NAME AS N FROM QSYS2.SYSVIEWDEP WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f)}`, 500),
    q(conn, `SELECT CONSTRAINT_NAME AS N, CONSTRAINT_TYPE AS T FROM QSYS2.SYSCST WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f)}`, 200),
    q(conn, `SELECT * FROM QSYS2.SYSTRIGGERS WHERE EVENT_OBJECT_SCHEMA = (SELECT TABLE_SCHEMA FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f)}) ` +
      `AND EVENT_OBJECT_TABLE = (SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(f)})`, 200),
  ]));
  const fks = await q(conn, `SELECT C.SYSTEM_TABLE_SCHEMA AS L, C.SYSTEM_TABLE_NAME AS N, C.CONSTRAINT_NAME AS CN FROM QSYS2.SYSREFCST R JOIN QSYS2.SYSCST C ON C.CONSTRAINT_SCHEMA = R.CONSTRAINT_SCHEMA AND C.CONSTRAINT_NAME = R.CONSTRAINT_NAME ` +
    `JOIN QSYS2.SYSCST P ON P.CONSTRAINT_SCHEMA = R.UNIQUE_CONSTRAINT_SCHEMA AND P.CONSTRAINT_NAME = R.UNIQUE_CONSTRAINT_NAME WHERE P.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND P.SYSTEM_TABLE_NAME = ${sqlString(f)}`, 200);
  const rows: (string | number)[][] = [
    ...dbr.map(r => [`${s(r, 'L')}/${s(r, 'F')}`, s(r, 'T') === 'D' ? 'logical file / index (data)' : s(r, 'T') === 'V' ? 'view' : s(r, 'T') === 'O' ? 'access path sharing' : `dependent (${s(r, 'T')})`]),
    ...idx.filter(r => !dbr.some(d => s(d, 'F') === s(r, 'N'))).map(r => [`${s(r, 'L')}/${s(r, 'N')}`, s(r, 'U') === 'U' || s(r, 'U') === 'Y' ? 'unique index' : 'index']),
    ...views.filter(r => !dbr.some(d => s(d, 'F') === s(r, 'N'))).map(r => [`${s(r, 'L')}/${s(r, 'N')}`, 'SQL view']),
    ...fks.map(r => [`${s(r, 'L')}/${s(r, 'N')}`, `foreign key ${s(r, 'CN')} refers to this table`]),
    ...trg.map(r => [`${pick(r, 'TRIGGER_SCHEMA')}.${pick(r, 'TRIGGER_NAME')}`, `trigger ${pick(r, 'ACTION_TIMING')} ${pick(r, 'EVENT_MANIPULATION')}${pick(r, 'TRIGGER_PROGRAM_NAME') ? ` → ${pick(r, 'TRIGGER_PROGRAM_LIBRARY')}/${pick(r, 'TRIGGER_PROGRAM_NAME')}` : ''}`]),
    ...cst.map(r => [s(r, 'N'), `constraint ${s(r, 'T')}`]),
  ];
  showReport('dependents', {
    title: vscode.l10n.t('What depends on {0}/{1}', lib, f), subtitle: vscode.l10n.t('{0} dependent object(s): logical files, indexes, views, constraints, foreign keys and triggers. Programs using the file are in "Where used".', rows.length),
    actions: [{ label: vscode.l10n.t('Programs using it (where used)'), command: 'vanthrex.whereUsed', args: [{ library: lib, name: f, type: '*FILE' }] }, { label: vscode.l10n.t('Who is locking rows?'), command: 'vanthrex.rowLocks', args: [{ library: lib, name: f }] }],
    tables: [{ title: vscode.l10n.t('Dependents'), filter: true, columns: ['Object', 'Dependency'], rows, empty: vscode.l10n.t('Nothing depends on it.') }],
    note: vscode.l10n.t('Check this list before changing or dropping a table: logical files and views must be recreated when the record format changes, and triggers and foreign keys may stop a change.'),
  }, ALLOWED);
}

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

// ================================================================ registration

export function registerDatabaseTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const obj = (x: unknown): Obj | undefined => { const o = x as Partial<Obj> | undefined; return o?.library && o?.name ? { library: o.library, name: o.name, type: o.type } : undefined; };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.tableStatistics', guard((x?: unknown) => tableStatistics(manager, typeof x === 'string' ? x : (x as { library?: string } | undefined)?.library))),
    vscode.commands.registerCommand('vanthrex.generateTestData', guard((x?: unknown) => generateTestData(manager, obj(x)))),
    vscode.commands.registerCommand('vanthrex.generateTestData.run', guard(() => insertTestData(manager))),
    vscode.commands.registerCommand('vanthrex.rowLocks', guard((x?: unknown) => rowLocks(manager, obj(x)))),
    vscode.commands.registerCommand('vanthrex.rowLocks.row', guard(async (job: string) => {
      const p = await vscode.window.showQuickPick([{ label: vscode.l10n.t('$(output) Job log'), v: 'log' }, { label: vscode.l10n.t('$(debug-stop) End the job (controlled)…'), v: 'end' }], { title: job });
      if (p?.v === 'log') { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); }
      if (p?.v === 'end') { await run(manager.require(), `ENDJOB JOB(${job}) OPTION(*CNTRLD) DELAY(30)`, vscode.l10n.t('Its uncommitted changes are rolled back and its locks released.')); }
    })),
    vscode.commands.registerCommand('vanthrex.compareStructure', guard((o?: { library?: string; name?: string }) => compareStructureCmd(manager, o))),
    vscode.commands.registerCommand('vanthrex.compareStructure.script', guard(async () => {
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: lastAlter });
      await vscode.window.showTextDocument(doc, { preview: false });
    })),
    vscode.commands.registerCommand('vanthrex.tableDependents', guard((o?: { library?: string; name?: string }) => tableDependents(manager, o))),
    vscode.commands.registerCommand('vanthrex.generateRpgForTable', guard((o?: { library: string; name: string }) => rpgFromTable(manager, o?.library ? o : undefined))),
  );
}
