import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { assertSystemName, parseMemberPath, sqlString } from '../core/util';
import {
  DEBUG_ENV_FILE, DEBUG_EXTENSION_ID, DEBUG_TYPE, DebugServiceInfo, batchLaunchConfig, debugServiceInfo,
  defaultCallCommand, parseEnvFile,
} from '../core/debugConfig';
import { MEMBER_SCHEME } from './fileSystems';
import { Report, showReport } from './reportPanel';

type ObjArg = { library: string; name: string; type?: string };

const ALLOWED = new Set(['vanthrex.debugSetup', 'vanthrex.debugStartService', 'vanthrex.debugDownloadCertificate',
  'vanthrex.debugInstallClient', 'vanthrex.debugProgram', 'vscode.open', 'workbench.action.openSettings']);

interface Check { name: string; ok: boolean | undefined; detail: string }

async function serviceInfo(conn: IbmiConnection): Promise<{ info: DebugServiceInfo; installed: boolean }> {
  try {
    const text = (await conn.readStreamFile(DEBUG_ENV_FILE)).toString('utf8');
    return { info: debugServiceInfo(parseEnvFile(text)), installed: true };
  } catch {
    return { info: debugServiceInfo(new Map()), installed: false };
  }
}

async function isListening(conn: IbmiConnection, port: number): Promise<boolean | undefined> {
  try {
    const r = await conn.rows<{ N: number }>(
      `SELECT COUNT(*) AS N FROM QSYS2.NETSTAT_INFO WHERE LOCAL_PORT = ${Math.floor(port)} AND TCP_STATE = 'LISTEN'`, 1);
    return Number(r[0]?.N ?? 0) > 0;
  } catch (e) {
    log(`Debug service port check: ${e}`);
    return undefined;
  }
}

async function remoteExists(conn: IbmiConnection, p: string): Promise<boolean> {
  try { await conn.stat(p); return true; } catch { return false; }
}

function localCertPath(context: vscode.ExtensionContext, host: string): string {
  return path.join(context.globalStorageUri.fsPath, 'debug', `${host.replace(/[^\w.-]/g, '_')}_debug_service.crt`);
}

async function downloadCertificate(context: vscode.ExtensionContext, conn: IbmiConnection, info: DebugServiceInfo): Promise<string> {
  const local = localCertPath(context, conn.profile.host);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(local)));
  const data = await conn.readStreamFile(info.clientCertificate);
  await vscode.workspace.fs.writeFile(vscode.Uri.file(local), data);
  log(`Downloaded debug certificate ${info.clientCertificate} to ${local}`);
  return local;
}

async function fileExists(p: string): Promise<boolean> {
  try { await vscode.workspace.fs.stat(vscode.Uri.file(p)); return true; } catch { return false; }
}

// ---------------------------------------------------------------- setup check page

async function setupCheck(context: vscode.ExtensionContext, manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const cfg = vscode.workspace.getConfiguration('vanthrex.debug');
  const { info, installed } = await serviceInfo(conn);
  const port = cfg.get<number>('port') || info.port;
  const listening = installed ? await isListening(conn, port) : false;
  const serverCert = installed ? await remoteExists(conn, info.clientCertificate) : false;
  const localCert = await fileExists(localCertPath(context, conn.profile.host));
  const client = !!vscode.extensions.getExtension(DEBUG_EXTENSION_ID);
  const ignoreCerts = cfg.get<boolean>('ignoreCertificateErrors', false);

  const checks: Check[] = [
    { name: 'IBM i Debug extension (debug client) in VS Code', ok: client,
      detail: client ? 'Installed.' : 'Not installed. It is IBM\'s free debug client; Vanthrex starts sessions through it.' },
    { name: 'IBM i Debug Service installed on the IBM i', ok: installed,
      detail: installed ? `${info.root}` : `Not found (${DEBUG_ENV_FILE} is missing). Install the Debug Service PTFs for your release — see the Debugging guide.` },
    { name: `Debug Service running (port ${port})`, ok: listening,
      detail: listening === undefined ? 'Could not check (needs QSYS2.NETSTAT_INFO through SQL).' : listening ? 'Listening.' : 'Not running. Use "Start Debug Service", or IBM i Navigator → Network → Servers → TCP/IP Servers → Debug Service.' },
    { name: 'Server certificate generated', ok: serverCert,
      detail: serverCert ? info.clientCertificate : `${info.clientCertificate} not found. An administrator generates it once (see the Debugging guide in the documentation).` },
    { name: 'Certificate trusted on this PC', ok: localCert || ignoreCerts,
      detail: localCert ? localCertPath(context, conn.profile.host) : ignoreCerts ? 'Not downloaded, but vanthrex.debug.ignoreCertificateErrors is on.' : 'Not downloaded yet — use "Download certificate".' },
  ];
  const ready = checks.every(c => c.ok);
  const report: Report = {
    title: `Debugger setup — ${conn.profile.name}`,
    subtitle: ready ? '✔ Everything is ready. Right-click a program (or open its source) → Debug Program.'
      : 'Fix the items marked ✖, then refresh.',
    actions: [
      { label: 'Refresh', command: 'vanthrex.debugSetup' },
      ...(!client ? [{ label: 'Install IBM i Debug extension', command: 'vanthrex.debugInstallClient' }] : []),
      ...(installed && !listening ? [{ label: 'Start Debug Service', command: 'vanthrex.debugStartService' }] : []),
      ...(serverCert && !localCert ? [{ label: 'Download certificate', command: 'vanthrex.debugDownloadCertificate' }] : []),
      { label: 'Debugger settings', command: 'workbench.action.openSettings', args: ['vanthrex.debug'] },
      { label: 'Debugging guide', command: 'vscode.open', args: [vscode.Uri.parse('https://gauravgupta0612.github.io/vanthrex-ibmi-docs/debugging.html')] },
    ],
    tables: [{
      title: 'Checks', columns: ['', 'Check', 'Details'],
      rows: checks.map(c => [c.ok === undefined ? '?' : c.ok ? '✔' : '✖', c.name, c.detail]),
      rowClass: checks.map(c => (c.ok === false ? 'bad' : undefined)),
    }],
    facts: [['Service root', info.root], ['Work directory', info.workDir], ['Secured port', String(port)]],
  };
  showReport('debugSetup', report, ALLOWED);
}

// ---------------------------------------------------------------- debug a program

async function resolveTarget(manager: ConnectionManager, n?: ObjArg): Promise<{ library: string; program: string } | undefined> {
  const conn = manager.require();
  if (n?.library && n.name) { return { library: n.library, program: n.name }; }
  const doc = vscode.window.activeTextEditor?.document;
  let library = conn.profile.objectLibrary || conn.profile.currentLibrary || '';
  let program = '';
  if (doc?.uri.scheme === MEMBER_SCHEME) {
    const m = parseMemberPath(doc.uri.path);
    program = m.member;
    library = conn.profile.objectLibrary || m.library;
  } else if (doc) {
    program = path.basename(doc.uri.path).split('.')[0].toUpperCase().slice(0, 10);
  }
  const v = await vscode.window.showInputBox({
    title: 'Debug program', prompt: 'Program to debug (LIBRARY/PROGRAM). Compile it with DBGVIEW(*SOURCE) first.',
    value: program ? `${library}/${program}` : '', placeHolder: 'MYLIB/ORDENTRY', ignoreFocusOut: true,
    validateInput: s => /^[A-Za-z$#@][\w$#@.]{0,9}\/[A-Za-z$#@][\w$#@.]{0,9}$/.test(s.trim()) ? undefined : 'Use LIBRARY/PROGRAM',
  });
  if (!v) { return undefined; }
  const [l, p] = v.trim().toUpperCase().split('/');
  return { library: assertSystemName(l, 'library'), program: assertSystemName(p, 'program name') };
}

async function debugProgram(context: vscode.ExtensionContext, manager: ConnectionManager, n?: ObjArg): Promise<void> {
  const conn = manager.require();
  if (!vscode.extensions.getExtension(DEBUG_EXTENSION_ID)) {
    const c = await vscode.window.showWarningMessage(
      'Debugging uses IBM\'s free "IBM i Debug" extension as the debug client. Install it now?', 'Install', 'Setup Check');
    if (c === 'Install') { await installClient(); }
    if (c === 'Setup Check') { await setupCheck(context, manager); }
    return;
  }
  const target = await resolveTarget(manager, n);
  if (!target) { return; }

  const exists = await conn.rows<{ T: string }>(
    `SELECT OBJTYPE AS T FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(target.library)}, '*PGM', ${sqlString(target.program)}))`, 1)
    .catch(() => [{ T: '*PGM' }]);
  if (!exists.length) { throw new Error(`Program ${target.library}/${target.program} was not found. Compile it first (Ctrl+Alt+C).`); }

  const cfg = vscode.workspace.getConfiguration('vanthrex.debug');
  const { info, installed } = await serviceInfo(conn);
  if (!installed) {
    const c = await vscode.window.showErrorMessage('The IBM i Debug Service is not installed on this system.', 'Setup Check');
    if (c) { await setupCheck(context, manager); }
    return;
  }
  const port = cfg.get<number>('port') || info.port;
  if (await isListening(conn, port) === false) {
    const c = await vscode.window.showWarningMessage(`The Debug Service is not running (port ${port}). Start it now?`, 'Start', 'Setup Check');
    if (c === 'Setup Check') { await setupCheck(context, manager); return; }
    if (c !== 'Start') { return; }
    await startService(manager);
  }

  // Certificates: the IBM i Debug client reads the CA to trust from DEBUG_CA_PATH in this process.
  const ignoreCertificateErrors = cfg.get<boolean>('ignoreCertificateErrors', false);
  let cert = localCertPath(context, conn.profile.host);
  if (!await fileExists(cert)) {
    try { cert = await downloadCertificate(context, conn, info); }
    catch (e) {
      if (!ignoreCertificateErrors) {
        const c = await vscode.window.showErrorMessage(
          `Could not download the debug certificate (${info.clientCertificate}): ${errorMessage(e)}`, 'Setup Check');
        if (c) { await setupCheck(context, manager); }
        return;
      }
    }
  }
  if (await fileExists(cert)) { process.env.DEBUG_CA_PATH = cert; }

  const remembered = context.workspaceState.get<Record<string, string>>('vanthrex.debug.calls', {});
  const key = `${target.library}/${target.program}`;
  const callCommand = await vscode.window.showInputBox({
    title: `Debug ${key}`, prompt: 'Command that starts the program (add PARM(...) if it needs parameters). It runs in a batch job.',
    value: remembered[key] ?? defaultCallCommand(target.library, target.program), ignoreFocusOut: true,
  });
  if (!callCommand?.trim()) { return; }
  await context.workspaceState.update('vanthrex.debug.calls', { ...remembered, [key]: callCommand.trim() });

  let password = await manager.profiles.getPassword(conn.profile.id);
  if (!password) {
    password = await vscode.window.showInputBox({
      title: 'IBM i Debug', prompt: `Password for ${conn.user} (the Debug Service signs in with it)`, password: true, ignoreFocusOut: true,
    });
    if (!password) { return; }
  }

  const config = batchLaunchConfig({
    host: conn.profile.host, user: conn.user, password, port,
    library: target.library, program: target.program, callCommand: callCommand.trim(),
    libraries: conn.profile.libraries, currentLibrary: conn.profile.currentLibrary,
    ignoreCertificateErrors, updateProductionFiles: cfg.get<boolean>('updateProductionFiles', false),
    trace: cfg.get<boolean>('trace', false),
  });
  log(`Starting IBM i debug session for ${key} (port ${port})`);
  const started = await vscode.debug.startDebugging(undefined, config as vscode.DebugConfiguration);
  if (!started) {
    const c = await vscode.window.showErrorMessage('The debug session did not start. Check the IBM i Debug output and the setup.', 'Setup Check');
    if (c) { await setupCheck(context, manager); }
  }
}

async function startService(manager: ConnectionManager): Promise<void> {
  const conn = manager.require();
  const { info, installed } = await serviceInfo(conn);
  if (!installed) { throw new Error('The IBM i Debug Service is not installed on this system.'); }
  // Same start method as IBM's tooling: the service's own script in a batch job named QDBGSRV, with a Java home.
  const jdks = (await conn.qsh('ls -d /QOpenSys/QIBM/ProdData/JavaVM/jdk*/64bit 2>/dev/null')).stdout.split(/\s+/).filter(Boolean);
  const version = (p: string) => { const n = Number(p.match(/jdk(\d+)/)?.[1] ?? 0); return n >= 50 ? n / 10 : n; };
  const javaHome = jdks.sort((a, b) => version(b) - version(a))[0];
  if (!javaHome) { throw new Error('No 64-bit Java was found on the IBM i (5770-JV1). The Debug Service needs Java 11 or later.'); }
  const logFile = `/tmp/vanthrex_debugservice_${conn.user.toLowerCase()}.log`;
  const cmd = `QSYS/SBMJOB JOB(QDBGSRV) SYSLIBL(*SYSVAL) CURLIB(*USRPRF) INLLIBL(*JOBD) CMD(QSH CMD('touch ${logFile};` +
    `attr ${logFile} CCSID=1208;export JAVA_HOME=${javaHome};${info.root}/bin/startDebugService.sh > ${logFile} 2>&1'))`;
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting the IBM i Debug Service…' },
    async () => {
      const res = await conn.runCL(cmd);
      if (res.ok) { await new Promise(done => setTimeout(done, 8000)); } // the service needs a few seconds to open its port
      return res;
    });
  if (!r.ok) {
    throw new Error(`Could not submit the Debug Service job: ${(r.stderr || r.stdout).trim().split('\n').pop()}. ` +
      'You may need more authority — ask your administrator, or start it in IBM i Navigator (Network → Servers → TCP/IP Servers → Debug Service).');
  }
  const port = vscode.workspace.getConfiguration('vanthrex.debug').get<number>('port') || info.port;
  const up = await isListening(conn, port);
  if (up === false) {
    vscode.window.showWarningMessage(`The Debug Service job was submitted but port ${port} is not open yet. Its log is ${logFile} on the IBM i.`);
  } else {
    vscode.window.showInformationMessage(`The Debug Service is running (port ${port}).`);
  }
}

async function installClient(): Promise<void> {
  await vscode.commands.executeCommand('workbench.extensions.installExtension', DEBUG_EXTENSION_ID);
  vscode.window.showInformationMessage('IBM i Debug installed. Run "Vanthrex: Debugger Setup Check" to finish the setup.');
}

export function registerDebugger(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.debugSetup', guard(() => setupCheck(context, manager))),
    vscode.commands.registerCommand('vanthrex.debugProgram', guard((n?: ObjArg) => debugProgram(context, manager, n))),
    vscode.commands.registerCommand('vanthrex.debugStartService', guard(async () => { await startService(manager); await setupCheck(context, manager); })),
    vscode.commands.registerCommand('vanthrex.debugInstallClient', guard(installClient)),
    vscode.commands.registerCommand('vanthrex.debugDownloadCertificate', guard(async () => {
      const conn = manager.require();
      const { info } = await serviceInfo(conn);
      const local = await downloadCertificate(context, conn, info);
      vscode.window.showInformationMessage(`Debug certificate saved: ${local}`);
      await setupCheck(context, manager);
    })),
    // Sessions end: nothing to clean up on our side, but log it for support.
    vscode.debug.onDidTerminateDebugSession(s => { if (s.type === DEBUG_TYPE) { log(`Debug session ended: ${s.name}`); } }),
  );
}
