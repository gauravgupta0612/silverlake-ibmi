import * as vscode from 'vscode';
import { IbmiConnection } from './connection';
import { ConnectionProfile, ProfileStore } from './profiles';
import { errorMessage, log, logError, showLog } from './log';

/** Owns the single active IBM i connection and broadcasts connect/disconnect. */
export class ConnectionManager implements vscode.Disposable {
  private active?: IbmiConnection;
  private readonly _onDidChange = new vscode.EventEmitter<IbmiConnection | undefined>();
  readonly onDidChange = this._onDidChange.event;
  private readonly statusItem: vscode.StatusBarItem;

  constructor(readonly profiles: ProfileStore) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.command = 'vanthrex.showMenu';
    this.updateStatus();
    this.statusItem.show();
  }

  get connection(): IbmiConnection | undefined {
    return this.active?.isConnected ? this.active : undefined;
  }

  /** The active connection, or a friendly error when not connected. */
  require(): IbmiConnection {
    const c = this.connection;
    if (!c) {
      throw new Error('Not connected to an IBM i. Open the Vanthrex view and click a connection to connect.');
    }
    return c;
  }

  async connect(profile: ConnectionProfile): Promise<IbmiConnection | undefined> {
    if (this.active) { await this.disconnect(); }

    let password = await this.profiles.getPassword(profile.id);
    if (profile.authType === 'password' && !password) {
      password = await vscode.window.showInputBox({
        title: `Connect to ${profile.name}`,
        prompt: `Password for ${profile.user}@${profile.host}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (password === undefined) { return undefined; }
      const remember = await vscode.window.showQuickPick(['Yes, remember it securely', 'No, ask every time'], {
        title: 'Save the password in the VS Code secret store?',
      });
      if (remember?.startsWith('Yes')) { await this.profiles.setPassword(profile.id, password); }
    }

    const conn = new IbmiConnection(profile);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${profile.name}…` },
        () => conn.connect(password),
      );
    } catch (e) {
      logError(e);
      const msg = errorMessage(e);
      const choice = await vscode.window.showErrorMessage(
        `Could not connect to ${profile.host}: ${msg}`,
        'Edit Connection', 'Forget Saved Password', 'Show Log');
      if (choice === 'Edit Connection') { vscode.commands.executeCommand('vanthrex.editConnection', profile); }
      if (choice === 'Forget Saved Password') { await this.profiles.setPassword(profile.id, undefined); }
      if (choice === 'Show Log') { showLog(); }
      conn.ssh.dispose();
      return undefined;
    }

    this.active = conn;
    conn.ssh.connection?.on('close', () => {
      if (this.active === conn) {
        log('SSH connection closed by the remote system');
        this.active = undefined;
        this.fire();
        vscode.window.showWarningMessage(`Connection to ${profile.name} was closed.`, 'Reconnect')
          .then(c => { if (c) { this.connect(profile); } });
      }
    });
    await this.profiles.setLastUsed(profile.id);
    this.fire();
    vscode.window.setStatusBarMessage(`$(check) Connected to ${profile.name}`, 4000);
    return conn;
  }

  async disconnect(): Promise<void> {
    const conn = this.active;
    this.active = undefined;
    if (conn) { await conn.dispose(); }
    this.fire();
  }

  /** Persist a changed profile and apply it to the live connection. */
  async updateActiveProfile(change: (p: ConnectionProfile) => void): Promise<void> {
    const conn = this.require();
    change(conn.profile);
    await this.profiles.save(conn.profile);
    this.fire();
  }

  private fire(): void {
    vscode.commands.executeCommand('setContext', 'vanthrex.connected', !!this.connection);
    this.updateStatus();
    this._onDidChange.fire(this.connection);
  }

  private updateStatus(): void {
    const c = this.connection;
    if (c) {
      this.statusItem.text = `$(server) ${c.profile.name}`;
      this.statusItem.tooltip = new vscode.MarkdownString(
        `**${c.profile.name}** — ${c.user}@${c.profile.host}\n\n` +
        `Current library: ${c.profile.currentLibrary || '*none*'}\n\n` +
        `Library list: ${c.profile.libraries.join(', ') || '*none*'}\n\n` +
        `SQL engine: ${c.sqlEngineName}\n\nClick for the IBM i quick menu`);
      this.statusItem.backgroundColor = undefined;
    } else {
      this.statusItem.text = '$(plug) IBM i: not connected';
      this.statusItem.tooltip = 'Click to connect to an IBM i system';
    }
  }

  dispose(): void {
    this.active?.dispose();
    this.statusItem.dispose();
    this._onDidChange.dispose();
  }
}
