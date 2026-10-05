import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, log } from '../core/log';
import { isValidSystemName, sqlString } from '../core/util';
import { isReadOnlySql, limitRows } from '../core/sqlSafety';
import { clampSource, parseObjectRef, rowsToText } from './prompts';

// Language model tools: used by the @vanthrex chat participant and available to Copilot agent mode
// (reference them in a prompt as #ibmiQuery, #ibmiSource, #ibmiObject, #ibmiSearch, #ibmiStatus).

const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

function cfg() { return vscode.workspace.getConfiguration('vanthrex'); }

function requireConn(manager: ConnectionManager) {
  const c = manager.connection;
  if (!c) { throw new Error('No IBM i system is connected in Vanthrex. Ask the user to connect first (Vanthrex view → click a connection).'); }
  return c;
}

const MEMBER = /^([A-Z$#@][A-Z0-9$#@_.]{0,9})\/([A-Z$#@][A-Z0-9$#@_.]{0,9})\(([A-Z$#@][A-Z0-9$#@_.]{0,9})\)$/;

interface QueryInput { sql: string; maxRows?: number }
interface SourceInput { member: string }
interface ObjectInput { object: string; type?: string }
interface SearchInput { pattern: string; type?: string; library?: string }

export function registerAiTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  if (!vscode.lm?.registerTool) { log('Language model tools API not available in this VS Code — AI tools disabled'); return; }

  const query: vscode.LanguageModelTool<QueryInput> = {
    prepareInvocation(options) {
      const sql = String(options.input?.sql ?? '');
      if (!cfg().get<boolean>('ai.confirmQueries', true)) { return { invocationMessage: 'Querying Db2 for i…' }; }
      return {
        invocationMessage: 'Querying Db2 for i…',
        confirmationMessages: {
          title: 'Run this read-only query on the IBM i?',
          message: new vscode.MarkdownString('```sql\n' + sql + '\n```\nOnly SELECT / WITH / VALUES statements are allowed. Turn off confirmations with `vanthrex.ai.confirmQueries`.'),
        },
      };
    },
    async invoke(options) {
      if (!cfg().get<boolean>('ai.allowQueries', true)) { return text('Running queries is turned off (setting vanthrex.ai.allowQueries).'); }
      const conn = requireConn(manager);
      const sql = String(options.input?.sql ?? '').trim();
      if (!isReadOnlySql(sql)) { return text('Refused: only a single read-only SELECT, WITH or VALUES statement can be run. Write changes out for the user instead.'); }
      const max = Math.min(200, Math.max(1, Number(options.input?.maxRows) || 50));
      try {
        const r = await conn.sql(limitRows(sql, max), max);
        return text(`${r.rows.length} row(s)${r.truncated ? ' (more exist)' : ''}:\n${rowsToText(r.columns, r.rows)}`);
      } catch (e) { return text(`The query failed: ${errorMessage(e)}`); }
    },
  };

  const source: vscode.LanguageModelTool<SourceInput> = {
    prepareInvocation(options) {
      const ref = String(options.input?.member ?? '');
      // Members are source; an IFS path could be any file the user can read, so ask first.
      if (!ref.startsWith('/')) { return { invocationMessage: `Reading ${ref || 'source'}…` }; }
      return {
        invocationMessage: `Reading ${ref}…`,
        confirmationMessages: { title: 'Let the AI read this IFS file?', message: new vscode.MarkdownString(`\`${ref}\` will be read from the IBM i and sent to the language model.`) },
      };
    },
    async invoke(options) {
      const conn = requireConn(manager);
      const ref = String(options.input?.member ?? '').trim();
      const max = cfg().get<number>('ai.maxSourceChars', 60000);
      try {
        let body: string;
        const m = ref.toUpperCase().match(MEMBER);
        if (m) { body = await conn.readMember(m[1], m[2], m[3]); }
        else if (ref.startsWith('/')) { body = (await conn.readStreamFile(ref)).toString('utf8'); }
        else { return text('Give the member as LIBRARY/FILE(MEMBER), for example MYLIB/QRPGLESRC(ORDENTRY), or an IFS path starting with /.'); }
        const c = clampSource(body, max);
        return text(`${ref}:\n${c.text}${c.truncated ? '\n…(cut)' : ''}`);
      } catch (e) { return text(`Could not read ${ref}: ${errorMessage(e)}`); }
    },
  };

  const object: vscode.LanguageModelTool<ObjectInput> = {
    prepareInvocation(options) { return { invocationMessage: `Looking up ${options.input?.object ?? 'object'}…` }; },
    async invoke(options) {
      const conn = requireConn(manager);
      const ref = parseObjectRef(`${options.input?.object ?? ''} ${options.input?.type ?? ''}`);
      if (!ref) { return text('Give the object as LIBRARY/NAME, for example MYLIB/CUSTMAST.'); }
      const type = ref.type ?? '*ALL';
      const out: string[] = [];
      try {
        const rows = await conn.rows<Record<string, unknown>>(
          `SELECT OBJNAME, OBJTYPE, OBJATTRIBUTE, OBJTEXT, OBJOWNER, OBJSIZE, OBJCREATED, CHANGE_TIMESTAMP, LAST_USED_TIMESTAMP, DAYS_USED_COUNT, ` +
          `SOURCE_LIBRARY, SOURCE_FILE, SOURCE_MEMBER, JOURNALED FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(ref.library)}, ${sqlString(type)}, ${sqlString(ref.name)}))`, 5);
        if (!rows.length) { return text(`${ref.library}/${ref.name} ${type} was not found.`); }
        out.push(rowsToText(Object.keys(rows[0]), rows));
        const t = String(rows[0].OBJTYPE ?? '').trim();
        if (t === '*FILE') {
          const cols = await conn.rows<Record<string, unknown>>(
            `SELECT SYSTEM_COLUMN_NAME AS NAME, DATA_TYPE AS TYPE, LENGTH, NUMERIC_SCALE AS SCALE, IS_NULLABLE AS NULLS, COALESCE(COLUMN_TEXT, '') AS TEXT ` +
            `FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(ref.library)} AND SYSTEM_TABLE_NAME = ${sqlString(ref.name)} ORDER BY ORDINAL_POSITION`, 500);
          out.push(`Columns:\n${rowsToText(['NAME', 'TYPE', 'LENGTH', 'SCALE', 'NULLS', 'TEXT'], cols)}`);
          const keys = await conn.rows<Record<string, unknown>>(
            `SELECT INDEX_NAME, INDEX_SCHEMA, COLUMN_NAMES FROM QSYS2.SYSINDEXSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(ref.library)} AND SYSTEM_TABLE_NAME = ${sqlString(ref.name)} FETCH FIRST 20 ROWS ONLY`, 20)
            .catch(() => []);
          if (keys.length) { out.push(`Indexes / logical files:\n${rowsToText(Object.keys(keys[0]), keys)}`); }
        }
        if (t === '*PGM' || t === '*SRVPGM') {
          const mods = await conn.rows<Record<string, unknown>>(
            `SELECT BOUND_MODULE, BOUND_MODULE_LIBRARY, SOURCE_FILE_LIBRARY, SOURCE_FILE, SOURCE_FILE_MEMBER, MODULE_ATTRIBUTE FROM QSYS2.BOUND_MODULE_INFO ` +
            `WHERE PROGRAM_LIBRARY = ${sqlString(ref.library)} AND PROGRAM_NAME = ${sqlString(ref.name)} FETCH FIRST 30 ROWS ONLY`, 30).catch(() => []);
          if (mods.length) { out.push(`Modules:\n${rowsToText(Object.keys(mods[0]), mods)}`); }
        }
      } catch (e) { out.push(`Lookup failed: ${errorMessage(e)}`); }
      return text(out.join('\n\n'));
    },
  };

  const search: vscode.LanguageModelTool<SearchInput> = {
    prepareInvocation(options) { return { invocationMessage: `Searching objects for "${options.input?.pattern ?? ''}"…` }; },
    async invoke(options) {
      const conn = requireConn(manager);
      const pattern = String(options.input?.pattern ?? '').trim().toUpperCase();
      if (!pattern) { return text('Give a name or text pattern (use * as a wildcard).'); }
      const like = pattern.includes('*') ? pattern.replace(/\*/g, '%') : `%${pattern}%`;
      const type = /^\*[A-Z]+$/.test(String(options.input?.type ?? '').toUpperCase()) ? String(options.input!.type).toUpperCase() : '*ALL';
      const lib = String(options.input?.library ?? '').trim().toUpperCase();
      const libs = lib && isValidSystemName(lib) ? [lib] : [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean) as string[])];
      if (!libs.length) { return text('The library list is empty; give a library.'); }
      const sql = libs.map(l => `SELECT OBJLIB, OBJNAME, OBJTYPE, COALESCE(OBJATTRIBUTE, '') AS ATTR, COALESCE(OBJTEXT, '') AS TEXT ` +
        `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(l)}, ${sqlString(type)})) WHERE OBJNAME LIKE ${sqlString(like)} OR UPPER(COALESCE(OBJTEXT, '')) LIKE ${sqlString(like)}`)
        .join(' UNION ALL ') + ' ORDER BY OBJNAME FETCH FIRST 60 ROWS ONLY';
      try {
        const rows = await conn.rows<Record<string, unknown>>(sql, 60);
        return text(`Searched ${libs.join(', ')}:\n${rowsToText(['OBJLIB', 'OBJNAME', 'OBJTYPE', 'ATTR', 'TEXT'], rows)}`);
      } catch (e) { return text(`Search failed: ${errorMessage(e)}`); }
    },
  };

  const status: vscode.LanguageModelTool<Record<string, never>> = {
    prepareInvocation() { return { invocationMessage: 'Checking the system status…' }; },
    async invoke() {
      const conn = requireConn(manager);
      const out: string[] = [];
      const add = async (title: string, sql: string, n = 20) => {
        try { const r = await conn.sql(sql, n); out.push(`${title}:\n${rowsToText(r.columns, r.rows)}`); }
        catch (e) { out.push(`${title}: not available (${errorMessage(e)})`); }
      };
      await add('System', 'SELECT AVERAGE_CPU_UTILIZATION AS CPU_PCT, SYSTEM_ASP_USED AS ASP_PCT, TOTAL_JOBS_IN_SYSTEM AS JOBS, ACTIVE_JOBS_IN_SYSTEM AS ACTIVE FROM QSYS2.SYSTEM_STATUS_INFO', 1);
      await add('Jobs waiting for a reply (MSGW)', "SELECT JOB_NAME, SUBSYSTEM, FUNCTION, JOB_STATUS FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) WHERE JOB_STATUS = 'MSGW' FETCH FIRST 20 ROWS ONLY");
      await add('Latest QSYSOPR messages', "SELECT MESSAGE_ID, SEVERITY, VARCHAR(MESSAGE_TIMESTAMP) AS TIME, MESSAGE_TEXT FROM QSYS2.MESSAGE_QUEUE_INFO WHERE MESSAGE_QUEUE_NAME = 'QSYSOPR' ORDER BY MESSAGE_TIMESTAMP DESC FETCH FIRST 10 ROWS ONLY");
      return text(out.join('\n\n'));
    },
  };

  context.subscriptions.push(
    vscode.lm.registerTool('vanthrex_runQuery', query),
    vscode.lm.registerTool('vanthrex_readSource', source),
    vscode.lm.registerTool('vanthrex_describeObject', object),
    vscode.lm.registerTool('vanthrex_searchObjects', search),
    vscode.lm.registerTool('vanthrex_systemStatus', status),
  );
}
