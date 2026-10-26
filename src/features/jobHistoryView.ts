// Batch job history: how long a job ran each night over the last weeks (from the history log), which runs failed or
// took twice as long as usual; and where a message (CPF4131, "level check"…) appeared in the job logs of recent jobs.
import * as vscode from 'vscode';
import { formatSeconds, jobHistorySql, jobRuns, messageInJobSql, recentJobsSql, runStats } from '../core/jobHistory';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { reportProgress, showReport } from './reportPanel';

type Row = Record<string, unknown>;
const ALLOWED = new Set(['vanthrex.jobRunHistory', 'vanthrex.jobLog', 'vanthrex.findMessageInJobLogs', 'vanthrex.explainMessage']);

async function history(manager: ConnectionManager, state: vscode.Memento, a?: unknown): Promise<void> {
  const conn = manager.require();
  const given = typeof a === 'string' ? a : (a as { job?: string } | undefined)?.job?.split('/').pop();
  const name = (given ?? await vscode.window.showInputBox({ title: vscode.l10n.t('Run history of which job name?'), value: state.get<string>('vanthrex.jobHistory.last', ''), prompt: vscode.l10n.t('A job name such as NIGHTLY (ORD* for every job starting with ORD)') }))?.trim().toUpperCase();
  if (!name) { return; }
  await state.update('vanthrex.jobHistory.last', name);
  const days = vscode.workspace.getConfiguration('vanthrex').get<number>('jobHistoryDays', 30);
  const rows = await reportProgress('jobHistory', vscode.l10n.t('Reading the history log…'), () => conn.rows<{ ID: string; TS: string; JOB: string; TEXT: string }>(jobHistorySql(name, days), 20000));
  const runs = jobRuns(rows); const st = runStats(runs);
  const slow = new Set(st.slow.map(r => r.job));
  showReport('jobHistory', {
    title: vscode.l10n.t('Run history of {0}', name),
    subtitle: vscode.l10n.t('{0} run(s) in the last {1} days, {2} failed. Runs more than twice the usual time are marked.', st.runs, days, st.failed),
    facts: [[vscode.l10n.t('Average'), formatSeconds(st.avg)], [vscode.l10n.t('Longest'), formatSeconds(st.max)], [vscode.l10n.t('Last run'), formatSeconds(st.last)], [vscode.l10n.t('Unusually slow'), st.slow.length]],
    actions: [{ label: vscode.l10n.t('Another job…'), command: 'vanthrex.jobRunHistory' }],
    tables: [{ title: vscode.l10n.t('Runs (newest first)'), filter: true, columns: ['Job', 'Started', 'Ended', 'Elapsed', 'CPU (s)', 'End code', ''],
      rows: [...runs].reverse().map(r => [r.job, r.started ?? '', r.ended ?? vscode.l10n.t('(still running or not logged)'), formatSeconds(r.seconds), r.cpuSeconds ?? null, r.endCode ?? null, '█'.repeat(st.max && r.seconds ? Math.max(1, Math.round((r.seconds / st.max) * 20)) : 0)]),
      rowActions: [...runs].reverse().map(r => ({ label: vscode.l10n.t('Job log'), command: 'vanthrex.jobLog', args: [{ job: r.job }] })),
      rowClass: [...runs].reverse().map(r => (r.ok === false ? 'bad' : slow.has(r.job) ? 'different' : undefined)),
      empty: vscode.l10n.t('No run of {0} in the history log (QHST) in the last {1} days.', name, days) }],
    note: vscode.l10n.t('Read from the history log (QHST): CPF1124 job started, CPF1164 job ended. The history log keeps what the system value QHSTLOGSIZ and the cleanup allow.'),
  }, ALLOWED);
}

async function findMessage(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const id = (await vscode.window.showInputBox({ title: vscode.l10n.t('Find a message in job logs'), value: state.get<string>('vanthrex.findMessage.last', ''), prompt: vscode.l10n.t('A message ID (CPF4131, CPF41*) or words of the message text') }))?.trim();
  if (!id) { return; }
  const who = (await vscode.window.showInputBox({ title: vscode.l10n.t('Whose jobs?'), value: conn.user, prompt: vscode.l10n.t('User profile, or *ALL (slower)') }))?.trim();
  if (!who) { return; }
  const jobName = (await vscode.window.showInputBox({ title: vscode.l10n.t('Job name (optional)'), prompt: vscode.l10n.t('Only jobs with this name; ORD* for every name starting with ORD; empty for all') }))?.trim();
  if (jobName === undefined) { return; }
  await state.update('vanthrex.findMessage.last', id);
  const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Searching job logs…'), cancellable: true }, async (progress, token) => {
    const jobs = (await conn.rows<Row>(recentJobsSql({ user: who === '*ALL' ? undefined : who, jobName: jobName || undefined, days: 7, max: 60 }), 60)).map(r => String(r.J).trim());
    const out: Row[] = [];
    for (const [i, j] of jobs.entries()) {
      if (token.isCancellationRequested) { break; }
      progress.report({ message: `${i + 1}/${jobs.length} ${j}`, increment: 100 / jobs.length });
      out.push(...await conn.rows<Row>(messageInJobSql(j, id), 20).catch(() => [] as Row[]));
    }
    return { jobs: jobs.length, rows: out };
  });
  showReport('findMessage', {
    title: vscode.l10n.t('"{0}" in job logs', id),
    subtitle: vscode.l10n.t('{0} message(s) in {1} of the {2} most recent job(s) of {3} (last 7 days). Click one for the whole job log.', found.rows.length, new Set(found.rows.map(r => r.J)).size, found.jobs, who),
    actions: [{ label: vscode.l10n.t('Search again…'), command: 'vanthrex.findMessageInJobLogs' }],
    tables: [{ title: vscode.l10n.t('Messages'), filter: true, columns: ['Job', 'Time', 'Message', 'Sev', 'Program', 'Text'],
      rows: found.rows.map(r => [String(r.J), String(r.TS), String(r.ID), Number(r.SEV), String(r.PGM ?? '').trim(), String(r.TEXT)]),
      rowActions: found.rows.map(r => ({ label: vscode.l10n.t('Job log'), command: 'vanthrex.jobLog', args: [{ job: String(r.J) }] })),
      rowClass: found.rows.map(r => (Number(r.SEV) >= 30 ? 'bad' : undefined)), empty: vscode.l10n.t('Not found in these jobs.') }],
  }, ALLOWED);
}

export function registerJobHistory(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.jobRunHistory', wrap((a?: unknown) => history(manager, context.globalState, a))),
    vscode.commands.registerCommand('vanthrex.findMessageInJobLogs', wrap(() => findMessage(manager, context.globalState))),
  );
}
