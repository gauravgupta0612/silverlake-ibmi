// Db2 for i schema browser (every SQL object of a schema by kind, with its SQL source one click away) and a stored
// procedure caller with a typed form for the parameters that shows OUT values and result rows.
import * as vscode from 'vscode';
import {
  callPlan, checkSchema, countByKind, ddlTypes, KIND_LABEL, parametersSql, ProcParam, schemaQueries, SchemaKind, SchemaObject, sqlTypeOf, toProcParam, toSchemaObject,
} from '../core/schemaObjects';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { sqlString } from '../core/util';
import { reportProgress, showReport } from './reportPanel';

const ALLOWED = new Set(['vanthrex.schemaBrowser', 'vanthrex.schema.row', 'vanthrex.callProcedure']);
const LAST_SCHEMA = 'vanthrex.schemaBrowser.last';
const LAST_VALUES = 'vanthrex.callProcedure.values';
type Row = Record<string, unknown>;
/** Kind names as shown (literal calls so they are translated). */
const kindText = (k: SchemaKind): string => ({
  table: vscode.l10n.t('Table'), view: vscode.l10n.t('View'), index: vscode.l10n.t('Index'), alias: vscode.l10n.t('Alias'), mqt: vscode.l10n.t('Materialized query table'),
  physical: vscode.l10n.t('Physical file'), logical: vscode.l10n.t('Logical file'), procedure: vscode.l10n.t('Procedure'), function: vscode.l10n.t('Function'),
  trigger: vscode.l10n.t('Trigger'), sequence: vscode.l10n.t('Sequence'), variable: vscode.l10n.t('Global variable'),
} as Record<SchemaKind, string>)[k];

async function askSchema(manager: ConnectionManager, state: vscode.Memento, given?: unknown): Promise<string | undefined> {
  if (typeof given === 'string' && given.trim()) { return checkSchema(given); }
  const g = given as { library?: string; name?: string; kind?: string } | undefined;
  if (g?.kind === 'library' && g.name) { return checkSchema(g.name); }
  if (g?.library && !g.name) { return checkSchema(g.library); }
  const conn = manager.require();
  const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Schema (library) to browse'), value: state.get<string>(LAST_SCHEMA) || conn.profile.currentLibrary || '',
    validateInput: x => { try { checkSchema(x); return undefined; } catch (e) { return errorMessage(e); } } });
  return v ? checkSchema(v) : undefined;
}

async function browse(manager: ConnectionManager, state: vscode.Memento, arg?: unknown): Promise<void> {
  const schema = await askSchema(manager, state, arg);
  if (!schema) { return; }
  await state.update(LAST_SCHEMA, schema);
  const conn = manager.require();
  const { objects, failed } = await reportProgress('schema', vscode.l10n.t('Reading the objects of {0}…', schema), async () => {
    const objects: SchemaObject[] = []; const failed: string[] = [];
    await Promise.all(schemaQueries(schema).map(async q => {
      try { objects.push(...(await conn.cachedRows<Row>(q.sql, 20000, 15_000)).map(toSchemaObject).filter((o): o is SchemaObject => !!o)); }
      catch (e) { failed.push(`${q.label}: ${errorMessage(e).split('\n')[0]}`); }
    }));
    return { objects, failed };
  });
  const order = Object.keys(KIND_LABEL) as SchemaKind[];
  objects.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
  showReport('schema', {
    title: vscode.l10n.t('Schema {0}', schema), subtitle: vscode.l10n.t('{0} SQL object(s) on {1}. Click an object for its SQL source, data, or to call it.', objects.length, conn.profile.name),
    facts: countByKind(objects).map(([k, n]) => [kindText(k), n]),
    actions: [{ label: vscode.l10n.t('Refresh'), command: 'vanthrex.schemaBrowser', args: [schema] }, { label: vscode.l10n.t('Another schema…'), command: 'vanthrex.schemaBrowser', args: [{}] }],
    tables: [{ title: vscode.l10n.t('Objects'), filter: true, columns: ['Kind', 'Name', 'System name', 'On', 'Details'],
      rows: objects.map(o => [kindText(o.kind), o.name, o.systemName === o.name ? '' : o.systemName, o.on, o.detail.slice(0, 200)]),
      rowActions: objects.map(o => ({ label: vscode.l10n.t('Options…'), command: 'vanthrex.schema.row', args: [schema, o] })),
      empty: vscode.l10n.t('No SQL objects in {0}.', schema) }],
    note: failed.length ? vscode.l10n.t('Some kinds could not be read: {0}', failed.join(' · ')) : undefined,
  }, ALLOWED);
}

async function generateSql(manager: ConnectionManager, schema: string, o: SchemaObject): Promise<void> {
  const conn = manager.require();
  if (!conn.sqlKeepsJob) { throw new Error(vscode.l10n.t('Generate SQL needs the Mapepire SQL engine (it reads the result from QTEMP). Change the SQL engine in the connection settings.')); }
  const name = o.specific ?? o.name;
  let lines: string[] = []; let lastError = '';
  for (const type of ddlTypes(o.kind)) {
    try {
      const res = await conn.sql(`CALL QSYS2.GENERATE_SQL(DATABASE_OBJECT_NAME => ${sqlString(name)}, DATABASE_OBJECT_LIBRARY_NAME => ${sqlString(schema)}, ` +
        `DATABASE_OBJECT_TYPE => '${type}', CREATE_OR_REPLACE_OPTION => '1', PRIVILEGES_OPTION => '0')`, 100000);
      lines = res.rows.map(r => String(r.SRCDTA ?? Object.values(r).pop() ?? ''));
      if (!lines.length) { lines = (await conn.rows<Row>('SELECT SRCDTA FROM QTEMP.Q_GENSQL ORDER BY SRCSEQ', 100000)).map(r => String(r.SRCDTA ?? '')); }
      if (lines.length) { break; }
    } catch (e) { lastError = errorMessage(e); }
  }
  if (!lines.length) { throw new Error(vscode.l10n.t('Could not generate SQL for {0}.{1}: {2}', schema, o.name, lastError || '—')); }
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `-- ${KIND_LABEL[o.kind]} ${schema}.${o.name} (QSYS2.GENERATE_SQL)\n` + lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n' });
  await vscode.window.showTextDocument(doc);
}

async function rowOptions(manager: ConnectionManager, state: vscode.Memento, schema: string, o: SchemaObject): Promise<void> {
  const data = ['table', 'view', 'physical', 'logical', 'mqt', 'alias'].includes(o.kind);
  const items: (vscode.QuickPickItem & { id: string })[] = [
    { label: vscode.l10n.t('$(code) Show SQL source (CREATE statement)'), id: 'ddl' },
    ...(o.kind === 'procedure' ? [{ label: vscode.l10n.t('$(play) Call this procedure…'), id: 'call' }] : []),
    ...(data ? [{ label: vscode.l10n.t('$(table) Query the data…'), id: 'query' }, { label: vscode.l10n.t('$(edit) Edit the data…'), id: 'edit' }] : []),
    ...(o.kind === 'table' || o.kind === 'physical' ? [{ label: vscode.l10n.t('$(references) What depends on this table?'), id: 'deps' }] : []),
    { label: vscode.l10n.t('$(copy) Copy name'), id: 'copy' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: `${kindText(o.kind)} ${schema}.${o.name}` });
  if (!pick) { return; }
  const sys = { library: schema, name: o.systemName || o.name, type: '*FILE' };
  switch (pick.id) {
    case 'ddl': await generateSql(manager, schema, o); break;
    case 'call': await callProcedure(manager, { schema, name: o.name, specific: o.specific ?? o.name }, state); break;
    case 'query': await vscode.commands.executeCommand('vanthrex.sqlQuery', sys); break;
    case 'edit': await vscode.commands.executeCommand('vanthrex.editData', sys); break;
    case 'deps': await vscode.commands.executeCommand('vanthrex.tableDependents', sys); break;
    case 'copy': await vscode.env.clipboard.writeText(`${schema}.${o.name}`); break;
  }
}

async function readParams(manager: ConnectionManager, schema: string, specific: string): Promise<ProcParam[]> {
  const conn = manager.require();
  try { return (await conn.rows<Row>(parametersSql(schema, specific), 500)).map(toProcParam); }
  catch { return (await conn.rows<Row>(parametersSql(schema, specific, false), 500)).map(toProcParam); }
}

async function findProcedure(manager: ConnectionManager): Promise<{ schema: string; name: string; specific: string } | undefined> {
  const conn = manager.require();
  const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Procedure to call'), placeHolder: 'MYLIB.MYPROC', prompt: vscode.l10n.t('schema.procedure (or only the name to search the library list)') });
  if (!text?.trim()) { return undefined; }
  const [a, b] = text.trim().toUpperCase().split('.');
  const where = b ? `ROUTINE_SCHEMA = ${sqlString(checkSchema(a))} AND ROUTINE_NAME = ${sqlString(b)}` : `ROUTINE_NAME = ${sqlString(a)}`;
  const rows = await conn.rows<Row>(`SELECT ROUTINE_SCHEMA AS S, ROUTINE_NAME AS N, SPECIFIC_NAME AS SN, COALESCE(ROUTINE_TEXT, '') AS D FROM QSYS2.SYSROUTINES WHERE ROUTINE_TYPE = 'PROCEDURE' AND ${where} ORDER BY ROUTINE_SCHEMA FETCH FIRST 50 ROWS ONLY`, 50)
    .catch(async () => conn.rows<Row>(`SELECT ROUTINE_SCHEMA AS S, ROUTINE_NAME AS N, SPECIFIC_NAME AS SN, '' AS D FROM QSYS2.SYSROUTINES WHERE ROUTINE_TYPE = 'PROCEDURE' AND ${where} FETCH FIRST 50 ROWS ONLY`, 50));
  if (!rows.length) { vscode.window.showWarningMessage(vscode.l10n.t('No procedure {0} found.', text.trim())); return undefined; }
  const items = rows.map(r => ({ label: `${String(r.S).trim()}.${String(r.N).trim()}`, description: String(r.SN).trim(), detail: String(r.D ?? '').trim() || undefined, r }));
  const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Which procedure?') });
  return pick ? { schema: String(pick.r.S).trim(), name: String(pick.r.N).trim(), specific: String(pick.r.SN).trim() } : undefined;
}

async function callProcedure(manager: ConnectionManager, target?: { schema: string; name: string; specific: string }, state?: vscode.Memento): Promise<void> {
  target ??= await findProcedure(manager);
  if (!target) { return; }
  const conn = manager.require();
  const params = await readParams(manager, target.schema, target.specific);
  const outs = params.filter(p => p.mode !== 'IN');
  if (outs.length && !conn.sqlKeepsJob) { throw new Error(vscode.l10n.t('This procedure has OUT parameters: calling it needs the Mapepire SQL engine (the values come back through QTEMP).')); }
  const key = `${target.schema}.${target.specific}`;
  const remembered = state?.get<Record<string, Record<number, string>>>(LAST_VALUES, {})[key] ?? {};
  const values: Record<number, string> = {};
  for (const p of params.filter(x => x.mode !== 'OUT')) {
    const v = await vscode.window.showInputBox({
      title: vscode.l10n.t('{0} — parameter {1} of {2}', target.name, p.position, params.length),
      prompt: `${p.name || `P${p.position}`} ${p.mode} ${sqlTypeOf(p)}${p.hasDefault ? ' · ' + vscode.l10n.t('empty = default') : ''} · ${vscode.l10n.t('NULL for null')}`,
      value: remembered[p.position] ?? '', ignoreFocusOut: true,
      validateInput: x => { try { callPlan(target!.schema, target!.name, [p], { [p.position]: x }); return undefined; } catch (e) { return errorMessage(e); } },
    });
    if (v === undefined) { return; }
    values[p.position] = v;
  }
  if (state) { await state.update(LAST_VALUES, { ...state.get<Record<string, Record<number, string>>>(LAST_VALUES, {}), [key]: values }); }
  const plan = callPlan(target.schema, target.name, params, values, /[^A-Z0-9_$#@]/.test(target.name));
  const started = Date.now();
  const result = await reportProgress('callproc', vscode.l10n.t('Calling {0}…', target.name), async () => {
    for (const s of plan.setup) { await conn.sql(s, 1); }
    try {
      const r = await conn.sql(plan.call, 5000);
      const outRow = plan.read ? (await conn.rows<Row>(plan.read, 1))[0] : undefined;
      return { r, outRow };
    } finally { for (const s of plan.cleanup) { await conn.sql(s, 1).catch(() => undefined); } }
  });
  const ms = Date.now() - started;
  showReport('callproc', {
    title: vscode.l10n.t('CALL {0}.{1}', target.schema, target.name), subtitle: vscode.l10n.t('Finished in {0} ms.', ms),
    facts: [
      ...params.filter(p => p.mode !== 'OUT').map(p => [`${p.name || `P${p.position}`} (${p.mode})`, values[p.position] === '' ? (p.hasDefault ? 'DEFAULT' : "''") : values[p.position]] as [string, string]),
      ...outs.map(p => [`${p.name || `P${p.position}`} → (${p.mode})`, String(result.outRow?.[p.name || `P${p.position}`] ?? 'NULL')] as [string, string]),
    ],
    actions: [{ label: vscode.l10n.t('Call again…'), command: 'vanthrex.callProcedure', args: [target] }],
    tables: result.r.columns.length ? [{ title: vscode.l10n.t('Result set'), filter: true, columns: result.r.columns,
      rows: result.r.rows.map(row => result.r.columns.map(c => (row[c] === null || row[c] === undefined ? null : typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c] as string | number))) }] : [],
    note: vscode.l10n.t('Statement: {0}', plan.call),
  }, ALLOWED);
}

export function registerSchema(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.schemaBrowser', wrap((arg?: unknown) => browse(manager, context.globalState, arg))),
    vscode.commands.registerCommand('vanthrex.schema.row', wrap((schema: string, o: SchemaObject) => rowOptions(manager, context.globalState, schema, o))),
    vscode.commands.registerCommand('vanthrex.callProcedure', wrap((t?: { schema: string; name: string; specific: string }) =>
      callProcedure(manager, t && typeof t === 'object' && 'specific' in t ? t : undefined, context.globalState))),
  );
}
