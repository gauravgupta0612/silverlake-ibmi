// Quick fixes (the light bulb) for RPG compile errors: declare a name the compiler did not find (RNF7030), in the
// procedure that uses it or globally, and remove a declaration that is never used (RNF7031).
import * as vscode from 'vscode';
import { DECLARE_TYPES, declaredNameOn, declarePlan, nameFromMessage, unusedLine } from '../core/compileFixes';
import { ConnectionManager } from '../core/manager';

const codeOf = (d: vscode.Diagnostic) => String(typeof d.code === 'object' ? d.code.value : d.code ?? '');

function nameOf(doc: vscode.TextDocument, d: vscode.Diagnostic): string | undefined {
  const fromMsg = nameFromMessage(d.message);
  if (fromMsg) { return fromMsg; }
  const declared = declaredNameOn(doc.lineAt(d.range.start.line).text);
  if (declared) { return declared; }
  const word = doc.getWordRangeAtPosition(d.range.start, /[A-Za-z$#@_][\w$#@]*/);
  return word ? doc.getText(word) : undefined;
}

async function declare(uri: vscode.Uri, name: string, line: number, local: boolean): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const type = await vscode.window.showQuickPick([...DECLARE_TYPES, vscode.l10n.t('Other…')], { title: vscode.l10n.t('Type of {0}', name) });
  if (!type) { return; }
  const t = type === vscode.l10n.t('Other…') ? await vscode.window.showInputBox({ title: vscode.l10n.t('Type of {0}', name), value: 'char(10)', prompt: 'char(n), varchar(n), packed(p:s), zoned(p:s), int(10), ind, date, timestamp, like(other)' }) : type;
  if (!t?.trim()) { return; }
  const plan = declarePlan(doc.getText(), name, t.trim(), line, local);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(plan.line, 0), plan.text + (doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'));
  await vscode.workspace.applyEdit(edit);
}

export function registerCompileFixes(context: vscode.ExtensionContext, _manager: ConnectionManager): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ language: 'rpgle' }, {
      provideCodeActions: (doc, _range, ctx) => {
        const actions: vscode.CodeAction[] = [];
        for (const d of ctx.diagnostics) {
          const code = codeOf(d);
          const name = nameOf(doc, d);
          if (!name) { continue; }
          if (code === 'RNF7030') {
            const inProc = vscode.l10n.t('Declare {0} here (dcl-s in this procedure)…', name);
            const a = new vscode.CodeAction(inProc, vscode.CodeActionKind.QuickFix);
            a.command = { command: 'vanthrex.fix.declare', title: inProc, arguments: [doc.uri, name, d.range.start.line, true] };
            a.diagnostics = [d]; a.isPreferred = true; actions.push(a);
            const glob = vscode.l10n.t('Declare {0} globally…', name);
            const b = new vscode.CodeAction(glob, vscode.CodeActionKind.QuickFix);
            b.command = { command: 'vanthrex.fix.declare', title: glob, arguments: [doc.uri, name, d.range.start.line, false] };
            b.diagnostics = [d]; actions.push(b);
          }
          if (code === 'RNF7031') {
            const line = unusedLine(doc.getText(), d.range.start.line, name);
            if (line === undefined) { continue; }
            const title = vscode.l10n.t('Remove unused declaration of {0}', name);
            const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
            a.edit = new vscode.WorkspaceEdit();
            a.edit.delete(doc.uri, doc.lineAt(line).rangeIncludingLineBreak);
            a.diagnostics = [d]; actions.push(a);
          }
        }
        return actions;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand('vanthrex.fix.declare', (uri: vscode.Uri, name: string, line: number, local: boolean) => declare(uri, name, line, local)),
  );
}
