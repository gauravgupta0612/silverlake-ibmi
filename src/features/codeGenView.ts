// Code generators: RPG data structures from a JSON sample (DATA-INTO / DATA-GEN) and an embedded-SQL cursor loop for
// the query at the cursor (column types read from the system, so the RPG types match).
import * as vscode from 'vscode';
import { ffdToColumns, jsonToRpg, queryToRpg } from '../core/codeGen';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { TableColumn } from '../core/rpgFromTable';
import { sqlString, statementAtOffset } from '../core/util';

type Row = Record<string, unknown>;

async function jsonCommand(uri?: vscode.Uri): Promise<void> {
  let text = '';
  const ed = vscode.window.activeTextEditor;
  if (uri instanceof vscode.Uri && uri.scheme !== 'untitled') { text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); }
  else if (ed && !ed.selection.isEmpty) { text = ed.document.getText(ed.selection); }
  else if (ed && ed.document.languageId === 'json') { text = ed.document.getText(); }
  if (!text.trim()) {
    const clip = (await vscode.env.clipboard.readText()).trim();
    if (/^[[{]/.test(clip)) { text = clip; }
  }
  if (!text.trim()) {
    const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, title: vscode.l10n.t('JSON sample to turn into RPG') });
    if (!pick?.length) { vscode.window.showInformationMessage(vscode.l10n.t('Select a JSON sample in the editor, copy one to the clipboard, or choose a .json file.')); return; }
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(pick[0]));
  }
  const root = await vscode.window.showInputBox({ title: vscode.l10n.t('Name of the data structure'), value: 'doc', validateInput: v => (/^[A-Za-z$#@_][\w$#@]*$/.test(v) ? undefined : vscode.l10n.t('Letters, digits and _ only.')) });
  if (!root) { return; }
  const doc = await vscode.workspace.openTextDocument({ language: 'rpgle', content: '**FREE\n' + jsonToRpg(text, { root, dim: vscode.workspace.getConfiguration('vanthrex.codeGen').get<number>('arraySize', 100) }) });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** Column types of a query: through a temporary table in QTEMP described by DSPFFD (works for any query). */
async function queryColumns(manager: ConnectionManager, sql: string): Promise<TableColumn[]> {
  const conn = manager.require();
  if (!conn.sqlKeepsJob) { throw new Error(vscode.l10n.t('Reading the column types of a query needs the Mapepire SQL engine (it uses QTEMP).')); }
  await conn.sql(`DECLARE GLOBAL TEMPORARY TABLE SESSION.VX_QUERY AS (${sql.replace(/;\s*$/, '')}) WITH NO DATA WITH REPLACE`, 1);
  await conn.sql(`CALL QSYS2.QCMDEXC(${sqlString('DSPFFD FILE(QTEMP/VX_QUERY) OUTPUT(*OUTFILE) OUTFILE(QTEMP/VX_QFFD)')})`, 1);
  const rows = await conn.rows<Row>('SELECT WHFLDE, WHFLDT, WHFLDB, WHFLDD, WHFLDP, WHFTXT, WHVARL, WHALIS, WHNULL FROM QTEMP.VX_QFFD', 2000);
  return ffdToColumns(rows);
}

async function queryCommand(manager: ConnectionManager, given?: string): Promise<void> {
  let sql = typeof given === 'string' ? given : '';
  const ed = vscode.window.activeTextEditor;
  if (!sql && ed && ed.document.languageId === 'sql') {
    sql = (ed.selection.isEmpty ? statementAtOffset(ed.document.getText(), ed.document.offsetAt(ed.selection.active)) : ed.document.getText(ed.selection)) ?? '';
  }
  if (!sql.trim()) { sql = await vscode.window.showInputBox({ title: vscode.l10n.t('Query to read in RPG'), prompt: 'SELECT …', ignoreFocusOut: true }) ?? ''; }
  sql = sql.replace(/^(\s*--[^\n]*\n)+/, '').trim();
  if (!sql) { return; }
  if (!/^(SELECT|WITH|VALUES)\b/i.test(sql)) { throw new Error(vscode.l10n.t('Only a SELECT (or WITH / VALUES) query can be read with a cursor.')); }
  const cols = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading the columns of the query…') }, () => queryColumns(manager, sql));
  const doc = await vscode.workspace.openTextDocument({ language: 'rpgle', content: '**FREE\n' + queryToRpg(sql, cols, 'row', vscode.workspace.getConfiguration('vanthrex.codeGen').get<number>('arraySize', 100)) });
  await vscode.window.showTextDocument(doc, { preview: false });
}

export function registerCodeGen(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.jsonToRpg', wrap((uri?: vscode.Uri) => jsonCommand(uri))),
    vscode.commands.registerCommand('vanthrex.queryToRpg', wrap((sql?: string) => queryCommand(manager, sql))),
  );
}
