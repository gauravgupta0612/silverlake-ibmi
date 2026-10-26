// SQL Error Log (SELF): see which programs get which SQL errors in production, without debugging; turn logging on or
// off for the whole system or only for this session.
import * as vscode from 'vscode';
import { describeSelfCodes, errorLogSql, groupErrors, selfCodesValue, sqlMessageId, systemWideSql, toLoggedError } from '../core/sqlErrorLog';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { reportProgress, showReport } from './reportPanel';

const ALLOWED = new Set(['vanthrex.sqlErrorLog', 'vanthrex.sqlErrorLog.settings', 'vanthrex.explainMessage', 'vanthrex.objectInfo']);
type Row = Record<string, unknown>;
let hours = 24;

async function show(manager: ConnectionManager, filter?: { hours?: number }): Promise<void> {
  const conn = manager.require();
  if (filter?.hours !== undefined) { hours = filter.hours; }
  const [setting, rows] = await reportProgress('sqlErrorLog', vscode.l10n.t('Reading the SQL error log…'), async () => {
    const v = await conn.rows<Row>('VALUES SYSIBMADM.SELFCODES', 1).catch(() => [] as Row[]);
    const list = await conn.rows<Row>(errorLogSql({ hours }, 2000), 2000);
    return [v.length ? String(Object.values(v[0])[0] ?? '').trim() : undefined, list] as const;
  });
  const errors = rows.map(toLoggedError);
  const groups = groupErrors(errors);
  showReport('sqlErrorLog', {
    title: vscode.l10n.t('SQL error log — {0}', conn.profile.name),
    subtitle: vscode.l10n.t('{0} logged error(s) in the last {1} hour(s), {2} different. Click a row for the meaning of the error.', errors.length, hours, groups.length),
    facts: [[vscode.l10n.t('Logging (new sessions)'), setting === undefined ? vscode.l10n.t('unknown (needs IBM i 7.4 TR7 / 7.5 TR1 or later)') : describeSelfCodes(setting)]],
    actions: [
      { label: vscode.l10n.t('Refresh'), command: 'vanthrex.sqlErrorLog' },
      { label: vscode.l10n.t('Last hour'), command: 'vanthrex.sqlErrorLog', args: [{ hours: 1 }] },
      { label: vscode.l10n.t('Last 7 days'), command: 'vanthrex.sqlErrorLog', args: [{ hours: 24 * 7 }] },
      { label: vscode.l10n.t('Turn logging on or off…'), command: 'vanthrex.sqlErrorLog.settings' },
    ],
    tables: [
      { title: vscode.l10n.t('Most frequent'), filter: true, columns: ['Count', 'SQLCODE', 'Message', 'Program', 'Jobs', 'Last', 'Statement'],
        rows: groups.slice(0, 300).map(g => [g.count, g.sqlcode, g.messageId, g.program, g.jobs, g.last, g.statement.slice(0, 300)]),
        rowActions: groups.slice(0, 300).map(g => ({ label: vscode.l10n.t('Explain {0}', g.messageId), command: 'vanthrex.explainMessage', args: [g.messageId] })),
        rowClass: groups.slice(0, 300).map(g => (g.sqlcode < 0 ? 'bad' : undefined)),
        empty: setting && setting !== '*NONE' ? vscode.l10n.t('No SQL errors were logged in this period.') : vscode.l10n.t('Nothing logged: SQL error logging is off. Use "Turn logging on or off…".') },
      { title: vscode.l10n.t('All logged errors (newest first)'), filter: true, columns: ['Logged', 'SQLCODE', 'SQLSTATE', 'Job', 'Program', 'Module', 'Statement'],
        rows: errors.slice(0, 1000).map(e => [e.logged, e.sqlcode, e.sqlstate, e.job, e.program, e.module, e.statement.slice(0, 300)]),
        rowActions: errors.slice(0, 1000).map(e => ({ label: vscode.l10n.t('Explain {0}', sqlMessageId(e.sqlcode)), command: 'vanthrex.explainMessage', args: [sqlMessageId(e.sqlcode)] })) },
    ],
    note: vscode.l10n.t('The SQL Error Logging Facility (SELF) records the failing statement, the program and the job each time a logged SQLCODE happens, so problems in batch and production jobs are found without a debugger. Logging every error costs a little performance; turn it on while you investigate.'),
  }, ALLOWED);
}

async function settings(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const items: (vscode.QuickPickItem & { value?: string; scope?: 'system' | 'session' })[] = [
    { label: vscode.l10n.t('$(check) Log all SQL errors on the whole system'), detail: '*ERR — ' + vscode.l10n.t('every new SQL session (needs *SECADM or authority to SYSIBMADM)'), value: '*ERR', scope: 'system' },
    { label: vscode.l10n.t('$(check-all) Log errors and warnings on the whole system'), detail: '*ALL', value: '*ALL', scope: 'system' },
    { label: vscode.l10n.t('$(list-selection) Log only some SQL codes on the whole system…'), detail: vscode.l10n.t('for example -204, -803, -911'), scope: 'system' },
    { label: vscode.l10n.t('$(circle-slash) Turn logging off on the whole system'), detail: '*NONE', value: '*NONE', scope: 'system' },
    { label: vscode.l10n.t('$(person) Log errors only in my Vanthrex SQL session'), detail: vscode.l10n.t('nothing changes for other jobs'), value: '*ERR', scope: 'session' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('SQL error logging on {0}', conn.profile.name) });
  if (!pick?.scope) { return; }
  let value = pick.value;
  if (!value) {
    value = await vscode.window.showInputBox({ title: vscode.l10n.t('SQL codes to log'), placeHolder: '-204, -803, -911', validateInput: v => { try { selfCodesValue(v); return undefined; } catch (e) { return errorMessage(e); } } });
    if (!value) { return; }
  }
  if (pick.scope === 'session') {
    await conn.sql(`SET SYSIBMADM.SELFCODES = '${selfCodesValue(value)}'`, 1);
    vscode.window.showInformationMessage(vscode.l10n.t('SQL error logging is on for this Vanthrex session.'));
  } else {
    await conn.sql(systemWideSql(value), 1);
    vscode.window.showInformationMessage(vscode.l10n.t('SQL error logging is now "{0}" for new SQL sessions on {1}. Jobs already running keep their setting until they reconnect.', selfCodesValue(value), conn.profile.name));
  }
  await show(manager);
}

export function registerSqlErrorLog(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.sqlErrorLog', wrap((f?: { hours?: number }) => show(manager, f))),
    vscode.commands.registerCommand('vanthrex.sqlErrorLog.settings', wrap(() => settings(manager))),
  );
}
