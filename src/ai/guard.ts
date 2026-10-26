// The one place everything bound for the language model goes through: secrets, personal data and internal host names
// replaced by placeholders, sensitive columns masked, denied libraries refused, production systems limited to metadata,
// and a local audit trail of what was sent (sizes and counts, never the content).
import * as vscode from 'vscode';
import { AuditEntry, DataAccess, dataAccessFor, deniedLibrary, maskRows, Redactor, RedactOptions, SENSITIVE_COLUMNS, StreamRestorer } from '../core/aiGuard';
import { IbmiConnection } from '../core/connection';
import { log } from '../core/log';
import { parseMemberPath } from '../core/util';

const cfg = () => vscode.workspace.getConfiguration('vanthrex.ai');
let redactor: Redactor | undefined;
let storage: vscode.Uri | undefined;
let channel: vscode.OutputChannel | undefined;
const recent: AuditEntry[] = [];
let knownHosts: string[] = [];

function options(): RedactOptions {
  return {
    secrets: cfg().get<boolean>('redact.secrets', true),
    personal: cfg().get<boolean>('redact.personalData', true),
    hosts: cfg().get<boolean>('redact.hostNames', true),
    hostNames: [...knownHosts, ...cfg().get<string[]>('redact.hostList', [])],
    words: cfg().get<string[]>('redact.words', []),
  };
}

/** The session's redactor (one mapping for the whole VS Code session, so answers can be restored). */
export function guard(): Redactor {
  if (!redactor) { redactor = new Redactor(options()); } else { redactor.options = options(); }
  return redactor;
}

export function setKnownHosts(hosts: string[]): void { knownHosts = [...new Set(hosts.filter(Boolean).map(h => h.toLowerCase()))]; if (redactor) { redactor.options = options(); } }

/** Placeholders sent during a request: only these are restored in its answer. */
const scopes = new Set<Set<string>>();
export function beginScope(): Set<string> { const s = new Set<string>(); scopes.add(s); return s; }
export function endScope(s: Set<string>): void { scopes.delete(s); }

/** Redact text bound for the model and record it in the audit trail. */
export function outbound(feature: string, what: string, text: string, conn?: IbmiConnection, maskedColumns?: string[]): string {
  const r = guard();
  const before = r.size;
  const counts = { ...r.counts };
  const out = r.redact(text);
  const hidden = Object.entries(r.counts).reduce((a, [k, v]) => a + v - counts[k as keyof typeof counts], 0);
  audit({ time: new Date().toISOString(), system: conn?.profile.name ?? '-', feature, what, chars: out.length, hidden, maskedColumns });
  void before;
  if (scopes.size) { for (const p of out.match(/xxxx\d+/g) ?? []) { for (const sc of scopes) { sc.add(p); } } }
  return out;
}

/** Answer text shown on this computer: placeholders back to the real values. */
export function restorer(scope?: Set<string>): StreamRestorer { return new StreamRestorer(guard(), scope); }
export function restore(text: string, scope?: Set<string>, inLinks = false): string { return guard().restore(text, scope, inLinks); }

/** Throws when a document may not be sent: a denied library, a key file, or data of a protected system. */
export function checkSource(uri: vscode.Uri, conn: IbmiConnection | undefined): void {
  if (uri.scheme === 'vanthrex-member') { checkLibraries(`${parseMemberPath(uri.path).library}/X`); return; }
  if (uri.scheme === 'vanthrex-ifs') {
    checkLibraries(uri.path);
    if (/\.(key|pem|p12|pfx|kdb|sth|env|jks|keystore|netrc|pgpass|htpasswd)$|\/\.ssh\/|\/\.aws\//i.test(uri.path)) { throw new Error(vscode.l10n.t('{0} looks like a key or credential file: it is not sent to the AI.', uri.path)); }
    if (conn && dataAccess(conn) === 'metadata' && !/\.(rpgle|sqlrpgle|rpgleinc|rpginc|clle|clp|cl|cmd|dspf|prtf|pf|lf|sql|cbl|cblle|sqlcblle|c|cpp|h|java|js|ts|py|sh|md|xml|yaml|yml|json)$/i.test(uri.path)) {
      throw new Error(vscode.l10n.t('{0} is a protected system: only source files of its IFS are sent to the AI.', conn.profile.name));
    }
    return;
  }
  if (uri.scheme === 'vanthrex-spool' && conn && dataAccess(conn) !== 'full') {
    throw new Error(vscode.l10n.t('{0} is a protected system: its spooled files are data and are not sent to the AI (setting vanthrex.ai.productionData).', conn.profile.name));
  }
}

/** How much of a system's data the AI may see. */
export function dataAccess(conn: IbmiConnection | undefined): DataAccess {
  if (!conn) { return 'none'; }
  return dataAccessFor(conn.profile.protection, cfg().get<DataAccess>('productionData', 'metadata'), cfg().get<DataAccess>('otherSystemsData', 'full'));
}

/** Throws when the text names a library the AI may not see. */
export function checkLibraries(text: string): void {
  const lib = deniedLibrary(text, cfg().get<string[]>('deniedLibraries', []));
  if (lib) { throw new Error(vscode.l10n.t('Library {0} is not shared with the AI (setting vanthrex.ai.deniedLibraries).', lib)); }
}

export function isDenied(library: string): boolean {
  return !!deniedLibrary(`${library}/X`, cfg().get<string[]>('deniedLibraries', []));
}

/** Query rows as they may be sent. */
export function safeRows(columns: string[], rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; masked: string[] } {
  return maskRows(columns, rows, guard(), cfg().get<string[]>('sensitiveColumns', SENSITIVE_COLUMNS));
}

function audit(e: AuditEntry): void {
  recent.unshift(e); recent.length = Math.min(recent.length, 500);
  if (!cfg().get<boolean>('audit', true)) { return; }
  (channel ??= vscode.window.createOutputChannel('Vanthrex AI Audit')).appendLine(
    `${e.time} ${e.system} ${e.feature}: ${e.what} — ${e.chars} chars sent, ${e.hidden} value(s) hidden${e.maskedColumns?.length ? `, columns masked: ${e.maskedColumns.join(', ')}` : ''}`);
  if (storage) {
    const file = vscode.Uri.joinPath(storage, 'ai-audit.jsonl');
    void (async () => {
      try {
        let old = '';
        try { old = new TextDecoder().decode(await vscode.workspace.fs.readFile(file)); } catch { /* first entry */ }
        if (old.length > 2_000_000) { old = old.slice(old.length - 1_000_000); old = old.slice(old.indexOf('\n') + 1); }
        await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(old + JSON.stringify(e) + '\n'));
      } catch (err) { log(`AI audit not written: ${String(err)}`); }
    })();
  }
}

export function recentAudit(): AuditEntry[] { return recent; }
export function auditFile(): vscode.Uri | undefined { return storage ? vscode.Uri.joinPath(storage, 'ai-audit.jsonl') : undefined; }

export function initGuard(context: vscode.ExtensionContext): void {
  storage = context.globalStorageUri;
  Promise.resolve().then(() => vscode.workspace.fs.createDirectory(storage!)).catch(() => undefined);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('vanthrex.ai') && redactor) { redactor.options = options(); } }));
}
