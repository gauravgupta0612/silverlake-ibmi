// Table tools: find a value in every column of a table (which row, which column), and copy rows as an SQL INSERT
// script (to load a test system or keep a fix).
import * as vscode from 'vscode';
import { insertScript, searchSql } from '../core/tableSearch';
import { ColumnInfo } from '../core/sqlLiteral';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { assertSystemName, sqlString } from '../core/util';
import { reportProgress, showReport } from './reportPanel';

type Row = Record<string, unknown>;
const ALLOWED = new Set(['vanthrex.findInTable', 'vanthrex.editData', 'vanthrex.exportInserts']);
const show = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : (v as string | number));

async function pickTable(o?: { library?: string; name?: string }, title?: string): Promise<{ library: string; name: string } | undefined> {
  let lib = o?.library; let name = o?.name;
  if (!lib || !name) {
    const v = await vscode.window.showInputBox({ title, prompt: 'LIBRARY/TABLE', ignoreFocusOut: true, validateInput: x => (/^[^/\s]+\/[^/\s]+$/.test(x.trim()) ? undefined : 'LIBRARY/TABLE') });
    if (!v) { return undefined; }
    [lib, name] = v.trim().toUpperCase().split('/');
  }
  return { library: assertSystemName(lib, 'library'), name: assertSystemName(name, 'table') };
}

async function columnsOf(manager: ConnectionManager, lib: string, name: string): Promise<ColumnInfo[]> {
  const rows = await manager.require().cachedRows<Row>(`SELECT COLUMN_NAME AS N, DATA_TYPE AS T, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS S, IS_NULLABLE AS NL ` +
    `FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(name)} ORDER BY ORDINAL_POSITION`, 5000, 60_000);
  if (!rows.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', lib, name)); }
  return rows.map(r => ({ name: String(r.N).trim(), type: String(r.T).trim(), length: Number(r.L) || 0, scale: Number(r.S) || 0, nullable: String(r.NL).trim() === 'Y' }));
}

async function findInTable(manager: ConnectionManager, state: vscode.Memento, o?: { library?: string; name?: string; value?: string }): Promise<void> {
  const t = await pickTable(o, vscode.l10n.t('Find a value in a table'));
  if (!t) { return; }
  const value = o?.value ?? await vscode.window.showInputBox({ title: vscode.l10n.t('Find in {0}/{1}', t.library, t.name), value: state.get<string>('vanthrex.findInTable.last', ''),
    prompt: vscode.l10n.t('Text is found anywhere in text columns (any case); a number in number columns; a date by its start (2026-10).'), ignoreFocusOut: true });
  if (!value?.trim()) { return; }
  await state.update('vanthrex.findInTable.last', value);
  const conn = manager.require();
  const { plan, rows } = await reportProgress('findInTable', vscode.l10n.t('Searching {0}/{1}…', t.library, t.name), async () => {
    const cols = await columnsOf(manager, t.library, t.name);
    const plan = searchSql(`${t.library}/${t.name}`, cols, value, { max: 500 });
    return { plan, rows: await conn.rows<Row>(plan.sql, 500) };
  });
  const dataCols = rows.length ? Object.keys(rows[0]).filter(k => k !== 'VX_RRN' && k !== 'VX_MATCH') : [];
  showReport('findInTable', {
    title: vscode.l10n.t('"{0}" in {1}/{2}', value, t.library, t.name),
    subtitle: vscode.l10n.t('{0} row(s) found{1}. Searched {2} column(s).', rows.length, rows.length >= 500 ? ' ' + vscode.l10n.t('(first 500)') : '', plan.searched.length),
    facts: [[vscode.l10n.t('Searched'), plan.searched.join(', ').slice(0, 400)], [vscode.l10n.t('Not searched'), plan.skipped.join(', ').slice(0, 400) || '—']],
    actions: [{ label: vscode.l10n.t('Search again…'), command: 'vanthrex.findInTable', args: [t] }, { label: vscode.l10n.t('Edit table data…'), command: 'vanthrex.editData', args: [t] }],
    tables: [{ title: vscode.l10n.t('Rows'), filter: true, columns: ['RRN', vscode.l10n.t('Found in'), ...dataCols],
      rows: rows.map(r => [show(r.VX_RRN), show(r.VX_MATCH), ...dataCols.map(c => show(r[c]))]), empty: vscode.l10n.t('The value is in no row.') }],
  }, ALLOWED);
}

async function exportInserts(manager: ConnectionManager, o?: { library?: string; name?: string }): Promise<void> {
  const t = await pickTable(o, vscode.l10n.t('Copy rows as SQL INSERT statements'));
  if (!t) { return; }
  const where = await vscode.window.showInputBox({ title: vscode.l10n.t('Which rows of {0}/{1}?', t.library, t.name), prompt: vscode.l10n.t('A WHERE condition, or empty for all rows'), placeHolder: "CUSNO = 1234 AND STATUS <> 'X'", ignoreFocusOut: true });
  if (where === undefined) { return; }
  if (/;|--|\/\*/.test(where)) { throw new Error(vscode.l10n.t('The condition may not contain ;, -- or /*.')); }
  const max = vscode.workspace.getConfiguration('vanthrex.codeGen').get<number>('insertRows', 1000);
  const conn = manager.require();
  const { cols, rows } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading {0}/{1}…', t.library, t.name) }, async () => {
    const cols = await columnsOf(manager, t.library, t.name);
    const rows = await conn.rows<Row>(`SELECT * FROM ${t.library}/${t.name}${where.trim() ? ` WHERE ${where.trim()}` : ''} FETCH FIRST ${max} ROWS ONLY`, max);
    return { cols, rows };
  });
  const script = insertScript(`${t.library}/${t.name}`, cols, rows, {
    header: vscode.l10n.t('{0} row(s) of {1}/{2} on {3}{4}. Generated by Vanthrex for IBM i — check before running.', rows.length, t.library, t.name, conn.profile.name, where.trim() ? ` WHERE ${where.trim()}` : ''),
  });
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: script });
  await vscode.window.showTextDocument(doc, { preview: false });
  if (rows.length >= max) { vscode.window.showInformationMessage(vscode.l10n.t('Only the first {0} rows were copied (setting vanthrex.codeGen.insertRows).', max)); }
}

export function registerTableTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.findInTable', wrap((o?: { library?: string; name?: string; value?: string }) => findInTable(manager, context.globalState, o))),
    vscode.commands.registerCommand('vanthrex.exportInserts', wrap((o?: { library?: string; name?: string }) => exportInserts(manager, o))),
  );
}
