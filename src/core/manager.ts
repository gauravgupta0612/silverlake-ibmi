import * as vscode from 'vscode';
import { IbmiConnection } from './connection';
import { ConnectionProfile, ProfileStore } from './profiles';
import { errorMessage, log, logError, showLog } from './log';

/**
 * Owns the IBM i connections. Several systems can be connected at the same time; one of them is
 * the *active* connection that the views, editors and commands work with. Switching between open
 * connections is instant (no new sign-on).
 */
export class ConnectionManager implements vscode.Disposable {
  private readonly open = new Map<string, IbmiConnection>();
  private activeId?: string;
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
    const c = this.activeId ? this.open.get(this.activeId) : undefined;
    return c?.isConnected ? c : undefined;
  }

  /** Every connection that is currently open (the active one first). */
  get openConnections(): IbmiConnection[] {
    const all = [...this.open.values()].filter(c => c.isConnected);
    return all.sort((a, b) => (a.profile.id === this.activeId ? -1 : b.profile.id === this.activeId ? 1 : a.profile.name.localeCompare(b.profile.name)));
  }

  isOpen(profileId: string): boolean {
    return !!this.open.get(profileId)?.isConnected;
  }

  /** The active connection, or a friendly error when not connected. */
  require(): IbmiConnection {
    const c = this.connection;
    if (!c) {
      throw new Error('Not connected to an IBM i. Open the Vanthrex view and click a connection to connect.');
    }
    return c;
  }

  private keepOthersOpen(): boolean {
    return vscode.workspace.getConfiguration('vanthrex').get<boolean>('connections.keepOthersOpen', true);
  }

  async connect(profile: ConnectionProfile): Promise<IbmiConnection | undefined> {
    // Already open: just make it the active one.
    const existing = this.open.get(profile.id);
    if (existing?.isConnected) {
      if (this.activeId !== profile.id) { await this.switchTo(profile.id); }
      return existing;
    }
    if (!this.keepOthersOpen()) { await this.disconnectAll(); }

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

    this.open.set(profile.id, conn);
    this.activeId = profile.id;
    conn.ssh.connection?.on('close', () => {
      if (this.open.get(profile.id) !== conn) { return; }
      log(`SSH connection to ${profile.host} closed by the remote system`);
      this.open.delete(profile.id);
      if (this.activeId === profile.id) { this.activeId = [...this.open.values()].find(c => c.isConnected)?.profile.id; }
      this.fire();
      vscode.window.showWarningMessage(`Connection to ${profile.name} was closed.`, 'Reconnect')
        .then(c => { if (c) { this.connect(profile); } });
    });
    await this.profiles.setLastUsed(profile.id);
    this.fire();
    const others = this.openConnections.length - 1;
    vscode.window.setStatusBarMessage(`$(check) Connected to ${profile.name}${others ? ` (${others} other system${others > 1 ? 's' : ''} still open)` : ''}`, 4000);
    return conn;
  }

  /** Make another open connection the active one. */
  async switchTo(profileId: string): Promise<void> {
    const c = this.open.get(profileId);
    if (!c?.isConnected) { throw new Error('That system is not connected.'); }
    if (this.activeId === profileId) { return; }
    this.activeId = profileId;
    await this.profiles.setLastUsed(profileId);
    this.fire();
    vscode.window.setStatusBarMessage(`$(arrow-swap) Now working on ${c.profile.name}`, 3000);
  }

  /** Disconnect one system (the active one by default). Another open system becomes active. */
  async disconnect(profileId = this.activeId): Promise<void> {
    if (!profileId) { this.fire(); return; }
    const conn = this.open.get(profileId);
    this.open.delete(profileId);
    if (this.activeId === profileId) {
      this.activeId = [...this.open.values()].find(c => c.isConnected)?.profile.id;
    }
    if (conn) { await conn.dispose(); }
    this.fire();
  }

  async disconnectAll(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    this.activeId = undefined;
    for (const c of all) { await c.dispose(); }
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
    vscode.commands.executeCommand('setContext', 'vanthrex.multipleConnections', this.openConnections.length > 1);
    this.updateStatus();
    this._onDidChange.fire(this.connection);
  }

  private updateStatus(): void {
    const c = this.connection;
    const count = this.openConnections.length;
    if (c) {
      this.statusItem.text = `$(server) ${c.profile.name}${count > 1 ? ` +${count - 1}` : ''}`;
      this.statusItem.tooltip = new vscode.MarkdownString(
        `**${c.profile.name}** — ${c.user}@${c.profile.host}\n\n` +
        `Current library: ${c.profile.currentLibrary || '*none*'}\n\n` +
        `Library list: ${c.profile.libraries.join(', ') || '*none*'}\n\n` +
        `SQL engine: ${c.sqlEngineName}\n\n` +
        (count > 1 ? `Also connected: ${this.openConnections.slice(1).map(o => o.profile.name).join(', ')} — switch from the quick menu\n\n` : '') +
        'Click for the IBM i quick menu');
      this.statusItem.backgroundColor = undefined;
    } else {
      this.statusItem.text = '$(plug) IBM i: not connected';
      this.statusItem.tooltip = 'Click to connect to an IBM i system';
    }
  }

  dispose(): void {
    for (const c of this.open.values()) { c.dispose(); }
    this.open.clear();
    this.statusItem.dispose();
    this._onDidChange.dispose();
  }
}
