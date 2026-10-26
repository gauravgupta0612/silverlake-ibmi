import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { errorMessage, log } from '../core/log';
import { isValidSystemName, sqlString } from '../core/util';
import { isReadOnlySql, limitRows } from '../core/sqlSafety';
import { blockedForAi, isSensitiveColumn, sensitiveRefs, SENSITIVE_COLUMNS } from '../core/aiGuard';
import { tablesInSql } from './context';
import { commandMarkdown } from '../core/clAssist';
import { commandDefinition } from '../features/prompter';
import { clampSource, parseObjectRef, rowsToText } from './prompts';
import { checkLibraries, dataAccess, isDenied, outbound, safeRows } from './guard';

const aiCfg = () => vscode.workspace.getConfiguration('vanthrex.ai');

// Language model tools: used by the @vanthrex chat participant and available to Copilot agent mode
// (reference them in a prompt as #ibmiQuery, #ibmiSource, #ibmiObject, #ibmiSearch, #ibmiStatus, #ibmiMessage,
// #ibmiMembers, #ibmiCommand, #ibmiIndexes). Every result goes through the AI guard: secrets and personal data hidden,
// sensitive columns masked, denied libraries refused, production systems limited to metadata.

const plain = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

function cfg() { return vscode.workspace.getConfiguration('vanthrex'); }

function requireConn(manager: ConnectionManager) {
  const c = manager.connection;
  if (!c) { throw new Error(vscode.l10n.t('No IBM i system is connected in Vanthrex. Ask the user to connect first (Vanthrex view → click a connection).')); }
  if (dataAccess(c) === 'none') { throw new Error(vscode.l10n.t('The AI may not read this system (setting vanthrex.ai.productionData or vanthrex.ai.otherSystemsData is "none").')); }
  return c;
}

const MEMBER = /^([A-Z$#@][A-Z0-9$#@_.]{0,9})\/([A-Z$#@][A-Z0-9$#@_.]{0,9})\(([A-Z$#@][A-Z0-9$#@_.]{0,9})\)$/;

interface QueryInput { sql: string; maxRows?: number }
interface SourceInput { member: string }
interface ObjectInput { object: string; type?: string }
interface SearchInput { pattern: string; type?: string; library?: string }
interface MessageInput { id: string }
interface MembersInput { sourceFile: string; pattern?: string }
interface CommandInput { command: string }
interface IndexInput { table: string }

export function registerAiTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  if (!vscode.lm?.registerTool) { log('Language model tools API not available in this VS Code — AI tools disabled'); return; }

  /** Run a tool body; whatever it returns is redacted and audited, errors become an answer for the model. */
  const run = async (tool: string, what: string, fn: () => Promise<string>): Promise<vscode.LanguageModelToolResult> => {
    try { return plain(outbound(`tool ${tool}`, what, await fn(), manager.connection)); }
    catch (e) { return plain(outbound(`tool ${tool}`, what, `${tool} failed: ${errorMessage(e)}`, manager.connection)); }
  };

  const query: vscode.LanguageModelTool<QueryInput> = {
    prepareInvocation(options) {
      const sql = String(options.input?.sql ?? '');
      if (!cfg().get<boolean>('ai.confirmQueries', true)) { return { invocationMessage: 'Querying Db2 for i…' }; }
      return {
        invocationMessage: 'Querying Db2 for i…',
        confirmationMessages: {
          title: vscode.l10n.t('Run this read-only query on the IBM i?'),
          message: new vscode.MarkdownString('```sql\n' + sql + '\n```\n' + vscode.l10n.t('Only SELECT / WITH / VALUES statements are allowed. Secrets and personal data in the result are hidden and sensitive columns masked before the AI sees them. Turn off confirmations with `vanthrex.ai.confirmQueries`.')),
        },
      };
    },
    invoke: options => run('runQuery', 'query result', async () => {
      if (!cfg().get<boolean>('ai.allowQueries', true)) { return 'Running queries is turned off (setting vanthrex.ai.allowQueries).'; }
      const conn = requireConn(manager);
      const sql = String(options.input?.sql ?? '').trim();
      if (!isReadOnlySql(sql)) { return 'Refused: only a single read-only SELECT, WITH or VALUES statement can be run. Write changes out for the user instead.'; }
      if (dataAccess(conn) === 'metadata') {
        return `Refused: ${conn.profile.name} is a protected system, so the AI cannot run its own queries there. Use the describe-object, search-objects, list-members and index tools (catalog facts only), or write the query out for the user to run.`;
      }
      checkLibraries(sql);
      const blocked = blockedForAi(sql);
      if (blocked) { return `Refused: ${blocked}. Write the statement out for the user instead.`; }
      // Unqualified tables are found through the library list: refuse when a library the AI may not see is in it.
      const libl = [conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean) as string[];
      if (tablesInSql(sql).some(t => !t.library) && libl.some(l => isDenied(l))) { return 'Refused: qualify the table names (LIBRARY.TABLE): the library list contains a library that is not shared with the AI.'; }
      const max = Math.min(200, Math.max(1, Number(options.input?.maxRows) || 50));
      const r = await conn.sql(limitRows(sql, max), max);
      // A sensitive column renamed with AS or used in an expression would not be masked by its result name.
      const patterns = aiCfg().get<string[]>('sensitiveColumns', SENSITIVE_COLUMNS);
      const hiddenUse = sensitiveRefs(sql, patterns).filter(w => !r.columns.some(c => c.toUpperCase() === w) && !/^(QSYS2|SYSIBM|SYSTOOLS)$/.test(w));
      if (hiddenUse.length) { return `Refused: the query uses ${hiddenUse.join(', ')}, which hold sensitive data, under another name or in an expression. Select the column by its own name (it is masked) or leave it out.`; }
      void isSensitiveColumn;
      const safe = safeRows(r.columns, r.rows);
      return `${r.rows.length} row(s)${r.truncated ? ' (more exist)' : ''}${safe.masked.length ? `; columns masked for privacy: ${safe.masked.join(', ')}` : ''}:\n${rowsToText(r.columns, safe.rows)}`;
    }),
  };

  const source: vscode.LanguageModelTool<SourceInput> = {
    prepareInvocation(options) {
      const ref = String(options.input?.member ?? '');
      // Members are source; an IFS path could be any file the user can read, so ask first.
      if (!ref.startsWith('/')) { return { invocationMessage: `Reading ${ref || 'source'}…` }; }
      return {
        invocationMessage: `Reading ${ref}…`,
        confirmationMessages: { title: vscode.l10n.t('Let the AI read this IFS file?'), message: new vscode.MarkdownString(vscode.l10n.t('`{0}` will be read from the IBM i and sent to the language model (secrets and personal data hidden).', ref)) },
      };
    },
    invoke: options => run('readSource', String(options.input?.member ?? ''), async () => {
      const conn = requireConn(manager);
      const ref = String(options.input?.member ?? '').trim();
      const max = cfg().get<number>('ai.maxSourceChars', 60000);
      const m = ref.toUpperCase().match(MEMBER);
      let body: string;
      if (m) {
        checkLibraries(`${m[1]}/X`);
        // Only source files: a member of a data file is business data, not source.
        const ft = await conn.rows<Record<string, unknown>>(`SELECT FILE_TYPE AS T FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(m[1])} AND SYSTEM_TABLE_NAME = ${sqlString(m[2])}`, 1).catch(() => []);
        if (String(ft[0]?.T ?? '').trim() !== 'S') { return `Refused: ${m[1]}/${m[2]} is not a source file (it holds data).`; }
        body = await conn.readMember(m[1], m[2], m[3]);
      } else if (ref.startsWith('/')) {
        if (/^\/QSYS\.LIB\//i.test(ref)) { return 'Refused: give a member as LIBRARY/FILE(MEMBER), not a /QSYS.LIB path.'; }
        checkLibraries(ref);
        if (/\.(key|pem|p12|pfx|kdb|sth|env|jks|keystore|crt|cer|der|netrc|pgpass|htpasswd)$|\/\.ssh\/|\/\.aws\/|\/\.config\/|^\/etc\/|^\/QOpenSys\/etc\/|password|passwd|credential|secret/i.test(ref)) { return `Refused: ${ref} looks like a key, credential or system file.`; }
        if (dataAccess(conn) === 'metadata' && !/\.(rpgle|sqlrpgle|rpgleinc|rpginc|clle|clp|cl|cmd|dspf|prtf|pf|lf|sql|cbl|cblle|sqlcblle|c|cpp|h|java|js|ts|py|sh|md|txt|xml|yaml|yml|json)$/i.test(ref)) {
          return `Refused: ${conn.profile.name} is a protected system; only source files (by their extension) can be read from its IFS.`;
        }
        body = (await conn.readStreamFile(ref)).toString('utf8');
      } else { return 'Give the member as LIBRARY/FILE(MEMBER), for example MYLIB/QRPGLESRC(ORDENTRY), or an IFS path starting with /.'; }
      const c = clampSource(body, max);
      return `${ref}:\n${c.text}${c.truncated ? '\n…(cut)' : ''}`;
    }),
  };

  const object: vscode.LanguageModelTool<ObjectInput> = {
    prepareInvocation(options) { return { invocationMessage: `Looking up ${options.input?.object ?? 'object'}…` }; },
    invoke: options => run('describeObject', String(options.input?.object ?? ''), async () => {
      const conn = requireConn(manager);
      const ref = parseObjectRef(`${options.input?.object ?? ''} ${options.input?.type ?? ''}`);
      if (!ref) { return 'Give the object as LIBRARY/NAME, for example MYLIB/CUSTMAST.'; }
      checkLibraries(`${ref.library}/${ref.name}`);
      const type = ref.type ?? '*ALL';
      const out: string[] = [];
      const rows = await conn.rows<Record<string, unknown>>(
        `SELECT OBJNAME, OBJTYPE, OBJATTRIBUTE, OBJTEXT, OBJOWNER, OBJSIZE, OBJCREATED, CHANGE_TIMESTAMP, LAST_USED_TIMESTAMP, DAYS_USED_COUNT, ` +
        `SOURCE_LIBRARY, SOURCE_FILE, SOURCE_MEMBER, JOURNALED FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(ref.library)}, ${sqlString(type)}, ${sqlString(ref.name)}))`, 5);
      if (!rows.length) { return `${ref.library}/${ref.name} ${type} was not found.`; }
      out.push(rowsToText(Object.keys(rows[0]), rows));
      const t = String(rows[0].OBJTYPE ?? '').trim();
      if (t === '*FILE') {
        const cols = await conn.rows<Record<string, unknown>>(
          `SELECT SYSTEM_COLUMN_NAME AS NAME, DATA_TYPE AS TYPE, LENGTH, NUMERIC_SCALE AS SCALE, IS_NULLABLE AS NULLS, COALESCE(COLUMN_TEXT, '') AS TEXT ` +
          `FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(ref.library)} AND SYSTEM_TABLE_NAME = ${sqlString(ref.name)} ORDER BY ORDINAL_POSITION`, 500);
        out.push(`Columns:\n${rowsToText(['NAME', 'TYPE', 'LENGTH', 'SCALE', 'NULLS', 'TEXT'], cols)}`);
        const keys = await conn.rows<Record<string, unknown>>(
          `SELECT INDEX_NAME, INDEX_SCHEMA, COLUMN_NAMES FROM QSYS2.SYSINDEXSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(ref.library)} AND SYSTEM_TABLE_NAME = ${sqlString(ref.name)} FETCH FIRST 20 ROWS ONLY`, 20).catch(() => []);
        if (keys.length) { out.push(`Indexes / logical files:\n${rowsToText(Object.keys(keys[0]), keys)}`); }
      }
      if (t === '*PGM' || t === '*SRVPGM') {
        const mods = await conn.rows<Record<string, unknown>>(
          `SELECT BOUND_MODULE, BOUND_MODULE_LIBRARY, SOURCE_FILE_LIBRARY, SOURCE_FILE, SOURCE_FILE_MEMBER, MODULE_ATTRIBUTE FROM QSYS2.BOUND_MODULE_INFO ` +
          `WHERE PROGRAM_LIBRARY = ${sqlString(ref.library)} AND PROGRAM_NAME = ${sqlString(ref.name)} FETCH FIRST 30 ROWS ONLY`, 30).catch(() => []);
        if (mods.length) { out.push(`Modules:\n${rowsToText(Object.keys(mods[0]), mods)}`); }
      }
      return out.join('\n\n');
    }),
  };

  const search: vscode.LanguageModelTool<SearchInput> = {
    prepareInvocation(options) { return { invocationMessage: `Searching objects for "${options.input?.pattern ?? ''}"…` }; },
    invoke: options => run('searchObjects', String(options.input?.pattern ?? ''), async () => {
      const conn = requireConn(manager);
      const pattern = String(options.input?.pattern ?? '').trim().toUpperCase();
      if (!pattern) { return 'Give a name or text pattern (use * as a wildcard).'; }
      const like = pattern.includes('*') ? pattern.replace(/\*/g, '%') : `%${pattern}%`;
      const type = /^\*[A-Z]+$/.test(String(options.input?.type ?? '').toUpperCase()) ? String(options.input!.type).toUpperCase() : '*ALL';
      const lib = String(options.input?.library ?? '').trim().toUpperCase();
      if (lib) { checkLibraries(`${lib}/X`); }
      const libs = (lib && isValidSystemName(lib) ? [lib] : [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean) as string[])]).filter(l => !isDenied(l));
      if (!libs.length) { return 'The library list is empty (or not shared with the AI); give a library.'; }
      const sql = libs.map(l => `SELECT OBJLIB, OBJNAME, OBJTYPE, COALESCE(OBJATTRIBUTE, '') AS ATTR, COALESCE(OBJTEXT, '') AS TEXT ` +
        `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(l)}, ${sqlString(type)})) WHERE OBJNAME LIKE ${sqlString(like)} OR UPPER(COALESCE(OBJTEXT, '')) LIKE ${sqlString(like)}`)
        .join(' UNION ALL ') + ' ORDER BY OBJNAME FETCH FIRST 60 ROWS ONLY';
      const rows = await conn.rows<Record<string, unknown>>(sql, 60);
      return `Searched ${libs.join(', ')}:\n${rowsToText(['OBJLIB', 'OBJNAME', 'OBJTYPE', 'ATTR', 'TEXT'], rows)}`;
    }),
  };

  const status: vscode.LanguageModelTool<Record<string, never>> = {
    prepareInvocation() { return { invocationMessage: 'Checking the system status…' }; },
    invoke: () => run('systemStatus', 'system status', async () => systemStatusText(manager)),
  };

  const message: vscode.LanguageModelTool<MessageInput> = {
    prepareInvocation(options) { return { invocationMessage: `Reading the help of ${options.input?.id ?? 'a message'}…` }; },
    invoke: options => run('messageHelp', String(options.input?.id ?? ''), async () => {
      const conn = requireConn(manager);
      const id = String(options.input?.id ?? '').trim().toUpperCase();
      if (!/^[A-Z]{2,3}[0-9A-F]{4,5}$/.test(id)) { return 'Give a message ID such as CPF9801, RNF7030 or SQL0204.'; }
      const rows = await conn.rows<Record<string, unknown>>(`SELECT MESSAGE_FILE_LIBRARY AS LIB, MESSAGE_FILE AS FILE, MESSAGE_TEXT AS TEXT, COALESCE(MESSAGE_SECOND_LEVEL_TEXT, '') AS HELP, SEVERITY ` +
        `FROM QSYS2.MESSAGE_FILE_DATA WHERE MESSAGE_ID = ${sqlString(id)} AND MESSAGE_FILE_LIBRARY = 'QSYS' FETCH FIRST 3 ROWS ONLY`, 3);
      return rows.length ? rows.map(r => `${id} (${String(r.LIB).trim()}/${String(r.FILE).trim()}, severity ${r.SEVERITY}): ${String(r.TEXT).trim()}\n${String(r.HELP).replace(/&N|&P|&B/g, '\n').trim()}`).join('\n\n') : `${id} was not found in the IBM message files.`;
    }),
  };

  const members: vscode.LanguageModelTool<MembersInput> = {
    prepareInvocation(options) { return { invocationMessage: `Listing members of ${options.input?.sourceFile ?? 'a source file'}…` }; },
    invoke: options => run('listMembers', String(options.input?.sourceFile ?? ''), async () => {
      const conn = requireConn(manager);
      const [lib, file] = String(options.input?.sourceFile ?? '').trim().toUpperCase().split('/');
      if (!lib || !file || !isValidSystemName(lib) || !isValidSystemName(file)) { return 'Give the source file as LIBRARY/FILE, for example MYLIB/QRPGLESRC.'; }
      checkLibraries(`${lib}/${file}`);
      const p = String(options.input?.pattern ?? '').trim().toUpperCase();
      const like = p ? (p.includes('*') ? p.replace(/\*/g, '%') : `%${p}%`) : '%';
      const rows = await conn.rows<Record<string, unknown>>(`SELECT SYSTEM_TABLE_MEMBER AS MEMBER, COALESCE(SOURCE_TYPE, '') AS TYPE, VARCHAR_FORMAT(LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD') AS CHANGED, ` +
        `NUMBER_ROWS AS LINES, COALESCE(PARTITION_TEXT, '') AS TEXT FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(file)} ` +
        `AND (SYSTEM_TABLE_MEMBER LIKE ${sqlString(like)} OR UPPER(COALESCE(PARTITION_TEXT, '')) LIKE ${sqlString(like)}) ORDER BY SYSTEM_TABLE_MEMBER FETCH FIRST 200 ROWS ONLY`, 200);
      return `${rows.length} member(s) in ${lib}/${file}:\n${rowsToText(['MEMBER', 'TYPE', 'CHANGED', 'LINES', 'TEXT'], rows)}`;
    }),
  };

  const command: vscode.LanguageModelTool<CommandInput> = {
    prepareInvocation(options) { return { invocationMessage: `Reading the definition of ${options.input?.command ?? 'a command'}…` }; },
    invoke: options => run('commandHelp', String(options.input?.command ?? ''), async () => {
      requireConn(manager);
      const c = String(options.input?.command ?? '').trim().toUpperCase();
      if (!/^([A-Z$#@][A-Z0-9$#@_.]{0,9}\/)?[A-Z$#@][A-Z0-9$#@_.]{0,9}$/.test(c)) { return 'Give a CL command name such as CRTBNDRPG or QSYS/SBMJOB.'; }
      return commandMarkdown(await commandDefinition(manager, c), 80);
    }),
  };

  const indexes: vscode.LanguageModelTool<IndexInput> = {
    prepareInvocation(options) { return { invocationMessage: `Reading the indexes of ${options.input?.table ?? 'a table'}…` }; },
    invoke: options => run('indexAdvice', String(options.input?.table ?? ''), async () => tableFacts(manager, String(options.input?.table ?? ''))),
  };

  context.subscriptions.push(
    vscode.lm.registerTool('vanthrex_runQuery', query),
    vscode.lm.registerTool('vanthrex_readSource', source),
    vscode.lm.registerTool('vanthrex_describeObject', object),
    vscode.lm.registerTool('vanthrex_searchObjects', search),
    vscode.lm.registerTool('vanthrex_systemStatus', status),
    vscode.lm.registerTool('vanthrex_messageHelp', message),
    vscode.lm.registerTool('vanthrex_listMembers', members),
    vscode.lm.registerTool('vanthrex_commandHelp', command),
    vscode.lm.registerTool('vanthrex_indexAdvice', indexes),
  );
}

/** System status for the model (also used by /health). */
export async function systemStatusText(manager: ConnectionManager): Promise<string> {
  const conn = requireConn(manager);
  const out: string[] = [];
  const add = async (title: string, sql: string, n = 20) => {
    try { const r = await conn.sql(sql, n); const s = safeRows(r.columns, r.rows); out.push(`${title}:\n${rowsToText(r.columns, s.rows)}`); }
    catch (e) { out.push(`${title}: not available (${errorMessage(e)})`); }
  };
  await add('System', 'SELECT AVERAGE_CPU_UTILIZATION AS CPU_PCT, SYSTEM_ASP_USED AS ASP_PCT, TOTAL_JOBS_IN_SYSTEM AS JOBS, ACTIVE_JOBS_IN_SYSTEM AS ACTIVE, ' +
    'MAXIMUM_JOBS_IN_SYSTEM AS MAX_JOBS, CURRENT_TEMPORARY_STORAGE AS TEMP_MB FROM QSYS2.SYSTEM_STATUS_INFO', 1);
  await add('Jobs waiting for a reply (MSGW)', "SELECT JOB_NAME, SUBSYSTEM, FUNCTION, JOB_STATUS FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) WHERE JOB_STATUS = 'MSGW' FETCH FIRST 20 ROWS ONLY");
  await add('Top CPU jobs', "SELECT JOB_NAME, SUBSYSTEM, ELAPSED_CPU_PERCENTAGE AS CPU_PCT, TEMPORARY_STORAGE AS TEMP_MB FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) ORDER BY ELAPSED_CPU_PERCENTAGE DESC FETCH FIRST 10 ROWS ONLY");
  await add('Latest QSYSOPR messages', "SELECT MESSAGE_ID, SEVERITY, VARCHAR(MESSAGE_TIMESTAMP) AS TIME, MESSAGE_TEXT FROM QSYS2.MESSAGE_QUEUE_INFO WHERE MESSAGE_QUEUE_NAME = 'QSYSOPR' ORDER BY MESSAGE_TIMESTAMP DESC FETCH FIRST 15 ROWS ONLY");
  await add('Subsystems', 'SELECT SUBSYSTEM_DESCRIPTION AS SUBSYSTEM, STATUS, CURRENT_ACTIVE_JOBS AS JOBS FROM QSYS2.SUBSYSTEM_INFO ORDER BY CURRENT_ACTIVE_JOBS DESC FETCH FIRST 15 ROWS ONLY');
  return out.join('\n\n');
}

/** Table facts for tuning: size, indexes and the optimizer's index advice (metadata only). */
export async function tableFacts(manager: ConnectionManager, table: string): Promise<string> {
  const conn = requireConn(manager);
  const [lib, name] = table.trim().toUpperCase().split(/[./]/);
  if (!lib || !name || !isValidSystemName(lib) || !isValidSystemName(name)) { return 'Give the table as LIBRARY/TABLE.'; }
  checkLibraries(`${lib}/${name}`);
  const q = (sql: string, n = 30) => conn.rows<Record<string, unknown>>(sql, n).catch(e => [{ ERROR: errorMessage(e) }] as Record<string, unknown>[]);
  const [size, idx, adv] = await Promise.all([
    q(`SELECT NUMBER_ROWS, NUMBER_DELETED_ROWS, DATA_SIZE FROM QSYS2.SYSTABLESTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(name)}`, 1),
    q(`SELECT INDEX_SCHEMA, INDEX_NAME, INDEX_TYPE, COLUMN_NAMES, NUMBER_KEY_COLUMNS, LAST_QUERY_USE, QUERY_USE_COUNT FROM QSYS2.SYSINDEXSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(name)} FETCH FIRST 30 ROWS ONLY`),
    q(`SELECT KEY_COLUMNS_ADVISED, INDEX_TYPE, TIMES_ADVISED, LAST_ADVISED, ESTIMATED_CREATION_TIME FROM QSYS2.SYSIXADV WHERE TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(name)} ORDER BY TIMES_ADVISED DESC FETCH FIRST 15 ROWS ONLY`),
  ]);
  const t = (rows: Record<string, unknown>[]) => (rows.length ? rowsToText(Object.keys(rows[0]), rows) : 'none');
  return `Table ${lib}/${name}\nSize:\n${t(size)}\nIndexes and logical files:\n${t(idx)}\nIndex advice from the optimizer:\n${t(adv)}`;
}
