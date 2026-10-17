import { explainError } from './friendlyErrors';
import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel = vscode.window.createOutputChannel('Vanthrex for IBM i', { log: true });
  return channel;
}

export function log(message: string): void {
  channel?.info(message);
}

export function logError(error: unknown): void {
  channel?.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

export function showLog(): void {
  channel?.show(true);
}

export function errorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  const hint = localHint(explainError(msg));
  return hint && !msg.includes(hint) ? `${msg} — ${hint}` : msg;
}

/** The raw message, without the plain-language hint. */
export function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The hint in the display language (each string is listed so it can be translated). */
function localHint(h: string | undefined): string | undefined {
  switch (h) {
    case 'This connection is protected as read-only. Change "Protection" in the connection settings to allow changes.': return vscode.l10n.t('This connection is protected as read-only. Change "Protection" in the connection settings to allow changes.');
    case 'Mapepire needs Java 11 or later on the IBM i (5770-JV1). Install it, or choose another SQL engine in the connection settings.': return vscode.l10n.t('Mapepire needs Java 11 or later on the IBM i (5770-JV1). Install it, or choose another SQL engine in the connection settings.');
    case 'The user or password was not accepted, or the profile is disabled / expired. Sign on with ACS or 5250 to check it.': return vscode.l10n.t('The user or password was not accepted, or the profile is disabled / expired. Sign on with ACS or 5250 to check it.');
    case 'This IBM i service is not on your system yet. Install the latest Db2 for i PTF group (SF99xxx) or run "Vanthrex: Self-Check" to see which features your release supports.': return vscode.l10n.t('This IBM i service is not on your system yet. Install the latest Db2 for i PTF group (SF99xxx) or run "Vanthrex: Self-Check" to see which features your release supports.');
    case 'Check the name and the library list (status bar → quick menu → library list).': return vscode.l10n.t('Check the name and the library list (status bar → quick menu → library list).');
    case 'You don\'t have the authority this needs. Right-click the object → "Check Authority…" shows what is missing and the GRTOBJAUT to fix it.': return vscode.l10n.t('You don\'t have the authority this needs. Right-click the object → "Check Authority…" shows what is missing and the GRTOBJAUT to fix it.');
    case 'The file is not journaled, so it can\'t be changed under commitment control. Add WITH NC to the statement, or start journaling the file (STRJRNPF).': return vscode.l10n.t('The file is not journaled, so it can\'t be changed under commitment control. Add WITH NC to the statement, or start journaling the file (STRJRNPF).');
    case 'Another job holds a lock on it. Right-click the object → "Who Has It Locked?" to see the job.': return vscode.l10n.t('Another job holds a lock on it. Right-click the object → "Who Has It Locked?" to see the job.');
    case 'An IBM i service failed — the job log of the SQL job usually says why. Turn on "vanthrex.logging" and look at the Vanthrex log.': return vscode.l10n.t('An IBM i service failed — the job log of the SQL job usually says why. Turn on "vanthrex.logging" and look at the Vanthrex log.');
    case 'SQL syntax error. Vanthrex uses system naming, so qualify objects as LIBRARY/TABLE.': return vscode.l10n.t('SQL syntax error. Vanthrex uses system naming, so qualify objects as LIBRARY/TABLE.');
    case 'A value is too long or does not fit the column.': return vscode.l10n.t('A value is too long or does not fit the column.');
    case 'A row with the same key already exists.': return vscode.l10n.t('A row with the same key already exists.');
    case 'A referential constraint stopped the change (parent row missing or child rows exist).': return vscode.l10n.t('A referential constraint stopped the change (parent row missing or child rows exist).');
    case 'The CL command has a parameter error. Press F4 in a CL source (or use the CL runner prompt) to check the parameters.': return vscode.l10n.t('The CL command has a parameter error. Press F4 in a CL source (or use the CL runner prompt) to check the parameters.');
    case 'The program ended with an error. Right-click the job → "Analyze Job Log" for the root cause.': return vscode.l10n.t('The program ended with an error. Right-click the job → "Analyze Job Log" for the root cause.');
    case 'The IBM i did not answer on the SSH port. Check the host name and that SSH runs: STRTCPSVR SERVER(*SSHD).': return vscode.l10n.t('The IBM i did not answer on the SSH port. Check the host name and that SSH runs: STRTCPSVR SERVER(*SSHD).');
    case 'The connection was lost (network, sleep, or the SSH job ended). Reconnect from the Connections view; Vanthrex keeps your settings.': return vscode.l10n.t('The connection was lost (network, sleep, or the SSH job ended). Reconnect from the Connections view; Vanthrex keeps your settings.');
    default: return h;
  }
}
