import { NodeSSH } from 'node-ssh';
import { SQLJob, createNodeSSHExec, createNodeSSHUpload, getRootCertificate } from '@ibm/mapepire-js';
import type { DaemonServer, JDBCOptions } from '@ibm/mapepire-js';
import { shDoubleQuote } from './util';

export interface SqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  updateCount: number;
  truncated: boolean;
  elapsedMs: number;
  engine: string;
}

export interface SqlEngine {
  readonly name: string;
  query(sql: string, maxRows: number): Promise<SqlResult>;
  dispose(): Promise<void>;
}

function jdbcOptions(libraries: string[]): JDBCOptions {
  return {
    naming: 'system',
    libraries: libraries.length ? libraries : undefined,
    'date format': 'iso',
    'time format': 'iso',
    // Most IBM i files are not journaled: run without commitment control so INSERT/UPDATE/DELETE work.
    'transaction isolation': 'none',
  } as JDBCOptions;
}

/** Db2 for i through Mapepire (fast, typed, supports large result sets). */
export class MapepireEngine implements SqlEngine {
  private constructor(private readonly job: SQLJob, readonly name: string) {}

  /**
   * Zero-install mode: the Mapepire server JAR shipped with the extension is uploaded
   * to ~/.mapepire on the IBM i (once) and started over the existing SSH connection.
   * Only needs Java on the IBM i — no daemon, no extra port.
   */
  static async overSsh(ssh: NodeSSH, libraries: string[]): Promise<MapepireEngine> {
    const javaPath = await findJava(ssh);
    if (!javaPath) { throw new Error('Java was not found on the IBM i (install 5770-JV1)'); }
    const job = SQLJob.withConfig(
      {
        transport: 'ssh-single',
        sshSingle: {
          exec: createNodeSSHExec(ssh),
          upload: createNodeSSHUpload(ssh),
          javaPath,
          startupTimeout: 45000,
          requestTimeout: 120000,
        },
      },
      jdbcOptions(libraries),
    );
    await job.connect();
    return new MapepireEngine(job, 'Mapepire (over SSH)');
  }

  /** Connect to a Mapepire daemon already running on the IBM i (default port 8076). */
  static async daemon(host: string, port: number, user: string, password: string, libraries: string[]): Promise<MapepireEngine> {
    const server: DaemonServer = { host, port, user, password };
    // Trust a self-signed root certificate presented by the server (public CAs keep default validation).
    const ca = await withTimeout(getRootCertificate(server), 8000, `no Mapepire daemon answered on port ${port}`);
    if (ca) { server.ca = ca; }
    const job = new SQLJob(jdbcOptions(libraries));
    await withTimeout(job.connect(server), 20000, 'the Mapepire daemon did not respond');
    return new MapepireEngine(job, `Mapepire daemon (port ${port})`);
  }

  async query(sql: string, maxRows: number): Promise<SqlResult> {
    const started = Date.now();
    const q = this.job.query<Record<string, unknown>>(sql);
    try {
      let result = await q.execute(Math.min(maxRows, 1000));
      if (!result.success) {
        throw new Error(result.error || `SQL failed (SQLSTATE ${result.sql_state})`);
      }
      const rows = [...(result.data ?? [])];
      // Statements without a result set (CREATE, DROP, CALL, INSERT…) report has_results = false and
      // sometimes is_done = false: fetching more from them fails with "Result set was null".
      const hasResults = (result as { has_results?: boolean }).has_results !== false && !!result.metadata?.columns?.length;
      let done = !hasResults || result.is_done;
      while (!done && rows.length < maxRows) {
        try {
          result = await q.fetchMore(Math.min(1000, maxRows - rows.length));
        } catch (e) {
          if (/result set was null/i.test(String(e))) { done = true; break; }
          throw e;
        }
        rows.push(...(result.data ?? []));
        done = result.is_done;
      }
      const columns = result.metadata?.columns?.map(c => c.label || c.name)
        ?? (rows[0] ? Object.keys(rows[0]) : []);
      return {
        columns,
        rows,
        updateCount: result.update_count ?? -1,
        truncated: !done,
        elapsedMs: Date.now() - started,
        engine: this.name,
      };
    } finally {
      await q.close().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    await this.job.close().catch(() => undefined);
  }
}

/** Fallback: db2util (yum install db2util) over SSH. Slower but needs no Java. */
export class Db2utilEngine implements SqlEngine {
  readonly name = 'db2util (over SSH)';
  constructor(private readonly ssh: NodeSSH) {}

  static async isAvailable(ssh: NodeSSH): Promise<boolean> {
    const r = await ssh.execCommand('test -x /QOpenSys/pkgs/bin/db2util && echo yes');
    return r.stdout.trim() === 'yes';
  }

  async query(sql: string, maxRows: number): Promise<SqlResult> {
    const started = Date.now();
    // db2util runs in its own job: unqualified names resolve through the user profile's job description.
    const cmd = `/QOpenSys/pkgs/bin/db2util -o json ${shDoubleQuote(sql)}`;
    const r = await this.ssh.execCommand(cmd);
    const out = r.stdout.trim();
    if (r.code && r.code !== 0 && !out.startsWith('{')) {
      throw new Error((r.stderr || out || 'db2util failed').trim());
    }
    let rows: Record<string, unknown>[] = [];
    if (out.startsWith('{')) {
      const parsed = JSON.parse(out);
      if (parsed.error || parsed.errors) {
        throw new Error(JSON.stringify(parsed.error ?? parsed.errors));
      }
      rows = parsed.records ?? [];
    } else if (out.length && /SQLSTATE|SQL\d{4}|error/i.test(out)) {
      throw new Error(out);
    }
    const truncated = rows.length > maxRows;
    rows = rows.slice(0, maxRows);
    return {
      columns: rows[0] ? Object.keys(rows[0]) : [],
      rows,
      updateCount: -1,
      truncated,
      elapsedMs: Date.now() - started,
      engine: this.name,
    };
  }

  async dispose(): Promise<void> { /* nothing to release */ }
}

/** Pick the newest 64-bit JDK installed on the IBM i (or java on the PATH). */
export async function findJava(ssh: NodeSSH): Promise<string | undefined> {
  const r = await ssh.execCommand(
    'ls -d /QOpenSys/QIBM/ProdData/JavaVM/jdk*/64bit/bin/java 2>/dev/null; command -v java 2>/dev/null');
  const paths = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  const version = (p: string) => {
    const m = p.match(/jdk(\d+)/);
    if (!m) { return 0; }
    const n = Number(m[1]);
    return n >= 50 ? n / 10 : n; // jdk80 -> 8, jdk11 -> 11, jdk17 -> 17
  };
  const jdks = paths.filter(p => /jdk\d+/.test(p)).sort((a, b) => version(b) - version(a));
  return jdks[0] ?? paths[0];
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}
