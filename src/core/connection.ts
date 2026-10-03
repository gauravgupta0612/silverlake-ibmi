import * as vscode from 'vscode';
import * as fs from 'fs';
import { NodeSSH } from 'node-ssh';
import type { SFTPWrapper, FileEntry, Stats } from 'ssh2';
import { ConnectionProfile } from './profiles';
import { Db2utilEngine, MapepireEngine, SqlEngine, SqlResult } from './sql';
import { clString, memberPath, shDoubleQuote, shSingleQuote } from './util';
import { log, logError } from './log';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ClResult extends CommandResult {
  ok: boolean;
  /** CPF/MCH/RNF… message ids found in the output. */
  messages: string[];
}

const QSH = '/QOpenSys/usr/bin/qsh';

export class IbmiConnection implements vscode.Disposable {
  readonly ssh = new NodeSSH();
  private sftpClient?: SFTPWrapper;
  private sqlEngine?: SqlEngine;
  private sqlEnginePromise?: Promise<SqlEngine>;
  private password?: string;
  homeDirectory = '/home';

  constructor(public profile: ConnectionProfile) {}

  get user(): string { return this.profile.user.toUpperCase(); }

  get sqlEngineName(): string { return this.sqlEngine?.name ?? 'not started'; }

  async connect(password?: string): Promise<void> {
    this.password = password;
    const p = this.profile;
    await this.ssh.connect({
      host: p.host,
      port: p.port || 22,
      username: p.user,
      password: p.authType === 'password' ? password : undefined,
      privateKeyPath: p.authType === 'key' ? p.privateKeyPath : undefined,
      passphrase: p.authType === 'key' ? password : undefined,
      tryKeyboard: p.authType === 'password',
      onKeyboardInteractive: (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => password ?? ''));
      },
      readyTimeout: 30000,
      keepaliveInterval: 30000,
    });
    const home = await this.exec('echo $HOME');
    if (home.stdout.trim()) { this.homeDirectory = home.stdout.trim(); }
    log(`Connected to ${p.host} as ${this.user}`);
  }

  get isConnected(): boolean {
    return this.ssh.isConnected();
  }

  /** Run a PASE shell command. */
  async exec(command: string, stdin?: string): Promise<CommandResult> {
    const r = await this.ssh.execCommand(command, { stdin });
    return { code: r.code ?? 0, stdout: r.stdout, stderr: r.stderr };
  }

  /** Run a QSH script (passed on stdin). */
  async qsh(script: string): Promise<CommandResult> {
    return this.exec(QSH, script.endsWith('\n') ? script : script + '\n');
  }

  /** True when the SQL engine keeps one job (needed for QTEMP work). */
  get sqlKeepsJob(): boolean {
    return this.sqlEngineName.startsWith('Mapepire');
  }

  /** Run a CL command in a QSH job that has the profile's library list. */
  async runCL(command: string, extraLibraries: string[] = []): Promise<ClResult> {
    const libs = [...new Set([...extraLibraries, ...this.profile.libraries].map(l => l.toUpperCase()))];
    const lines: string[] = [];
    // liblist -a puts the library at the top of the user list, so add in reverse to preserve order.
    for (const lib of [...libs].reverse()) {
      lines.push(`liblist -a ${lib} >/dev/null 2>&1`);
    }
    if (this.profile.currentLibrary) {
      lines.push(`liblist -c ${this.profile.currentLibrary.toUpperCase()} >/dev/null 2>&1`);
    }
    lines.push(`system ${shDoubleQuote(command)}`);
    log(`> ${command}`);
    const r = await this.exec(QSH, lines.join('\n') + '\n');
    const all = `${r.stdout}\n${r.stderr}`;
    const messages = [...new Set(all.match(/\b[A-Z]{3}[0-9A-F]{4}\b/g) ?? [])];
    // QSH 'system' returns a non-zero exit status when the command ends with an escape message.
    const ok = r.code === 0;
    if (r.stdout.trim()) { log(r.stdout.trim()); }
    if (r.stderr.trim()) { log(r.stderr.trim()); }
    return { ...r, ok, messages };
  }

  // ---------------------------------------------------------------- SQL

  async sql(statement: string, maxRows = 1000): Promise<SqlResult> {
    const engine = await this.getSqlEngine();
    return engine.query(statement, maxRows);
  }

  /** Convenience: run a query and return the rows. */
  async rows<T = Record<string, unknown>>(statement: string, maxRows = 5000): Promise<T[]> {
    return (await this.sql(statement, maxRows)).rows as T[];
  }

  private getSqlEngine(): Promise<SqlEngine> {
    if (this.sqlEngine) { return Promise.resolve(this.sqlEngine); }
    if (!this.sqlEnginePromise) {
      this.sqlEnginePromise = this.startSqlEngine()
        .then(e => { this.sqlEngine = e; log(`SQL engine: ${e.name}`); return e; })
        .catch(e => { this.sqlEnginePromise = undefined; throw e; });
    }
    return this.sqlEnginePromise;
  }

  private async startSqlEngine(): Promise<SqlEngine> {
    const p = this.profile;
    const libs = p.libraries.map(l => l.toUpperCase());
    const errors: string[] = [];
    const tryDaemon = async () => {
      if (!this.password || p.authType !== 'password') {
        throw new Error('the Mapepire daemon needs password authentication');
      }
      return MapepireEngine.daemon(p.host, p.mapepirePort || 8076, p.user, this.password, libs);
    };
    const tryDb2util = async () => {
      if (!(await Db2utilEngine.isAvailable(this.ssh))) {
        throw new Error('db2util is not installed (yum install db2util)');
      }
      return new Db2utilEngine(this.ssh);
    };
    const order: [string, () => Promise<SqlEngine>][] =
      p.sqlEngine === 'mapepire-daemon' ? [['Mapepire daemon', tryDaemon]]
      : p.sqlEngine === 'mapepire-ssh' ? [['Mapepire over SSH', () => MapepireEngine.overSsh(this.ssh, libs)]]
      : p.sqlEngine === 'db2util' ? [['db2util', tryDb2util]]
      : [
        ['Mapepire over SSH', () => MapepireEngine.overSsh(this.ssh, libs)],
        ['Mapepire daemon', tryDaemon],
        ['db2util', tryDb2util],
      ];
    for (const [label, start] of order) {
      try {
        return await start();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${label}: ${msg}`);
        log(`SQL engine ${label} unavailable – ${msg}`);
      }
    }
    throw new Error(`No SQL engine could be started.\n${errors.join('\n')}\n` +
      'Tip: Mapepire over SSH only needs Java on the IBM i; otherwise install db2util or the Mapepire server.');
  }

  // ---------------------------------------------------------------- SFTP / IFS

  async sftp(): Promise<SFTPWrapper> {
    if (!this.sftpClient) {
      this.sftpClient = await this.ssh.requestSFTP();
      this.sftpClient.on('close', () => { this.sftpClient = undefined; });
    }
    return this.sftpClient;
  }

  async readStreamFile(path: string): Promise<Buffer> {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => sftp.readFile(path, (err, data) => err ? reject(err) : resolve(data)));
  }

  async writeStreamFile(path: string, content: Uint8Array): Promise<void> {
    const sftp = await this.sftp();
    await new Promise<void>((resolve, reject) =>
      sftp.writeFile(path, Buffer.from(content), err => err ? reject(err) : resolve()));
  }

  async readDirectory(path: string): Promise<FileEntry[]> {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => sftp.readdir(path, (err, list) => err ? reject(err) : resolve(list)));
  }

  async stat(path: string): Promise<Stats> {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => sftp.stat(path, (err, s) => err ? reject(err) : resolve(s)));
  }

  async mkdir(path: string): Promise<void> {
    const r = await this.exec(`mkdir -p ${shSingleQuote(path)}`);
    if (r.code !== 0) { throw new Error(r.stderr || `mkdir failed for ${path}`); }
  }

  async removePath(path: string, recursive: boolean): Promise<void> {
    const r = await this.exec(`rm ${recursive ? '-rf' : '-f'} ${shSingleQuote(path)}`);
    if (r.code !== 0) { throw new Error(r.stderr || `Could not delete ${path}`); }
  }

  async renamePath(from: string, to: string): Promise<void> {
    const r = await this.exec(`mv ${shSingleQuote(from)} ${shSingleQuote(to)}`);
    if (r.code !== 0) { throw new Error(r.stderr || `Could not rename ${from}`); }
  }

  // ---------------------------------------------------------------- Source members

  tempPath(suffix = ''): string {
    const dir = vscode.workspace.getConfiguration('silverlake').get<string>('tempDirectory', '/tmp').replace(/\/$/, '');
    return `${dir}/slk_${this.user}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${suffix}`;
  }

  async readMember(lib: string, file: string, member: string): Promise<string> {
    const tmp = this.tempPath('.txt');
    try {
      const cmd = `CPYTOSTMF FROMMBR(${clString(memberPath(lib, file, member))}) TOSTMF(${clString(tmp)}) ` +
        `STMFOPT(*REPLACE) STMFCCSID(1208) ENDLINFMT(*LF)`;
      const r = await this.runCL(cmd);
      if (!r.ok) { throw new Error(`Could not read ${lib}/${file}(${member}): ${(r.stderr || r.stdout).trim()}`); }
      return (await this.readStreamFile(tmp)).toString('utf8');
    } finally {
      this.exec(`rm -f ${shSingleQuote(tmp)}`).catch(() => undefined);
    }
  }

  async writeMember(lib: string, file: string, member: string, content: string): Promise<void> {
    const tmp = this.tempPath('.txt');
    try {
      const text = content.replace(/\r\n/g, '\n');
      await this.writeStreamFile(tmp, Buffer.from(text, 'utf8'));
      await this.exec(`/QOpenSys/usr/bin/setccsid 1208 ${shSingleQuote(tmp)}`);
      const cmd = `CPYFRMSTMF FROMSTMF(${clString(tmp)}) TOMBR(${clString(memberPath(lib, file, member))}) ` +
        `MBROPT(*REPLACE) STMFCCSID(1208) DBFCCSID(*FILE) ENDLINFMT(*LF)`;
      const r = await this.runCL(cmd);
      if (!r.ok) { throw new Error(`Could not save ${lib}/${file}(${member}): ${(r.stderr || r.stdout).trim()}`); }
    } finally {
      this.exec(`rm -f ${shSingleQuote(tmp)}`).catch(() => undefined);
    }
  }

  async downloadToLocal(remotePath: string, localPath: string): Promise<void> {
    const data = await this.readStreamFile(remotePath);
    await fs.promises.writeFile(localPath, data);
  }

  async dispose(): Promise<void> {
    try { await this.sqlEngine?.dispose(); } catch (e) { logError(e); }
    this.sqlEngine = undefined;
    this.sqlEnginePromise = undefined;
    try { this.sftpClient?.end(); } catch { /* ignore */ }
    this.ssh.dispose();
    log(`Disconnected from ${this.profile.host}`);
  }
}
