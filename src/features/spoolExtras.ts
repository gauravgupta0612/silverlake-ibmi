import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { clString, isDestructiveSql, sqlString, statementAtOffset } from '../core/util';
import { emailCommand, parseRecipients, textToPdf } from '../core/diagrams';
import { buildXlsx } from '../core/dataTransfer';

interface Spool { name: string; job: string; number: number; pages?: number }
const progress = <T>(title: string, fn: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, fn);

async function spoolPdf(conn: IbmiConnection, n: Spool): Promise<Uint8Array> {
  if (vscode.workspace.getConfiguration('vanthrex.spool').get<string>('pdfMode', 'local') === 'server') {
    const tmp = conn.tempPath('.pdf');
    try {
      const r = await conn.runCL(`CPYSPLF FILE(${n.name}) TOFILE(*TOSTMF) JOB(${n.job}) SPLNBR(${n.number}) TOSTMF(${clString(tmp)}) WSCST(*PDF) STMFOPT(*REPLACE)`);
      if (r.ok) { return new Uint8Array(await conn.readStreamFile(tmp)); }
      log(`CPYSPLF *PDF failed, converting the text instead: ${(r.stderr || r.stdout).trim()}`);
    } finally { await conn.removePath(tmp, false).catch(() => undefined); }
  }
  const [rows, info] = await Promise.all([
    conn.rows<{ D: string }>(`SELECT SPOOLED_DATA AS D FROM TABLE(SYSTOOLS.SPOOLED_FILE_DATA(JOB_NAME => ${sqlString(n.job)}, SPOOLED_FILE_NAME => ${sqlString(n.name)}, ` +
      `SPOOLED_FILE_NUMBER => ${Math.floor(n.number)})) ORDER BY ORDINAL_POSITION`, 500000),
    conn.rows<{ P: number }>(`SELECT TOTAL_PAGES AS P FROM QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC WHERE JOB_NAME = ${sqlString(n.job)} AND SPOOLED_FILE_NAME = ${sqlString(n.name)} AND FILE_NUMBER = ${Math.floor(n.number)}`, 1).catch(() => []),
  ]);
  const lines = rows.map(r => String(r.D ?? '').trimEnd());
  const pages = Number(info[0]?.P ?? n.pages ?? 0);
  const lpp = pages > 0 ? Math.ceil(lines.length / pages) : 66;
  return textToPdf(lines.join('\n'), { linesPerPage: lpp, title: `${n.name} ${n.job}` });
}

async function lastRecipients(state: vscode.Memento): Promise<string[] | undefined> {
  const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Send by e-mail'), prompt: vscode.l10n.t('Recipients, separated by commas'),
    value: state.get<string>('vanthrex.email.last', ''), ignoreFocusOut: true,
    validateInput: x => { try { parseRecipients(x); return undefined; } catch (e) { return errorMessage(e); } } });
  if (!v) { return undefined; }
  await state.update('vanthrex.email.last', v);
  return parseRecipients(v);
}

async function sendWithAttachment(conn: IbmiConnection, to: string[], subject: string, note: string, data: Uint8Array, fileName: string, type: '*PDF' | '*OCTET' | '*PLAIN'): Promise<void> {
  const tmp = conn.tempPath(`_${fileName.replace(/[^\w.-]/g, '_')}`);
  const cmd = emailCommand(to, subject, note, { path: tmp, type });
  const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Send "{0}" to {1}?', subject, to.join(', ')), { modal: true,
    detail: vscode.l10n.t('The IBM i sends it with SNDSMTPEMM, so its SMTP server must be set up (CHGSMTPA / ADDUSRSMTP for your profile).') }, vscode.l10n.t('Send'));
  if (ok !== vscode.l10n.t('Send')) { return; }
  await progress(vscode.l10n.t('Sending…'), async () => {
    await conn.writeStreamFile(tmp, data);
    try {
      const r = await conn.runCL(cmd);
      if (!r.ok) { throw new Error(vscode.l10n.t('SNDSMTPEMM failed: {0}', (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' '))); }
    } finally { await conn.removePath(tmp, false).catch(() => undefined); }
  });
  vscode.window.showInformationMessage(vscode.l10n.t('Sent to {0}.', to.join(', ')));
}

export function registerSpoolExtras(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.spoolPdf', guard(async (n: Spool) => {
      const conn = manager.require();
      if (!n?.name) { throw new Error(vscode.l10n.t('Right-click a spooled file in the Spooled Files view.')); }
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${n.name}_${n.number}.pdf`), filters: { PDF: ['pdf'] }, saveLabel: vscode.l10n.t('Save PDF') });
      if (!target) { return; }
      const pdf = await progress(vscode.l10n.t('Making the PDF…'), () => spoolPdf(conn, n));
      await vscode.workspace.fs.writeFile(target, pdf);
      const c = await vscode.window.showInformationMessage(vscode.l10n.t('Saved {0}', path.basename(target.fsPath)), vscode.l10n.t('Open'));
      if (c) { await vscode.env.openExternal(target); }
    })),
    vscode.commands.registerCommand('vanthrex.spoolEmail', guard(async (n: Spool) => {
      const conn = manager.require();
      if (!n?.name) { throw new Error(vscode.l10n.t('Right-click a spooled file in the Spooled Files view.')); }
      const to = await lastRecipients(context.globalState);
      if (!to) { return; }
      const subject = await vscode.window.showInputBox({ title: vscode.l10n.t('Subject'), value: `${n.name} (${n.job})`, ignoreFocusOut: true });
      if (subject === undefined) { return; }
      const pdf = await progress(vscode.l10n.t('Making the PDF…'), () => spoolPdf(conn, n));
      await sendWithAttachment(conn, to, subject, vscode.l10n.t('Spooled file {0} of job {1} is attached.', n.name, n.job), pdf, `${n.name}.pdf`, '*PDF');
    })),
    vscode.commands.registerCommand('vanthrex.emailQuery', guard(async () => {
      const conn = manager.require();
      const ed = vscode.window.activeTextEditor;
      let sql = ed ? (ed.selection.isEmpty ? statementAtOffset(ed.document.getText(), ed.document.offsetAt(ed.selection.active)) : ed.document.getText(ed.selection)) : undefined;
      if (!sql?.trim()) { sql = await vscode.window.showInputBox({ title: vscode.l10n.t('E-mail a query result'), prompt: 'SELECT …', ignoreFocusOut: true }); }
      if (!sql?.trim()) { return; }
      if (isDestructiveSql(sql) || !/^\s*(SELECT|WITH|VALUES)\b/i.test(sql)) { throw new Error(vscode.l10n.t('Only SELECT, WITH or VALUES statements can be sent.')); }
      const to = await lastRecipients(context.globalState);
      if (!to) { return; }
      const subject = await vscode.window.showInputBox({ title: vscode.l10n.t('Subject'), value: vscode.l10n.t('Query result'), ignoreFocusOut: true });
      if (subject === undefined) { return; }
      const rows = await progress(vscode.l10n.t('Running the query…'), () => conn.rows<Record<string, unknown>>(sql!.trim().replace(/;\s*$/, ''), 100000));
      const cols = rows.length ? Object.keys(rows[0]) : [];
      const xlsx = buildXlsx('Result', cols, rows, cols.map(c => rows.slice(0, 50).every(r => r[c] === null || typeof r[c] === 'number')));
      await sendWithAttachment(conn, to, subject, vscode.l10n.t('{0} row(s) attached as an Excel file.\n\n{1}', rows.length, sql.trim()), xlsx, 'result.xlsx', '*OCTET');
    })),
  );
}
