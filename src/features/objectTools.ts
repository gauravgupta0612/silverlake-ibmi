import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage } from '../core/log';
import { assertSystemName, clString, sqlString } from '../core/util';
import { CompareItem, compareSets, summarize } from '../core/compareSets';
import { memberUri } from './fileSystems';
import { Report, ReportAction, showReport } from './reportPanel';

type ObjArg = { library: string; name: string; type?: string };

/** Commands the report pages may run (anything else posted by a webview is ignored). */
const ALLOWED = new Set([
  'vanthrex.objectInfo', 'vanthrex.objectLocks', 'vanthrex.whereUsed', 'vanthrex.openProgramSource',
  'vanthrex.serviceProgramInfo', 'vanthrex.editData', 'vanthrex.generateDdl', 'vanthrex.jobLog',
  'vanthrex.openMemberSource', 'vanthrex.diffMembers', 'vscode.open', 'vanthrex.lockHolderActions', 'vanthrex.procedureCallers', 'vanthrex.sqlQuery',
]);

async function askObject(title: string): Promise<ObjArg | undefined> {
  const v = await vscode.window.showInputBox({ title, prompt: 'LIBRARY/OBJECT (optionally *TYPE)', placeHolder: 'MYLIB/ORDENTRY *PGM', ignoreFocusOut: true });
  if (!v?.trim()) { return undefined; }
  const [path, type] = v.trim().toUpperCase().split(/\s+/);
  const [library, name] = path.split('/');
  if (!name) { throw new Error('Use LIBRARY/OBJECT, for example MYLIB/ORDENTRY.'); }
  return { library: assertSystemName(library, 'library'), name: assertSystemName(name, 'object name'), type: type || '*ALL' };
}

function ts(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).replace(/\.\d+$/, '').replace('T', ' ');
}

function fmtSize(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) { return v === null || v === undefined ? '' : String(v); }
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let i = 0; let x = n;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${i ? x.toFixed(1) : x} ${units[i]}`;
}

async function sourceTypeOf(conn: IbmiConnection, lib: string, file: string, member: string): Promise<string> {
  const r = await conn.rows<{ T: string }>(
    `SELECT COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} ` +
    `AND SYSTEM_TABLE_NAME = ${sqlString(file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(member)}`, 1).catch(() => []);
  return String(r[0]?.T ?? '').trim() || 'mbr';
}

// ---------------------------------------------------------------- object information

async function objectInfo(manager: ConnectionManager, o: ObjArg): Promise<void> {
  const conn = manager.require();
  const rows = await conn.rows<Record<string, unknown>>(
    `SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(o.library)}, ${sqlString(o.type && o.type !== '*ALL' ? o.type : '*ALL')}, ${sqlString(o.name)}))`, 20);
  if (!rows.length) { throw new Error(`${o.library}/${o.name} ${o.type ?? ''} was not found.`); }
  const r = rows[0];
  const type = String(r.OBJTYPE ?? o.type ?? '').trim();
  const srcLib = String(r.SOURCE_LIBRARY ?? '').trim();
  const srcFile = String(r.SOURCE_FILE ?? '').trim();
  const srcMbr = String(r.SOURCE_MEMBER ?? '').trim();
  const arg = { library: o.library, name: o.name, type };
  const actions: ReportAction[] = [
    { label: 'Who has it locked?', command: 'vanthrex.objectLocks', args: [arg] },
    { label: 'Where used', command: 'vanthrex.whereUsed', args: [arg] },
  ];
  if (srcLib && srcFile && srcMbr) {
    actions.unshift({ label: `Open source ${srcLib}/${srcFile}(${srcMbr})`, command: 'vanthrex.openMemberSource', args: [srcLib, srcFile, srcMbr] });
  } else if (type === '*PGM' || type === '*SRVPGM' || type === '*MODULE') {
    actions.unshift({ label: 'Open program source', command: 'vanthrex.openProgramSource', args: [arg] });
  }
  if (type === '*SRVPGM' || type === '*PGM') { actions.push({ label: 'Modules & exports', command: 'vanthrex.serviceProgramInfo', args: [arg] }); }
  if (type === '*SRVPGM') { actions.push({ label: 'Who calls each exported procedure?', command: 'vanthrex.procedureCallers', args: [arg] }); }
  actions.push({ label: 'Run SQL query…', command: 'vanthrex.sqlQuery', args: [arg] });
  if (type === '*FILE') {
    actions.push({ label: 'Edit data', command: 'vanthrex.editData', args: [arg] });
    actions.push({ label: 'Generate SQL (DDL)', command: 'vanthrex.generateDdl', args: [arg] });
  }
  const known = new Set(['OBJNAME', 'OBJTYPE', 'OBJATTRIBUTE', 'OBJTEXT', 'OBJOWNER', 'OBJDEFINER', 'OBJCREATED', 'CHANGE_TIMESTAMP',
    'LAST_USED_TIMESTAMP', 'DAYS_USED_COUNT', 'OBJSIZE', 'SOURCE_LIBRARY', 'SOURCE_FILE', 'SOURCE_MEMBER', 'SOURCE_TIMESTAMP',
    'JOURNALED', 'JOURNAL_LIBRARY', 'JOURNAL_NAME', 'SAVE_TIMESTAMP', 'CREATED_SYSTEM', 'CREATED_SYSTEM_VERSION', 'OBJLONGNAME']);
  const others = Object.entries(r).filter(([k, v]) => !known.has(k) && v !== null && v !== '' && v !== undefined)
    .map(([k, v]) => [k, String(v)]);
  const report: Report = {
    title: `${o.library}/${String(r.OBJNAME ?? o.name).trim()} ${type}`,
    subtitle: [String(r.OBJATTRIBUTE ?? '').trim(), String(r.OBJTEXT ?? '').trim()].filter(Boolean).join(' — '),
    actions,
    facts: [
      ['Owner', String(r.OBJOWNER ?? '').trim()],
      ['Created', `${ts(r.OBJCREATED)}${r.CREATED_SYSTEM ? ` on ${String(r.CREATED_SYSTEM).trim()} ${String(r.CREATED_SYSTEM_VERSION ?? '').trim()}` : ''}`],
      ['Changed', ts(r.CHANGE_TIMESTAMP)],
      ['Last used', `${ts(r.LAST_USED_TIMESTAMP) || 'never (since last reset)'}${r.DAYS_USED_COUNT !== undefined ? ` · used on ${r.DAYS_USED_COUNT} day(s)` : ''}`],
      ['Size', fmtSize(r.OBJSIZE)],
      ['Source', srcFile ? `${srcLib}/${srcFile}(${srcMbr})${r.SOURCE_TIMESTAMP ? ` · source changed ${ts(r.SOURCE_TIMESTAMP)}` : ''}` : ''],
      ['Journaled', r.JOURNALED === undefined ? '' : `${String(r.JOURNALED).trim()}${r.JOURNAL_NAME ? ` to ${String(r.JOURNAL_LIBRARY ?? '').trim()}/${String(r.JOURNAL_NAME).trim()}` : ''}`],
      ['Last saved', ts(r.SAVE_TIMESTAMP)],
      ['Long name', String(r.OBJLONGNAME ?? '').trim()],
    ],
    tables: others.length ? [{ title: 'All attributes', columns: ['Attribute', 'Value'], rows: others, filter: true }] : [],
  };
  showReport('objectInfo', report, ALLOWED);
}

// ---------------------------------------------------------------- object locks

async function objectLocks(manager: ConnectionManager, o: ObjArg): Promise<void> {
  const conn = manager.require();
  let type = o.type && o.type !== '*ALL' ? o.type : '';
  if (!type) {
    const t = await conn.rows<{ T: string }>(`SELECT OBJTYPE AS T FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(o.library)}, '*ALL', ${sqlString(o.name)}))`, 5);
    type = String(t[0]?.T ?? '*FILE').trim();
  }
  const holders = await conn.lockHolders(o.library, o.name, type);
  const jobs = holders.map(h => String(h.JOB).trim());
  let detail = new Map<string, { status: string; fn: string; text: string }>();
  if (jobs.length) {
    const users = [...new Set(jobs.map(j => j.split('/')[1]).filter(Boolean))];
    const u = await conn.rows<{ U: string; T: string }>(
      `SELECT AUTHORIZATION_NAME AS U, COALESCE(TEXT_DESCRIPTION, '') AS T FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME IN (${users.map(sqlString).join(', ')})`, 50)
      .catch(() => []);
    detail = new Map(jobs.map(j => [j, { status: '', fn: '', text: String(u.find(x => String(x.U).trim() === j.split('/')[1])?.T ?? '').trim() }]));
  }
  const report: Report = {
    title: `Locks on ${o.library}/${o.name} ${type}`,
    subtitle: jobs.length ? `${jobs.length} job(s) hold a lock. Click a job for its job log, to message the user or to end the job.` : 'No job holds a lock on this object right now.',
    actions: [{ label: 'Refresh', command: 'vanthrex.objectLocks', args: [{ ...o, type }] }],
    tables: [{
      title: 'Lock holders', columns: ['Job', 'User', 'Name', 'Lock state'],
      rows: holders.map(h => { const j = String(h.JOB).trim(); return [j, j.split('/')[1] ?? '', detail.get(j)?.text ?? '', String(h.ST).trim()]; }),
      rowActions: holders.map(h => ({ label: 'Job actions', command: 'vanthrex.lockHolderActions', args: [String(h.JOB).trim(), `${o.library}/${o.name}`] })),
      empty: 'No locks.',
    }],
  };
  showReport('objectLocks', report, ALLOWED);
}

async function lockHolderActions(manager: ConnectionManager, job: string, objectLabel: string): Promise<void> {
  const conn = manager.require();
  const [, user = '', name = ''] = job.split('/');
  const pick = await vscode.window.showQuickPick([
    { label: '$(output) Show job log', id: 'log' },
    { label: '$(mail) Ask them to release it', id: 'msg' },
    { label: '$(stop-circle) End the job…', id: 'end', detail: 'Needs *JOBCTL. They lose unsaved work.' },
  ], { title: `${job} — lock on ${objectLabel}` });
  if (!pick) { return; }
  if (pick.id === 'log') { await vscode.commands.executeCommand('vanthrex.jobLog', { job }); return; }
  if (pick.id === 'msg') {
    const text = await vscode.window.showInputBox({
      title: `Message ${user}`, ignoreFocusOut: true,
      value: `Hi, I need ${objectLabel}. Could you please release it when you can? Thanks — ${conn.user}`,
    });
    if (!text?.trim()) { return; }
    let r = await conn.runCL(`SNDBRKMSG MSG(${clString(text.trim())}) TOMSGQ(${name})`);
    if (!r.ok) { r = await conn.runCL(`SNDMSG MSG(${clString(text.trim())}) TOUSR(${user})`); }
    if (!r.ok) { throw new Error(`Could not send the message: ${(r.stderr || r.stdout).trim()}`); }
    vscode.window.showInformationMessage(`Message sent to ${user}.`);
    return;
  }
  const ok = await vscode.window.showWarningMessage(`End job ${job}? Work in progress in that job is lost.`, { modal: true }, 'End Job');
  if (ok !== 'End Job') { return; }
  const r = await conn.runCL(`ENDJOB JOB(${job}) OPTION(*CNTRLD) DELAY(10)`);
  if (!r.ok) { throw new Error(`ENDJOB failed: ${(r.stderr || r.stdout).trim()}`); }
  vscode.window.showInformationMessage(`Ending ${job}.`);
}

// ---------------------------------------------------------------- service program / program modules & exports

async function serviceProgramInfo(manager: ConnectionManager, o: ObjArg): Promise<void> {
  const conn = manager.require();
  const type = o.type && o.type !== '*ALL' ? o.type : '*SRVPGM';
  const where = `PROGRAM_LIBRARY = ${sqlString(o.library)} AND PROGRAM_NAME = ${sqlString(o.name)} AND OBJECT_TYPE = ${sqlString(type)}`;
  const [exports, modules] = await Promise.all([
    type === '*SRVPGM'
      ? conn.rows<Record<string, unknown>>(`SELECT SYMBOL_NAME, SYMBOL_USAGE FROM QSYS2.PROGRAM_EXPORT_IMPORT_INFO WHERE ${where} ORDER BY SYMBOL_USAGE, SYMBOL_NAME`, 5000)
      : Promise.resolve([] as Record<string, unknown>[]),
    conn.rows<Record<string, unknown>>(`SELECT * FROM QSYS2.BOUND_MODULE_INFO WHERE ${where} ORDER BY BOUND_MODULE`, 2000),
  ]);
  const s = (r: Record<string, unknown>, k: string) => String(r[k] ?? '').trim();
  const usage: Record<string, string> = { '*PROCEXP': 'procedure', '*DATAEXP': 'data' };
  const report: Report = {
    title: `${o.library}/${o.name} ${type}`,
    subtitle: `${exports.length} export(s), ${modules.length} module(s). Click a module to open its source.`,
    actions: [
      { label: 'Object information', command: 'vanthrex.objectInfo', args: [{ ...o, type }] },
      ...(type === '*SRVPGM' ? [{ label: 'Who calls each exported procedure?', command: 'vanthrex.procedureCallers', args: [{ ...o, type }] }] : []),
    ],
    tables: [
      ...(type === '*SRVPGM' ? [{
        title: 'Exports (signature order)', columns: ['Symbol', 'Kind'], filter: true,
        rows: exports.map(r => [s(r, 'SYMBOL_NAME'), usage[s(r, 'SYMBOL_USAGE')] ?? s(r, 'SYMBOL_USAGE')]),
        empty: 'No exports found.',
      }] : []),
      {
        title: 'Bound modules', columns: ['Module', 'Attribute', 'Source', 'Source changed', 'Module created'], filter: true,
        rows: modules.map(r => [
          `${s(r, 'BOUND_MODULE_LIBRARY')}/${s(r, 'BOUND_MODULE')}`, s(r, 'MODULE_ATTRIBUTE'),
          s(r, 'SOURCE_FILE') ? `${s(r, 'SOURCE_FILE_LIBRARY')}/${s(r, 'SOURCE_FILE')}(${s(r, 'SOURCE_FILE_MEMBER')})` : s(r, 'SOURCE_STREAM_FILE_PATH'),
          ts(r.SOURCE_CHANGE_TIMESTAMP), ts(r.MODULE_CREATE_TIMESTAMP)]),
        rowActions: modules.map(r => s(r, 'SOURCE_FILE')
          ? { label: 'Open source', command: 'vanthrex.openMemberSource', args: [s(r, 'SOURCE_FILE_LIBRARY'), s(r, 'SOURCE_FILE'), s(r, 'SOURCE_FILE_MEMBER')] }
          : undefined),
        rowClass: modules.map(r => r.SOURCE_CHANGE_TIMESTAMP && r.MODULE_CREATE_TIMESTAMP && String(r.SOURCE_CHANGE_TIMESTAMP) > String(r.MODULE_CREATE_TIMESTAMP) ? 'different' : undefined),
        empty: 'No bound module information (OPM programs have none).',
      },
    ],
    note: 'Modules marked on the left have source that changed after the module was created — the object may be out of date.',
  };
  showReport('srvpgm', report, ALLOWED);
}

// ---------------------------------------------------------------- compare libraries

async function compareLibraries(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const libs = [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean) as string[])];
  const ask = async (title: string, exclude?: string) => {
    const items = libs.filter(l => l !== exclude).map(l => ({ label: l }));
    const qp = vscode.window.createQuickPick();
    qp.title = title; qp.placeholder = 'Pick or type a library name'; qp.items = items;
    qp.onDidChangeValue(v => { qp.items = v && !libs.includes(v.toUpperCase()) ? [{ label: v.toUpperCase() }, ...items] : items; });
    return new Promise<string | undefined>(resolve => {
      qp.onDidAccept(() => { resolve((qp.selectedItems[0]?.label ?? qp.value).trim().toUpperCase()); qp.hide(); });
      qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
      qp.show();
    });
  };
  const a = await ask('Compare libraries — first library (e.g. DEV)');
  if (!a) { return; }
  const b = await ask(`Compare ${a} with… (e.g. PROD)`, a);
  if (!b) { return; }
  assertSystemName(a, 'library'); assertSystemName(b, 'library');

  const objects = async (lib: string): Promise<CompareItem[]> => (await conn.rows<Record<string, unknown>>(
    `SELECT OBJNAME, OBJTYPE, COALESCE(OBJATTRIBUTE, '') AS ATTR, OBJSIZE, VARCHAR(CHANGE_TIMESTAMP) AS CHG, ` +
    `VARCHAR(SOURCE_TIMESTAMP) AS SRCTS, COALESCE(OBJTEXT, '') AS TXT FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*ALL'))`, 50000))
    .map(r => ({
      key: `${String(r.OBJNAME).trim()} ${String(r.OBJTYPE).trim()}`,
      // Same source timestamp + same size is the best "same object" signal available without reading the objects.
      fingerprint: `${r.SRCTS ?? ''}|${r.OBJSIZE ?? ''}|${String(r.ATTR).trim()}`,
      changed: String(r.CHG ?? ''),
      detail: `${String(r.ATTR).trim()} ${fmtSize(r.OBJSIZE)}`.trim(),
    }));
  const members = async (lib: string): Promise<CompareItem[]> => (await conn.rows<Record<string, unknown>>(
    `SELECT SYSTEM_TABLE_NAME AS F, SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, '') AS T, NUMBER_ROWS AS N, ` +
    `VARCHAR(LAST_SOURCE_UPDATE_TIMESTAMP) AS CHG FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} ` +
    `AND SOURCE_TYPE IS NOT NULL`, 100000))
    .map(r => ({
      key: `${String(r.F).trim()}(${String(r.M).trim()})`,
      fingerprint: `${r.N}|${r.CHG ?? ''}`,
      changed: String(r.CHG ?? ''),
      detail: `${String(r.T).trim()} · ${r.N} lines`,
    }));
  const [oa, ob, ma, mb] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Comparing ${a} and ${b}…` },
    () => Promise.all([objects(a), objects(b), members(a), members(b)]));
  const objRows = compareSets(oa, ob);
  const mbrRows = compareSets(ma, mb);
  const so = summarize(objRows); const sm = summarize(mbrRows);
  const label: Record<string, string> = { onlyA: `only in ${a}`, onlyB: `only in ${b}`, different: 'different', same: 'same' };
  const hideSame = so.same + sm.same > 0;
  const objShown = objRows.filter(r => r.status !== 'same');
  const mbrShown = mbrRows.filter(r => r.status !== 'same');
  const types = new Map([...ma, ...mb].map(x => [x.key, x.detail?.split(' ·')[0] || 'mbr']));
  showReport('compareLibs', {
    title: `${a} ↔ ${b}`,
    subtitle: `Objects: ${so.different} different, ${so.onlyA} only in ${a}, ${so.onlyB} only in ${b}, ${so.same} same. ` +
      `Source members: ${sm.different} different, ${sm.onlyA} only in ${a}, ${sm.onlyB} only in ${b}, ${sm.same} same.`,
    actions: [{ label: 'Compare other libraries', command: 'vanthrex.compareLibraries' }],
    tables: [
      {
        title: 'Source members', columns: ['Member', 'Status', a, b, 'Newer'], filter: true,
        rows: mbrShown.map(r => [r.key, label[r.status], r.a ? `${r.a.detail} · ${ts(r.a.changed)}` : null, r.b ? `${r.b.detail} · ${ts(r.b.changed)}` : null, r.newer === 'A' ? a : r.newer === 'B' ? b : '']),
        rowClass: mbrShown.map(r => r.status),
        rowActions: mbrShown.map(r => {
          const m = r.key.match(/^(\w+|[$#@\w]+)\(([^)]+)\)$/);
          if (!m) { return undefined; }
          const t = types.get(r.key) || 'mbr';
          return r.status === 'different'
            ? { label: 'Compare side by side', command: 'vanthrex.diffMembers', args: [a, b, m[1], m[2], t] }
            : { label: 'Open', command: 'vanthrex.openMemberSource', args: [r.a ? a : b, m[1], m[2]] };
        }),
        empty: 'All source members match.',
      },
      {
        title: 'Objects', columns: ['Object', 'Status', a, b, 'Newer'], filter: true,
        rows: objShown.map(r => [r.key, label[r.status], r.a ? `${r.a.detail} · ${ts(r.a.changed)}` : null, r.b ? `${r.b.detail} · ${ts(r.b.changed)}` : null, r.newer === 'A' ? a : r.newer === 'B' ? b : '']),
        rowClass: objShown.map(r => r.status),
        rowActions: objShown.map(r => { const [name, type] = r.key.split(' '); return { label: 'Object information', command: 'vanthrex.objectInfo', args: [{ library: r.a ? a : b, name, type }] }; }),
        empty: 'All objects match.',
      },
    ],
    note: (hideSame ? 'Items that are the same in both libraries are not listed. ' : '') +
      'Members are "different" when their line count or last change differ; objects when their size, attribute or source timestamp differ. Click a different member to compare its text side by side.',
  }, ALLOWED);
}

export function registerObjectTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const objArg = async (n: ObjArg | undefined, title: string) => (n?.library && n.name ? n : await askObject(title));
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.objectInfo', guard(async (n?: ObjArg) => {
      const o = await objArg(n, 'Object information'); if (o) { await objectInfo(manager, o); }
    })),
    vscode.commands.registerCommand('vanthrex.objectLocks', guard(async (n?: ObjArg) => {
      const o = await objArg(n, 'Who has this object locked?'); if (o) { await objectLocks(manager, o); }
    })),
    vscode.commands.registerCommand('vanthrex.lockHolderActions', guard((job: string, label: string) => lockHolderActions(manager, job, label))),
    vscode.commands.registerCommand('vanthrex.serviceProgramInfo', guard(async (n?: ObjArg) => {
      const o = await objArg(n, 'Modules & exports of a program or service program'); if (o) { await serviceProgramInfo(manager, o); }
    })),
    vscode.commands.registerCommand('vanthrex.compareLibraries', guard(() => compareLibraries(manager))),
    vscode.commands.registerCommand('vanthrex.openMemberSource', guard(async (lib: string, file: string, member: string) => {
      const type = await sourceTypeOf(manager.require(), lib, file, member);
      await vscode.window.showTextDocument(memberUri(lib, file, member, type));
    })),
    vscode.commands.registerCommand('vanthrex.diffMembers', guard(async (libA: string, libB: string, file: string, member: string, type: string) => {
      await vscode.commands.executeCommand('vscode.diff', memberUri(libA, file, member, type), memberUri(libB, file, member, type),
        `${member}: ${libA} ↔ ${libB}`);
    })),
  );
}
