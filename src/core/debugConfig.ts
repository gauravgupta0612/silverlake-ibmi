// IBM i Debug Service settings and the launch configuration for IBM's "IBM i Debug" client
// (extension IBM.ibmidebug, debug type "IBMiDebug"). Pure functions, unit tested.

export const DEBUG_EXTENSION_ID = 'IBM.ibmidebug';
export const DEBUG_TYPE = 'IBMiDebug';
/** Configuration file the IBM i Debug Service ships with. */
export const DEBUG_ENV_FILE = '/QIBM/ProdData/IBMiDebugService/bin/DebugService.env';

/** Parse a KEY=VALUE file ("#" comments, optional quotes, optional "export "). */
export function parseEnvFile(text: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) { continue; }
    const eq = line.indexOf('=');
    if (eq <= 0) { continue; }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env.set(key, value);
  }
  return env;
}

export interface DebugServiceInfo {
  root: string;
  workDir: string;
  port: number;
  sepPort: number;
  /** Server keystore (.pfx) and the client certificate (.crt) clients must trust. */
  serviceCertificate: string;
  clientCertificate: string;
}

export function debugServiceInfo(env: Map<string, string>): DebugServiceInfo {
  const get = (k: string, d: string) => (env.get(k) || d);
  const root = get('DBGSRV_ROOT', '/QIBM/ProdData/IBMiDebugService');
  const workDir = get('DBGSRV_WRK_DIR', '/QIBM/UserData/IBMiDebugService');
  const serviceCertificate = get('DEBUG_SERVICE_KEYSTORE_FILE', `${workDir}/certs/debug_service.pfx`);
  return {
    root, workDir,
    port: Number(get('DBGSRV_SECURED_PORT', '8005')) || 8005,
    sepPort: Number(get('DBGSRV_SEP_DAEMON_PORT', '8008')) || 8008,
    serviceCertificate,
    clientCertificate: serviceCertificate.replace(/\.pfx$/i, '.crt'),
  };
}

export interface BatchDebugOptions {
  host: string;
  user: string;
  password: string;
  port: number;
  library: string;
  program: string;
  /** CL command that starts the program (usually CALL PGM(LIB/PGM) PARM(...)). */
  callCommand: string;
  libraries: string[];
  currentLibrary?: string;
  ignoreCertificateErrors: boolean;
  updateProductionFiles: boolean;
  trace: boolean;
}

/** The SBMJOB that runs the program in batch under the debugger. */
export function batchJobCommand(o: Pick<BatchDebugOptions, 'callCommand' | 'libraries' | 'currentLibrary'>): string {
  const libl = o.libraries.length ? o.libraries.join(' ') : '*CURRENT';
  const curlib = o.currentLibrary || '*CRTDFT';
  return `SBMJOB CMD(${o.callCommand.trim()}) INLLIBL(${libl}) CURLIB(${curlib}) JOBQ(QSYSNOMAX) MSGQ(*USRPRF) CPYENVVAR(*YES)`;
}

/** Launch configuration understood by the IBM i Debug extension (same shape Code for IBM i uses). */
export function batchLaunchConfig(o: BatchDebugOptions): Record<string, unknown> {
  const library = o.library.toUpperCase();
  const program = o.program.toUpperCase();
  return {
    type: DEBUG_TYPE,
    request: 'launch',
    name: `IBM i batch debug: program ${library}/${program}`,
    user: o.user.toUpperCase(),
    password: o.password,
    host: o.host,
    port: o.port,
    secure: true,
    ignoreCertificateErrors: o.ignoreCertificateErrors,
    subType: 'batch',
    library,
    program,
    startBatchJobCommand: batchJobCommand(o),
    updateProductionFiles: o.updateProductionFiles,
    trace: o.trace,
  };
}

/** Default call command for a program, with optional parameters typed by the user. */
export function defaultCallCommand(library: string, program: string, parms = ''): string {
  const p = parms.trim();
  return `CALL PGM(${library.toUpperCase()}/${program.toUpperCase()})${p ? ` PARM(${p})` : ''}`;
}
