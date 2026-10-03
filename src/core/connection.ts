import * as vscode from 'vscode';
import * as fs from 'fs';
import { NodeSSH } from 'node-ssh';
import type { SFTPWrapper, FileEntry, Stats } from 'ssh2';
import { ConnectionProfile } from './profiles';
import { Db2utilEngine, MapepireEngine, SqlEngine, SqlResult } from './sql';
import { clString, memberPath, shDoubleQuote, shSingleQuote, sqlString } from './util';
import { SourceRecord } from './sourceDates';
import { log, logError } from './log';

export interface MemberLock {
  /** Qualified job name: number/user/name (for interactive jobs, name = the workstation). */
  job: string;
  user: string;
  jobName: string;
  /** Lock state, e.g. *SHRRD, *SHRUPD, *EXCLRD. */
  state: string;
  /** User profile description — usually the person's name. */
  userText: string;
}

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
    const dir = vscode.workspace.getConfiguration('vanthrex').get<string>('tempDirectory', '/tmp').replace(/\/$/, '');
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

  // ---------------------------------------------------------------- Members with SEU dates

  private aliasCounter = 0;

  /** True when members can be read and written with their sequence numbers and dates. */
  async canKeepSourceDates(): Promise<boolean> {
    if (!vscode.workspace.getConfiguration('vanthrex').get<boolean>('sourceDates.enabled', true)) { return false; }
    try { await this.sql('VALUES 1', 1); } catch { return false; }
    return this.sqlKeepsJob;
  }

  /** Length of the SRCDTA field of a source file. */
  async sourceLineLength(lib: string, file: string): Promise<number> {
    const r = await this.rows<{ L: number }>(
      `SELECT LENGTH AS L FROM QSYS2.SYSCOLUMNS WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} ` +
      `AND SYSTEM_TABLE_NAME = ${sqlString(file)} AND SYSTEM_COLUMN_NAME = 'SRCDTA'`, 1);
    return Number(r[0]?.L ?? 80);
  }

  private async withAlias<T>(lib: string, file: string, member: string, fn: (alias: string, id: string) => Promise<T>): Promise<T> {
    // The id is taken synchronously, so concurrent operations never share QTEMP object names.
    const id = (++this.aliasCounter % 100000).toString().padStart(5, '0');
    const alias = `QTEMP/SLKA${id}`;
    await this.sql(`CREATE OR REPLACE ALIAS ${alias} FOR ${lib}/${file}(${member})`, 1);
    try { return await fn(alias, id); }
    finally { await this.sql(`DROP ALIAS ${alias}`, 1).catch(() => undefined); }
  }

  /** Run a CL command inside the SQL job (so it sees the same QTEMP). */
  private async sqlCl(command: string): Promise<void> {
    await this.sql(`CALL QSYS2.QCMDEXC(${sqlString(command)})`, 1);
  }

  /** Read a member with its SRCSEQ / SRCDAT values (needs a Mapepire SQL engine). */
  async readMemberRecords(lib: string, file: string, member: string): Promise<SourceRecord[]> {
    return this.withAlias(lib, file, member, async alias => {
      const rows = await this.rows<{ SRCSEQ: number; SRCDAT: number; SRCDTA: string }>(
        `SELECT SRCSEQ, SRCDAT, RTRIM(SRCDTA) AS SRCDTA FROM ${alias} A ORDER BY RRN(A)`, 2_000_000);
      return rows.map(r => ({ seq: Number(r.SRCSEQ), date: Number(r.SRCDAT), text: String(r.SRCDTA ?? '') }));
    });
  }

  private saveChain: Promise<unknown> = Promise.resolve();

  /**
   * Replace a member's records, keeping the given sequence numbers and dates.
   * - The lines are first loaded into a QTEMP work file (a broken transfer never touches the member).
   * - The member is backed up into QTEMP, then replaced in one CPYF MBROPT(*REPLACE), which keeps
   *   the records in order. If that fails, the backup is copied back.
   * - Saves run one at a time on a connection.
   */
  writeMemberRecords(lib: string, file: string, member: string, records: SourceRecord[]): Promise<void> {
    const run = this.saveChain.then(() => this.doWriteMemberRecords(lib, file, member, records));
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  private async doWriteMemberRecords(lib: string, file: string, member: string, records: SourceRecord[]): Promise<void> {
    await this.withAlias(lib, file, member, async (alias, id) => {
      const work = `QTEMP/SLKW${id}`;
      const backup = `QTEMP/SLKB${id}`;
      await this.sql(`DROP TABLE ${work}`, 1).catch(() => undefined);
      await this.sql(`CREATE TABLE ${work} AS (SELECT SRCSEQ, SRCDAT, SRCDTA FROM ${alias}) WITH NO DATA`, 1);
      let backedUp = false;
      try {
        const chunk = 200;
        try {
          for (let i = 0; i < records.length; i += chunk) {
            const values = records.slice(i, i + chunk)
              .map(r => `(${r.seq.toFixed(2)}, ${Math.floor(r.date)}, ${sqlString(r.text)})`).join(', ');
            await this.sql(`INSERT INTO ${work} (SRCSEQ, SRCDAT, SRCDTA) VALUES ${values}`, 1);
          }
        } catch (e) {
          throw new Error('Some lines could not be stored (a line may be too long for the source file, or contain characters ' +
            `its CCSID cannot hold). The member was not changed. Details: ${e instanceof Error ? e.message : e}`);
        }
        const count = (await this.rows<{ N: number }>(`SELECT COUNT(*) AS N FROM ${work}`, 1))[0];
        if (Number(count?.N) !== records.length) {
          throw new Error(`Only ${count?.N} of ${records.length} lines reached the IBM i; the member was not changed.`);
        }
        const existing = Number((await this.rows<{ N: number }>(`SELECT COUNT(*) AS N FROM ${alias}`, 1))[0]?.N ?? 0);
        if (existing > 0) {
          await this.sqlCl(`CPYF FROMFILE(${lib}/${file}) FROMMBR(${member}) TOFILE(${backup}) MBROPT(*REPLACE) CRTFILE(*YES)`);
          backedUp = true;
        }
        try {
          if (records.length) {
            await this.sqlCl(`CPYF FROMFILE(${work}) TOFILE(${lib}/${file}) TOMBR(${member}) MBROPT(*REPLACE) FMTOPT(*MAP)`);
          } else {
            await this.sqlCl(`CLRPFM FILE(${lib}/${file}) MBR(${member})`);
          }
        } catch (e) {
          if (backedUp) {
            try {
              await this.sqlCl(`CPYF FROMFILE(${backup}) TOFILE(${lib}/${file}) TOMBR(${member}) MBROPT(*REPLACE) FMTOPT(*MAP)`);
              log(`Restored ${lib}/${file}(${member}) from the backup after a failed save`);
            } catch (r) { logError(r); }
          }
          throw new Error(`Saving ${lib}/${file}(${member}) failed${backedUp ? ' — the previous version was put back' : ''}: ${e instanceof Error ? e.message : e}`);
        }
      } finally {
        await this.sql(`DROP TABLE ${work}`, 1).catch(() => undefined);
        if (backedUp) { await this.sql(`DROP TABLE ${backup}`, 1).catch(() => undefined); }
      }
    });
    log(`Saved ${lib}/${file}(${member}) with source dates (${records.length} lines)`);
  }

  /**
   * Jobs holding a lock on an object (or one member of a file), strongest lock state per job.
   * OBJECT_LOCK_INFO names the member column SYSTEM_TABLE_MEMBER; on releases without it we fall
   * back to file-level locks, which still shows who has the file open.
   */
  async lockHolders(lib: string, name: string, type: string, member?: string): Promise<{ JOB: string; ST: string }[]> {
    const select = `SELECT JOB_NAME AS JOB, MAX(LOCK_STATE) AS ST FROM QSYS2.OBJECT_LOCK_INFO WHERE `;
    const tail = ` AND OBJECT_TYPE = ${sqlString(type)} AND LOCK_SCOPE <> 'LOCK SPACE'`;
    const sys = `SYSTEM_OBJECT_SCHEMA = ${sqlString(lib)} AND SYSTEM_OBJECT_NAME = ${sqlString(name)}${tail}`;
    const sqlNames = `OBJECT_SCHEMA = ${sqlString(lib)} AND OBJECT_NAME = ${sqlString(name)}${tail}`;
    const attempts = [
      ...(member ? [`${sys} AND SYSTEM_TABLE_MEMBER = ${sqlString(member)}`] : []),
      sys,
      sqlNames,
    ];
    let last: unknown;
    for (const where of attempts) {
      try {
        return await this.rows<{ JOB: string; ST: string }>(`${select}${where} GROUP BY JOB_NAME`, 50);
      } catch (e) {
        last = e;
        // Column not found on this release: try the next, simpler form.
        if (!/SQL0206|42703/.test(String(e))) { throw e; }
      }
    }
    log(`OBJECT_LOCK_INFO: ${last}`);
    return [];
  }

  /** Last change time of a member, and jobs (other than ours) holding a lock on it. */
  async memberState(lib: string, file: string, member: string): Promise<{ changed?: string; locks: MemberLock[] }> {
    let changed: string | undefined;
    let locks: MemberLock[] = [];
    try {
      const r = await this.rows<{ T: string }>(
        `SELECT VARCHAR(LAST_SOURCE_UPDATE_TIMESTAMP) AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} ` +
        `AND SYSTEM_TABLE_NAME = ${sqlString(file)} AND SYSTEM_TABLE_MEMBER = ${sqlString(member)}`, 1);
      changed = r[0]?.T ? String(r[0].T) : undefined;
    } catch (e) { log(`Member change time: ${e}`); }
    try {
      const r = await this.lockHolders(lib, file, '*FILE', member);
      locks = r.map(x => {
        const job = String(x.JOB).trim();
        const [, user = '', name = ''] = job.split('/');
        return { job, user, jobName: name, state: String(x.ST).trim(), userText: '' };
      })
        // Ignore this extension's own background jobs (SSH/PASE and SQL server jobs of the same user).
        .filter(x => !(x.user === this.user && /^(QP0ZSPW[PT]|QSQSRVR|QZDASOINIT|QZSHSH)$/.test(x.jobName)));
      // Who is it? Add the user profile's description (usually the person's name).
      const users = [...new Set(locks.map(l => l.user))].filter(Boolean);
      if (users.length) {
        try {
          const u = await this.rows<{ U: string; T: string }>(
            `SELECT AUTHORIZATION_NAME AS U, COALESCE(TEXT_DESCRIPTION, '') AS T FROM QSYS2.USER_INFO ` +
            `WHERE AUTHORIZATION_NAME IN (${users.map(sqlString).join(', ')})`, 50);
          for (const l of locks) { l.userText = String(u.find(x => String(x.U).trim() === l.user)?.T ?? '').trim(); }
        } catch (e) { log(`User names: ${e}`); }
      }
    } catch (e) { log(`Member locks: ${e}`); }
    return { changed, locks };
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
