import * as vscode from 'vscode';
import { BIFS, OPCODES, SPEC_COLUMNS } from './docs';
import { convertFixedToFree } from './fixedToFree';

const RPG: vscode.DocumentSelector = { language: 'rpgle' };

function isFullyFree(doc: vscode.TextDocument): boolean {
  return doc.lineCount > 0 && /^\*\*free/i.test(doc.lineAt(0).text.trim());
}

/** A line is fixed-format when column 6 holds a spec letter and column 7 isn't a free-form start. */
function fixedSpec(doc: vscode.TextDocument, line: string): string | undefined {
  if (isFullyFree(doc) || line.length < 6) { return undefined; }
  const spec = line[5].toUpperCase();
  if (!'HFDICOP'.includes(spec) || spec === ' ') { return undefined; }
  if (line[6] === '*' || line[6] === '/') { return undefined; }
  return spec;
}

class RpgHoverProvider implements vscode.HoverProvider {
  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const range = doc.getWordRangeAtPosition(pos, /%?[A-Za-z][A-Za-z0-9-]*/);
    const md = new vscode.MarkdownString();
    if (range) {
      const word = doc.getText(range).toUpperCase();
      const entry = BIFS[word] ?? OPCODES[word];
      if (entry) {
        md.appendCodeblock(entry.syntax, 'rpgle');
        md.appendMarkdown(entry.summary);
      }
    }
    const line = doc.lineAt(pos.line).text;
    const spec = fixedSpec(doc, line);
    if (spec && SPEC_COLUMNS[spec]) {
      const col = pos.character + 1;
      const field = SPEC_COLUMNS[spec].find(f => col >= f.from && col <= f.to);
      if (field) {
        if (md.value) { md.appendMarkdown('\n\n---\n\n'); }
        md.appendMarkdown(`**${spec}-spec · column ${col}** — ${field.name} (${field.from}–${field.to})` +
          (field.hint ? `  \n_${field.hint}_` : ''));
      }
    }
    return md.value ? new vscode.Hover(md, range) : undefined;
  }
}

class RpgCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
    const prefix = doc.lineAt(pos.line).text.substring(0, pos.character);
    const bifMatch = prefix.match(/%[A-Za-z]*$/);
    if (!bifMatch) { return []; }
    const start = pos.translate(0, -bifMatch[0].length);
    return Object.entries(BIFS).map(([name, e]) => {
      const item = new vscode.CompletionItem(name.toLowerCase(), vscode.CompletionItemKind.Function);
      item.range = new vscode.Range(start, pos);
      item.detail = e.syntax;
      item.documentation = e.summary;
      item.insertText = new vscode.SnippetString(`${name.toLowerCase()}($1)`);
      return item;
    });
  }
}

/** Outline / breadcrumbs: procedures, subroutines, data structures, prototypes, files. */
class RpgSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = [];
    const open: { kind: string; sym: vscode.DocumentSymbol }[] = [];
    const add = (name: string, detail: string, kind: vscode.SymbolKind, line: number, container?: string) => {
      const r = doc.lineAt(line).range;
      const sym = new vscode.DocumentSymbol(name, detail, kind, r, r);
      const parent = open[open.length - 1];
      (parent ? parent.sym.children : symbols).push(sym);
      if (container) { open.push({ kind: container, sym }); }
    };
    const close = (kind: string, line: number) => {
      const idx = [...open].reverse().findIndex(o => o.kind === kind);
      if (idx === -1) { return; }
      const o = open.splice(open.length - 1 - idx, 1)[0];
      o.sym.range = new vscode.Range(o.sym.range.start, doc.lineAt(line).range.end);
    };

    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      const code = text.replace(/\/\/.*$/, '');
      let m: RegExpMatchArray | null;
      if ((m = code.match(/^\s*dcl-proc\s+([\w$#@]+)/i))) { add(m[1], 'procedure', vscode.SymbolKind.Function, i, 'proc'); }
      else if (/^\s*end-proc\b/i.test(code)) { close('proc', i); }
      else if ((m = code.match(/^\s*begsr\s+([\w$#@]+)/i))) { add(m[1], 'subroutine', vscode.SymbolKind.Method, i, 'sr'); }
      else if (/^\s*endsr\b/i.test(code)) { close('sr', i); }
      else if ((m = code.match(/^\s*dcl-ds\s+([\w$#@*]+)/i))) {
        const single = /\b(likeds|likerec|extname)\s*\(/i.test(code) || /end-ds\s*;/i.test(code);
        add(m[1], 'data structure', vscode.SymbolKind.Struct, i, single ? undefined : 'ds');
      } else if (/^\s*end-ds\b/i.test(code)) { close('ds', i); }
      else if ((m = code.match(/^\s*dcl-pr\s+([\w$#@]+)/i))) { add(m[1], 'prototype', vscode.SymbolKind.Interface, i, /end-pr\s*;/i.test(code) ? undefined : 'pr'); }
      else if (/^\s*end-pr\b/i.test(code)) { close('pr', i); }
      else if ((m = code.match(/^\s*dcl-f\s+([\w$#@]+)/i))) { add(m[1], 'file', vscode.SymbolKind.File, i); }
      else if ((m = code.match(/^\s*dcl-c\s+([\w$#@]+)/i))) { add(m[1], 'constant', vscode.SymbolKind.Constant, i); }
      else if ((m = code.match(/^\s*dcl-s\s+([\w$#@]+)\s+(.*?);?\s*$/i))) { add(m[1], m[2].replace(/;$/, ''), vscode.SymbolKind.Variable, i); }
      else if (text.length > 6 && !isFullyFree(doc)) {
        // Fixed-format procedures and subroutines.
        const spec = text[5]?.toUpperCase();
        if (spec === 'P' && text[23]?.toUpperCase() === 'B') { add(text.substring(6, 21).trim(), 'procedure', vscode.SymbolKind.Function, i, 'proc'); }
        else if (spec === 'P' && text[23]?.toUpperCase() === 'E') { close('proc', i); }
        else if (spec === 'C' && /^BEGSR\b/i.test(text.substring(25, 35).trim())) { add(text.substring(11, 25).trim(), 'subroutine', vscode.SymbolKind.Method, i, 'sr'); }
        else if (spec === 'C' && /^ENDSR\b/i.test(text.substring(25, 35).trim())) { close('sr', i); }
      }
    }
    return symbols;
  }
}

export function registerRpgFeatures(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(RPG, new RpgHoverProvider()),
    vscode.languages.registerCompletionItemProvider(RPG, new RpgCompletionProvider(), '%'),
    vscode.languages.registerDocumentSymbolProvider(RPG, new RpgSymbolProvider()),
    vscode.commands.registerTextEditorCommand('vanthrex.convertToFree', async editor => {
      const doc = editor.document;
      const sel = editor.selection.isEmpty
        ? new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
        : new vscode.Range(editor.selection.start.line, 0, editor.selection.end.line, doc.lineAt(editor.selection.end.line).text.length);
      if (editor.selection.isEmpty && isFullyFree(doc)) {
        vscode.window.showInformationMessage('This source is already fully free-form (**FREE). Select pasted fixed-format lines to convert just those.');
        return;
      }
      if (editor.selection.isEmpty) {
        const ok = await vscode.window.showWarningMessage('Convert all fixed-format H, F, D, P and C specs in this source to free form?', { modal: true }, 'Convert');
        if (ok !== 'Convert') { return; }
      }
      const lines = doc.getText(sel).split(/\r?\n/);
      const { lines: out, todo } = convertFixedToFree(lines, { baseIndent: isFullyFree(doc) ? '' : '       ' });
      await editor.edit(e => e.replace(sel, out.join('\n')));
      vscode.window.showInformationMessage(
        `Converted ${lines.length} line(s) to free format.` +
        (todo ? ` ${todo} spot(s) marked "// TODO" need a manual check.` : ' Review the result before compiling.'));
    }),
  );
}
