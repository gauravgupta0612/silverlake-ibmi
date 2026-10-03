import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { log } from '../core/log';
import { parseMemberPath, sqlString } from '../core/util';
import { IFS_SCHEME, MEMBER_SCHEME, ifsUri, memberUri } from '../features/fileSystems';
import { BIFS, OPCODES } from './docs';
import { CopyDirective, RpgParse, findOccurrences, parseRpg, resolveDefinition, wordAt } from './parser';

const RPG: vscode.DocumentSelector = { language: 'rpgle' };

const KIND_LABEL: Record<string, string> = {
  variable: 'standalone field', constant: 'constant', ds: 'data structure', subfield: 'subfield', prototype: 'prototype',
  procedure: 'procedure', file: 'file', subroutine: 'subroutine', parameter: 'parameter', enum: 'enumeration',
};

/** Parses are cached per document version. */
class ParseCache {
  private readonly cache = new Map<string, { version: number; parse: RpgParse }>();
  get(doc: vscode.TextDocument): RpgParse {
    const key = doc.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === doc.version) { return hit.parse; }
    const parse = parseRpg(doc.getText());
    this.cache.set(key, { version: doc.version, parse });
    return parse;
  }
  forget(doc: vscode.TextDocument): void { this.cache.delete(doc.uri.toString()); }
}

export class CopyResolver {
  private readonly resolved = new Map<string, vscode.Uri | null>();

  constructor(private readonly manager: ConnectionManager) {
    manager.onDidChange(() => this.resolved.clear());
  }

  /** Resolve a /COPY directive to a document URI, searching the library list when needed. */
  async resolve(doc: vscode.TextDocument, c: CopyDirective): Promise<vscode.Uri | undefined> {
    if (c.ifsPath) {
      let path = c.ifsPath;
      if (!path.startsWith('/') && doc.uri.scheme === IFS_SCHEME) {
        path = doc.uri.path.replace(/\/[^/]*$/, '') + '/' + path;
      } else if (!path.startsWith('/')) {
        const home = this.manager.connection?.homeDirectory ?? '/home';
        path = `${home}/${path}`;
      }
      return ifsUri(path);
    }
    if (!c.member) { return undefined; }
    const file = c.file ?? 'QRPGLESRC';
    const conn = this.manager.connection;
    const ownLib = doc.uri.scheme === MEMBER_SCHEME ? parseMemberPath(doc.uri.path).library : undefined;
    const libs = c.library ? [c.library]
      : [...new Set([ownLib, conn?.profile.currentLibrary, ...(conn?.profile.libraries ?? [])].filter(Boolean) as string[])];
    const key = `${libs.join(',')}|${file}|${c.member}`;
    if (this.resolved.has(key)) { return this.resolved.get(key) ?? undefined; }
    let uri: vscode.Uri | undefined;
    if (conn && libs.length) {
      try {
        const rows = await conn.rows<{ LIB: string; TYPE: string }>(
          `SELECT SYSTEM_TABLE_SCHEMA AS LIB, COALESCE(SOURCE_TYPE, '') AS TYPE FROM QSYS2.SYSPARTITIONSTAT ` +
          `WHERE SYSTEM_TABLE_SCHEMA IN (${libs.map(sqlString).join(', ')}) AND SYSTEM_TABLE_NAME = ${sqlString(file)} ` +
          `AND SYSTEM_TABLE_MEMBER = ${sqlString(c.member)}`, 50);
        const hit = libs.map(l => rows.find(r => String(r.LIB).trim() === l)).find(Boolean);
        if (hit) { uri = memberUri(String(hit.LIB).trim(), file, c.member, String(hit.TYPE).trim() || 'rpgleinc'); }
      } catch (e) { log(`Could not resolve /COPY ${c.target}: ${e}`); }
    }
    if (!uri && libs[0]) { uri = memberUri(libs[0], file, c.member, 'rpgleinc'); }
    this.resolved.set(key, uri ?? null);
    return uri;
  }
}

export function registerRpgNavigation(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const cache = new ParseCache();
  const copies = new CopyResolver(manager);

  const definitionIn = async (doc: vscode.TextDocument, name: string, line: number, depth = 0): Promise<vscode.Location | undefined> => {
    const parse = cache.get(doc);
    const def = resolveDefinition(parse, name, line);
    if (def) { return new vscode.Location(doc.uri, new vscode.Position(def.line, def.column)); }
    if (depth > 2) { return undefined; }
    for (const c of parse.copies) {
      const uri = await copies.resolve(doc, c);
      if (!uri) { continue; }
      try {
        const inc = await vscode.workspace.openTextDocument(uri);
        const found = await definitionIn(inc, name, -1, depth + 1);
        if (found) { return found; }
      } catch (e) { log(`Could not open ${c.target}: ${e}`); }
    }
    return undefined;
  };

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(d => cache.forget(d)),

    vscode.languages.registerDefinitionProvider(RPG, {
      async provideDefinition(doc, pos) {
        const w = wordAt(doc.lineAt(pos.line).text, pos.character);
        if (!w) { return undefined; }
        // Ctrl+click on a /COPY line opens the member.
        const copy = cache.get(doc).copies.find(c => c.line === pos.line);
        if (copy) {
          const uri = await copies.resolve(doc, copy);
          return uri ? new vscode.Location(uri, new vscode.Position(0, 0)) : undefined;
        }
        return definitionIn(doc, w.word, pos.line);
      },
    }),

    vscode.languages.registerReferenceProvider(RPG, {
      provideReferences(doc, pos) {
        const w = wordAt(doc.lineAt(pos.line).text, pos.character);
        if (!w) { return []; }
        return findOccurrences(doc.getText(), w.word)
          .map(o => new vscode.Location(doc.uri, new vscode.Range(o.line, o.start, o.line, o.end)));
      },
    }),

    vscode.languages.registerDocumentHighlightProvider(RPG, {
      provideDocumentHighlights(doc, pos) {
        const w = wordAt(doc.lineAt(pos.line).text, pos.character);
        if (!w || BIFS[`%${w.word.toUpperCase()}`] || OPCODES[w.word.toUpperCase()]) { return []; }
        const parse = cache.get(doc);
        if (!parse.definitions.some(d => d.upper === w.word.toUpperCase())) { return []; }
        return findOccurrences(doc.getText(), w.word).map(o => new vscode.DocumentHighlight(
          new vscode.Range(o.line, o.start, o.line, o.end),
          parse.definitions.some(d => d.line === o.line && d.upper === w.word.toUpperCase())
            ? vscode.DocumentHighlightKind.Write : vscode.DocumentHighlightKind.Read));
      },
    }),

    vscode.languages.registerRenameProvider(RPG, {
      prepareRename(doc, pos) {
        const w = wordAt(doc.lineAt(pos.line).text, pos.character);
        if (!w) { throw new Error('Place the cursor on a name to rename it.'); }
        if (!resolveDefinition(cache.get(doc), w.word, pos.line)) {
          throw new Error(`"${w.word}" is not declared in this source, so it can't be renamed safely here.`);
        }
        return { range: new vscode.Range(pos.line, w.start, pos.line, w.end), placeholder: w.word };
      },
      provideRenameEdits(doc, pos, newName) {
        if (!/^[A-Za-z$#@_][\w$#@]*$/.test(newName)) { throw new Error(`"${newName}" is not a valid RPG name.`); }
        const w = wordAt(doc.lineAt(pos.line).text, pos.character);
        if (!w) { return undefined; }
        const parse = cache.get(doc);
        if (!parse.fullyFree && newName.length !== w.word.length) {
          throw new Error(`This source is not **FREE: renaming to a name of a different length would shift fixed-format columns. Use a ${w.word.length}-character name.`);
        }
        const def = resolveDefinition(parse, w.word, pos.line);
        // A procedure-local name only changes inside its procedure; a global one everywhere
        // except procedures that declare their own name with the same spelling.
        const local = def?.procedure && def.kind !== 'procedure' ? parse.procedures.find(p => p.name === def.procedure) : undefined;
        const shadowing = parse.procedures.filter(p => p !== local && parse.definitions.some(d =>
          d.procedure === p.name && d.kind !== 'procedure' && d.upper === w.word.toUpperCase()));
        const edit = new vscode.WorkspaceEdit();
        for (const o of findOccurrences(doc.getText(), w.word)) {
          if (local && (o.line < local.start || o.line > local.end)) { continue; }
          if (!local && shadowing.some(p => o.line >= p.start && o.line <= p.end)) { continue; }
          edit.replace(doc.uri, new vscode.Range(o.line, o.start, o.line, o.end), newName);
        }
        return edit;
      },
    }),

    vscode.languages.registerDocumentLinkProvider(RPG, {
      provideDocumentLinks(doc) {
        return cache.get(doc).copies.map(c => {
          const link = new vscode.DocumentLink(new vscode.Range(c.line, c.start, c.line, c.end));
          link.tooltip = `Open ${c.target}`;
          (link as vscode.DocumentLink & { copy?: CopyDirective; doc?: vscode.TextDocument }).copy = c;
          (link as vscode.DocumentLink & { copy?: CopyDirective; doc?: vscode.TextDocument }).doc = doc;
          return link;
        });
      },
      async resolveDocumentLink(link: vscode.DocumentLink & { copy?: CopyDirective; doc?: vscode.TextDocument }) {
        if (link.copy && link.doc) { link.target = await copies.resolve(link.doc, link.copy); }
        return link;
      },
    }),

    // Hover on a declared name: show its declaration (also from /COPY members).
    vscode.languages.registerHoverProvider(RPG, {
      async provideHover(doc, pos) {
        const w = wordAt(doc.lineAt(pos.line).text, pos.character);
        if (!w || BIFS[`%${w.word.toUpperCase()}`] || OPCODES[w.word.toUpperCase()]) { return undefined; }
        const prev = doc.lineAt(pos.line).text[w.start - 1];
        if (prev === '%' || prev === '*') { return undefined; }
        const loc = await definitionIn(doc, w.word, pos.line);
        if (!loc) { return undefined; }
        const defDoc = loc.uri.toString() === doc.uri.toString() ? doc : await vscode.workspace.openTextDocument(loc.uri);
        const def = cache.get(defDoc).definitions.find(d => d.line === loc.range.start.line && d.upper === w.word.toUpperCase());
        const md = new vscode.MarkdownString();
        md.appendCodeblock(defDoc.lineAt(loc.range.start.line).text.trim(), 'rpgle');
        if (def) {
          md.appendMarkdown(`*${KIND_LABEL[def.kind] ?? def.kind}*` + (def.parent ? ` of **${def.parent}**` : '') +
            (def.procedure && def.kind !== 'procedure' ? ` · local to ${def.procedure}` : '') +
            (loc.uri.toString() !== doc.uri.toString() ? ` · from ${loc.uri.path.split('/').slice(-2).join('/')}` : ''));
        }
        return new vscode.Hover(md, new vscode.Range(pos.line, w.start, pos.line, w.end));
      },
    }),
  );
}
