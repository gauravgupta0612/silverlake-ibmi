// CL editing help from the system's own command definitions: hover a command for what it does and its parameters,
// and get its keywords and their allowed values offered while typing (the same definitions F4 uses).
import * as vscode from 'vscode';
import { commandDefinition } from './prompter';
import { clCursor, commandMarkdown, keywordsToOffer, valuesToOffer } from '../core/clAssist';
import { clStatements } from '../core/clLanguage';
import { ClCommandDef } from '../core/clCommand';
import { logError } from '../core/log';
import { ConnectionManager } from '../core/manager';

const CL: vscode.DocumentSelector = { language: 'cl' };
/** Commands whose definition could not be read (not on this system): not asked again in this session. */
const missing = new Set<string>();

/** The statement around a line: its first line and the text from its start up to the position. */
function statementAt(doc: vscode.TextDocument, pos: vscode.Position): { start: number; before: string } | undefined {
  // Walk back over continuation lines (+ or - at the end of the previous line).
  let start = pos.line;
  while (start > 0 && /[+-]\s*$/.test(doc.lineAt(start - 1).text.replace(/\/\*.*\*\/\s*$/, ''))) { start--; }
  const parts: string[] = [];
  for (let l = start; l <= pos.line; l++) {
    const t = l === pos.line ? doc.lineAt(l).text.substring(0, pos.character) : doc.lineAt(l).text.replace(/\s*[+-]\s*$/, ' ');
    parts.push(t);
  }
  return { start, before: parts.join(' ') };
}

async function definition(manager: ConnectionManager, command: string): Promise<ClCommandDef | undefined> {
  const key = command.toUpperCase();
  if (!manager.connection || missing.has(key) || !/^([A-Z$#@][A-Z0-9$#@_.]{0,9}\/)?[A-Z$#@][A-Z0-9$#@_.]{0,9}$/.test(key)) { return undefined; }
  try { return await commandDefinition(manager, key); } catch (e) { missing.add(key); logError(e); return undefined; }
}

export function registerClAssist(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const enabled = () => vscode.workspace.getConfiguration('vanthrex.editor').get<boolean>('clCommandHelp', true);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(CL, {
      provideHover: async (doc, pos) => {
        if (!enabled()) { return undefined; }
        const range = doc.getWordRangeAtPosition(pos, /(?:[A-Za-z$#@][\w$#@]*\/)?[A-Za-z$#@][\w$#@]*/);
        if (!range) { return undefined; }
        // Only the command word of a statement (not a keyword, a value or a variable).
        const st = clStatements(doc.getText()).find(s => s.line <= pos.line && s.endLine >= pos.line);
        if (!st || st.line !== range.start.line) { return undefined; }
        const word = doc.getText(range).toUpperCase();
        if (word !== st.command) { return undefined; }
        const def = await definition(manager, word);
        return def ? new vscode.Hover(new vscode.MarkdownString(commandMarkdown(def)), range) : undefined;
      },
    }),
    vscode.languages.registerCompletionItemProvider(CL, {
      provideCompletionItems: async (doc, pos) => {
        if (!enabled()) { return undefined; }
        const at = statementAt(doc, pos);
        const cur = at ? clCursor(at.before) : undefined;
        if (!cur || cur.atCommand) { return undefined; }
        const def = await definition(manager, cur.command);
        if (!def) { return undefined; }
        if (cur.keyword) {
          return valuesToOffer(def, cur.keyword).map((v, i) => {
            const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember);
            item.sortText = String(i).padStart(3, '0');
            item.detail = `${cur.keyword} — ${def.parms.find(p => p.kwd === cur.keyword)?.prompt ?? ''}`;
            return item;
          });
        }
        return keywordsToOffer(def, cur.used).map((p, i) => {
          const item = new vscode.CompletionItem({ label: p.kwd, description: p.prompt }, vscode.CompletionItemKind.Property);
          item.insertText = new vscode.SnippetString(`${p.kwd}(\${1${p.dft ? ':' + p.dft.replace(/[$}\\]/g, '\\$&') : ''}})`);
          item.sortText = String(i).padStart(3, '0');
          item.detail = [p.min > 0 ? vscode.l10n.t('required') : '', p.dft ? vscode.l10n.t('default {0}', p.dft) : '', p.values.length ? p.values.slice(0, 6).join(' ') : ''].filter(Boolean).join(' · ');
          item.command = p.values.length ? { command: 'editor.action.triggerSuggest', title: '' } : undefined;
          return item;
        });
      },
    }, ' ', '('),
  );
}
