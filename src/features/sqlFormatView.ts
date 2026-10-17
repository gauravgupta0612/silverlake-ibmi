// Format SQL documents and selections.
import * as vscode from 'vscode';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { formatSql } from '../core/sqlFormat';

function sqlFormatter(): vscode.DocumentFormattingEditProvider & vscode.DocumentRangeFormattingEditProvider {
  const edit = (doc: vscode.TextDocument, range: vscode.Range) => [vscode.TextEdit.replace(range, formatSql(doc.getText(range)).replace(/\n$/, range.end.line === doc.lineCount - 1 ? '\n' : ''))];
  return {
    provideDocumentFormattingEdits: doc => edit(doc, new vscode.Range(0, 0, doc.lineCount, 0)),
    provideDocumentRangeFormattingEdits: (doc, range) => edit(doc, range),
  };
}

// ================================================================ registration

export function registerSqlFormat(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const fmt = sqlFormatter();
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'sql' }, fmt),
    vscode.languages.registerDocumentRangeFormattingEditProvider({ language: 'sql' }, fmt),
    vscode.commands.registerCommand('vanthrex.formatSql', guard(async () => { await vscode.commands.executeCommand('editor.action.formatDocument'); })),
  );
}
