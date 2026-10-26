// Speed and flow: a speed test of the connection with advice, the member cache commands, links on every IBM i
// reference in any editor (members, objects, IFS paths, message IDs, jobs), and recompiling in parallel every program
// that uses a changed file.
import * as vscode from 'vscode';
import { refsIn, runPool, speedSummary, SpeedMeasures } from '../core/speed';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { assertSystemName, sqlString, substituteVariables } from '../core/util';
import { ifsUri, memberUri } from './fileSystems';
import { cacheClear, cacheEnabled, cacheStats } from './memberCache';
import { reportProgress, showReport } from './reportPanel';
import { indexedLibraries } from './sourceIndexView';

type Row = Record<string, unknown>;
const ALLOWED = new Set(['vanthrex.speedTest', 'vanthrex.memberCache.clear', 'vanthrex.index.build', 'vanthrex.rebuildImpacted', 'vanthrex.codeMetrics.open', 'vanthrex.openSettings']);
const s = (r: Row, k: string) => String(r[k] ?? '').trim();

// ---------------------------------------------------------------- speed test

async function speedTest(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const m = await reportProgress('speedTest', vscode.l10n.t('Measuring {0}…', conn.profile.name), async () => {
    const time = async (fn: () => Promise<unknown>) => { const t = Date.now(); await fn(); return Date.now() - t; };
    const sshMs: number[] = []; const qshMs: number[] = []; const sqlMs: number[] = [];
    for (let i = 0; i < 5; i++) { sshMs.push(await time(() => conn.exec('true'))); }
    for (let i = 0; i < 3; i++) { qshMs.push(await time(() => conn.qsh('true'))); }
    await conn.sql('VALUES 1', 1);
    for (let i = 0; i < 5; i++) { sqlMs.push(await time(() => conn.sql('VALUES 1', 1))); }
    const size = 2 * 1024 * 1024;
    const down = await time(() => conn.exec(`/QOpenSys/usr/bin/head -c ${size} /dev/zero | /QOpenSys/usr/bin/tr '\\0' 'a'`));
    const up = await time(() => conn.exec('/QOpenSys/usr/bin/wc -c', 'a'.repeat(size)));
    const st = await cacheStats();
    const measures: SpeedMeasures = { sshMs, qshMs, sqlMs, downloadMBps: 2 / Math.max(0.001, down / 1000), uploadMBps: 2 / Math.max(0.001, up / 1000), sqlEngine: conn.sqlEngineName, memberCache: cacheEnabled(), indexedLibraries: (await indexedLibraries(conn.profile.id)).length };
    return { measures, st };
  });
  const sum = speedSummary(m.measures);
  const icon = { fast: '🟢', good: '🟡', slow: '🔴' };
  showReport('speedTest', {
    title: vscode.l10n.t('Speed test — {0}', conn.profile.name),
    subtitle: sum.grade === 'fast' ? vscode.l10n.t('This connection is fast.') : sum.grade === 'good' ? vscode.l10n.t('This connection is good; see below how to make it faster.') : vscode.l10n.t('Part of this connection is slow; see below what helps most.'),
    facts: [[vscode.l10n.t('SQL engine'), m.measures.sqlEngine || '—'], [vscode.l10n.t('Member cache'), cacheEnabled() ? vscode.l10n.t('{0} member(s), {1} opened from the cache this session', m.st.members, m.st.hits) : vscode.l10n.t('off')],
      [vscode.l10n.t('Indexed libraries'), m.measures.indexedLibraries]],
    actions: [{ label: vscode.l10n.t('Measure again'), command: 'vanthrex.speedTest' }, { label: vscode.l10n.t('Index source libraries…'), command: 'vanthrex.index.build' }, { label: vscode.l10n.t('Clear the member cache'), command: 'vanthrex.memberCache.clear' }],
    tables: [
      { title: vscode.l10n.t('Measures (median)'), columns: ['What', 'Time / speed', ''], rows: sum.rows.map(r => [r[0], r[1], `${icon[r[2] as keyof typeof icon]} ${r[2]}`]), rowClass: sum.rows.map(r => (r[2] === 'slow' ? 'bad' : undefined)) },
      { title: vscode.l10n.t('How to make it faster'), columns: ['Advice'], rows: sum.advice.map(a => [a]), empty: vscode.l10n.t('Nothing to improve: every speed feature is in use.') },
    ],
    note: vscode.l10n.t('Download and upload use 2 MB of generated data; nothing is written on the IBM i.'),
  }, ALLOWED);
}

// ---------------------------------------------------------------- links on IBM i references

async function openRef(manager: ConnectionManager, a: { kind: string; args: Record<string, string> }): Promise<void> {
  const conn = manager.require();
  const x = a.args;
  if (a.kind === 'member') {
    const t = (await conn.rows<Row>(`SELECT COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(x.library)} AND SYSTEM_TABLE_NAME = ${sqlString(x.file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(x.member)}`, 1))[0];
    if (!t) { vscode.window.showWarningMessage(vscode.l10n.t('{0}/{1}({2}) was not found.', x.library, x.file, x.member)); return; }
    await vscode.window.showTextDocument(memberUri(x.library, x.file, x.member, s(t, 'T') || 'mbr'), { preview: false });
  } else if (a.kind === 'object') {
    let type = x.type;
    if (!type) { type = String((await conn.rows<Row>(`SELECT OBJTYPE AS T FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(x.library)}, '*ALL', ${sqlString(x.name)})) O FETCH FIRST 1 ROW ONLY`, 1))[0]?.T ?? '').trim(); }
    await vscode.commands.executeCommand('vanthrex.objectInfo', { library: x.library, name: x.name, type });
  } else if (a.kind === 'ifs') { await vscode.window.showTextDocument(ifsUri(x.path), { preview: false }); }
  else if (a.kind === 'message') { await vscode.commands.executeCommand('vanthrex.explainMessage', x.id); }
  else if (a.kind === 'job') { await vscode.commands.executeCommand('vanthrex.jobLog', { job: x.job }); }
}

const linkTip = (k: string) => (k === 'member' ? vscode.l10n.t('Open the member') : k === 'object' ? vscode.l10n.t('Object information') : k === 'ifs' ? vscode.l10n.t('Open the IFS file') : k === 'message' ? vscode.l10n.t('Explain this message') : vscode.l10n.t('Job log'));

class RefLinks implements vscode.DocumentLinkProvider {
  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    if (!vscode.workspace.getConfiguration('vanthrex.editor').get<boolean>('referenceLinks', true) || doc.lineCount > 20000) { return []; }
    const out: vscode.DocumentLink[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i).text;
      if (!/[\/0-9]/.test(line)) { continue; }
      for (const r of refsIn(line)) {
        const link = new vscode.DocumentLink(new vscode.Range(i, r.start, i, r.end),
          vscode.Uri.parse(`command:vanthrex.openRef?${encodeURIComponent(JSON.stringify([{ kind: r.kind, args: r.args }]))}`));
        link.tooltip = linkTip(r.kind);
        out.push(link);
        if (out.length > 3000) { return out; }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- parallel compile

interface CompileItem { library: string; file: string; member: string; type: string; objlib: string; label?: string }
export interface CompileResult { item: CompileItem; ok: boolean | undefined; command: string; messages: string; ms: number }

/** Compiles members with the first matching compile action, several at a time (vanthrex.compile.parallel). */
export async function compileInParallel(conn: IbmiConnection, items: CompileItem[], title: string): Promise<CompileResult[]> {
  const actions = vscode.workspace.getConfiguration('vanthrex').get<{ name: string; extensions: string[]; source?: string; command: string }[]>('compileActions', []);
  const parallel = Math.max(1, Math.min(8, vscode.workspace.getConfiguration('vanthrex.compile').get<number>('parallel', 4)));
  let done = 0;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (p, token) => {
    const r = await runPool(items, parallel, async (it): Promise<CompileResult> => {
      const ext = it.type.toLowerCase();
      const action = actions.find(a => a.extensions.map(x => x.toLowerCase()).includes(ext) && (a.source ?? 'member') !== 'ifs');
      const t0 = Date.now();
      let res: CompileResult;
      if (!action) { res = { item: it, ok: undefined, command: '', messages: vscode.l10n.t('No compile action for .{0}', ext), ms: 0 }; }
      else {
        const command = substituteVariables(action.command, { LIB: it.library, SRCFILE: it.file, NAME: it.member, EXT: ext, OBJLIB: it.objlib, CURLIB: conn.profile.currentLibrary || 'QGPL', USER: conn.user });
        try {
          const x = await conn.runCL(command);
          res = { item: it, ok: x.ok, command, messages: x.messages.filter(m => !/^CPC/.test(m)).join(' ') || (x.ok ? '' : (x.stderr || x.stdout).trim().split('\n').pop() ?? ''), ms: Date.now() - t0 };
        } catch (e) { res = { item: it, ok: false, command, messages: errorMessage(e).split('\n')[0], ms: Date.now() - t0 }; }
      }
      done++;
      p.report({ message: `${done}/${items.length} ${it.member}`, increment: 100 / items.length });
      return res;
    }, () => token.isCancellationRequested);
    return r.filter((x): x is CompileResult => !!x);
  });
}

// ---------------------------------------------------------------- rebuild what uses a file

async function rebuildImpacted(manager: ConnectionManager, a?: unknown): Promise<void> {
  const conn = manager.require();
  if (!conn.sqlKeepsJob) { throw new Error(vscode.l10n.t('This needs the Mapepire SQL engine (it builds a cross-reference in QTEMP).')); }
  const n = a as { library?: string; name?: string; only?: string[] } | undefined;
  const v = (n?.library && n?.name ? `${n.library}/${n.name}` : await vscode.window.showInputBox({ title: vscode.l10n.t('Recompile the programs that use which file?'), prompt: 'LIBRARY/FILE', placeHolder: 'APPLIB/CUSTMAST' }))?.trim().toUpperCase();
  if (!v?.includes('/')) { return; }
  const [lib, file] = v.split('/').map((x, i) => assertSystemName(x, i ? 'file' : 'library'));
  const scope = n?.only ? undefined : await vscode.window.showQuickPick([{ label: lib, description: vscode.l10n.t('programs of the file library') }, { label: '*USRLIBL', description: vscode.l10n.t('programs of the user part of the library list') }], { title: vscode.l10n.t('Look for programs in') });
  if (!n?.only && !scope) { return; }
  const programs = await reportProgress('rebuild', vscode.l10n.t('Finding the programs that use {0}…', file), async () => {
    let refs: Row[];
    if (n?.only) { refs = n.only.map(x => ({ WHLIB: x.split('/')[0], WHPNAM: x.split('/')[1] })); }
    else {
      await conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(`DSPPGMREF PGM(${scope!.label}/*ALL) OUTPUT(*OUTFILE) OBJTYPE(*PGM *SRVPGM) OUTFILE(QTEMP/VXRBREF)`)})`, 1);
      refs = await conn.rows<Row>(`SELECT DISTINCT WHLIB, WHPNAM FROM QTEMP.VXRBREF WHERE WHFNAM = ${sqlString(file)} AND (WHLNAM = ${sqlString(lib)} OR WHLNAM IN ('*LIBL', '*CURLIB', ' '))`, 5000);
    }
    const out: CompileItem[] = []; const noSource: string[] = [];
    for (const r of refs) {
      const pl = s(r, 'WHLIB'), pn = s(r, 'WHPNAM');
      const i = (await conn.rows<Row>(`SELECT SOURCE_FILE_LIBRARY AS SL, SOURCE_FILE AS SF, SOURCE_FILE_MEMBER AS SM FROM QSYS2.PROGRAM_INFO WHERE PROGRAM_LIBRARY = ${sqlString(pl)} AND PROGRAM_NAME = ${sqlString(pn)} FETCH FIRST 1 ROW ONLY`, 1).catch(() => [] as Row[]))[0];
      if (!i || !s(i, 'SM')) { noSource.push(`${pl}/${pn}`); continue; }
      const t = (await conn.rows<Row>(`SELECT COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(s(i, 'SL'))} AND SYSTEM_TABLE_NAME = ${sqlString(s(i, 'SF'))} AND SYSTEM_TABLE_MEMBER = ${sqlString(s(i, 'SM'))}`, 1).catch(() => [] as Row[]))[0];
      if (!t) { noSource.push(`${pl}/${pn}`); continue; }
      out.push({ library: s(i, 'SL'), file: s(i, 'SF'), member: s(i, 'SM'), type: s(t, 'T'), objlib: pl, label: `${pl}/${pn}` });
    }
    return { out, noSource };
  });
  if (!programs.out.length) { vscode.window.showInformationMessage(vscode.l10n.t('No program with a known source uses {0}/{1}.', lib, file)); return; }
  const go = vscode.l10n.t('Recompile {0}', programs.out.length);
  if (await vscode.window.showWarningMessage(vscode.l10n.t('Recompile the {0} program(s) that use {1}/{2}?', programs.out.length, lib, file), { modal: true, detail: programs.out.map(p => p.label).join(', ').slice(0, 900) }, go) !== go) { return; }
  const t0 = Date.now();
  const res = await compileInParallel(conn, programs.out, vscode.l10n.t('Recompiling the programs that use {0}…', file));
  const failed = res.filter(r => r.ok === false).length;
  showReport('rebuild', {
    title: vscode.l10n.t('Programs recompiled after {0}/{1}', lib, file),
    subtitle: vscode.l10n.t('{0} compiled, {1} failed, {2} without a known source — in {3} s, {4} at a time.', res.filter(r => r.ok).length, failed, programs.noSource.length, ((Date.now() - t0) / 1000).toFixed(1), vscode.workspace.getConfiguration('vanthrex.compile').get<number>('parallel', 4)),
    tables: [{ title: vscode.l10n.t('Programs'), filter: true, columns: ['Program', 'Source', 'Result', 'Seconds', 'Messages'],
      rows: [...res.map(r => [r.item.label ?? '', `${r.item.library}/${r.item.file}(${r.item.member})`, r.ok === undefined ? 'skipped' : r.ok ? '✔ compiled' : '✘ failed', (r.ms / 1000).toFixed(1), r.messages]),
        ...programs.noSource.map(p => [p, '—', vscode.l10n.t('no source recorded'), '', ''])],
      rowActions: res.map(r => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.codeMetrics.open', args: [r.item.library, r.item.file, r.item.member, r.item.type] })),
      rowClass: [...res.map(r => (r.ok === false ? 'bad' : undefined)), ...programs.noSource.map(() => 'different')] }],
    note: vscode.l10n.t('Each program is compiled with the first compile action that matches its source type, into its own library. Programs bound to modules (CRTPGM) may need their modules rebuilt first.'),
  }, ALLOWED);
}

export function registerSpeed(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.speedTest', wrap(() => speedTest(manager))),
    vscode.commands.registerCommand('vanthrex.memberCache.clear', wrap(async () => { const n = await cacheClear(); vscode.window.setStatusBarMessage(vscode.l10n.t('Member cache cleared ({0} member(s)).', n), 4000); })),
    vscode.commands.registerCommand('vanthrex.openRef', wrap((a: { kind: string; args: Record<string, string> }) => openRef(manager, a))),
    vscode.commands.registerCommand('vanthrex.rebuildImpacted', wrap((a?: unknown) => rebuildImpacted(manager, a))),
    vscode.languages.registerDocumentLinkProvider([{ language: 'rpgle' }, { language: 'cl' }, { language: 'sql' }, { language: 'dds' }, { language: 'markdown' }, { language: 'plaintext' }, { language: 'log' },
      { scheme: 'vanthrex-spool' }, { scheme: 'vanthrex-member' }, { scheme: 'vanthrex-ifs' }], new RefLinks()),
  );
}
