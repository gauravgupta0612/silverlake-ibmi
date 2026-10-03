import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage } from '../core/log';
import { parseRpg, isFullyFreeSource } from './parser';
import { CopyResolver } from './navigation';
import { copybookUsage, extractProcedure, hasProcedureFriendlyControl, prototypeFromProcedure } from './procTools';

function rpgEditor(): vscode.TextEditor {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'rpgle') { throw new Error('Open an RPG source first.'); }
  return editor;
}

export function registerProcedureTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const resolver = new CopyResolver(manager);
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { vscode.window.showErrorMessage(errorMessage(e)); }
  };

  context.subscriptions.push(
    // ------------------------------------------------------------ prototype from procedure
    vscode.commands.registerCommand('vanthrex.generatePrototype', guard(async () => {
      const editor = rpgEditor();
      const r = prototypeFromProcedure(editor.document.getText(), editor.selection.active.line);
      await vscode.env.clipboard.writeText(r.text);
      const c = await vscode.window.showInformationMessage(
        `Prototype for ${r.name} copied to the clipboard — paste it into your prototype copybook.`, 'Open in Editor');
      if (c) {
        const doc = await vscode.workspace.openTextDocument({ language: 'rpgle', content: r.text + '\n' });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      }
    })),

    // ------------------------------------------------------------ extract to procedure
    vscode.commands.registerCommand('vanthrex.extractProcedure', guard(async () => {
      const editor = rpgEditor();
      const doc = editor.document;
      if (editor.selection.isEmpty) { throw new Error('Select the lines to move into a new procedure.'); }
      const start = editor.selection.start.line;
      const end = editor.selection.end.character === 0 && editor.selection.end.line > start
        ? editor.selection.end.line - 1 : editor.selection.end.line;
      const name = await vscode.window.showInputBox({
        title: 'Extract to procedure', prompt: 'Name of the new procedure', value: 'newProcedure', ignoreFocusOut: true,
        validateInput: v => /^[A-Za-z$#@_][\w$#@]*$/.test(v.trim()) ? undefined : 'Not a valid RPG name',
      });
      if (!name) { return; }
      const r = extractProcedure(doc.getText(), start, end, name.trim());
      const edit = new vscode.WorkspaceEdit();
      const insertAt = r.insertLine >= doc.lineCount
        ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(r.insertLine, 0);
      edit.insert(doc.uri, insertAt, r.insertLine >= doc.lineCount ? r.procedure.replace(/\n$/, '') : r.procedure.replace(/^\n/, '') + '\n');
      edit.replace(doc.uri, new vscode.Range(start, 0, end, doc.lineAt(end).text.length), r.call);
      await vscode.workspace.applyEdit(edit);
      if (!hasProcedureFriendlyControl(doc.getText())) {
        vscode.window.showWarningMessage(`${name} was extracted. Programs with sub-procedures need CTL-OPT DFTACTGRP(*NO) (or NOMAIN) to compile.`);
      } else {
        vscode.window.setStatusBarMessage(`$(check) Extracted ${name}`, 4000);
      }
    })),

    // ------------------------------------------------------------ unused copybooks
    vscode.commands.registerCommand('vanthrex.checkCopybooks', guard(async () => {
      const editor = rpgEditor();
      const doc = editor.document;
      const parse = parseRpg(doc.getText());
      if (!parse.copies.length) { vscode.window.showInformationMessage('This source has no /COPY or /INCLUDE.'); return; }
      const texts = new Map<number, string>();
      const missing: string[] = [];
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading copybooks…' }, async () => {
        for (const c of parse.copies) {
          try {
            const uri = await resolver.resolve(doc, c);
            if (!uri) { missing.push(c.target); continue; }
            texts.set(c.line, Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
          } catch { missing.push(c.target); }
        }
      });
      const usage = copybookUsage(doc.getText(), texts);
      const unused = usage.filter(u => u.declared > 0 && !u.used.length);
      type Item = vscode.QuickPickItem & { line: number };
      const items: Item[] = usage.map(u => ({
        label: `${!u.declared ? '$(question)' : u.used.length ? '$(check)' : '$(warning)'} ${u.target}`,
        description: !u.declared ? 'declares nothing Vanthrex can see'
          : u.used.length ? `uses ${u.used.length} of ${u.declared}: ${u.used.slice(0, 6).join(', ')}${u.used.length > 6 ? '…' : ''}`
          : `unused — none of its ${u.declared} declarations is referenced`,
        line: u.line,
      }));
      for (const m of missing) { items.push({ label: `$(error) ${m}`, description: 'not found on the library list', line: parse.copies.find(c => c.target === m)!.line }); }
      const qp = vscode.window.createQuickPick<Item>();
      qp.title = `Copybooks: ${unused.length} unused of ${parse.copies.length}`;
      qp.items = items;
      if (unused.length && isFullyFreeSource(doc.getText())) {
        qp.buttons = [{ iconPath: new vscode.ThemeIcon('comment'), tooltip: 'Comment out the unused /COPY lines' }];
        qp.onDidTriggerButton(async () => {
          qp.hide();
          const edit = new vscode.WorkspaceEdit();
          for (const u of unused) { edit.insert(doc.uri, new vscode.Position(u.line, 0), '// unused: '); }
          await vscode.workspace.applyEdit(edit);
        });
      }
      qp.onDidAccept(() => {
        const it = qp.selectedItems[0];
        qp.hide();
        if (it) {
          const pos = new vscode.Position(it.line, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      });
      qp.show();
    })),
  );
}
