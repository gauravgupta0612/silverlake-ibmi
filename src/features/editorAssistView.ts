// Editor help for RPG and CL: folding, parameter hints while typing a call, Format Document for fully free RPG, the
// fixed-format field under the cursor (status bar, jump to next/previous field, field list), and for CL an outline,
// folding, Go to Definition, Find All References and hovers on variables.
import { commentBlocks } from '../core/sqlGen';
import * as vscode from 'vscode';
import { activeCall, BIF_SIGNATURES, fieldAt, formatFreeRpg, nextFieldColumn, rpgFolds, rpgSignatures } from '../rpg/editing';
import { clDefinition, clFolds, clReferences, clSymbols, ClSymbolKind } from '../core/clLanguage';
import { ConnectionManager } from '../core/manager';

const RPG: vscode.DocumentSelector = { language: 'rpgle' };
const CL: vscode.DocumentSelector = { language: 'cl' };

/** Parse results per document version (typing in a big member should not re-scan it on every key). */
function cached<T>(fn: (text: string) => T): (doc: vscode.TextDocument) => T {
  const cache = new Map<string, { version: number; value: T }>();
  return doc => {
    const k = doc.uri.toString();
    const hit = cache.get(k);
    if (hit && hit.version === doc.version) { return hit.value; }
    const value = fn(doc.getText());
    cache.set(k, { version: doc.version, value });
    if (cache.size > 50) { cache.delete(cache.keys().next().value as string); }
    return value;
  };
}
const signaturesOf = cached(rpgSignatures);
const clSymbolsOf = cached(clSymbols);

const CL_KIND: Record<ClSymbolKind, vscode.SymbolKind> = {
  program: vscode.SymbolKind.Module, variable: vscode.SymbolKind.Variable, file: vscode.SymbolKind.File, label: vscode.SymbolKind.Key, subroutine: vscode.SymbolKind.Function,
};

function clWordAt(doc: vscode.TextDocument, pos: vscode.Position): { word: string; range: vscode.Range } | undefined {
  const range = doc.getWordRangeAtPosition(pos, /&?[A-Za-z$#@][\w$#@]*/);
  return range ? { word: doc.getText(range), range } : undefined;
}

function fixedLanguage(doc: vscode.TextDocument): 'rpgle' | 'dds' | undefined {
  return doc.languageId === 'rpgle' ? 'rpgle' : doc.languageId === 'dds' ? 'dds' : undefined;
}

const commentFolds = (doc: vscode.TextDocument, language: string) => commentBlocks(doc.getText(), language).map(b => new vscode.FoldingRange(b.start, b.end, vscode.FoldingRangeKind.Comment));

export function registerEditorAssist(context: vscode.ExtensionContext, _manager: ConnectionManager): void {
  const cfg = () => vscode.workspace.getConfiguration('vanthrex.editor');

  // ---------------------------------------------------------------- RPG
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider(RPG, {
      provideFoldingRanges: doc => [...rpgFolds(doc.getText()).map(f => new vscode.FoldingRange(f.start, f.end)), ...commentFolds(doc, 'rpgle')],
    }),
    vscode.languages.registerSignatureHelpProvider(RPG, {
      provideSignatureHelp: (doc, pos) => {
        const before = doc.lineAt(pos.line).text.substring(0, pos.character);
        // A call may continue over lines: look back up to 5 lines for the opening parenthesis.
        let text = before;
        for (let l = pos.line - 1; l >= Math.max(0, pos.line - 5) && !activeCall(text); l--) { text = doc.lineAt(l).text + ' ' + text; }
        const call = activeCall(text);
        if (!call) { return undefined; }
        const help = new vscode.SignatureHelp();
        if (call.name.startsWith('%')) {
          const params = BIF_SIGNATURES[call.name.toUpperCase()];
          if (!params) { return undefined; }
          const sig = new vscode.SignatureInformation(`${call.name.toUpperCase()}(${params.join(' : ')})`);
          sig.parameters = params.map(p => new vscode.ParameterInformation(p));
          help.signatures = [sig];
        } else {
          const s = signaturesOf(doc).find(x => x.name.toUpperCase() === call.name.toUpperCase());
          if (!s) { return undefined; }
          const label = `${s.name}(${s.params.map(p => `${p.name} ${p.definition}`.trim()).join(' : ')})${s.returns ? ' → ' + s.returns : ''}`;
          const sig = new vscode.SignatureInformation(label, new vscode.MarkdownString(vscode.l10n.t('Declared on line {0}', s.line + 1)));
          sig.parameters = s.params.map(p => new vscode.ParameterInformation(`${p.name} ${p.definition}`.trim()));
          help.signatures = [sig];
        }
        help.activeSignature = 0;
        help.activeParameter = Math.min(call.index, Math.max(0, help.signatures[0].parameters.length - 1));
        return help;
      },
    }, '(', ':'),
    vscode.languages.registerDocumentFormattingEditProvider(RPG, {
      provideDocumentFormattingEdits: (doc, options) => {
        const lines = formatFreeRpg(doc.getText(), cfg().get<number>('rpgIndent', options.tabSize || 2));
        if (!lines) {
          vscode.window.setStatusBarMessage(vscode.l10n.t('Format Document works on fully free RPG (**FREE) sources.'), 6000);
          return [];
        }
        const edits: vscode.TextEdit[] = [];
        lines.forEach((l, i) => { if (i < doc.lineCount && doc.lineAt(i).text !== l) { edits.push(vscode.TextEdit.replace(doc.lineAt(i).range, l)); } });
        return edits;
      },
    }),
  );

  // Fixed-format field under the cursor in the status bar.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
  status.command = 'vanthrex.fixedFields';
  const update = () => {
    const ed = vscode.window.activeTextEditor;
    const lang = ed ? fixedLanguage(ed.document) : undefined;
    if (!ed || !lang || !cfg().get<boolean>('columnHints', true)) { status.hide(); return; }
    const pos = ed.selection.active;
    const at = fieldAt(ed.document.lineAt(pos.line).text, pos.character, lang);
    if (!at) { status.hide(); vscode.commands.executeCommand('setContext', 'vanthrex.fixedLine', false); return; }
    status.text = `$(symbol-ruler) ${at.spec} · ${at.field ? `${at.field.label} (${at.field.from}–${at.field.to})` : vscode.l10n.t('column {0}', pos.character + 1)}`;
    status.tooltip = new vscode.MarkdownString(`**${at.title}**\n\n${at.field?.hint ?? ''}\n\n${vscode.l10n.t('Click for all fields of this line. Ctrl+Alt+] / Ctrl+Alt+[ jump to the next / previous field.')}`);
    status.show();
    vscode.commands.executeCommand('setContext', 'vanthrex.fixedLine', true);
  };
  const jump = (backwards: boolean) => {
    const ed = vscode.window.activeTextEditor;
    const lang = ed ? fixedLanguage(ed.document) : undefined;
    if (!ed || !lang) { return; }
    const pos = ed.selection.active;
    const text = ed.document.lineAt(pos.line).text;
    const col = nextFieldColumn(text, pos.character, lang, backwards);
    if (col === undefined) { return; }
    if (col > text.length) { void ed.edit(e => e.insert(new vscode.Position(pos.line, text.length), ' '.repeat(col - text.length))); }
    const p = new vscode.Position(pos.line, col);
    ed.selection = new vscode.Selection(p, p);
  };
  context.subscriptions.push(
    status,
    vscode.window.onDidChangeTextEditorSelection(update),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.commands.registerCommand('vanthrex.nextField', () => jump(false)),
    vscode.commands.registerCommand('vanthrex.previousField', () => jump(true)),
    vscode.commands.registerCommand('vanthrex.fixedFields', async () => {
      const ed = vscode.window.activeTextEditor;
      const lang = ed ? fixedLanguage(ed.document) : undefined;
      if (!ed || !lang) { return; }
      const pos = ed.selection.active;
      const text = ed.document.lineAt(pos.line).text;
      const at = fieldAt(text, pos.character, lang);
      if (!at) { vscode.window.showInformationMessage(vscode.l10n.t('This line is not a fixed-format specification.')); return; }
      const pick = await vscode.window.showQuickPick(at.fields.map(f => ({
        label: f.label, description: `${f.from}–${f.to}`, detail: `"${text.substring(f.from - 1, f.to).trimEnd()}"${f.hint ? ' · ' + f.hint : ''}`, f,
        picked: f === at.field,
      })), { title: at.title, placeHolder: vscode.l10n.t('Choose a field to move the cursor there (F4 opens the prompter)') });
      if (pick) {
        if (pick.f.from - 1 > text.length) { await ed.edit(e => e.insert(new vscode.Position(pos.line, text.length), ' '.repeat(pick.f.from - 1 - text.length))); }
        const p = new vscode.Position(pos.line, pick.f.from - 1);
        ed.selection = new vscode.Selection(p, p);
      }
    }),
  );
  update();

  // ---------------------------------------------------------------- CL
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(CL, {
      provideDocumentSymbols: doc => clSymbolsOf(doc).map(s => {
        const range = new vscode.Range(s.line, 0, Math.min(s.endLine, doc.lineCount - 1), doc.lineAt(Math.min(s.endLine, doc.lineCount - 1)).text.length);
        return new vscode.DocumentSymbol(s.name, s.detail, CL_KIND[s.kind], range, new vscode.Range(s.line, 0, s.line, doc.lineAt(s.line).text.length));
      }),
    }),
    vscode.languages.registerFoldingRangeProvider(CL, {
      provideFoldingRanges: doc => [...clFolds(doc.getText()).map(f => new vscode.FoldingRange(f.start, f.end)), ...commentFolds(doc, 'cl')],
    }),
    vscode.languages.registerDefinitionProvider(CL, {
      provideDefinition: (doc, pos) => {
        const w = clWordAt(doc, pos);
        const d = w ? clDefinition(doc.getText(), w.word) : undefined;
        if (!d) { return undefined; }
        const text = doc.lineAt(d.line).text; const col = Math.max(0, text.toUpperCase().indexOf(d.name));
        return new vscode.Location(doc.uri, new vscode.Range(d.line, col, d.line, col + d.name.length));
      },
    }),
    vscode.languages.registerReferenceProvider(CL, {
      provideReferences: (doc, pos) => {
        const w = clWordAt(doc, pos);
        return w ? clReferences(doc.getText(), w.word).map(r => new vscode.Location(doc.uri, new vscode.Range(r.line, r.start, r.line, r.end))) : [];
      },
    }),
    vscode.languages.registerDocumentHighlightProvider(CL, {
      provideDocumentHighlights: (doc, pos) => {
        const w = clWordAt(doc, pos);
        if (!w || !clDefinition(doc.getText(), w.word)) { return []; }
        return clReferences(doc.getText(), w.word).map(r => new vscode.DocumentHighlight(new vscode.Range(r.line, r.start, r.line, r.end)));
      },
    }),
    vscode.languages.registerHoverProvider(CL, {
      provideHover: (doc, pos) => {
        const w = clWordAt(doc, pos);
        if (!w) { return undefined; }
        const d = clDefinition(doc.getText(), w.word);
        if (!d || d.line === pos.line) { return undefined; }
        return new vscode.Hover(new vscode.MarkdownString().appendCodeblock(`${d.name} ${d.detail}`.trim(), 'cl').appendMarkdown(vscode.l10n.t('Declared on line {0}', d.line + 1)), w.range);
      },
    }),
  );
}
