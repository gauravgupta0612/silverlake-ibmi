// "Never lose a save": when a member or IFS file cannot be saved because the connection is gone, the
// content is kept on this computer and saved as soon as the system is back.

import * as vscode from 'vscode';
import { errorMessage, log, logError } from '../core/log';
import { isConnectionError, pendingFileName } from '../core/v27';

interface Pending { uri: string; file: string; at: string; system?: string }
let dir: vscode.Uri | undefined;
let state: vscode.Memento | undefined;
const KEY = 'vanthrex.pendingSaves';
export const pendingChanged = new vscode.EventEmitter<number>();

export function initPendingSaves(storage: vscode.Uri, memento: vscode.Memento): void { dir = vscode.Uri.joinPath(storage, 'pending-saves'); state = memento; }
export function pendingList(): Pending[] { return state?.get<Pending[]>(KEY, []) ?? []; }

async function keep(uri: vscode.Uri, content: Uint8Array, system?: string): Promise<void> {
  if (!dir || !state) { return; }
  await vscode.workspace.fs.createDirectory(dir);
  const file = pendingFileName(uri.toString());
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, file), content);
  const list = pendingList().filter(p => p.uri !== uri.toString());
  list.push({ uri: uri.toString(), file, at: new Date().toISOString(), system });
  await state.update(KEY, list);
  log(`Connection lost while saving ${uri.path}: the content is kept on this computer (${file})`);
  pendingChanged.fire(list.length);
}

export async function forget(uri: string): Promise<void> {
  if (!state || !dir) { return; }
  const p = pendingList().find(x => x.uri === uri);
  if (p) { try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, p.file)); } catch { /* already gone */ } }
  await state.update(KEY, pendingList().filter(x => x.uri !== uri));
  pendingChanged.fire(pendingList().length);
}

export async function pendingContent(p: Pending): Promise<Uint8Array> { return vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir!, p.file)); }

/** Run a save; if it fails because the connection is gone, keep the content and say so. */
export async function saveOrKeep(uri: vscode.Uri, content: Uint8Array, system: string | undefined, save: () => Promise<void>): Promise<void> {
  try {
    await save();
    if (pendingList().some(p => p.uri === uri.toString())) { await forget(uri.toString()); }
  } catch (e) {
    const msg = errorMessage(e);
    if (!isConnectionError(msg)) { throw e; }
    try { await keep(uri, content, system); } catch (k) { logError(k); throw e; }
    throw vscode.FileSystemError.Unavailable(vscode.l10n.t('The connection is gone, so this was not saved on the IBM i yet. Your change is kept on this computer and will be saved when the connection is back.'));
  }
}
