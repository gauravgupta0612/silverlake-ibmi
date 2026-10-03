import * as vscode from 'vscode';
import { LINT_RULES, LintRule, LintSeverity, lintRpg } from './lint';

const SEVERITY: Record<LintSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

export function registerRpgLint(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('Silverlake checks');
  const timers = new Map<string, NodeJS.Timeout>();

  const config = () => vscode.workspace.getConfiguration('silverlake');
  // Only check sources shown in an editor (not /COPY members opened in the background for navigation).
  const visible = (doc: vscode.TextDocument) => vscode.window.visibleTextEditors.some(e => e.document === doc);
  const run = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'rpgle' || !visible(doc)) { return; }
    if (!config().get<boolean>('lint.enabled', true)) { collection.delete(doc.uri); return; }
    const findings = lintRpg(doc.getText(), {
      rules: config().get<Partial<Record<LintRule, boolean>>>('lint.rules', {}),
      maxProcedureLines: config().get<number>('lint.maxProcedureLines', 200),
      isInclude: /\.(rpgleinc|rpginc)$/i.test(doc.uri.path) || /\/Q?CPYSRC\//i.test(doc.uri.path),
    });
    collection.set(doc.uri, findings.map(f => {
      const line = Math.min(f.line, doc.lineCount - 1);
      const d = new vscode.Diagnostic(new vscode.Range(line, f.start, line, f.end), f.message, SEVERITY[f.severity]);
      d.source = 'Silverlake';
      d.code = f.rule;
      if (f.rule === 'unused-definition') { d.tags = [vscode.DiagnosticTag.Unnecessary]; }
      return d;
    }));
  };
  const schedule = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); run(doc); }, 400));
  };

  context.subscriptions.push(
    collection,
    vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(e => { if (!collection.has(e.document.uri)) { run(e.document); } })),
    vscode.workspace.onDidChangeTextDocument(e => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument(d => collection.delete(d.uri)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('silverlake.lint')) { vscode.window.visibleTextEditors.forEach(ed => run(ed.document)); }
    }),
    vscode.commands.registerCommand('silverlake.lintCurrent', () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) { run(doc); vscode.commands.executeCommand('workbench.actions.view.problems'); }
    }),
    vscode.languages.registerCodeActionsProvider({ language: 'rpgle' }, {
      provideCodeActions(doc, _range, ctx) {
        const actions: vscode.CodeAction[] = [];
        for (const d of ctx.diagnostics.filter(x => x.source === 'Silverlake')) {
          const rule = String(d.code) as LintRule;
          if (rule === 'unused-definition') {
            const line = doc.lineAt(d.range.start.line);
            if (/^\s*dcl-[sc]\b[^;]*;\s*(\/\/.*)?$/i.test(line.text)) {
              const fix = new vscode.CodeAction('Remove unused declaration', vscode.CodeActionKind.QuickFix);
              fix.edit = new vscode.WorkspaceEdit();
              fix.edit.delete(doc.uri, line.rangeIncludingLineBreak);
              fix.diagnostics = [d];
              fix.isPreferred = true;
              actions.push(fix);
            }
          }
          if (rule === 'mixed-format') {
            const conv = new vscode.CodeAction('Convert fixed-format C-specs to free…', vscode.CodeActionKind.RefactorRewrite);
            conv.command = { command: 'silverlake.convertToFree', title: 'Convert' };
            actions.push(conv);
          }
          const off = new vscode.CodeAction(`Turn off the "${rule}" check (${LINT_RULES[rule] ?? rule})`, vscode.CodeActionKind.QuickFix);
          off.command = { command: 'silverlake.disableLintRule', title: 'Turn off', arguments: [rule] };
          off.diagnostics = [d];
          actions.push(off);
        }
        return actions;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite] }),
    vscode.commands.registerCommand('silverlake.disableLintRule', async (rule: LintRule) => {
      const rules = { ...config().get<Record<string, boolean>>('lint.rules', {}), [rule]: false };
      await config().update('lint.rules', rules, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`The "${rule}" check is off. Turn it back on in Settings → Silverlake: Lint Rules.`);
    }),
  );
  vscode.window.visibleTextEditors.forEach(e => run(e.document));
}
