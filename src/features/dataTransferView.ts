import * as vscode from 'vscode';
import * as zlib from 'zlib';
import * as path from 'path';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { assertSystemName, isDestructiveSql, sqlString, statementAtOffset, toCsv } from '../core/util';
import { insertScript } from '../core/testData';
import { Column, buildXlsx, insertStatements, mapColumns, parseCsv, readSheet, toJson, unzip } from '../core/dataTransfer';
import { showReport } from './reportPanel';

type Obj = { library: string; name: string; file?: vscode.Uri };
type Row = Record<string, unknown>;
const progress = <T>(title: string, fn: () => Promise<T>) =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

const ALLOWED = new Set(['vanthrex.importData.run', 'vanthrex.importData', 'vanthrex.exportData', 'vanthrex.editData']);

async function askTable(title: string, o?: Obj): Promise<Obj | undefined> {
  if (o?.library && o?.name) { return { library: o.library.toUpperCase(), name: o.name.toUpperCase() }; }
  const v = await vscode.window.showInputBox({ title, prompt: 'LIBRARY/TABLE', placeHolder: 'APPLIB/CUSTMAST', ignoreFocusOut: true });
  if (!v?.includes('/')) { return undefined; }
  const [l, t] = v.trim().toUpperCase().split('/');
  return { library: assertSystemName(l, 'library'), name: assertSystemName(t, 'table') };
}

async function columnsOf(conn: IbmiConnection, t: Obj): Promise<Column[]> {
  const rows = await conn.rows<Row>(
    `SELECT COLUMN_NAME AS N, DATA_TYPE AS T, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS S, IS_NULLABLE AS NL FROM QSYS2.SYSCOLUMNS ` +
    `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(t.library)} AND SYSTEM_TABLE_NAME = ${sqlString(t.name)} ORDER BY ORDINAL_POSITION`, 2000);
  if (!rows.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', t.library, t.name)); }
  return rows.map(r => ({ name: String(r.N).trim(), type: String(r.T).trim(), length: Number(r.L), scale: Number(r.S), nullable: String(r.NL).trim() === 'Y' }));
}

type Format = 'csv' | 'xlsx' | 'json' | 'sql';

async function pickFormat(withSql = false): Promise<Format | undefined> {
  const f = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(table) Excel (.xlsx)'), f: 'xlsx' as const }, { label: vscode.l10n.t('$(file) CSV (.csv)'), f: 'csv' as const }, { label: vscode.l10n.t('$(json) JSON (.json)'), f: 'json' as const },
    ...(withSql ? [{ label: vscode.l10n.t('$(database) SQL INSERT statements (.sql)'), f: 'sql' as const }] : []),
  ], { title: vscode.l10n.t('Export format') });
  return f?.f;
}

async function writeExport(base: string, format: Format, columns: string[], rows: Row[], numeric: boolean[], table?: { library: string; name: string; cols: Column[] }): Promise<void> {
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${base}.${format}`), filters: { [format.toUpperCase()]: [format] }, saveLabel: 'Export' });
  if (!target) { return; }
  const data = format === 'sql' && table ? Buffer.from(insertScript(table.library, table.name, table.cols.filter(c => columns.includes(c.name)), rows), 'utf8')
    : format === 'xlsx' ? buildXlsx(base, columns, rows, numeric)
    : Buffer.from(format === 'csv' ? '﻿' + toCsv(columns, rows) : toJson(columns, rows), 'utf8');
  await vscode.workspace.fs.writeFile(target, data);
  const open = await vscode.window.showInformationMessage(vscode.l10n.t('Exported {0} row(s) to {1}', rows.length, path.basename(target.fsPath)), vscode.l10n.t('Open'), vscode.l10n.t('Show in Folder'));
  if (open === vscode.l10n.t('Open')) { await vscode.env.openExternal(target); }
  if (open === vscode.l10n.t('Show in Folder')) { await vscode.commands.executeCommand('revealFileInOS', target); }
}

async function exportData(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  const t = await askTable('Export table data', o);
  if (!t) { return; }
  const format = await pickFormat(true);
  if (!format) { return; }
  const where = await vscode.window.showInputBox({ title: vscode.l10n.t('Filter rows (optional)'), prompt: vscode.l10n.t('SQL WHERE condition, e.g. STATUS = \'A\' — leave empty for all rows'), ignoreFocusOut: true });
  if (where === undefined) { return; }
  if (/;|\b(DELETE|UPDATE|INSERT|DROP|ALTER|CALL)\b/i.test(where)) { throw new Error(vscode.l10n.t('Only a WHERE condition is allowed here.')); }
  const max = vscode.workspace.getConfiguration('vanthrex.export').get<number>('maxRows', 100000);
  const cols = await columnsOf(conn, t);
  const rows = await progress(vscode.l10n.t('Reading {0}/{1}…', t.library, t.name), () => conn.rows<Row>(
    `SELECT * FROM ${t.library}/${t.name}${where.trim() ? ` WHERE ${where.trim()}` : ''} FETCH FIRST ${max} ROWS ONLY`, max));
  if (rows.length >= max) { vscode.window.showWarningMessage(vscode.l10n.t('Only the first {0} rows were exported (setting vanthrex.export.maxRows).', max)); }
  const names = rows.length ? Object.keys(rows[0]) : cols.map(c => c.name);
  const numeric = names.map(nm => /DECIMAL|NUMERIC|INT|FLOAT|DOUBLE|REAL|DECFLOAT/i.test(cols.find(c => c.name === nm)?.type ?? ''));
  await writeExport(`${t.library}_${t.name}`, format, names, rows.map(r => Object.fromEntries(names.map(nm => [nm, typeof r[nm] === 'string' ? (r[nm] as string).trimEnd() : r[nm]]))), numeric, { library: t.library, name: t.name, cols });
}

async function exportQuery(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const ed = vscode.window.activeTextEditor;
  let sql = ed ? (ed.selection.isEmpty ? statementAtOffset(ed.document.getText(), ed.document.offsetAt(ed.selection.active)) : ed.document.getText(ed.selection)) : undefined;
  if (!sql?.trim()) { sql = await vscode.window.showInputBox({ title: vscode.l10n.t('Export query result'), prompt: 'SELECT statement', ignoreFocusOut: true }); }
  if (!sql?.trim()) { return; }
  if (isDestructiveSql(sql) || !/^\s*(SELECT|WITH|VALUES)\b/i.test(sql)) { throw new Error(vscode.l10n.t('Only SELECT, WITH or VALUES statements can be exported.')); }
  const format = await pickFormat();
  if (!format) { return; }
  const max = vscode.workspace.getConfiguration('vanthrex.export').get<number>('maxRows', 100000);
  const rows = await progress(vscode.l10n.t('Running the query…'), () => conn.rows<Row>(sql!.trim().replace(/;\s*$/, ''), max));
  const names = rows.length ? Object.keys(rows[0]) : [];
  const numeric = names.map(nm => rows.slice(0, 50).every(r => r[nm] === null || typeof r[nm] === 'number'));
  await writeExport('query', format, names, rows, numeric);
}

// ---------------------------------------------------------------- import

interface Pending { table: Obj; columns: Column[]; mapping: number[]; rows: string[][]; replace: boolean; file: string }
let pending: Pending | undefined;

export async function readFileRows(uri: vscode.Uri): Promise<string[][]> {
  const data = await vscode.workspace.fs.readFile(uri);
  if (/\.xlsx$/i.test(uri.fsPath)) {
    const files = unzip(data, d => new Uint8Array(zlib.inflateRawSync(d)));
    const dec = new TextDecoder();
    const rels = dec.decode(files.get('xl/_rels/workbook.xml.rels') ?? new Uint8Array());
    const wb = dec.decode(files.get('xl/workbook.xml') ?? new Uint8Array());
    const firstId = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb)?.[1];
    const target = firstId ? new RegExp(`Id="${firstId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]+)"[^>]*Id="${firstId}"`).exec(rels)?.[1] : undefined;
    const sheetPath = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target}`) : 'xl/worksheets/sheet1.xml';
    const sheet = files.get(sheetPath);
    if (!sheet) { throw new Error(vscode.l10n.t('The workbook has no worksheet.')); }
    return readSheet(dec.decode(sheet), dec.decode(files.get('xl/sharedStrings.xml') ?? new Uint8Array()));
  }
  return parseCsv(new TextDecoder('utf-8').decode(data));
}

async function importData(manager: ConnectionManager, o?: Obj): Promise<void> {
  const conn = manager.require();
  const t = await askTable('Import into table', o);
  if (!t) { return; }
  const src = o?.file ? [o.file] : await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'CSV or Excel': ['csv', 'txt', 'xlsx'] }, openLabel: 'Import' });
  if (!src?.[0]) { return; }
  const all = await readFileRows(src[0]);
  if (all.length < 2) { throw new Error(vscode.l10n.t('The file needs a header row and at least one data row.')); }
  const [headers, ...rows] = all;
  const columns = await columnsOf(conn, t);
  const mapping = mapColumns(headers, columns);
  const mode = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(add) Add the rows to the table'), replace: false },
    { label: vscode.l10n.t('$(warning) Replace: delete all rows first, then add'), replace: true },
  ], { title: vscode.l10n.t('Import {0} row(s) into {1}/{2}', rows.length, t.library, t.name) });
  if (!mode) { return; }
  pending = { table: t, columns, mapping, rows, replace: mode.replace, file: path.basename(src[0].fsPath) };
  const { errors } = insertStatements(t.library, t.name, columns, mapping, rows);
  const unmatched = headers.filter((h, i) => !mapping.includes(i));
  showReport('import', {
    title: vscode.l10n.t('Import {0} → {1}/{2}', pending.file, t.library, t.name),
    subtitle: `${rows.length} row(s), ${mapping.filter(m => m >= 0).length} of ${columns.length} column(s) matched by name.${errors.length ? ` ⚠ ${errors.length} row(s) have values that don't fit and will be skipped.` : ''}${mode.replace ? ' ⚠ All existing rows will be deleted first.' : ''}`,
    facts: [['File columns not imported', unmatched.join(', ') || 'none'], ['Table columns left empty / default', columns.filter((_, i) => mapping[i] < 0).map(c => c.name).join(', ') || 'none']],
    actions: [{ label: vscode.l10n.t('Import {0} row(s)…', rows.length - errors.length), command: 'vanthrex.importData.run' }, { label: vscode.l10n.t('Pick another file'), command: 'vanthrex.importData', args: [t] }],
    tables: [
      { title: vscode.l10n.t('Column mapping'), columns: ['Table column', 'Type', 'From file column'],
        rows: columns.map((c, i) => [c.name, `${c.type}(${c.length}${c.scale ? `,${c.scale}` : ''})`, mapping[i] >= 0 ? headers[mapping[i]] : '—']),
        rowClass: columns.map((_, i) => (mapping[i] >= 0 ? undefined : 'dim')) },
      { title: vscode.l10n.t('Preview (first 20 rows)'), columns: headers, rows: rows.slice(0, 20) },
      ...(errors.length ? [{ title: vscode.l10n.t('Rows that will be skipped'), columns: ['Problem'], rows: errors.slice(0, 200).map(e => [e]) }] : []),
    ],
    note: vscode.l10n.t('Columns are matched by name, ignoring case and punctuation — rename the file\'s headers to match the table if needed. Rows are inserted without commitment control (WITH NC) in batches of 100.'),
  }, ALLOWED);
}

async function runImport(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const p = pending;
  if (!p) { throw new Error(vscode.l10n.t('Pick a file to import first.')); }
  const { sql, errors } = insertStatements(p.table.library, p.table.name, p.columns, p.mapping, p.rows);
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Import {0} row(s) into {1}/{2}?', p.rows.length - errors.length, p.table.library, p.table.name),
    { modal: true, detail: p.replace ? vscode.l10n.t('All existing rows are deleted first. This can\'t be undone.') : vscode.l10n.t('The rows are added to the table.') }, vscode.l10n.t('Import'));
  if (ok !== vscode.l10n.t('Import')) { return; }
  let done = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Importing into {0}/{1}…', p.table.library, p.table.name), cancellable: true }, async (prog, token) => {
    if (p.replace) { await conn.sql(`DELETE FROM ${p.table.library}/${p.table.name} WITH NC`, 1); }
    for (const [i, stmt] of sql.entries()) {
      if (token.isCancellationRequested) { break; }
      await conn.sql(stmt, 1);
      done = Math.min(p.rows.length - errors.length, (i + 1) * 100);
      prog.report({ message: `${done} / ${p.rows.length - errors.length}`, increment: 100 / sql.length });
    }
  });
  pending = undefined;
  const c = await vscode.window.showInformationMessage(vscode.l10n.t('Imported {0} row(s) into {1}/{2}.', done, p.table.library, p.table.name), vscode.l10n.t('Open the Data'));
  if (c) { await vscode.commands.executeCommand('vanthrex.editData', p.table); }
}

export function registerDataTransfer(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const obj = (x: unknown) => { const o = x as Partial<Obj> | undefined; return o?.library && o?.name ? { library: o.library, name: o.name, file: o.file instanceof vscode.Uri ? o.file : undefined } : undefined; };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.exportData', guard((x?: unknown) => exportData(manager, obj(x)))),
    vscode.commands.registerCommand('vanthrex.exportQuery', guard(() => exportQuery(manager))),
    vscode.commands.registerCommand('vanthrex.importData', guard((x?: unknown) => importData(manager, obj(x)))),
    vscode.commands.registerCommand('vanthrex.importData.run', guard(() => runImport(manager))),
  );
}
