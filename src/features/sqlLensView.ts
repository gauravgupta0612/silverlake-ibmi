// Run / Explain / RPG links above every statement of an SQL file, so a script of many statements can be worked
// through one statement at a time without selecting text.
import * as vscode from 'vscode';
import { splitSqlStatements } from '../core/util';
import { ConnectionManager } from '../core/manager';

export function registerSqlLens(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const changed = new vscode.EventEmitter<void>();
  const at = async (uri: vscode.Uri, offset: number, command: string) => {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
    const pos = doc.positionAt(offset);
    editor.selection = new vscode.Selection(pos, pos);
    await vscode.commands.executeCommand(command);
  };
  context.subscriptions.push(
    changed,
    manager.onDidChange(() => changed.fire()),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vanthrex.editor.sqlCodeLens')) { changed.fire(); } }),
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, {
      onDidChangeCodeLenses: changed.event,
      provideCodeLenses: doc => {
        if (!manager.connection || !vscode.workspace.getConfiguration('vanthrex.editor').get<boolean>('sqlCodeLens', true)) { return []; }
        const text = doc.getText();
        const stmts = splitSqlStatements(text).filter(s => s.sql.replace(/--[^\n]*/g, '').trim());
        if (stmts.length > 500) { return []; }
        const lenses: vscode.CodeLens[] = [];
        for (const s of stmts) {
          // The lens goes on the first line with code (not on leading comments).
          const lead = text.substring(s.start, s.end).match(/^(\s*(--[^\n]*\n)?)*/)?.[0].length ?? 0;
          const offset = s.start + lead;
          const range = new vscode.Range(doc.positionAt(offset), doc.positionAt(offset));
          lenses.push(new vscode.CodeLens(range, { title: vscode.l10n.t('▶ Run'), command: 'vanthrex.sqlLens', arguments: [doc.uri, offset, 'vanthrex.runSql'] }));
          if (/^\s*(--[^\n]*\n\s*)*(SELECT|WITH|VALUES)\b/i.test(text.substring(s.start, s.end))) {
            lenses.push(new vscode.CodeLens(range, { title: vscode.l10n.t('Explain'), command: 'vanthrex.sqlLens', arguments: [doc.uri, offset, 'vanthrex.explainSql'] }));
            lenses.push(new vscode.CodeLens(range, { title: vscode.l10n.t('RPG code'), command: 'vanthrex.sqlLens', arguments: [doc.uri, offset, 'vanthrex.queryToRpg'] }));
          }
        }
        return lenses;
      },
    }),
    vscode.commands.registerCommand('vanthrex.sqlLens', (uri: vscode.Uri, offset: number, command: string) =>
      ['vanthrex.runSql', 'vanthrex.explainSql', 'vanthrex.queryToRpg'].includes(command) ? at(uri, offset, command) : undefined),
  );
}
