// Source helpers: an RPG program skeleton for a display file, characters that break a compile (with a fix), TODO /
// FIXME notes of the open sources, and a spooled report turned into a CSV file for a spreadsheet.
import * as vscode from 'vscode';
import { parseDspf } from '../core/dspf';
import { rpgForDspf } from '../core/dspfSkeleton';
import { badCharacters, fixCharacters, notesIn, reportToTable, toCsvText } from '../core/textTools';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { spoolUri } from './spool';

const SOURCE_LANGS = new Set(['rpgle', 'cl', 'dds', 'sql', 'cobol']);

async function rpgFromDspf(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || (doc.languageId !== 'dds' && !/\.dspf$/i.test(doc.uri.path))) { vscode.window.showInformationMessage(vscode.l10n.t('Open a display file (DSPF) source first.')); return; }
  const text = doc.getText();
  const d = parseDspf(text);
  if (!d.records.length) { vscode.window.showWarningMessage(vscode.l10n.t('No record formats found in this source.')); return; }
  const name = (doc.uri.path.split('/').pop() ?? 'SCREEN').replace(/\.[^.]*$/, '');
  const out = await vscode.workspace.openTextDocument({ language: 'rpgle', content: rpgForDspf(name, d, text) });
  await vscode.window.showTextDocument(out, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

export function registerSourceHelpers(context: vscode.ExtensionContext, _manager: ConnectionManager): void {
  const diags = vscode.languages.createDiagnosticCollection('Vanthrex characters');
  const check = (doc: vscode.TextDocument, quiet = true) => {
    if (!SOURCE_LANGS.has(doc.languageId)) { return 0; }
    const bad = badCharacters(doc.getText(), { tabs: doc.languageId !== 'sql' });
    diags.set(doc.uri, bad.slice(0, 500).map(b => {
      const d = new vscode.Diagnostic(new vscode.Range(b.line, b.column, b.line, b.column + 1), vscode.l10n.t('{0}: may break the compile or the CCSID conversion', b.what), vscode.DiagnosticSeverity.Warning);
      d.source = 'Vanthrex'; d.code = 'bad-character';
      return d;
    }));
    if (!quiet) { vscode.window.setStatusBarMessage(bad.length ? vscode.l10n.t('{0} problem character(s) found.', bad.length) : vscode.l10n.t('No problem characters.'), 5000); }
    return bad.length;
  };
  const wrap = (fn: (...a: never[]) => Promise<void> | void) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    diags,
    vscode.workspace.onDidOpenTextDocument(d => { if (vscode.workspace.getConfiguration('vanthrex.editor').get<boolean>('checkCharacters', true)) { check(d); } }),
    vscode.workspace.onDidSaveTextDocument(d => { if (vscode.workspace.getConfiguration('vanthrex.editor').get<boolean>('checkCharacters', true)) { check(d); } }),
    vscode.workspace.onDidCloseTextDocument(d => diags.delete(d.uri)),
    vscode.languages.registerCodeActionsProvider([...SOURCE_LANGS].map(language => ({ language })), {
      provideCodeActions: (doc, _r, ctx) => {
        if (!ctx.diagnostics.some(d => d.code === 'bad-character')) { return []; }
        const a = new vscode.CodeAction(vscode.l10n.t('Fix every problem character in this source'), vscode.CodeActionKind.QuickFix);
        a.command = { command: 'vanthrex.fixCharacters', title: '', arguments: [doc.uri] };
        a.diagnostics = ctx.diagnostics.filter(d => d.code === 'bad-character');
        return [a];
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand('vanthrex.rpgFromDspf', wrap(rpgFromDspf)),
    vscode.commands.registerCommand('vanthrex.checkCharacters', wrap(() => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) { if (!SOURCE_LANGS.has(doc.languageId)) { vscode.window.showInformationMessage(vscode.l10n.t('Open an RPG, CL, DDS, SQL or COBOL source first.')); return; } check(doc, false); }
    })),
    vscode.commands.registerCommand('vanthrex.fixCharacters', wrap(async (uri?: vscode.Uri) => {
      const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
      if (!doc) { return; }
      const fixed = fixCharacters(doc.getText(), vscode.workspace.getConfiguration('vanthrex.editor').get<number>('rpgIndent', 2));
      if (fixed === doc.getText()) { return; }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), fixed);
      await vscode.workspace.applyEdit(edit);
      check(doc, false);
    })),
    vscode.commands.registerCommand('vanthrex.sourceNotes', wrap(async () => {
      const docs = vscode.workspace.textDocuments.filter(d => SOURCE_LANGS.has(d.languageId));
      const items = docs.flatMap(d => notesIn(d.getText()).map(n => ({ label: `$(${n.tag === 'TODO' ? 'checklist' : n.tag === 'FIXME' || n.tag === 'BUG' ? 'bug' : 'note'}) ${n.tag}: ${n.text || '…'}`,
        description: `${d.uri.path.split('/').pop()}:${n.line + 1}`, uri: d.uri, line: n.line })));
      if (!items.length) { vscode.window.showInformationMessage(vscode.l10n.t('No TODO, FIXME, HACK, XXX or BUG notes in the open sources.')); return; }
      const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('{0} note(s) in the open sources', items.length), matchOnDescription: true });
      if (pick) { await vscode.window.showTextDocument(pick.uri, { selection: new vscode.Range(pick.line, 0, pick.line, 0) }); }
    })),
    vscode.commands.registerCommand('vanthrex.reportToCsv', wrap(async (n?: { job: string; name: string; number: number }) => {
      const doc = n?.job ? await vscode.workspace.openTextDocument(spoolUri(n)) : vscode.window.activeTextEditor?.document;
      if (!doc) { vscode.window.showInformationMessage(vscode.l10n.t('Right-click a spooled file, or open a report first.')); return; }
      const t = reportToTable(doc.getText());
      if (!t.rows.length) { vscode.window.showWarningMessage(vscode.l10n.t('No table of columns was found in this report.')); return; }
      const sep = vscode.workspace.getConfiguration('vanthrex').get<string>('csvSeparator', ',') || ',';
      const csv = toCsvText(t.header, t.rows, sep);
      const base = (n?.name ?? doc.uri.path.split('/').pop() ?? 'report').replace(/\.[^.]*$/, '').toLowerCase();
      const to = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${base}.csv`), filters: { CSV: ['csv'] }, title: vscode.l10n.t('{0} row(s), {1} column(s) — save as', t.rows.length, t.header.length) });
      if (!to) { return; }
      await vscode.workspace.fs.writeFile(to, new TextEncoder().encode('﻿' + csv));
      const open = vscode.l10n.t('Open');
      void vscode.window.showInformationMessage(vscode.l10n.t('Saved {0} row(s) to {1}.', t.rows.length, to.fsPath), open).then(c => { if (c) { void vscode.env.openExternal(to); } });
    })),
  );
  vscode.workspace.textDocuments.forEach(d => check(d));
}
