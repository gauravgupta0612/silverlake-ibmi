// Go to Anything (Ctrl+Alt+J): members, objects, IFS files and recent items of the connected system in one list,
// filtered as you type from a list kept in memory — no query while typing. The list is loaded in the background right
// after connecting (warm-up), together with the SQL job, the source index refresh and the most recent members.
import * as vscode from 'vscode';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { parseMemberPath, sqlString } from '../core/util';
import { IFS_SCHEME, MEMBER_SCHEME, ifsUri, memberUri } from './fileSystems';
import { refreshIndexed } from './sourceIndexView';

type Row = Record<string, unknown>;
interface Entry { kind: 'member' | 'object' | 'ifs'; label: string; description: string; args: Record<string, string> }
const RECENT = 'vanthrex.recentItems';
const lists = new Map<string, { at: number; entries: Entry[] }>(); // per system
const loading = new Map<string, Promise<Entry[]>>();

function libsOf(conn: IbmiConnection): string[] {
  return [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries].filter(Boolean) as string[])];
}

async function loadEntries(conn: IbmiConnection): Promise<Entry[]> {
  const libs = libsOf(conn);
  if (!libs.length) { return []; }
  const max = vscode.workspace.getConfiguration('vanthrex.goTo').get<number>('maxItems', 40000);
  const inList = libs.map(sqlString).join(', ');
  const [members, objects] = await Promise.all([
    conn.rows<Row>(`SELECT P.SYSTEM_TABLE_SCHEMA AS L, P.SYSTEM_TABLE_NAME AS F, P.SYSTEM_TABLE_MEMBER AS M, COALESCE(P.SOURCE_TYPE, '') AS T, COALESCE(P.PARTITION_TEXT, '') AS X FROM QSYS2.SYSPARTITIONSTAT P ` +
      `JOIN QSYS2.SYSTABLES T ON T.SYSTEM_TABLE_SCHEMA = P.SYSTEM_TABLE_SCHEMA AND T.SYSTEM_TABLE_NAME = P.SYSTEM_TABLE_NAME AND T.FILE_TYPE = 'S' ` +
      `WHERE P.SYSTEM_TABLE_SCHEMA IN (${inList}) FETCH FIRST ${max} ROWS ONLY`, max).catch(e => { log(`Go to: members: ${errorMessage(e)}`); return [] as Row[]; }),
    Promise.all(libs.map(l => conn.rows<Row>(`SELECT '${l.replace(/'/g, "''")}' AS L, OBJNAME AS N, OBJTYPE AS T, COALESCE(OBJATTRIBUTE, '') AS A, COALESCE(OBJTEXT, '') AS X ` +
      `FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(l)}, '*PGM *SRVPGM *FILE *CMD *DTAARA *DTAQ *MODULE *MSGF *BNDDIR *JOBD *OUTQ')) O`, max).catch(() => [] as Row[]))).then(a => a.flat()),
  ]);
  const s = (r: Row, k: string) => String(r[k] ?? '').trim();
  return [
    ...members.map(r => ({ kind: 'member' as const, label: `$(file-code) ${s(r, 'M')}`, description: `${s(r, 'L')}/${s(r, 'F')} · ${s(r, 'T')}${s(r, 'X') ? ' · ' + s(r, 'X') : ''}`, args: { library: s(r, 'L'), file: s(r, 'F'), member: s(r, 'M'), type: s(r, 'T') } })),
    ...objects.map(r => ({ kind: 'object' as const, label: `$(symbol-class) ${s(r, 'N')}`, description: `${s(r, 'L')} · ${s(r, 'T')}${s(r, 'A') ? ' ' + s(r, 'A') : ''}${s(r, 'X') ? ' · ' + s(r, 'X') : ''}`, args: { library: s(r, 'L'), name: s(r, 'N'), type: s(r, 'T') } })),
  ];
}

function entriesFor(conn: IbmiConnection, force = false): Promise<Entry[]> {
  const k = conn.profile.id;
  const ttl = vscode.workspace.getConfiguration('vanthrex.goTo').get<number>('refreshMinutes', 30) * 60000;
  const have = lists.get(k);
  if (have && !force && Date.now() - have.at < ttl) { return Promise.resolve(have.entries); }
  if (loading.has(k)) { return loading.get(k)!; }
  const p = loadEntries(conn).then(entries => { lists.set(k, { at: Date.now(), entries }); return entries; }).finally(() => loading.delete(k));
  loading.set(k, p);
  return have && !force ? Promise.resolve(have.entries) : p;
}

function recentEntries(state: vscode.Memento, system: string): Entry[] {
  return state.get<(Entry & { system: string })[]>(RECENT, []).filter(e => e.system === system);
}

export async function rememberRecent(state: vscode.Memento, system: string, e: Entry): Promise<void> {
  const all = state.get<(Entry & { system: string })[]>(RECENT, []).filter(x => !(x.system === system && x.kind === e.kind && JSON.stringify(x.args) === JSON.stringify(e.args)));
  await state.update(RECENT, [{ ...e, system }, ...all].slice(0, 60));
}

async function goToAnything(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  type Item = vscode.QuickPickItem & { e?: Entry };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = vscode.l10n.t('Go to anything on {0} — members, objects, recent IFS files', conn.profile.name);
  qp.placeholder = vscode.l10n.t('Type part of a name or description (ORD*, customer…)');
  qp.matchOnDescription = true;
  qp.busy = !lists.has(conn.profile.id);
  const recent = recentEntries(state, conn.profile.id);
  const toItems = (entries: Entry[]): Item[] => [
    ...(recent.length ? [{ label: vscode.l10n.t('Recently opened'), kind: vscode.QuickPickItemKind.Separator } as Item, ...recent.map(e => ({ label: e.label, description: e.description, e }))] : []),
    { label: vscode.l10n.t('Library list'), kind: vscode.QuickPickItemKind.Separator },
    ...entries.map(e => ({ label: e.label, description: e.description, e })),
  ];
  qp.items = toItems(lists.get(conn.profile.id)?.entries ?? []);
  qp.buttons = [{ iconPath: new vscode.ThemeIcon('refresh'), tooltip: vscode.l10n.t('Reload the list') }];
  qp.onDidTriggerButton(async () => { qp.busy = true; qp.items = toItems(await entriesFor(conn, true)); qp.busy = false; });
  void entriesFor(conn).then(entries => { qp.items = toItems(entries); qp.busy = false; }).catch(e => { qp.busy = false; logError(e); });
  qp.onDidAccept(async () => {
    const e = qp.selectedItems[0]?.e;
    if (!e) { return; }
    qp.hide();
    await rememberRecent(state, conn.profile.id, e);
    if (e.kind === 'member') { await vscode.window.showTextDocument(memberUri(e.args.library, e.args.file, e.args.member, e.args.type || 'mbr'), { preview: false }); }
    else if (e.kind === 'ifs') { await vscode.window.showTextDocument(ifsUri(e.args.path), { preview: false }); }
    else {
      const t = e.args.type;
      const options = [
        { label: vscode.l10n.t('$(info) Object information'), cmd: 'vanthrex.objectInfo' },
        ...(t === '*PGM' || t === '*SRVPGM' ? [{ label: vscode.l10n.t('$(go-to-file) Open the source'), cmd: 'vanthrex.openProgramSource' }, { label: vscode.l10n.t('$(type-hierarchy) Call graph'), cmd: 'vanthrex.callGraph' }] : []),
        ...(t === '*FILE' ? [{ label: vscode.l10n.t('$(table) Query the data'), cmd: 'vanthrex.sqlQuery' }, { label: vscode.l10n.t('$(references) Where used'), cmd: 'vanthrex.whereUsed' }] : []),
        { label: vscode.l10n.t('$(lock) Who has it locked?'), cmd: 'vanthrex.objectLocks' },
      ];
      const pick = options.length === 1 ? options[0] : await vscode.window.showQuickPick(options, { title: `${e.args.library}/${e.args.name} ${t}` });
      if (pick) { await vscode.commands.executeCommand(pick.cmd, { library: e.args.library, name: e.args.name, type: t }); }
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

// ---------------------------------------------------------------- warm-up

async function warmUp(manager: ConnectionManager, conn: IbmiConnection, state: vscode.Memento, quiet: boolean): Promise<void> {
  const t0 = Date.now();
  const steps: string[] = [];
  const time = async (name: string, fn: () => Promise<unknown>) => { const s = Date.now(); try { await fn(); steps.push(`${name} ${Date.now() - s} ms`); } catch (e) { log(`Warm-up ${name}: ${errorMessage(e)}`); } };
  const bar = vscode.window.setStatusBarMessage(vscode.l10n.t('$(sync~spin) Vanthrex: getting {0} ready…', conn.profile.name));
  try {
    await time('SQL job', () => conn.sql('VALUES 1', 1));
    await Promise.all([
      time('Go to list', () => entriesFor(conn, true)),
      time('Source index', () => (vscode.workspace.getConfiguration('vanthrex.index').get<boolean>('refreshOnConnect', true) ? refreshIndexed(conn) : Promise.resolve(0))),
    ]);
    // The most recently opened members go into the member cache, so they open instantly.
    const recentMembers = recentEntries(state, conn.profile.id).filter(e => e.kind === 'member').slice(0, vscode.workspace.getConfiguration('vanthrex.warmUp').get<number>('members', 5));
    await time('Recent members', async () => { for (const e of recentMembers) { await vscode.workspace.fs.readFile(memberUri(e.args.library, e.args.file, e.args.member, e.args.type || 'mbr')).then(undefined, () => undefined); } });
  } finally { bar.dispose(); }
  log(`Warm-up of ${conn.profile.name} in ${Date.now() - t0} ms: ${steps.join(', ')}`);
  if (!quiet) { vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) {0} ready in {1} s', conn.profile.name, ((Date.now() - t0) / 1000).toFixed(1)), 6000); }
  void manager;
}

export function registerQuickOpen(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  const warmed = new Set<string>();
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.goToAnything', wrap(() => goToAnything(manager, context.globalState))),
    vscode.commands.registerCommand('vanthrex.warmUp', wrap(() => warmUp(manager, manager.require(), context.globalState, false))),
    manager.onDidChange(conn => {
      if (!conn || warmed.has(conn.profile.id) || !vscode.workspace.getConfiguration('vanthrex.warmUp').get<boolean>('enabled', true)) { return; }
      warmed.add(conn.profile.id);
      // After the views have loaded: never slow down the connection itself.
      setTimeout(() => { if (conn.isConnected) { void warmUp(manager, conn, context.globalState, false).catch(logError); } }, 3000);
    }),
    // Remember opened members and IFS files for Go to Anything.
    vscode.workspace.onDidOpenTextDocument(doc => {
      const conn = manager.connection;
      if (!conn) { return; }
      try {
        if (doc.uri.scheme === MEMBER_SCHEME) {
          const m = parseMemberPath(doc.uri.path);
          void rememberRecent(context.globalState, conn.profile.id, { kind: 'member', label: `$(history) ${m.member}`, description: `${m.library}/${m.file} · ${m.extension.toUpperCase()}`, args: { library: m.library, file: m.file, member: m.member, type: m.extension } });
        } else if (doc.uri.scheme === IFS_SCHEME) {
          void rememberRecent(context.globalState, conn.profile.id, { kind: 'ifs', label: `$(history) ${doc.uri.path.split('/').pop()}`, description: doc.uri.path, args: { path: doc.uri.path } });
        }
      } catch { /* not a member path */ }
    }),
  );
}
