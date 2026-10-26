// Database care: indexes nobody uses (with the statement to drop one), physical files that are not journaled (with the
// STRJRNPF commands), the programs a file change would end with a level check, and library snapshots to compare a
// library before and after a release.
import * as vscode from 'vscode';
import { compareSnapshots, currentLevels, dropIndexCommand, formatUses, indexStatsSql, indexUse, IndexUse, journalCoverageSql, levelMismatches, snapshotSql, Snapshot, strjrnpfCommands, toSnapObject } from '../core/dbCare';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { assertSystemName, sqlString } from '../core/util';
import { reportProgress, showReport } from './reportPanel';

type Row = Record<string, unknown>;
const ALLOWED = new Set(['vanthrex.unusedIndexes', 'vanthrex.dropIndex', 'vanthrex.journalCoverage', 'vanthrex.journalCoverage.start', 'vanthrex.levelCheck',
  'vanthrex.librarySnapshot', 'vanthrex.compareSnapshot', 'vanthrex.objectInfo', 'vanthrex.rebuildImpacted']);
const s = (r: Row, k: string) => String(r[k] ?? '').trim();

async function libraryArg(manager: ConnectionManager, a: unknown, title: string): Promise<string | undefined> {
  const n = a as { kind?: string; name?: string; library?: string } | undefined;
  const lib = n?.kind === 'library' ? n.name : typeof a === 'string' ? a : undefined;
  if (lib) { return assertSystemName(lib, 'library'); }
  const v = await vscode.window.showInputBox({ title, value: manager.require().profile.currentLibrary ?? '' });
  return v?.trim() ? assertSystemName(v.trim(), 'library') : undefined;
}

// ---------------------------------------------------------------- unused indexes

const lastIndexes = new Map<string, IndexUse>();

async function unusedIndexes(manager: ConnectionManager, a?: unknown): Promise<void> {
  const lib = await libraryArg(manager, a, vscode.l10n.t('Unused indexes of which library?'));
  if (!lib) { return; }
  const conn = manager.require();
  const days = vscode.workspace.getConfiguration('vanthrex').get<number>('unusedIndexDays', 180);
  const rows = await reportProgress('unusedIndexes', vscode.l10n.t('Reading index statistics of {0}…', lib), () => conn.rows<Row>(indexStatsSql(lib), 5000));
  const all = indexUse(rows, new Date(), days);
  const unused = all.filter(i => i.unused);
  lastIndexes.clear();
  all.forEach(i => lastIndexes.set(`${i.schema}.${i.name}`, i));
  const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
  showReport('unusedIndexes', {
    title: vscode.l10n.t('Indexes of {0}', lib),
    subtitle: vscode.l10n.t('{0} of {1} index(es) and keyed logical file(s) were not used by a query and not opened for {2} days. Every unused index still costs time on each write.', unused.length, all.length, days),
    facts: [[vscode.l10n.t('Unused'), unused.length], [vscode.l10n.t('Space they take'), mb(unused.reduce((t, i) => t + i.size, 0))], [vscode.l10n.t('Kept (unique, constraint, new)'), all.filter(i => i.keep).length]],
    actions: [{ label: vscode.l10n.t('Another library…'), command: 'vanthrex.unusedIndexes' }],
    tables: [{ title: vscode.l10n.t('Indexes (unused first)'), filter: true, columns: ['Index', 'Table', 'Type', 'Columns', 'Size', 'Last query use', 'Last opened', 'Query uses', 'Why'],
      rows: all.map(i => [i.name, i.table, i.kind, i.columns, mb(i.size), i.lastQuery, i.lastUsed, i.queryUses, i.why]),
      rowActions: all.map(i => (i.unused ? { label: vscode.l10n.t('Drop…'), command: 'vanthrex.dropIndex', args: [`${i.schema}.${i.name}`, lib] } : undefined)),
      rowClass: all.map(i => (i.unused ? 'different' : undefined)), empty: vscode.l10n.t('No index in {0}.', lib) }],
    note: vscode.l10n.t('From QSYS2.SYSINDEXSTAT. Statistics restart when the system is reloaded or the index is restored: check the month-end and year-end jobs before dropping an index.'),
  }, ALLOWED);
}

async function dropIndex(manager: ConnectionManager, key: string, lib: string): Promise<void> {
  const i = lastIndexes.get(key);
  if (!i) { return; }
  const stmt = dropIndexCommand(i, lib);
  const drop = vscode.l10n.t('Drop');
  if (await vscode.window.showWarningMessage(vscode.l10n.t('Drop {0} over {1}?', i.name, i.table), { modal: true, detail: `${stmt}\n\n${i.why}` }, drop) !== drop) { return; }
  const conn = manager.require();
  if (stmt.startsWith('DLTF')) {
    const r = await conn.runCL(stmt);
    if (!r.ok) { throw new Error(r.stderr.trim() || r.stdout.trim() || stmt); }
  } else { await conn.sql(stmt); }
  vscode.window.showInformationMessage(vscode.l10n.t('{0} dropped.', i.name));
  await unusedIndexes(manager, lib);
}

// ---------------------------------------------------------------- journal coverage

let lastJournal: { lib: string; files: string[]; journal: string } | undefined;

async function journalCoverage(manager: ConnectionManager, a?: unknown): Promise<void> {
  const lib = await libraryArg(manager, a, vscode.l10n.t('Journal coverage of which library?'));
  if (!lib) { return; }
  const conn = manager.require();
  const rows = await reportProgress('journalCoverage', vscode.l10n.t('Reading the physical files of {0}…', lib), () => conn.rows<Row>(journalCoverageSql(lib), 20000));
  const off = rows.filter(r => s(r, 'J') !== 'YES');
  const journals = new Map<string, number>();
  rows.filter(r => s(r, 'J') === 'YES').forEach(r => { const j = `${s(r, 'JL')}/${s(r, 'JN')}`; journals.set(j, (journals.get(j) ?? 0) + 1); });
  const main = [...journals.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
  lastJournal = { lib, files: off.map(r => s(r, 'N')), journal: main };
  showReport('journalCoverage', {
    title: vscode.l10n.t('Journal coverage — {0}', lib),
    subtitle: vscode.l10n.t('{0} of {1} physical file(s) are not journaled: their changes cannot be rolled back, replicated or audited.', off.length, rows.length),
    facts: [[vscode.l10n.t('Journaled'), rows.length - off.length], [vscode.l10n.t('Not journaled'), off.length], [vscode.l10n.t('Journals used'), [...journals.keys()].join(', ') || '—']],
    actions: [...(off.length ? [{ label: vscode.l10n.t('Commands to journal the {0} file(s)…', off.length), command: 'vanthrex.journalCoverage.start' }] : []),
      { label: vscode.l10n.t('Another library…'), command: 'vanthrex.journalCoverage' }],
    tables: [{ title: vscode.l10n.t('Physical files'), filter: true, columns: ['File', 'Text', 'Journaled', 'Journal', 'Images', 'Size'],
      rows: rows.map(r => [s(r, 'N'), s(r, 'T'), s(r, 'J'), s(r, 'JN') ? `${s(r, 'JL')}/${s(r, 'JN')}` : '', s(r, 'IMG'), Number(r.S) || 0]),
      rowClass: rows.map(r => (s(r, 'J') === 'YES' ? undefined : 'bad')), empty: vscode.l10n.t('No physical file in {0}.', lib) }],
  }, ALLOWED);
}

async function startJournaling(manager: ConnectionManager): Promise<void> {
  if (!lastJournal?.files.length) { return; }
  const j = await vscode.window.showInputBox({ title: vscode.l10n.t('Journal to use'), value: lastJournal.journal, prompt: vscode.l10n.t('LIBRARY/JOURNAL (it must exist: CRTJRNRCV and CRTJRN first)'), ignoreFocusOut: true });
  if (!j?.trim()) { return; }
  const images = await vscode.window.showQuickPick([{ label: '*BOTH', description: vscode.l10n.t('before and after images (needed to roll back)') }, { label: '*AFTER', description: vscode.l10n.t('after images only (smaller)') }], { title: vscode.l10n.t('Images') });
  if (!images) { return; }
  const cmds = strjrnpfCommands(lastJournal.lib, lastJournal.files, j.trim(), images.label as '*BOTH' | '*AFTER');
  const doc = await vscode.workspace.openTextDocument({ language: 'cl', content: `/* ${vscode.l10n.t('Journal the files of {0} not journaled yet. Review, then run.', lastJournal.lib)} */\n${cmds.join('\n')}\n` });
  await vscode.window.showTextDocument(doc, { preview: false });
  const run = vscode.l10n.t('Run Now');
  if (await vscode.window.showWarningMessage(vscode.l10n.t('Start journaling {0} file(s) to {1}?', lastJournal.files.length, j.trim().toUpperCase()), { modal: true, detail: vscode.l10n.t('The files must not be in use (STRJRNPF needs an exclusive lock).') }, run) !== run) { return; }
  const conn = manager.require();
  for (const c of cmds) {
    const r = await conn.runCL(c);
    if (!r.ok) { throw new Error(r.stderr.trim() || r.stdout.trim() || c); }
  }
  vscode.window.showInformationMessage(vscode.l10n.t('Journaling started for {0} file(s).', lastJournal.files.length));
  await journalCoverage(manager, lastJournal.lib);
}

// ---------------------------------------------------------------- level checks

async function levelCheck(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  if (!conn.sqlKeepsJob) { throw new Error(vscode.l10n.t('This needs the Mapepire SQL engine (it builds a cross-reference in QTEMP).')); }
  const n = a as { library?: string; name?: string } | undefined;
  const given = n?.library && n?.name ? `${n.library}/${n.name}` : undefined;
  const v = (given ?? await vscode.window.showInputBox({ title: vscode.l10n.t('Programs that would get a level check on which file?'), prompt: 'LIBRARY/FILE', placeHolder: 'APPLIB/CUSTMAST' }))?.trim().toUpperCase();
  if (!v?.includes('/')) { return; }
  const [lib, file] = v.split('/').map((x, i) => assertSystemName(x, i ? 'file' : 'library'));
  const scope = await vscode.window.showQuickPick([
    { label: lib, description: vscode.l10n.t('programs of the file library') },
    { label: '*USRLIBL', description: vscode.l10n.t('programs of the user part of the library list (slower)') },
  ], { title: vscode.l10n.t('Look for programs in') });
  if (!scope) { return; }
  const out = await reportProgress('levelCheck', vscode.l10n.t('Comparing record format levels of {0}…', file), async () => {
    await conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(`DSPFD FILE(${lib}/${file}) TYPE(*RCDFMT) OUTPUT(*OUTFILE) OUTFILE(QTEMP/VXLVLFMT)`)})`, 1);
    const cur = currentLevels(await conn.rows<Row>('SELECT RFNAME, RFID FROM QTEMP.VXLVLFMT', 100));
    await conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(`DSPPGMREF PGM(${scope.label}/*ALL) OUTPUT(*OUTFILE) OBJTYPE(*PGM *SRVPGM *MODULE) OUTFILE(QTEMP/VXLVLREF)`)})`, 1);
    const uses = formatUses(await conn.rows<Row>(`SELECT WHLIB, WHPNAM, WHFNAM, WHRFNM, WHRFSN FROM QTEMP.VXLVLREF WHERE WHFNAM = ${sqlString(file)} AND WHRFNM <> ''`, 20000), file);
    return { cur, uses, bad: levelMismatches(uses, cur) };
  });
  showReport('levelCheck', {
    title: vscode.l10n.t('Level check — {0}/{1}', lib, file),
    subtitle: out.bad.length ? vscode.l10n.t('{0} of {1} program(s) were compiled against another format level: they end with CPF4131 when they open the file. Recompile them.', out.bad.length, out.uses.length)
      : vscode.l10n.t('All {0} program(s) that use {1} match its current format level.', out.uses.length, file),
    facts: [...out.cur.entries()].map(([f, l]) => [vscode.l10n.t('Format {0}', f), l] as [string, string]),
    actions: [...(out.bad.length ? [{ label: vscode.l10n.t('Recompile the {0} program(s) now', new Set(out.bad.map(b => `${b.lib}/${b.pgm}`)).size), command: 'vanthrex.rebuildImpacted', args: [{ library: lib, name: file, only: [...new Set(out.bad.map(b => `${b.lib}/${b.pgm}`))] }] }] : []),
      { label: vscode.l10n.t('Another file…'), command: 'vanthrex.levelCheck' }],
    tables: [{ title: vscode.l10n.t('Programs using {0}', file), filter: true, columns: ['Library', 'Program', 'Format', 'Compiled with', 'File now', ''],
      rows: out.uses.map(u => { const now = out.cur.get(u.format) ?? ''; return [u.lib, u.pgm, u.format, u.level, now, now && now !== u.level ? vscode.l10n.t('recompile') : '✓']; }),
      rowClass: out.uses.map(u => (out.cur.get(u.format) && out.cur.get(u.format) !== u.level ? 'bad' : undefined)), empty: vscode.l10n.t('No program in {0} uses {1}.', scope.label, file) }],
    note: vscode.l10n.t('Programs compiled with LVLCHK(*NO) on the file override are listed too but will not fail.'),
  }, ALLOWED);
}

// ---------------------------------------------------------------- snapshots

function snapDir(context: vscode.ExtensionContext): vscode.Uri { return vscode.Uri.joinPath(context.globalStorageUri, 'snapshots'); }
const fileName = (sys: string, lib: string, taken: string) => `${sys.replace(/[^A-Za-z0-9_-]/g, '_')}__${lib}__${taken.replace(/[^0-9]/g, '').slice(0, 14)}.json`;

async function readSnapshot(manager: ConnectionManager, lib: string): Promise<Snapshot> {
  const conn = manager.require();
  const rows = await conn.rows<Row>(snapshotSql(lib), 50000);
  return { library: lib, system: conn.profile.name, taken: new Date().toISOString().slice(0, 19).replace('T', ' '), objects: rows.map(toSnapObject) };
}

async function takeSnapshot(context: vscode.ExtensionContext, manager: ConnectionManager, a?: unknown): Promise<void> {
  const lib = await libraryArg(manager, a, vscode.l10n.t('Snapshot of which library?'));
  if (!lib) { return; }
  const snap = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading {0}…', lib) }, () => readSnapshot(manager, lib));
  await vscode.workspace.fs.createDirectory(snapDir(context));
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(snapDir(context), fileName(snap.system, lib, snap.taken)), new TextEncoder().encode(JSON.stringify(snap)));
  const compare = vscode.l10n.t('Compare Later');
  void vscode.window.showInformationMessage(vscode.l10n.t('Snapshot of {0} saved: {1} object(s). Compare it with the library after the release.', lib, snap.objects.length), compare)
    .then(c => { if (c) { void vscode.commands.executeCommand('vanthrex.compareSnapshot', lib); } });
}

async function compareSnapshot(context: vscode.ExtensionContext, manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  let files: [string, vscode.FileType][] = [];
  try { files = await vscode.workspace.fs.readDirectory(snapDir(context)); } catch { /* none yet */ }
  const mine = files.map(([f]) => f).filter(f => f.endsWith('.json') && f.startsWith(`${conn.profile.name.replace(/[^A-Za-z0-9_-]/g, '_')}__`));
  const lib = typeof a === 'string' ? a : (a as { kind?: string; name?: string } | undefined)?.kind === 'library' ? (a as { name: string }).name : undefined;
  const items = mine.filter(f => !lib || f.split('__')[1] === lib.toUpperCase()).sort().reverse().map(f => {
    const [, l, t] = f.replace(/\.json$/, '').split('__');
    return { label: l, description: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`, f };
  });
  if (!items.length) {
    const take = vscode.l10n.t('Take a Snapshot');
    if (await vscode.window.showInformationMessage(vscode.l10n.t('No snapshot saved for {0} yet.', lib ?? conn.profile.name), take)) { await takeSnapshot(context, manager, lib); }
    return;
  }
  const pick = items.length === 1 && lib ? items[0] : await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Compare which snapshot with the library now?') });
  if (!pick) { return; }
  const before = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(snapDir(context), pick.f)))) as Snapshot;
  const now = await reportProgress('snapshotDiff', vscode.l10n.t('Reading {0}…', before.library), () => readSnapshot(manager, before.library));
  const diff = compareSnapshots(before.objects, now.objects);
  const count = (k: string) => diff.filter(d => d.kind === k).length;
  showReport('snapshotDiff', {
    title: vscode.l10n.t('{0}: what changed since {1}', before.library, before.taken),
    subtitle: vscode.l10n.t('{0} added, {1} changed, {2} removed out of {3} object(s) now.', count('added'), count('changed'), count('removed'), now.objects.length),
    actions: [{ label: vscode.l10n.t('Take a new snapshot'), command: 'vanthrex.librarySnapshot', args: [before.library] }, { label: vscode.l10n.t('Compare another…'), command: 'vanthrex.compareSnapshot' }],
    tables: [{ title: vscode.l10n.t('Differences'), filter: true, columns: ['', 'Object', 'Type', 'Attribute', 'What'],
      rows: diff.map(d => [d.kind === 'added' ? '+' : d.kind === 'removed' ? '−' : '~', d.name, d.type, (d.after ?? d.before)?.attribute ?? '', d.what]),
      rowClass: diff.map(d => (d.kind === 'removed' ? 'bad' : d.kind === 'added' ? 'good' : 'different')), empty: vscode.l10n.t('Nothing changed.') }],
    note: vscode.l10n.t('Snapshots are kept on this computer only (the list of objects, sizes, dates and source members, never the data).'),
  }, ALLOWED);
}

export function registerDbCare(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.unusedIndexes', wrap((a?: unknown) => unusedIndexes(manager, a))),
    vscode.commands.registerCommand('vanthrex.dropIndex', wrap((key: string, lib: string) => dropIndex(manager, key, lib))),
    vscode.commands.registerCommand('vanthrex.journalCoverage', wrap((a?: unknown) => journalCoverage(manager, a))),
    vscode.commands.registerCommand('vanthrex.journalCoverage.start', wrap(() => startJournaling(manager))),
    vscode.commands.registerCommand('vanthrex.levelCheck', wrap((a?: unknown) => levelCheck(manager, a))),
    vscode.commands.registerCommand('vanthrex.librarySnapshot', wrap((a?: unknown) => takeSnapshot(context, manager, a))),
    vscode.commands.registerCommand('vanthrex.compareSnapshot', wrap((a?: unknown) => compareSnapshot(context, manager, a))),
  );
}
