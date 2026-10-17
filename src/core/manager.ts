import * as vscode from 'vscode';
import { IbmiConnection } from './connection';
import { ConnectionProfile, ProfileStore } from './profiles';
import { errorMessage, log, logError, showLog } from './log';
import { RECONNECT_DELAYS, reconnectDelay } from './connectionStability';

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
  private readonly _onDidReconnect = new vscode.EventEmitter<IbmiConnection>();
  /** Fired after a dropped connection came back by itself. */
  readonly onDidReconnect = this._onDidReconnect.event;
  private readonly reconnecting = new Map<string, { attempt: number; cancelled: boolean }>();

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

    let conn: IbmiConnection;
    try {
      conn = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${profile.name}…` },
        () => this.openConnection(profile, password));
    } catch (e) {
      logError(e);
      const msg = errorMessage(e);
      const choice = await vscode.window.showErrorMessage(
        `Could not connect to ${profile.host}: ${msg}`,
        'Edit Connection', 'Forget Saved Password', 'Show Log');
      if (choice === 'Edit Connection') { vscode.commands.executeCommand('vanthrex.editConnection', profile); }
      if (choice === 'Forget Saved Password') { await this.profiles.setPassword(profile.id, undefined); }
      if (choice === 'Show Log') { showLog(); }
      return undefined;
    }
    this.activeId = profile.id;
    await this.profiles.setLastUsed(profile.id);
    this.fire();
    const others = this.openConnections.length - 1;
    vscode.window.setStatusBarMessage(`$(check) Connected to ${profile.name}${others ? ` (${others} other system${others > 1 ? 's' : ''} still open)` : ''}`, 4000);
    return conn;
  }

  /** Sign on and register the connection, with the handler that notices when it drops. */
  private async openConnection(profile: ConnectionProfile, password: string | undefined): Promise<IbmiConnection> {
    const conn = new IbmiConnection(profile);
    try { await conn.connect(password); } catch (e) { conn.ssh.dispose(); throw e; }
    this.open.set(profile.id, conn);
    // Start the SQL engine now (Java on the IBM i takes a few seconds), so the views do not wait for it one by one.
    void conn.sql('VALUES 1', 1).catch(() => undefined);
    conn.ssh.connection?.on('close', () => {
      if (this.open.get(profile.id) !== conn) { return; }     // closed on purpose (disconnect)
      log(`SSH connection to ${profile.host} closed by the remote system`);
      const wasActive = this.activeId === profile.id;
      this.open.delete(profile.id);
      if (wasActive) { this.activeId = [...this.open.values()].find(c => c.isConnected)?.profile.id; }
      this.fire();
      void this.reconnect(profile, wasActive);
    });
    return conn;
  }

  /** Bring a dropped connection back: a few attempts with growing pauses, using the saved password. */
  private async reconnect(profile: ConnectionProfile, makeActive: boolean): Promise<void> {
    const auto = vscode.workspace.getConfiguration('vanthrex').get<boolean>('connections.autoReconnect', true);
    const password = await this.profiles.getPassword(profile.id);
    const askUser = () => vscode.window.showWarningMessage(`Connection to ${profile.name} was closed.`, 'Reconnect')
      .then(c => { if (c) { this.connect(profile); } });
    if (!auto || (profile.authType === 'password' && !password) || this.reconnecting.has(profile.id)) { if (!this.reconnecting.has(profile.id)) { void askUser(); } return; }
    const state = { attempt: 1, cancelled: false };
    this.reconnecting.set(profile.id, state);
    this.updateStatus();
    try {
      for (let attempt = 1; ; attempt++) {
        const wait = reconnectDelay(attempt);
        if (wait === undefined || state.cancelled) { break; }
        state.attempt = attempt;
        this.updateStatus();
        await new Promise(r => setTimeout(r, wait * 1000));
        if (state.cancelled || this.open.get(profile.id)?.isConnected) { return; }
        try {
          const conn = await this.openConnection(profile, password);
          if (makeActive || !this.activeId) { this.activeId = profile.id; }
          log(`Reconnected to ${profile.host} (attempt ${attempt})`);
          this.reconnecting.delete(profile.id);
          this.fire();
          vscode.window.setStatusBarMessage(`$(check) Reconnected to ${profile.name}`, 5000);
          this._onDidReconnect.fire(conn);
          return;
        } catch (e) { log(`Reconnect to ${profile.host}, attempt ${attempt}/${RECONNECT_DELAYS.length}: ${errorMessage(e)}`); }
      }
    } finally {
      if (this.reconnecting.get(profile.id) === state) { this.reconnecting.delete(profile.id); this.updateStatus(); }
    }
    if (!state.cancelled) { void askUser(); }
  }

  /** The connection looks dead although SSH did not say so: drop it, which starts the automatic reconnect. */
  forceReconnect(profileId = this.activeId): void {
    const c = profileId ? this.open.get(profileId) : undefined;
    if (c) { log(`Connection to ${c.profile.host} is not answering — reconnecting`); c.ssh.dispose(); }
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
  async disconnect(profileId = this.activeId, askUnsaved = true): Promise<void> {
    if (!profileId) { this.fire(); return; }
    const r = this.reconnecting.get(profileId); if (r) { r.cancelled = true; this.reconnecting.delete(profileId); }
    if (askUnsaved && !(await this.saveRemoteEditsFirst())) { return; }
    const conn = this.open.get(profileId);
    this.open.delete(profileId);
    if (this.activeId === profileId) {
      this.activeId = [...this.open.values()].find(c => c.isConnected)?.profile.id;
    }
    if (conn) { await conn.dispose(); }
    this.fire();
  }

  async disconnectAll(askUnsaved = true): Promise<void> {
    for (const r of this.reconnecting.values()) { r.cancelled = true; }
    this.reconnecting.clear();
    if (askUnsaved && !(await this.saveRemoteEditsFirst())) { return; }
    const all = [...this.open.values()];
    this.open.clear();
    this.activeId = undefined;
    for (const c of all) { await c.dispose(); }
    this.fire();
  }

  /** Unsaved members or IFS files would lose their way back: offer to save them before disconnecting. */
  private async saveRemoteEditsFirst(): Promise<boolean> {
    const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && /^vanthrex-(member|ifs)$/.test(d.uri.scheme));
    if (!dirty.length) { return true; }
    const save = 'Save and Disconnect'; const discard = 'Disconnect Anyway';
    const c = await vscode.window.showWarningMessage(`${dirty.length} member(s) or IFS file(s) have unsaved changes.`,
      { modal: true, detail: dirty.map(d => d.uri.path.split('/').slice(-2).join('/')).join('\n') }, save, discard);
    if (c === save) { for (const d of dirty) { if (!(await d.save())) { return false; } } return true; }
    return c === discard;
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

  updateStatus(): void {
    const c = this.connection;
    const count = this.openConnections.length;
    if (c) {
      const prot = c.profile.protection ?? 'none';
      this.statusItem.text = `${prot === 'none' ? '$(server)' : prot === 'readOnly' ? '$(lock)' : '$(shield)'} ${c.profile.name}${count > 1 ? ` +${count - 1}` : ''}`;
      this.statusItem.tooltip = new vscode.MarkdownString(
        `**${c.profile.name}** — ${c.user}@${c.profile.host}\n\n` +
        `Current library: ${c.profile.currentLibrary || '*none*'}\n\n` +
        `Library list: ${c.profile.libraries.join(', ') || '*none*'}\n\n` +
        `SQL engine: ${c.sqlEngineName}\n\n` +
        (prot === 'readOnly' ? '🔒 **Read-only** — Vanthrex refuses every change on this system\n\n' : prot === 'confirm' ? '🛡 **Production** — every change asks first\n\n' : '') +
        (count > 1 ? `Also connected: ${this.openConnections.slice(1).map(o => o.profile.name).join(', ')} — switch from the quick menu\n\n` : '') +
        'Click for the IBM i quick menu');
      this.statusItem.backgroundColor = prot === 'none' ? undefined : new vscode.ThemeColor(prot === 'readOnly' ? 'statusBarItem.warningBackground' : 'statusBarItem.errorBackground');
    } else if (this.reconnecting.size) {
      const [id, st] = [...this.reconnecting.entries()][0];
      const name = this.profiles.get(id)?.name ?? '';
      this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusItem.text = `$(sync~spin) ${name}: reconnecting (${st.attempt}/${RECONNECT_DELAYS.length})`;
      this.statusItem.tooltip = `The connection to ${name} dropped. Vanthrex is reconnecting with your saved sign-on; your open members stay as they are.`;
    } else {
      this.statusItem.backgroundColor = undefined;
      this.statusItem.text = '$(plug) IBM i: not connected';
      this.statusItem.tooltip = 'Click to connect to an IBM i system';
    }
  }

  dispose(): void {
    for (const c of this.open.values()) { c.dispose(); }
    this.open.clear();
    for (const r of this.reconnecting.values()) { r.cancelled = true; }
    this.statusItem.dispose();
    this._onDidChange.dispose();
    this._onDidReconnect.dispose();
  }
}
