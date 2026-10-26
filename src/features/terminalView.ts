// PASE terminal: an interactive shell on the IBM i inside VS Code's terminal panel, over the connection's SSH session
// (no second sign-on). Also offered in the terminal "+" menu and on IFS folders ("Open Terminal Here").
import * as vscode from 'vscode';
import type { ClientChannel } from 'ssh2';
import { shellStartup } from '../core/localDev';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';

function paseTerminal(manager: ConnectionManager, dir?: string): vscode.ExtensionTerminalOptions {
  const conn = manager.require();
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  let channel: ClientChannel | undefined;
  let size: vscode.TerminalDimensions | undefined;
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: dims => {
      size = dims ?? size;
      write.fire(`\x1b[2m${vscode.l10n.t('Connecting to {0} as {1}…', conn.profile.name, conn.user)}\x1b[0m\r\n`);
      conn.ssh.requestShell({ term: 'xterm-256color', cols: size?.columns ?? 120, rows: size?.rows ?? 30 }).then(ch => {
        channel = ch;
        ch.on('data', (d: Buffer) => write.fire(d.toString('utf8')));
        ch.stderr.on('data', (d: Buffer) => write.fire(d.toString('utf8')));
        ch.on('close', () => { write.fire(`\r\n\x1b[2m${vscode.l10n.t('Session ended.')}\x1b[0m\r\n`); close.fire(0); });
        const start = shellStartup(dir, vscode.workspace.getConfiguration('vanthrex').get<boolean>('terminal.openSourcePath', true));
        if (start) { ch.write(start); }
      }).catch(e => { logError(e); write.fire(`\x1b[31m${errorMessage(e)}\x1b[0m\r\n`); close.fire(1); });
    },
    close: () => { try { channel?.end(); } catch { /* already closed */ } },
    handleInput: data => { channel?.write(data); },
    setDimensions: dims => { size = dims; channel?.setWindow(dims.rows, dims.columns, 0, 0); },
  };
  return { name: `PASE ${conn.profile.name}${dir ? ` · ${dir.split('/').pop() || dir}` : ''}`, pty, iconPath: new vscode.ThemeIcon('terminal-linux') };
}

export function registerTerminal(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const open = (dir?: string) => {
    try { const t = vscode.window.createTerminal(paseTerminal(manager, dir)); t.show(); }
    catch (e) { vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.paseTerminal', () => open(manager.connection?.profile.ifsHome || undefined)),
    vscode.commands.registerCommand('vanthrex.paseTerminalHere', (node?: { path?: string; isDirectory?: boolean; resourceUri?: vscode.Uri }) => {
      const p = node?.path ?? node?.resourceUri?.path;
      open(p ? (node?.isDirectory === false ? p.replace(/\/[^/]*$/, '') || '/' : p) : undefined);
    }),
    vscode.window.registerTerminalProfileProvider('vanthrex.paseTerminal', {
      provideTerminalProfile: () => {
        if (!manager.connection) { throw new Error(vscode.l10n.t('Connect to an IBM i first (Vanthrex view).')); }
        return new vscode.TerminalProfile(paseTerminal(manager));
      },
    }),
  );
}
