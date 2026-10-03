import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { log } from '../core/log';
import { splitSqlStatements, sqlString } from '../core/util';
import { completionContext, tableReferences, TableRef } from '../core/sqlContext';

interface TableInfo { schema: string; name: string; systemName: string; type: string; text: string; }
interface ColumnMeta { name: string; type: string; length: number; scale: number; nullable: boolean; text: string; }

const TTL = 10 * 60 * 1000;
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL',
  'GROUP BY', 'ORDER BY', 'HAVING', 'FETCH FIRST', 'ROWS ONLY', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN', 'INNER JOIN',
  'EXCEPTION JOIN', 'ON', 'AS', 'DISTINCT', 'UNION', 'UNION ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CALL', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE',
  'TRIM', 'UPPER', 'LOWER', 'SUBSTR', 'VARCHAR_FORMAT', 'CURRENT DATE', 'CURRENT TIMESTAMP', 'CURRENT USER',
];

function typeLabel(c: ColumnMeta): string {
  const t = c.type.toUpperCase();
  const len = /^(DECIMAL|NUMERIC)$/.test(t) ? `(${c.length},${c.scale})` : /CHAR|GRAPHIC|VARG|BINARY|VARBIN/.test(t) ? `(${c.length})` : '';
  return `${t}${len}${c.nullable ? '' : ' NOT NULL'}`;
}

class Catalog {
  private tables = new Map<string, { at: number; list: TableInfo[] }>();
  private columns = new Map<string, { at: number; schema: string; list: ColumnMeta[] }>();

  constructor(private readonly manager: ConnectionManager) {
    manager.onDidChange(() => this.clear());
  }

  clear(): void { this.tables.clear(); this.columns.clear(); }

  libraries(): string[] {
    const p = this.manager.connection?.profile;
    return p ? [...new Set([p.currentLibrary, ...p.libraries].filter(Boolean) as string[])] : [];
  }

  async tablesIn(schema: string): Promise<TableInfo[]> {
    const key = schema.toUpperCase();
    const hit = this.tables.get(key);
    if (hit && Date.now() - hit.at < TTL) { return hit.list; }
    const conn = this.manager.connection;
    if (!conn) { return []; }
    const rows = await conn.rows<Record<string, unknown>>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, SYSTEM_TABLE_NAME, TABLE_TYPE, COALESCE(TABLE_TEXT, '') AS TEXT FROM QSYS2.SYSTABLES ` +
      `WHERE (SYSTEM_TABLE_SCHEMA = ${sqlString(key)} OR TABLE_SCHEMA = ${sqlString(schema)}) AND FILE_TYPE <> 'S' ` +
      `ORDER BY TABLE_NAME FETCH FIRST 3000 ROWS ONLY`, 3000);
    const list = rows.map(r => ({
      schema: String(r.TABLE_SCHEMA).trim(), name: String(r.TABLE_NAME).trim(), systemName: String(r.SYSTEM_TABLE_NAME).trim(),
      type: String(r.TABLE_TYPE).trim(), text: String(r.TEXT ?? '').trim(),
    }));
    this.tables.set(key, { at: Date.now(), list });
    return list;
  }

  /** Columns of a table; unqualified names are searched through the library list. */
  async columnsOf(ref: { schema?: string; table: string }): Promise<{ schema: string; list: ColumnMeta[] } | undefined> {
    const libs = ref.schema ? [ref.schema] : this.libraries();
    const key = `${libs.join(',')}|${ref.table}`;
    const hit = this.columns.get(key);
    if (hit && Date.now() - hit.at < TTL) { return hit; }
    const conn = this.manager.connection;
    if (!conn || !libs.length) { return undefined; }
    const rows = await conn.rows<Record<string, unknown>>(
      `SELECT SYSTEM_TABLE_SCHEMA AS LIB, COLUMN_NAME, DATA_TYPE, LENGTH, COALESCE(NUMERIC_SCALE, 0) AS SCALE, IS_NULLABLE, ` +
      `COALESCE(COLUMN_TEXT, '') AS TEXT FROM QSYS2.SYSCOLUMNS ` +
      `WHERE (SYSTEM_TABLE_SCHEMA IN (${libs.map(l => sqlString(l.toUpperCase())).join(', ')}) OR TABLE_SCHEMA IN (${libs.map(sqlString).join(', ')})) ` +
      `AND (TABLE_NAME = ${sqlString(ref.table)} OR SYSTEM_TABLE_NAME = ${sqlString(ref.table.toUpperCase())}) ` +
      `ORDER BY ORDINAL_POSITION`, 5000);
    if (!rows.length) { return undefined; }
    const firstLib = libs.map(l => l.toUpperCase()).find(l => rows.some(r => String(r.LIB).trim() === l)) ?? String(rows[0].LIB).trim();
    const list = rows.filter(r => String(r.LIB).trim() === firstLib).map(r => ({
      name: String(r.COLUMN_NAME).trim(), type: String(r.DATA_TYPE).trim(), length: Number(r.LENGTH ?? 0),
      scale: Number(r.SCALE ?? 0), nullable: String(r.IS_NULLABLE).trim() === 'Y', text: String(r.TEXT ?? '').trim(),
    }));
    const entry = { at: Date.now(), schema: firstLib, list };
    this.columns.set(key, entry);
    return entry;
  }
}

function statementAround(doc: vscode.TextDocument, pos: vscode.Position): { text: string; before: string } {
  const full = doc.getText();
  const offset = doc.offsetAt(pos);
  const stmts = splitSqlStatements(full);
  const s = stmts.find(x => offset >= x.start && offset <= x.end + 1);
  const start = s ? s.start : Math.max(0, full.lastIndexOf(';', offset - 1) + 1);
  const end = s ? s.end : full.length;
  return { text: full.substring(start, Math.max(end, offset)), before: full.substring(start, offset) };
}

export function registerSqlAssist(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const catalog = new Catalog(manager);
  const SQL: vscode.DocumentSelector = [{ language: 'sql' }];

  const tableItem = (t: TableInfo, range?: vscode.Range): vscode.CompletionItem => {
    const item = new vscode.CompletionItem({ label: t.name, description: `${t.schema} · ${t.type === 'V' ? 'view' : t.type === 'L' ? 'logical' : t.type === 'P' || t.type === 'T' ? 'table' : t.type}` },
      t.type === 'V' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Struct);
    item.detail = t.text || undefined;
    item.documentation = t.systemName !== t.name ? `System name: ${t.systemName}` : undefined;
    item.insertText = /^[A-Z$#@_][A-Z0-9$#@_]*$/.test(t.name) ? t.name : `"${t.name}"`;
    if (range) { item.range = range; }
    item.sortText = `1${t.name}`;
    return item;
  };
  const columnItem = (c: ColumnMeta, source: string): vscode.CompletionItem => {
    const item = new vscode.CompletionItem({ label: c.name, description: `${typeLabel(c)} · ${source}` }, vscode.CompletionItemKind.Field);
    item.detail = c.text || undefined;
    item.sortText = `0${c.name}`;
    return item;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.refreshSqlCache', () => {
      catalog.clear();
      vscode.window.setStatusBarMessage('$(check) SQL table and column cache cleared', 3000);
    }),

    vscode.languages.registerCompletionItemProvider(SQL, {
      async provideCompletionItems(doc, pos, _token, trigger) {
        if (!manager.connection) { return []; }
        const { text, before } = statementAround(doc, pos);
        const ctx = completionContext(before);
        // A space only pops suggestions up right after FROM / JOIN / INTO / UPDATE.
        if (trigger.triggerCharacter === ' ' && ctx.kind !== 'table') { return []; }
        const refs = tableReferences(text);
        try {
          if (ctx.kind === 'table') {
            if (ctx.schema) { return (await catalog.tablesIn(ctx.schema)).map(t => tableItem(t)); }
            const libs = catalog.libraries();
            const items: vscode.CompletionItem[] = libs.map(l => {
              const i = new vscode.CompletionItem({ label: l, description: 'library' }, vscode.CompletionItemKind.Module);
              i.sortText = `2${l}`;
              i.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
              i.insertText = `${l}.`;
              return i;
            });
            for (const lib of libs) { items.push(...(await catalog.tablesIn(lib)).map(t => tableItem(t))); }
            return items;
          }
          if (ctx.kind === 'qualified') {
            const ref = refs.find(r => r.alias === ctx.qualifier || (!r.alias && r.table === ctx.qualifier)) ?? refs.find(r => r.table === ctx.qualifier);
            if (ref) {
              const cols = await catalog.columnsOf(ref);
              return cols?.list.map(c => columnItem(c, ref.alias ?? ref.table)) ?? [];
            }
            // Not an alias: treat the qualifier as a library.
            return (await catalog.tablesIn(ctx.qualifier)).map(t => tableItem(t));
          }
          const items: vscode.CompletionItem[] = [];
          for (const ref of refs.slice(0, 8)) {
            const cols = await catalog.columnsOf(ref);
            cols?.list.forEach(c => items.push(columnItem(c, ref.alias ?? ref.table)));
            if (ref.alias) {
              const a = new vscode.CompletionItem({ label: ref.alias, description: `alias of ${ref.schema ? ref.schema + '.' : ''}${ref.table}` }, vscode.CompletionItemKind.Variable);
              a.sortText = `0${ref.alias}`;
              items.push(a);
            }
          }
          for (const k of KEYWORDS) {
            const i = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
            i.sortText = `9${k}`;
            items.push(i);
          }
          return items;
        } catch (e) {
          log(`SQL completion: ${e}`);
          return [];
        }
      },
    }, '.', '/', ' '),

    vscode.languages.registerHoverProvider(SQL, {
      async provideHover(doc, pos) {
        if (!manager.connection) { return undefined; }
        const range = doc.getWordRangeAtPosition(pos, /"[^"]+"|[A-Za-z$#@_][\w$#@]*/);
        if (!range) { return undefined; }
        const word = doc.getText(range).replace(/^"|"$/g, '');
        const upper = word.toUpperCase();
        const { text } = statementAround(doc, pos);
        const refs = tableReferences(text);
        try {
          // Hovering a table (or its alias): list its columns.
          const tableRef: TableRef | undefined = refs.find(r => r.table === upper || r.table === word || r.alias === upper);
          if (tableRef) {
            const cols = await catalog.columnsOf(tableRef);
            if (!cols) { return undefined; }
            const md = new vscode.MarkdownString(`**${cols.schema}.${tableRef.table}** — ${cols.list.length} columns\n\n| Column | Type | Text |\n|---|---|---|\n` +
              cols.list.slice(0, 60).map(c => `| ${c.name} | ${typeLabel(c)} | ${c.text.replace(/\|/g, '\\|')} |`).join('\n') +
              (cols.list.length > 60 ? `\n\n…and ${cols.list.length - 60} more` : ''));
            return new vscode.Hover(md, range);
          }
          // Hovering a column of one of the statement's tables.
          for (const ref of refs.slice(0, 8)) {
            const cols = await catalog.columnsOf(ref);
            const c = cols?.list.find(x => x.name === upper || x.name === word);
            if (c && cols) {
              return new vscode.Hover(new vscode.MarkdownString(
                `**${c.name}** \`${typeLabel(c)}\`  \n${c.text ? c.text + '  \n' : ''}_${cols.schema}.${ref.table}_`), range);
            }
          }
        } catch (e) { log(`SQL hover: ${e}`); }
        return undefined;
      },
    }),
  );
}
