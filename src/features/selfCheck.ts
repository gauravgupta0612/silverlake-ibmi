import * as vscode from 'vscode';
import { readLibraries } from './libraryLookup';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { sqlString } from '../core/util';
import { CheckResult, SERVICES, evaluateSelfCheck, missingServices } from '../core/robust';
import { showReport } from './reportPanel';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const ALLOWED = new Set(['vanthrex.selfCheck', 'vanthrex.selfCheck.copy', 'vanthrex.editConnection']);
let lastText = '';

async function timed<T>(fn: () => Promise<T>): Promise<[T | undefined, number, string?]> {
  const t = Date.now();
  try { return [await fn(), Date.now() - t]; } catch (e) { return [undefined, Date.now() - t, errorMessage(e)]; }
}

export async function runSelfCheck(conn: IbmiConnection): Promise<{ results: CheckResult[]; missing: typeof SERVICES; latency: { ssh: number; sql: number } }> {
  const p = conn.profile;
  const [qshOut, sshMs] = await timed(() => conn.qsh('echo vanthrex-ok'));
  const [cl] = await timed(() => conn.runCL('CHKOBJ OBJ(QSYS/QCMD) OBJTYPE(*PGM)'));
  const [, sqlMs, sqlErr] = await timed(() => conn.sql('VALUES 1', 1));
  const [java] = await timed(() => conn.exec('PATH=$PATH:/QOpenSys/pkgs/bin java -version 2>&1 | head -1'));
  const [home] = await timed(() => conn.exec('test -d "$HOME" && test -w "$HOME" && echo yes'));
  const libs = [...new Set([...p.libraries, p.currentLibrary ?? ''].map(l => l.trim().toUpperCase()).filter(Boolean))];
  const q = <T = Row>(sql: string, n = 50) => conn.rows<T>(sql, n).catch(e => { log(`Self-check: ${errorMessage(e)}`); return undefined; });
  const ruLib = vscode.workspace.getConfiguration('vanthrex.rpgunit').get<string>('library', 'RPGUNIT') || 'RPGUNIT';
  const names = SERVICES.map(x => sqlString(x.name)).join(', ');
  const [libRows, env, db2, user, ru, dbg, found] = await Promise.all([
    libs.length ? readLibraries(conn, libs, 500).then(r => r.rows.map(x => ({ L: x.OBJNAME }) as Row)) : Promise.resolve([] as Row[]),
    q(`SELECT OS_VERSION, OS_RELEASE FROM SYSIBMADM.ENV_SYS_INFO`, 1),
    q(`SELECT PTF_GROUP_NAME AS G, PTF_GROUP_LEVEL AS L FROM QSYS2.GROUP_PTF_INFO WHERE PTF_GROUP_DESCRIPTION LIKE '%DB2%' AND PTF_GROUP_STATUS = 'INSTALLED' ORDER BY PTF_GROUP_LEVEL DESC FETCH FIRST 1 ROW ONLY`, 1),
    q(`SELECT COALESCE(SPECIAL_AUTHORITIES, '*NONE') AS SPC, CCSID FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = ${sqlString(conn.user)}`, 1),
    readLibraries(conn, [ruLib.toUpperCase()], 1).then(r => (r.rows.length ? [{ X: 1 } as Row] : [] as Row[])),
    q(`SELECT 1 AS X FROM QSYS2.NETSTAT_INFO WHERE LOCAL_PORT = 8005 AND TCP_STATE = 'LISTEN' FETCH FIRST 1 ROW ONLY`, 1),
    q<{ N: string }>(`SELECT TRIM(ROUTINE_SCHEMA) || '.' || TRIM(ROUTINE_NAME) AS N FROM QSYS2.SYSROUTINES WHERE ROUTINE_SCHEMA IN ('QSYS2', 'SYSTOOLS') AND ROUTINE_NAME IN (${names}) ` +
      `UNION SELECT TRIM(TABLE_SCHEMA) || '.' || TRIM(TABLE_NAME) AS N FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA IN ('QSYS2', 'SYSTOOLS', 'SYSIBMADM') AND TABLE_NAME IN (${names})`, 500),
  ]);
  const results = evaluateSelfCheck({
    qsh: !!qshOut && /vanthrex-ok/.test(qshOut.stdout) && !!cl?.ok,
    sqlEngine: sqlErr ? 'not started' : conn.sqlEngineName,
    javaVersion: java ? java.stdout.trim() : undefined,
    ccsid: user?.[0] ? Number(user[0].CCSID) : undefined,
    homeWritable: home ? /yes/.test(home.stdout) : undefined,
    missingLibraries: libRows ? libs.filter(l => !libRows.some(r => s(r, 'L') === l)) : undefined,
    release: env?.[0] ? `${s(env[0], 'OS_VERSION')}.${s(env[0], 'OS_RELEASE')}` : undefined,
    db2Level: db2?.[0] ? `${s(db2[0], 'G')} level ${s(db2[0], 'L')}` : undefined,
    specialAuthorities: user?.[0] ? s(user[0], 'SPC') : undefined,
    rpgUnit: ru ? ru.length > 0 : undefined,
    debugService: dbg ? dbg.length > 0 : undefined,
  });
  if (sqlErr) { results.splice(1, 1, { area: 'SQL engine', ok: false, detail: sqlErr }); }
  return { results, missing: found ? missingServices(found.map(f => String(f.N))) : [], latency: { ssh: sshMs, sql: sqlMs } };
}

async function selfCheck(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const { results, missing, latency } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking {0}…', conn.profile.name) }, () => runSelfCheck(conn));
  const bad = results.filter(r => r.ok === false).length; const warn = results.filter(r => r.ok === 'warn').length;
  const icon = (ok: CheckResult['ok']) => (ok === true ? '✔' : ok === 'warn' ? '!' : '✘');
  lastText = [`Vanthrex self-check — ${conn.profile.name} (${conn.user}@${conn.profile.host})`, `SSH round trip ${latency.ssh} ms, SQL round trip ${latency.sql} ms`, '',
    ...results.map(r => `${icon(r.ok)} ${r.area}: ${r.detail}${r.fix ? ` → ${r.fix}` : ''}`), '',
    missing.length ? `IBM i services not found: ${missing.map(m => `${m.schema}.${m.name} (${m.features})`).join('; ')}` : 'All IBM i services used by Vanthrex are available.'].join('\n');
  showReport('selfcheck', {
    title: vscode.l10n.t('Self-check — {0}', conn.profile.name),
    subtitle: bad ? `${bad} problem(s) and ${warn} warning(s). Each line says how to fix it.` : warn ? `${warn} warning(s), no blocking problem.` : 'Everything Vanthrex needs is in place.',
    facts: [['SSH round trip', `${latency.ssh} ms`], ['SQL round trip', `${latency.sql} ms`], ['Protection', conn.profile.protection ?? 'none'],
      ['Features available', `${missing.length ? SERVICES.length - missing.length : SERVICES.length} of ${SERVICES.length} IBM i services found`]],
    actions: [{ label: vscode.l10n.t('Run again'), command: 'vanthrex.selfCheck' }, { label: vscode.l10n.t('Copy the report (for a support issue)'), command: 'vanthrex.selfCheck.copy' }],
    tables: [
      { title: vscode.l10n.t('Checks'), columns: ['', 'Area', 'Result', 'How to fix'], rows: results.map(r => [icon(r.ok), r.area, r.detail, r.fix ?? '']),
        rowClass: results.map(r => (r.ok === false ? 'bad' : r.ok === 'warn' ? 'different' : undefined)) },
      { title: vscode.l10n.t('IBM i services not available on this system'), columns: ['Service', 'Used by'], rows: missing.map(m => [`${m.schema}.${m.name}`, m.features]),
        empty: vscode.l10n.t('None — every feature can run here.') },
    ],
    note: vscode.l10n.t('Missing services come with newer IBM i releases and Db2 for i PTF groups (SF99950 on 7.5, SF99704 on 7.4, SF99703 on 7.3). Features that need them say so when you use them.'),
  }, ALLOWED);
}

export function registerSelfCheck(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const checked = new Set<string>();
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.selfCheck', async () => {
      try { await selfCheck(manager); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
    }),
    vscode.commands.registerCommand('vanthrex.selfCheck.copy', async () => {
      await vscode.env.clipboard.writeText(lastText);
      vscode.window.showInformationMessage(vscode.l10n.t('Self-check report copied.'));
    }),
    manager.onDidChange(async c => {
      if (!c || checked.has(c.profile.id) || !vscode.workspace.getConfiguration('vanthrex').get<boolean>('selfCheck.onConnect', true)) { return; }
      checked.add(c.profile.id);
      try {
        const { results } = await runSelfCheck(c);
        const bad = results.filter(r => r.ok === false);
        if (bad.length) {
          const pick = await vscode.window.showWarningMessage(vscode.l10n.t('{0}: {1} setup problem(s) found ({2}).', c.profile.name, bad.length, bad.map(b => b.area).join(', ')), vscode.l10n.t('Show Details'));
          if (pick) { await selfCheck(manager); }
        }
      } catch (e) { log(`Self-check on connect: ${errorMessage(e)}`); }
    }),
  );
}

/** Quick way to mark a connection as production / read-only. */
export function registerProtection(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  context.subscriptions.push(vscode.commands.registerCommand('vanthrex.setProtection', async (n?: { id?: string }) => {
    try {
      const id = n?.id ?? manager.connection?.profile.id;
      const profile = id ? manager.profiles.get(id) : undefined;
      if (!profile) { throw new Error(vscode.l10n.t('Pick a connection first.')); }
      const pick = await vscode.window.showQuickPick([
        { label: vscode.l10n.t('$(server) No protection'), detail: vscode.l10n.t('Development or test system'), value: 'none' as const },
        { label: vscode.l10n.t('$(shield) Production: ask before every change'), detail: vscode.l10n.t('Commands, SQL and saves that change something need a confirmation'), value: 'confirm' as const },
        { label: vscode.l10n.t('$(lock) Read-only: never change anything'), detail: vscode.l10n.t('Look, query and download only'), value: 'readOnly' as const },
      ], { title: vscode.l10n.t('Protection for {0}', profile.name) });
      if (!pick) { return; }
      const updated = { ...profile, protection: pick.value === 'none' ? undefined : pick.value };
      await manager.profiles.save(updated);
      for (const c of manager.openConnections) { if (c.profile.id === id) { c.profile.protection = updated.protection; } }
      manager.updateStatus();
      vscode.window.showInformationMessage(vscode.l10n.t('{0}: {1}', profile.name, pick.label.replace(/^\$\([^)]*\)\s*/, '')));
    } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  }));
}
