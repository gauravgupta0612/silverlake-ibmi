import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { assertSystemName, clString, parseMemberPath, sqlString } from '../core/util';
import { exportedProcedures, parseJUnit, parseRuSummary, rpgUnitSkeleton } from '../core/codeTools';
import { MEMBER_SCHEME, memberUri } from './fileSystems';

type Row = Record<string, unknown>;
const TESTCASE = /\/(copy|include)\s+\S*TESTCASE/i;
const TEST_PROC = /dcl-proc\s+(test[\w$#@]*)\s+export/gi;

const cfg = () => vscode.workspace.getConfiguration('vanthrex.rpgunit');

interface MemberData { library: string; file: string; member: string; type: string }
const data = new WeakMap<vscode.TestItem, MemberData & { proc?: string }>();

function testsIn(text: string): string[] {
  return [...text.matchAll(TEST_PROC)].map(m => m[1]);
}

function addMember(ctrl: vscode.TestController, m: MemberData, text: string): vscode.TestItem | undefined {
  const tests = testsIn(text);
  const id = `${m.library}/${m.file}/${m.member}`;
  if (!TESTCASE.test(text) || !tests.length) { ctrl.items.delete(id); return undefined; }
  const item = ctrl.items.get(id) ?? ctrl.createTestItem(id, `${m.member}`, memberUri(m.library, m.file, m.member, m.type));
  item.description = `${m.library}/${m.file}`;
  data.set(item, m);
  item.children.replace(tests.map(t => {
    const c = ctrl.createTestItem(`${id}#${t.toUpperCase()}`, t, item.uri);
    const line = text.split(/\r?\n/).findIndex(l => new RegExp(`dcl-proc\\s+${t}\\b`, 'i').test(l));
    if (line >= 0) { c.range = new vscode.Range(line, 0, line, 0); }
    data.set(c, { ...m, proc: t.toUpperCase() });
    return c;
  }));
  ctrl.items.add(item);
  return item;
}

async function discover(ctrl: vscode.TestController, conn: IbmiConnection, lib: string, file: string): Promise<number> {
  const members = await conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, COALESCE(SOURCE_TYPE, 'RPGLE') AS T FROM QSYS2.SYSPARTITIONSTAT ` +
    `WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(file)} AND SOURCE_TYPE IN ('RPGLE', 'SQLRPGLE')`, 5000);
  let found = 0;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Looking for RPGUnit tests in {0}/{1}…', lib, file), cancellable: true }, async (p, token) => {
    for (const [i, r] of members.entries()) {
      if (token.isCancellationRequested) { break; }
      p.report({ increment: 100 / members.length });
      const m = String(r.M).trim();
      try {
        const text = await conn.readMember(lib, file, m);
        if (addMember(ctrl, { library: lib, file, member: m, type: String(r.T).trim().toLowerCase() }, text)) { found++; }
      } catch (e) { log(`RPGUnit scan ${m}: ${errorMessage(e)}`); }
      void i;
    }
  });
  return found;
}

async function runMember(conn: IbmiConnection, run: vscode.TestRun, member: vscode.TestItem, only: Set<string> | undefined): Promise<void> {
  const m = data.get(member)!;
  const children: vscode.TestItem[] = []; member.children.forEach(c => children.push(c));
  const selected = children.filter(c => !only || only.has(c.id) || only.has(member.id));
  selected.forEach(c => run.started(c));
  const ruLib = cfg().get<string>('library', 'RPGUNIT') || 'RPGUNIT';
  const tlib = (cfg().get<string>('testLibrary', '') || conn.profile.currentLibrary || 'QGPL').toUpperCase();
  const pgm = `${tlib}/${m.member}`;
  const fail = (msg: string) => selected.forEach(c => run.errored(c, new vscode.TestMessage(msg)));
  run.appendOutput(`> RUCRTRPG TSTPGM(${pgm}) SRCFILE(${m.library}/${m.file}) SRCMBR(${m.member})\r\n`);
  const comp = await conn.runCL(`RUCRTRPG TSTPGM(${pgm}) SRCFILE(${m.library}/${m.file}) SRCMBR(${m.member})`, [ruLib, m.library]);
  if (!comp.ok) {
    run.appendOutput((comp.stdout + comp.stderr).replace(/\n/g, '\r\n'));
    return fail(vscode.l10n.t('Compile failed (RUCRTRPG). Is RPGUnit installed in library {0}? See the test output for the messages.', ruLib));
  }
  const xml = conn.tempPath('.xml');
  const prc = selected.length === children.length ? '*ALL' : selected.length === 1 ? data.get(selected[0])!.proc! : '*ALL';
  const cmd = `RUCALLTST TSTPGM(${pgm}) TSTPRC(${prc}) DETAIL(*ALL) XMLSTMF(${clString(xml)})`;
  run.appendOutput(`> ${cmd}\r\n`);
  const started = Date.now();
  const r = await conn.runCL(cmd, [ruLib, tlib, m.library]);
  run.appendOutput((r.stdout + r.stderr).replace(/\n/g, '\r\n'));
  let results = [] as ReturnType<typeof parseJUnit>;
  try { results = parseJUnit((await conn.readStreamFile(xml)).toString('utf8')); } catch (e) { log(`RPGUnit XML: ${errorMessage(e)}`); }
  await conn.removePath(xml, false).catch(() => undefined);
  if (results.length) {
    for (const c of selected) {
      const res = results.find(x => x.name.toUpperCase() === data.get(c)!.proc || x.name.toUpperCase().endsWith('.' + data.get(c)!.proc));
      const ms = res?.time !== undefined && isFinite(res.time) ? res.time * 1000 : undefined;
      if (!res) { run.skipped(c); } else if (res.status === 'passed') { run.passed(c, ms); }
      else { const msg = new vscode.TestMessage(res.message || res.status); if (c.uri && c.range) { msg.location = new vscode.Location(c.uri, c.range); } run.failed(c, msg, ms); }
    }
    return;
  }
  const sum = parseRuSummary(r.stdout + r.stderr);
  if (!sum) { return fail(vscode.l10n.t('RUCALLTST gave no result. See the test output.')); }
  for (const c of selected) { if (sum.ok) { run.passed(c, (Date.now() - started) / Math.max(1, selected.length)); } else { run.failed(c, new vscode.TestMessage(vscode.l10n.t('{0} failure(s), {1} error(s) in {2} — see the test output.', sum.failures ?? 0, sum.errors ?? 0, m.member))); } }
}

async function generateTests(manager: ConnectionManager, ctrl: vscode.TestController): Promise<void> {
  const conn = manager.require();
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== MEMBER_SCHEME) { throw new Error(vscode.l10n.t('Open the RPG member with the procedures to test first.')); }
  const p = parseMemberPath(ed.document.uri.path);
  const procs = exportedProcedures(ed.document.getText());
  let chosen = procs;
  if (procs.length) {
    const picks = await vscode.window.showQuickPick(procs.map(x => ({ label: x.name, description: `${x.params.length} parameter(s)${x.returns ? ` → ${x.returns}` : ''}`, picked: true, x })),
      { canPickMany: true, title: vscode.l10n.t('Which procedures should get a test?') });
    if (!picks?.length) { return; }
    chosen = picks.map(x => x.x);
  } else {
    const ok = await vscode.window.showInformationMessage(vscode.l10n.t('{0} has no exported procedures. Create an empty RPGUnit test member anyway?', p.member), vscode.l10n.t('Create'));
    if (ok !== vscode.l10n.t('Create')) { return; }
  }
  const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('Test member name'), value: `T${p.member}`.slice(0, 10), ignoreFocusOut: true,
    validateInput: v => (/^[A-Za-z$#@][\w$#@]{0,9}$/.test(v.trim()) ? undefined : vscode.l10n.t('1–10 characters, a valid name')) }))?.trim().toUpperCase();
  if (!name) { return; }
  assertSystemName(name, 'member');
  const proto = await vscode.window.showInputBox({ title: vscode.l10n.t('Copybook with the prototypes (optional)'), prompt: 'e.g. QRPGLESRC,ORDERS_P', ignoreFocusOut: true });
  if (proto === undefined) { return; }
  const r = await conn.runCL(`ADDPFM FILE(${p.library}/${p.file}) MBR(${name}) SRCTYPE(RPGLE) TEXT(${clString(`RPGUnit tests for ${p.member}`)})`);
  if (!r.ok && !/CPF5812|already exists/i.test(r.stdout + r.stderr)) { throw new Error(vscode.l10n.t('Could not add member {0}: {1}', name, (r.stderr || r.stdout).trim())); }
  const text = rpgUnitSkeleton(p.member, chosen, proto.trim() || undefined);
  await conn.writeMember(p.library, p.file, name, text);
  const uri = memberUri(p.library, p.file, name, 'rpgle');
  await vscode.window.showTextDocument(uri);
  addMember(ctrl, { library: p.library, file: p.file, member: name, type: 'rpgle' }, text);
  vscode.window.showInformationMessage(vscode.l10n.t('Test member {0} created. Fill in the expected values, then run it from the Test Explorer.', name));
}

export function registerRpgUnit(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const ctrl = vscode.tests.createTestController('vanthrexRpgUnit', 'RPGUnit (IBM i)');
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const fromDoc = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme !== MEMBER_SCHEME) { return; }
    const p = parseMemberPath(doc.uri.path);
    addMember(ctrl, { library: p.library, file: p.file, member: p.member, type: p.extension }, doc.getText());
  };
  ctrl.refreshHandler = async () => { vscode.workspace.textDocuments.forEach(fromDoc); };
  ctrl.createRunProfile(vscode.l10n.t('Run on IBM i'), vscode.TestRunProfileKind.Run, async (req, token) => {
    const conn = manager.connection;
    const run = ctrl.createTestRun(req);
    try {
      if (!conn) { throw new Error(vscode.l10n.t('Connect to an IBM i first.')); }
      const members = new Set<vscode.TestItem>(); const only = req.include ? new Set(req.include.map(i => i.id)) : undefined;
      const collect = (i: vscode.TestItem) => { if (data.get(i)?.proc) { if (i.parent) { members.add(i.parent); } } else { members.add(i); } };
      if (req.include) { req.include.forEach(collect); } else { ctrl.items.forEach(collect); }
      for (const m of members) {
        if (token.isCancellationRequested) { break; }
        try { await runMember(conn, run, m, only); } catch (e) { m.children.forEach(c => run.errored(c, new vscode.TestMessage(errorMessage(e)))); }
      }
    } catch (e) { run.appendOutput(errorMessage(e) + '\r\n'); vscode.window.showErrorMessage(errorMessage(e)); } finally { run.end(); }
  }, true);
  context.subscriptions.push(
    ctrl,
    vscode.workspace.onDidOpenTextDocument(fromDoc),
    vscode.workspace.onDidSaveTextDocument(fromDoc),
    vscode.commands.registerCommand('vanthrex.rpgunit.generate', guard(() => generateTests(manager, ctrl))),
    vscode.commands.registerCommand('vanthrex.rpgunit.discover', guard(async (n?: { library?: string; file?: string }) => {
      const conn = manager.require();
      let lib = n?.library; let file = n?.file;
      if (!lib || !file) {
        const v = await vscode.window.showInputBox({ title: vscode.l10n.t('Find RPGUnit tests'), prompt: 'LIBRARY/SOURCEFILE', placeHolder: 'APPLIB/QTESTSRC', ignoreFocusOut: true });
        if (!v?.includes('/')) { return; }
        [lib, file] = v.trim().toUpperCase().split('/');
      }
      const found = await discover(ctrl, conn, lib, file);
      vscode.window.showInformationMessage(vscode.l10n.t('{0} RPGUnit test member(s) found in {1}/{2}. Run them from the Testing view.', found, lib, file));
      if (found) { await vscode.commands.executeCommand('workbench.view.testing.focus'); }
    })),
  );
  vscode.workspace.textDocuments.forEach(fromDoc);
}
