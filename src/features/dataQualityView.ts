// Data quality: a profile of every column of a table, child rows whose parent is missing, columns close to the largest
// value they can hold, objects nobody used for a year, and timing a query run several times.
import * as vscode from 'vscode';
import { capacity, capacitySql, foreignKeys, foreignKeysSql, orphanSql, profileSql, readProfile, timings, topValuesSql, unusedObjects, unusedObjectsSql, ForeignKey, UnusedObject } from '../core/dataQuality';
import { isChangingSql } from '../core/protection';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { assertSystemName, statementAtOffset } from '../core/util';
import { primaryKey, tableColumns } from './modernizeView';
import { reportProgress, showReport } from './reportPanel';

type Row = Record<string, unknown>;
const ALLOWED = new Set(['vanthrex.profileTable', 'vanthrex.profileTable.top', 'vanthrex.orphanRows', 'vanthrex.capacityCheck', 'vanthrex.unusedObjects', 'vanthrex.unusedObjects.commands',
  'vanthrex.sqlBenchmark', 'vanthrex.editData', 'vanthrex.objectInfo']);

async function tableArg(a: unknown, title: string): Promise<{ library: string; name: string } | undefined> {
  const o = a as { library?: string; name?: string } | undefined;
  let lib = o?.library; let name = o?.name;
  if (!lib || !name) {
    const v = await vscode.window.showInputBox({ title, prompt: 'LIBRARY/TABLE', ignoreFocusOut: true, validateInput: x => (/^[^/\s]+\/[^/\s]+$/.test(x.trim()) ? undefined : 'LIBRARY/TABLE') });
    if (!v) { return undefined; }
    [lib, name] = v.trim().toUpperCase().split('/');
  }
  return { library: assertSystemName(lib, 'library'), name: assertSystemName(name, 'table') };
}

// ---------------------------------------------------------------- profile

let lastProfile: { table: string } | undefined;

async function profileTable(manager: ConnectionManager, a?: unknown): Promise<void> {
  const t = await tableArg(a, vscode.l10n.t('Profile which table?'));
  if (!t) { return; }
  const conn = manager.require();
  const sample = vscode.workspace.getConfiguration('vanthrex').get<number>('profileSampleRows', 0) || undefined;
  const { table, cols } = await tableColumns(manager, t.library, t.name);
  const rows = await reportProgress('profile', vscode.l10n.t('Profiling {0} ({1} columns)…', table, cols.length), async () => {
    const out: Row[] = [];
    for (const sql of profileSql(table, cols, sample)) { out.push(...await conn.rows<Row>(sql, 1)); }
    return out;
  });
  const p = readProfile(rows, cols);
  lastProfile = { table };
  const total = p[0]?.total ?? 0;
  showReport('profile', {
    title: vscode.l10n.t('Data profile — {0}', table),
    subtitle: vscode.l10n.t('{0} row(s){1}. Click a column for its most frequent values.', total, sample ? vscode.l10n.t(' (first {0} rows only, vanthrex.profileSampleRows)', sample) : ''),
    facts: [[vscode.l10n.t('Columns'), cols.length], [vscode.l10n.t('Always null'), p.filter(x => x.flags.includes('always null')).length], [vscode.l10n.t('Single value'), p.filter(x => x.flags.some(f => f.startsWith('single value'))).length],
      [vscode.l10n.t('Key candidates'), p.filter(x => x.flags.includes('unique (key candidate)')).map(x => x.name).join(', ') || '—']],
    actions: [{ label: vscode.l10n.t('Edit the data'), command: 'vanthrex.editData', args: [{ library: t.library, name: t.name }] }, { label: vscode.l10n.t('Another table…'), command: 'vanthrex.profileTable' }],
    tables: [{ title: vscode.l10n.t('Columns'), filter: true, columns: ['Column', 'Type', 'Nulls', 'Null %', 'Distinct', 'Smallest', 'Largest', 'Notes'],
      rows: p.map(x => [x.name, x.type, x.nulls, total ? `${Math.round((x.nulls / total) * 100)}%` : '', x.distinct, x.min, x.max, x.flags.join(', ')]),
      rowActions: p.map(x => ({ label: vscode.l10n.t('Top values'), command: 'vanthrex.profileTable.top', args: [x.name] })),
      rowClass: p.map(x => (x.flags.some(f => /always null|single value|dummy/.test(f)) ? 'different' : undefined)) }],
    note: vscode.l10n.t('A full scan of the table: on a large production table run it at a quiet time, or set vanthrex.profileSampleRows.'),
  }, ALLOWED);
}

async function topValues(manager: ConnectionManager, column: string): Promise<void> {
  if (!lastProfile) { return; }
  const rows = await manager.require().rows<Row>(topValuesSql(lastProfile.table, column.replace(/^"|"$/g, '')), 15);
  const total = rows.reduce((s, r) => s + (Number(r.C) || 0), 0);
  const pick = await vscode.window.showQuickPick(rows.map(r => ({ label: r.V === null || r.V === undefined ? '(null)' : String(r.V) === '' ? vscode.l10n.t('(blank)') : String(r.V), description: `${Number(r.C)} ${vscode.l10n.t('row(s)')}`, detail: total ? '█'.repeat(Math.max(1, Math.round((Number(r.C) / total) * 30))) : undefined })),
    { title: vscode.l10n.t('Most frequent values of {0}', column) });
  if (pick) { await vscode.env.clipboard.writeText(pick.label); }
}

// ---------------------------------------------------------------- orphans

async function orphanRows(manager: ConnectionManager, a?: unknown): Promise<void> {
  const t = await tableArg(a, vscode.l10n.t('Check the child rows of which table?'));
  if (!t) { return; }
  const conn = manager.require();
  const { table, cols } = await tableColumns(manager, t.library, t.name);
  const [schema, name] = table.split('.').map(x => x.replace(/^"|"$/g, ''));
  const fks = foreignKeys(await conn.rows<Row>(foreignKeysSql(schema, name), 500).catch(() => [] as Row[]));
  let fk: Pick<ForeignKey, 'child' | 'childCols' | 'parent' | 'parentCols'> & { name?: string } | undefined;
  const custom = vscode.l10n.t('$(edit) Another relation (parent table and columns)…');
  const pick = await vscode.window.showQuickPick([...fks.map(f => ({ label: `$(link) ${f.name}`, description: `${f.childCols.join(', ')} → ${f.parent} (${f.parentCols.join(', ')})`, f })), { label: custom, description: fks.length ? '' : vscode.l10n.t('no foreign key is declared on {0}', table), f: undefined }],
    { title: vscode.l10n.t('Which relation?') });
  if (!pick) { return; }
  if (pick.f) { fk = pick.f; }
  else {
    const p = await vscode.window.showInputBox({ title: vscode.l10n.t('Parent table'), prompt: 'LIBRARY/TABLE', ignoreFocusOut: true, validateInput: x => (/^[^/\s]+\/[^/\s]+$/.test(x.trim()) ? undefined : 'LIBRARY/TABLE') });
    if (!p) { return; }
    const [pl, pt] = p.trim().toUpperCase().split('/');
    const parent = await tableColumns(manager, assertSystemName(pl, 'library'), assertSystemName(pt, 'table'));
    const pk = await primaryKey(manager, parent.table);
    const childCols = await vscode.window.showQuickPick(cols.map(c => ({ label: c.name, picked: pk.includes(c.name) })), { canPickMany: true, title: vscode.l10n.t('Columns of {0} that point to the parent (in key order)', table) });
    if (!childCols?.length) { return; }
    const parentCols = (await vscode.window.showInputBox({ title: vscode.l10n.t('Matching columns of {0}', parent.table), value: (pk.length === childCols.length ? pk : childCols.map(c => c.label)).join(', '), ignoreFocusOut: true }))?.split(',').map(x => x.trim()).filter(Boolean);
    if (!parentCols?.length) { return; }
    fk = { child: table, childCols: childCols.map(c => c.label), parent: parent.table, parentCols };
  }
  const q = orphanSql(fk);
  const res = await reportProgress('orphans', vscode.l10n.t('Looking for rows of {0} without a parent in {1}…', fk.child, fk.parent), async () => ({
    count: Number((await conn.rows<Row>(q.count, 1))[0]?.N ?? 0), rows: await conn.rows<Row>(q.rows, 200) }));
  const keys = fk.childCols;
  showReport('orphans', {
    title: vscode.l10n.t('Orphan rows — {0}', fk.child),
    subtitle: res.count ? vscode.l10n.t('{0} row(s) of {1} point to a {2} that does not exist.', res.count, fk.child, fk.parent) : vscode.l10n.t('Every row of {0} has its parent in {1}.', fk.child, fk.parent),
    facts: [[vscode.l10n.t('Relation'), `${keys.join(', ')} → ${fk.parent} (${fk.parentCols.join(', ')})`], [vscode.l10n.t('Orphan rows'), res.count]],
    actions: [{ label: vscode.l10n.t('Check again…'), command: 'vanthrex.orphanRows', args: [{ library: t.library, name: t.name }] }],
    tables: [{ title: vscode.l10n.t('Missing parents (most rows first)'), filter: true, columns: [...keys, 'Rows'],
      rows: res.rows.map(r => [...Object.values(r).slice(0, keys.length).map(v => (v === null || v === undefined ? null : String(v))), Number(Object.values(r)[keys.length]) || 0]), empty: vscode.l10n.t('None.') }],
    note: vscode.l10n.t('Rows with a null key are not counted. The SQL used: {0}', q.count),
  }, ALLOWED);
}

// ---------------------------------------------------------------- capacity

async function capacityCheck(manager: ConnectionManager, a?: unknown): Promise<void> {
  const t = await tableArg(a, vscode.l10n.t('Check the capacity of which table?'));
  if (!t) { return; }
  const { table, cols } = await tableColumns(manager, t.library, t.name);
  const sql = capacitySql(table, cols);
  if (!sql) { vscode.window.showInformationMessage(vscode.l10n.t('{0} has no numeric or character column to check.', table)); return; }
  const row = (await reportProgress('capacity', vscode.l10n.t('Reading the largest values of {0}…', table), () => manager.require().rows<Row>(sql, 1)))[0] ?? {};
  const warn = vscode.workspace.getConfiguration('vanthrex').get<number>('capacityWarnPercent', 80) / 100;
  const c = capacity(row, cols, warn);
  const near = c.filter(x => x.level !== 'ok');
  showReport('capacity', {
    title: vscode.l10n.t('Capacity — {0}', table),
    subtitle: near.length ? vscode.l10n.t('{0} column(s) use {1}% or more of what they can hold: a counter or an amount there will soon overflow, a text may already be cut.', near.length, Math.round(warn * 100))
      : vscode.l10n.t('No column is close to its limit.'),
    actions: [{ label: vscode.l10n.t('Another table…'), command: 'vanthrex.capacityCheck' }],
    tables: [{ title: vscode.l10n.t('Columns (fullest first)'), filter: true, columns: ['Column', 'Type', 'Largest now', 'Limit', 'Used', ''],
      rows: c.map(x => [x.name, x.type, x.max, x.limit, `${(x.pct * 100).toFixed(1)}%`, '█'.repeat(Math.round(Math.min(1, x.pct) * 20))]),
      rowClass: c.map(x => (x.level === 'full' ? 'bad' : x.level === 'high' ? 'different' : undefined)) }],
    note: vscode.l10n.t('Numbers: the largest absolute value against the digits of the type. Text: the longest value (trailing blanks removed) against the length — 100% may mean values were cut when written.'),
  }, ALLOWED);
}

// ---------------------------------------------------------------- unused objects

let lastUnused: { lib: string; objects: UnusedObject[] } | undefined;

async function unusedObjectsCommand(manager: ConnectionManager, a?: unknown): Promise<void> {
  const n = a as { kind?: string; name?: string } | undefined;
  const given = n?.kind === 'library' ? n.name : typeof a === 'string' ? a : undefined;
  const v = given ?? await vscode.window.showInputBox({ title: vscode.l10n.t('Unused objects of which library?'), value: manager.require().profile.currentLibrary ?? '' });
  if (!v?.trim()) { return; }
  const lib = assertSystemName(v.trim(), 'library');
  const days = vscode.workspace.getConfiguration('vanthrex').get<number>('unusedObjectDays', 365);
  const rows = await reportProgress('unusedObjects', vscode.l10n.t('Reading the objects of {0}…', lib), () => manager.require().rows<Row>(unusedObjectsSql(lib), 50000));
  const list = unusedObjects(rows, new Date(), days);
  lastUnused = { lib, objects: list };
  const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
  showReport('unusedObjects', {
    title: vscode.l10n.t('Unused objects — {0}', lib),
    subtitle: vscode.l10n.t('{0} of {1} object(s) were not used for {2} days (or never), taking {3}. Candidates to save and remove.', list.length, rows.length, days, mb(list.reduce((t, o) => t + o.size, 0))),
    actions: list.length ? [{ label: vscode.l10n.t('Commands to save and delete them…'), command: 'vanthrex.unusedObjects.commands' }] : [],
    tables: [{ title: vscode.l10n.t('Objects (largest first)'), filter: true, columns: ['Object', 'Type', 'Attribute', 'Size', 'Created', 'Last used', 'Days used', 'Text'],
      rows: list.map(o => [o.name, o.type, o.attribute, mb(o.size), o.created, o.lastUsed || vscode.l10n.t('never'), o.daysUsed, o.text]),
      rowActions: list.map(o => ({ label: vscode.l10n.t('Info'), command: 'vanthrex.objectInfo', args: [{ library: lib, name: o.name, type: o.type }] })), empty: vscode.l10n.t('Every object was used recently.') }],
    note: vscode.l10n.t('Usage is counted by the system when an object is opened or called; it restarts after a restore. Check month-end and year-end jobs before deleting anything (vanthrex.unusedObjectDays).'),
  }, ALLOWED);
}

async function unusedCommands(): Promise<void> {
  if (!lastUnused?.objects.length) { return; }
  const { lib, objects } = lastUnused;
  const savf = `${lib.slice(0, 6)}OLD`;
  const lines = [`/* ${vscode.l10n.t('Objects of {0} not used recently. Save them first, check the save, then delete. Review every line.', lib)} */`,
    `CRTSAVF FILE(QGPL/${savf})`,
    ...chunk(objects.map(o => o.name), 50).map(names => `SAVOBJ OBJ(${names.join(' ')}) LIB(${lib}) DEV(*SAVF) SAVF(QGPL/${savf}) OBJTYPE(*ALL)`),
    '', ...objects.map(o => `/* DLTOBJ OBJ(${lib}/${o.name}) OBJTYPE(${o.type}) */`)];
  const doc = await vscode.workspace.openTextDocument({ language: 'cl', content: lines.join('\n') + '\n' });
  await vscode.window.showTextDocument(doc, { preview: false });
}
const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// ---------------------------------------------------------------- benchmark

async function sqlBenchmark(manager: ConnectionManager): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const stmt = (ed ? (ed.selection.isEmpty ? statementAtOffset(ed.document.getText(), ed.document.offsetAt(ed.selection.active)) : ed.document.getText(ed.selection)) : '')?.trim().replace(/;\s*$/, '')
    || (await vscode.window.showInputBox({ title: vscode.l10n.t('Statement to time'), ignoreFocusOut: true }))?.trim();
  if (!stmt) { return; }
  const conn = manager.require();
  if (isChangingSql(stmt) || !/^\s*(select|with|values)\b/i.test(stmt)) { throw new Error(vscode.l10n.t('Only a SELECT, WITH or VALUES can be timed (a statement that changes data is not run again and again).')); }
  const times = Number(await vscode.window.showInputBox({ title: vscode.l10n.t('How many runs?'), value: '5', validateInput: v => (/^\d+$/.test(v) && +v >= 2 && +v <= 50 ? undefined : '2-50') }) ?? NaN);
  if (!times) { return; }
  const maxRows = vscode.workspace.getConfiguration('vanthrex').get<number>('benchmarkRows', 1000);
  const ms: number[] = []; let rows = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Timing the statement…'), cancellable: true }, async (p, token) => {
    for (let i = 0; i < times && !token.isCancellationRequested; i++) {
      p.report({ message: `${i + 1}/${times}`, increment: 100 / times });
      const t0 = Date.now(); const r = await conn.sql(stmt, maxRows); ms.push(Date.now() - t0); rows = r.rows.length;
    }
  });
  const t = timings(ms);
  showReport('benchmark', {
    title: vscode.l10n.t('SQL timing'),
    subtitle: stmt.length > 300 ? stmt.slice(0, 300) + '…' : stmt,
    facts: [[vscode.l10n.t('Runs'), t.runs], [vscode.l10n.t('First run'), `${t.first} ms`], [vscode.l10n.t('Average after the first'), `${t.warm.toFixed(0)} ms`], [vscode.l10n.t('Median'), `${t.median} ms`],
      [vscode.l10n.t('90th percentile'), `${t.p90} ms`], [vscode.l10n.t('Fastest / slowest'), `${t.min} / ${t.max} ms`], [vscode.l10n.t('Rows fetched'), rows]],
    actions: [{ label: vscode.l10n.t('Time again'), command: 'vanthrex.sqlBenchmark' }],
    tables: [{ title: vscode.l10n.t('Each run'), columns: ['Run', 'ms', ''], rows: ms.map((x, i) => [i + 1, x, '█'.repeat(Math.max(1, Math.round((x / t.max) * 30)))]) }],
    note: vscode.l10n.t('Time seen from VS Code: it includes the network and fetching up to {0} rows (vanthrex.benchmarkRows). The first run also opens and plans the query; later runs reuse it.', maxRows),
  }, ALLOWED);
}

export function registerDataQuality(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.profileTable', wrap((a?: unknown) => profileTable(manager, a))),
    vscode.commands.registerCommand('vanthrex.profileTable.top', wrap((c: string) => topValues(manager, c))),
    vscode.commands.registerCommand('vanthrex.orphanRows', wrap((a?: unknown) => orphanRows(manager, a))),
    vscode.commands.registerCommand('vanthrex.capacityCheck', wrap((a?: unknown) => capacityCheck(manager, a))),
    vscode.commands.registerCommand('vanthrex.unusedObjects', wrap((a?: unknown) => unusedObjectsCommand(manager, a))),
    vscode.commands.registerCommand('vanthrex.unusedObjects.commands', wrap(unusedCommands)),
    vscode.commands.registerCommand('vanthrex.sqlBenchmark', wrap(() => sqlBenchmark(manager))),
  );
}
