import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, log, logError } from '../core/log';
import { parseMemberPath, sqlString } from '../core/util';
import { generateDocs, rpgMetrics } from '../core/codeTools';
import { MEMBER_SCHEME, memberUri } from './fileSystems';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const ALLOWED = new Set(['vanthrex.codeMetrics', 'vanthrex.generateDocs', 'vanthrex.openMemberSource', 'vanthrex.codeMetrics.open']);
const SOURCE_TYPES = /^(RPGLE|SQLRPGLE|RPG|SQLRPG|RPGLEINC|CLLE|CLP|CL)$/i;

interface MemberRef { library: string; file: string; member: string; type: string; text?: string }

function memberOfEditor(): { ref?: MemberRef; text: string; name: string } | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return undefined; }
  const doc = ed.document;
  if (doc.uri.scheme === MEMBER_SCHEME) {
    const p = parseMemberPath(doc.uri.path);
    return { ref: { library: p.library, file: p.file, member: p.member, type: p.extension.toUpperCase() }, text: doc.getText(), name: p.member };
  }
  return { text: doc.getText(), name: doc.fileName.split(/[\\/]/).pop()?.replace(/\.[^.]*$/, '') ?? 'SOURCE' };
}

async function metricsForFile(manager: ConnectionManager, lib: string, file: string): Promise<void> {
  const conn = manager.require();
  const members = await conn.rows<Row>(
    `SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T, COALESCE(PARTITION_TEXT, '') AS TXT FROM QSYS2.SYSPARTITIONSTAT ` +
    `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(file)} ORDER BY SYSTEM_TABLE_MEMBER`, 5000);
  const rpg = members.filter(m => SOURCE_TYPES.test(s(m, 'T')));
  const limit = 300;
  const results: { m: Row; metrics: ReturnType<typeof rpgMetrics> }[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Measuring {0}/{1}…', lib, file), cancellable: true }, async (p, token) => {
    for (const [i, m] of rpg.slice(0, limit).entries()) {
      if (token.isCancellationRequested) { break; }
      p.report({ message: `${i + 1}/${Math.min(limit, rpg.length)} ${s(m, 'M')}`, increment: 100 / Math.min(limit, rpg.length) });
      try { results.push({ m, metrics: rpgMetrics(await conn.readMember(lib, file, s(m, 'M'))) }); } catch (e) { log(`Metrics ${s(m, 'M')}: ${errorMessage(e)}`); }
    }
  });
  const tot = results.reduce((a, r) => ({ code: a.code + r.metrics.code, free: a.free + r.metrics.free, fixed: a.fixed + r.metrics.fixed, procs: a.procs + r.metrics.procedures }), { code: 0, free: 0, fixed: 0, procs: 0 });
  const grades = ['A', 'B', 'C', 'D'].map(g => `${g}: ${results.filter(r => r.metrics.grade === g).length}`).join(' · ');
  showReport('metrics', {
    title: vscode.l10n.t('Code metrics — {0}/{1}', lib, file),
    subtitle: `${results.length} RPG/CL member(s)${rpg.length > limit ? ` (first ${limit} of ${rpg.length})` : ''}, ${tot.code.toLocaleString()} lines of code, ${Math.round(100 * tot.free / Math.max(1, tot.free + tot.fixed))} % free form. Grades — ${grades}. Click a member to open it.`,
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.codeMetrics', args: [{ library: lib, file }] }],
    tables: [{ title: vscode.l10n.t('Members (worst grade first)'), filter: true,
      columns: ['Member', 'Type', 'Grade', 'Code lines', 'Free %', 'Procedures', 'Subroutines', 'Complexity', 'Nesting', 'Indicators', 'GOTO', 'SQL', 'Advice'],
      rows: results.sort((a, b) => b.metrics.grade.localeCompare(a.metrics.grade) || b.metrics.complexity - a.metrics.complexity).map(({ m, metrics: x }) => [
        s(m, 'M'), s(m, 'T'), x.grade, x.code, Math.round(100 * x.free / Math.max(1, x.free + x.fixed)), x.procedures, x.subroutines, x.complexity, x.maxNesting, x.indicators, x.gotos, x.sqlStatements, x.notes.join(' ')]),
      rowActions: results.map(({ m }) => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.codeMetrics.open', args: [lib, file, s(m, 'M'), s(m, 'T')] })),
      rowClass: results.map(({ metrics: x }) => (x.grade === 'D' ? 'bad' : x.grade === 'C' ? 'different' : undefined)) }],
    note: vscode.l10n.t('Complexity counts decisions (IF, WHEN, DOW, DOU, FOR, ON-ERROR, AND/OR) + 1. Grades: A no findings, B one, C two or three, D more. These are hints for modernization, not rules.'),
  }, ALLOWED);
}

function metricsForEditor(): void {
  const cur = memberOfEditor();
  if (!cur) { throw new Error(vscode.l10n.t('Open an RPG or CL source first, or right-click a source file.')); }
  const x = rpgMetrics(cur.text);
  showReport('metricsOne', {
    title: vscode.l10n.t('Code metrics — {0}', cur.name), subtitle: vscode.l10n.t('Grade {0}. {1}', x.grade, x.notes.join(' ') || 'No findings.'),
    facts: [['Lines (code / comments / blank)', `${x.lines} (${x.code} / ${x.comments} / ${x.blank})`], ['Free / fixed lines', `${x.free} / ${x.fixed}`],
      ['Procedures / subroutines', `${x.procedures} / ${x.subroutines}`], ['/COPY members', x.copies], ['Embedded SQL statements', x.sqlStatements],
      ['Complexity / max nesting', `${x.complexity} / ${x.maxNesting}`], ['Numbered indicators / GOTO', `${x.indicators} / ${x.gotos}`]],
    actions: [{ label: vscode.l10n.t('Generate documentation'), command: 'vanthrex.generateDocs' }],
    tables: [{ title: vscode.l10n.t('Procedures'), columns: ['Procedure', 'Lines', 'Complexity', 'Nesting'], rows: x.procs.map(p => [p.name, p.lines, p.complexity, p.maxNesting]),
      rowClass: x.procs.map(p => (p.complexity > 20 ? 'bad' : p.complexity > 10 ? 'different' : undefined)), empty: vscode.l10n.t('No procedures.') }],
  }, ALLOWED);
}

async function generateDocsCmd(manager: ConnectionManager): Promise<void> {
  const cur = memberOfEditor();
  if (!cur) { throw new Error(vscode.l10n.t('Open an RPG or CL source first.')); }
  let memberText = '';
  if (cur.ref && manager.connection) {
    const r = await manager.connection.rows<Row>(`SELECT COALESCE(PARTITION_TEXT, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(cur.ref.library)} ` +
      `AND SYSTEM_TABLE_NAME = ${sqlString(cur.ref.file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(cur.ref.member)}`, 1).catch(() => []);
    memberText = s(r[0], 'T');
  }
  const md = generateDocs({ library: cur.ref?.library ?? '', file: cur.ref?.file ?? '', member: cur.name, type: cur.ref?.type ?? 'source', text: cur.text, memberText });
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  await vscode.commands.executeCommand('markdown.showPreviewToSide').then(undefined, () => undefined);
}

export function registerCodeTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.codeMetrics', guard((n?: { library?: string; file?: string }) =>
      n?.library && n?.file ? metricsForFile(manager, n.library, n.file) : metricsForEditor())),
    vscode.commands.registerCommand('vanthrex.codeMetrics.open', guard((lib: string, file: string, m: string, t: string) =>
      vscode.window.showTextDocument(memberUri(lib, file, m, t || 'rpgle')))),
    vscode.commands.registerCommand('vanthrex.generateDocs', guard(() => generateDocsCmd(manager))),
  );
}
