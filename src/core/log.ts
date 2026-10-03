import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel = vscode.window.createOutputChannel('Silverlake for IBM i', { log: true });
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
  return error instanceof Error ? error.message : String(error);
}
