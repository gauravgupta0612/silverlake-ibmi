// Run the same SQL statement or CL command on several connected systems at once and see the answers side by side
// (rows found on only some systems first), e.g. a system value, a PTF level or an object on DEV, TEST and PROD.
import * as vscode from 'vscode';
import { mergeResults, SystemResult } from '../core/multiSystem';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { isReadOnlySql } from '../core/sqlSafety';
import { statementAtOffset } from '../core/util';
import { reportProgress, showReport } from './reportPanel';

const ALLOWED = new Set(['vanthrex.sqlOnSystems', 'vanthrex.clOnSystems']);
const show = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : (v as string | number));

async function pickSystems(manager: ConnectionManager, title: string): Promise<IbmiConnection[] | undefined> {
  const open = manager.openConnections;
  if (open.length < 2) {
    vscode.window.showInformationMessage(vscode.l10n.t('Connect to two or more systems first (each connection in the Vanthrex view): this runs the same thing on all of them.'));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(open.map(c => ({ label: c.profile.name, description: `${c.profile.host}${c.profile.protection && c.profile.protection !== 'none' ? ' · ' + vscode.l10n.t('protected') : ''}`, picked: true, c })),
    { canPickMany: true, title });
  return picked?.length ? picked.map(p => p.c) : undefined;
}

async function sqlOnSystems(manager: ConnectionManager, given?: string): Promise<void> {
  let sql = typeof given === 'string' ? given : '';
  const ed = vscode.window.activeTextEditor;
  if (!sql && ed?.document.languageId === 'sql') {
    sql = (ed.selection.isEmpty ? statementAtOffset(ed.document.getText(), ed.document.offsetAt(ed.selection.active)) : ed.document.getText(ed.selection)) ?? '';
  }
  if (!sql.trim()) { sql = await vscode.window.showInputBox({ title: vscode.l10n.t('SQL to run on several systems'), placeHolder: "SELECT * FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME LIKE 'QPWD%'", ignoreFocusOut: true }) ?? ''; }
  sql = sql.trim().replace(/;\s*$/, '');
  if (!sql) { return; }
  const systems = await pickSystems(manager, vscode.l10n.t('Run on which systems?'));
  if (!systems) { return; }
  if (!isReadOnlySql(sql)) {
    const run = vscode.l10n.t('Run on {0} systems', systems.length);
    if (await vscode.window.showWarningMessage(vscode.l10n.t('This statement can change data. Run it on every chosen system?'), { modal: true, detail: `${systems.map(c => c.profile.name).join(', ')}\n\n${sql.slice(0, 800)}` }, run) !== run) { return; }
  }
  const results = await reportProgress('sqlOnSystems', vscode.l10n.t('Running on {0} systems…', systems.length), () => Promise.all(systems.map(async (c): Promise<SystemResult> => {
    const t0 = Date.now();
    try { const r = await c.sql(sql, 2000); return { system: c.profile.name, columns: r.columns, rows: r.rows, ms: Date.now() - t0 }; }
    catch (e) { return { system: c.profile.name, columns: [], rows: [], error: errorMessage(e).split('\n')[0], ms: Date.now() - t0 }; }
  })));
  const m = mergeResults(results);
  showReport('sqlOnSystems', {
    title: vscode.l10n.t('Same SQL on {0} systems', systems.length),
    subtitle: m.columns.length ? vscode.l10n.t('{0} distinct row(s); {1} are not on every system (shown first).', m.rows.length, m.differ) : vscode.l10n.t('The statement returned no rows.'),
    facts: results.map(r => [r.system, r.error ? `✖ ${r.error}` : vscode.l10n.t('{0} row(s) in {1} ms', r.rows.length, r.ms ?? 0)] as [string, string]),
    actions: [{ label: vscode.l10n.t('Run again'), command: 'vanthrex.sqlOnSystems', args: [sql] }],
    tables: m.columns.length ? [{ title: vscode.l10n.t('Rows'), filter: true, columns: [vscode.l10n.t('On'), ...m.columns],
      rows: m.rows.map(r => [r.on.length === m.systems.length ? vscode.l10n.t('all') : r.on.join(', '), ...m.columns.map(c => show(r.values[c]))]),
      rowClass: m.rows.map(r => (r.on.length < m.systems.length ? 'different' : undefined)) }] : [],
    note: sql,
  }, ALLOWED);
}

async function clOnSystems(manager: ConnectionManager, given?: string): Promise<void> {
  const cmd = (typeof given === 'string' ? given : await vscode.window.showInputBox({ title: vscode.l10n.t('CL command to run on several systems'), placeHolder: 'CHGSYSVAL SYSVAL(QMAXSIGN) VALUE(5)', ignoreFocusOut: true }))?.trim();
  if (!cmd) { return; }
  const systems = await pickSystems(manager, vscode.l10n.t('Run {0} on which systems?', cmd.split(/\s+/)[0].toUpperCase()));
  if (!systems) { return; }
  const run = vscode.l10n.t('Run on {0} systems', systems.length);
  if (await vscode.window.showWarningMessage(vscode.l10n.t('Run this command on every chosen system?'), { modal: true, detail: `${systems.map(c => c.profile.name).join(', ')}\n\n${cmd}` }, run) !== run) { return; }
  const results = await reportProgress('clOnSystems', vscode.l10n.t('Running on {0} systems…', systems.length), () => Promise.all(systems.map(async c => {
    try { const r = await c.runCL(cmd); return { system: c.profile.name, ok: r.ok, text: `${r.stdout}\n${r.stderr}`.split('\n').map(l => l.trim()).filter(Boolean).slice(-6).join(' · ') }; }
    catch (e) { return { system: c.profile.name, ok: false, text: errorMessage(e).split('\n')[0] }; }
  })));
  showReport('clOnSystems', {
    title: vscode.l10n.t('{0} on {1} systems', cmd.split(/\s+/)[0].toUpperCase(), systems.length),
    subtitle: vscode.l10n.t('{0} succeeded, {1} failed.', results.filter(r => r.ok).length, results.filter(r => !r.ok).length),
    actions: [{ label: vscode.l10n.t('Run again'), command: 'vanthrex.clOnSystems', args: [cmd] }],
    tables: [{ title: vscode.l10n.t('Systems'), columns: ['System', 'Result', 'Messages'], rows: results.map(r => [r.system, r.ok ? '✔' : '✖', r.text]), rowClass: results.map(r => (r.ok ? undefined : 'bad')) }],
    note: cmd,
  }, ALLOWED);
}

export function registerMultiSystem(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.sqlOnSystems', wrap((sql?: string) => sqlOnSystems(manager, sql))),
    vscode.commands.registerCommand('vanthrex.clOnSystems', wrap((cmd?: string) => clOnSystems(manager, cmd))),
  );
}
