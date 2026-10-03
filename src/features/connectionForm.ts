import * as vscode from 'vscode';
import { ConnectionProfile, newProfile, ProfileStore, SqlEngineKind } from '../core/profiles';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError } from '../core/log';
import { isValidSystemName } from '../core/util';
import { nonce, escapeHtml } from './webviewUtil';

interface FormData {
  name: string;
  host: string;
  port: string;
  user: string;
  authType: 'password' | 'key';
  password: string;
  savePassword: boolean;
  privateKeyPath: string;
  libraries: string;
  currentLibrary: string;
  objectLibrary: string;
  sqlEngine: SqlEngineKind;
  mapepirePort: string;
  ifsHome: string;
}

/** Guided, single-page form to add or edit a connection (with a "Test" button). */
export class ConnectionForm {
  private static current?: ConnectionForm;
  private readonly panel: vscode.WebviewPanel;

  static open(store: ProfileStore, existing?: ConnectionProfile, onSaved?: (p: ConnectionProfile) => void): void {
    log(`Opening connection form${existing ? ` for ${existing.name}` : ''}`);
    ConnectionForm.current?.panel.dispose();
    ConnectionForm.current = new ConnectionForm(store, existing, onSaved);
  }

  private constructor(
    private readonly store: ProfileStore,
    private readonly existing: ConnectionProfile | undefined,
    private readonly onSaved?: (p: ConnectionProfile) => void,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'silverlake.connectionForm',
      existing ? `Edit ${existing.name}` : 'New IBM i Connection',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.onDidDispose(() => { if (ConnectionForm.current === this) { ConnectionForm.current = undefined; } });
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => {
      logError(e);
      vscode.window.showErrorMessage(`Connection form error: ${errorMessage(e)}`);
    }));
    this.render().catch(e => {
      logError(e);
      vscode.window.showErrorMessage(`Could not open the connection form: ${errorMessage(e)}`);
    });
  }

  private async render(): Promise<void> {
    const p = this.existing ?? newProfile();
    const hasPassword = this.existing ? !!(await this.store.getPassword(this.existing.id)) : false;
    this.panel.webview.html = this.html(p, hasPassword);
  }

  private validate(d: FormData): string[] {
    const errors: string[] = [];
    if (!d.name.trim()) { errors.push('Give the connection a name.'); }
    if (!d.host.trim()) { errors.push('Host name or IP address is required.'); }
    if (!d.user.trim()) { errors.push('User profile is required.'); }
    const port = Number(d.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { errors.push('SSH port must be between 1 and 65535.'); }
    if (d.authType === 'key' && !d.privateKeyPath.trim()) { errors.push('Choose your private key file.'); }
    for (const lib of this.libs(d.libraries)) {
      if (!isValidSystemName(lib)) { errors.push(`"${lib}" is not a valid library name.`); }
    }
    for (const [label, v] of [['Current library', d.currentLibrary], ['Object library', d.objectLibrary]]) {
      if (v.trim() && !isValidSystemName(v.trim())) { errors.push(`${label} "${v}" is not a valid library name.`); }
    }
    return errors;
  }

  private libs(text: string): string[] {
    return text.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  }

  private toProfile(d: FormData): ConnectionProfile {
    const base = this.existing ?? newProfile();
    return {
      ...base,
      name: d.name.trim(),
      host: d.host.trim(),
      port: Number(d.port) || 22,
      user: d.user.trim(),
      authType: d.authType,
      privateKeyPath: d.authType === 'key' ? d.privateKeyPath.trim() : undefined,
      libraries: this.libs(d.libraries),
      currentLibrary: d.currentLibrary.trim().toUpperCase() || undefined,
      objectLibrary: d.objectLibrary.trim().toUpperCase() || undefined,
      sqlEngine: d.sqlEngine,
      mapepirePort: Number(d.mapepirePort) || 8076,
      ifsHome: d.ifsHome.trim() || undefined,
    };
  }

  private async onMessage(m: { type: string; data?: FormData }): Promise<void> {
    const post = (msg: object) => this.panel.webview.postMessage(msg);
    if (m.type === 'browseKey') {
      const pick = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Select SSH private key' });
      if (pick?.[0]) { post({ type: 'keyPath', path: pick[0].fsPath }); }
      return;
    }
    if (!m.data) { return; }
    const errors = this.validate(m.data);
    if (errors.length) { post({ type: 'errors', errors }); return; }
    const profile = this.toProfile(m.data);
    const password = m.data.password || (this.existing ? await this.store.getPassword(this.existing.id) : undefined);

    if (m.type === 'test') {
      post({ type: 'status', kind: 'info', text: 'Testing connection…' });
      const conn = new IbmiConnection(profile);
      try {
        await conn.connect(password);
        const checks = await conn.exec(
          'uname -srv; ' +
          'ls -d /QOpenSys/QIBM/ProdData/JavaVM/jdk*/64bit/bin/java 2>/dev/null | tail -1; ' +
          'test -x /QOpenSys/pkgs/bin/db2util && echo DB2UTIL_OK');
        const lines = checks.stdout.split('\n');
        const java = lines.find(l => l.includes('/java'));
        const parts = [
          `Connected as ${profile.user.toUpperCase()} — ${lines[0] ?? 'IBM i'}.`,
          java ? 'Java found: Mapepire SQL over SSH will work with no server setup.' : 'Java not found: SQL will need db2util or a Mapepire daemon.',
          checks.stdout.includes('DB2UTIL_OK') ? 'db2util is installed.' : '',
        ];
        post({ type: 'status', kind: 'ok', text: parts.filter(Boolean).join(' ') });
      } catch (e) {
        post({ type: 'status', kind: 'error', text: `Connection failed: ${errorMessage(e)}` });
      } finally {
        await conn.dispose();
      }
      return;
    }

    if (m.type === 'save') {
      await this.store.save(profile);
      if (m.data.authType === 'password' || m.data.password) {
        if (m.data.savePassword && m.data.password) {
          await this.store.setPassword(profile.id, m.data.password);
        } else if (!m.data.savePassword) {
          await this.store.setPassword(profile.id, undefined);
        }
      }
      vscode.window.showInformationMessage(`Saved connection "${profile.name}".`, 'Connect now')
        .then(c => { if (c) { vscode.commands.executeCommand('silverlake.connect', profile); } });
      this.onSaved?.(profile);
      this.panel.dispose();
    }
  }

  private html(p: ConnectionProfile, hasPassword: boolean): string {
    const n = nonce();
    const v = (s: string | number | undefined) => escapeHtml(String(s ?? ''));
    const sel = (a: string, b: string) => (a === b ? 'selected' : '');
    return /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 24px 32px; max-width: 760px; }
  h1 { font-weight: 600; font-size: 1.5em; margin-bottom: 4px; }
  .sub { color: var(--vscode-descriptionForeground); margin-top: 0; }
  fieldset { border: 1px solid var(--vscode-widget-border, #8884); border-radius: 6px; margin: 18px 0; padding: 12px 16px 16px; }
  legend { font-weight: 600; padding: 0 6px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
  .full { grid-column: 1 / -1; }
  label { display: block; font-size: 0.92em; margin-bottom: 4px; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 3px; }
  input, select { width: 100%; box-sizing: border-box; padding: 6px 8px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 3px; font: inherit; }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  .row { display: flex; gap: 8px; } .row input { flex: 1; }
  .check { display: flex; align-items: center; gap: 6px; } .check input { width: auto; }
  button { padding: 7px 16px; border: none; border-radius: 3px; cursor: pointer; font: inherit;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .actions { display: flex; gap: 10px; margin-top: 20px; }
  #status { margin-top: 14px; padding: 8px 12px; border-radius: 4px; display: none; white-space: pre-wrap; }
  #status.info { display: block; background: var(--vscode-editorInfo-background, #3794ff22); }
  #status.ok { display: block; background: #2ea04333; }
  #status.error { display: block; background: var(--vscode-inputValidation-errorBackground, #be110033); }
  .hidden { display: none; }
</style></head>
<body>
  <h1>${this.existing ? 'Edit connection' : 'Connect to an IBM i'}</h1>
  <p class="sub">Silverlake connects over SSH (port 22). Start the SSH server on IBM i with <code>STRTCPSVR *SSHD</code> if needed.</p>

  <fieldset><legend>System</legend><div class="grid">
    <div><label for="name">Connection name</label><input id="name" value="${v(p.name)}" placeholder="e.g. DEV400"></div>
    <div><label for="host">Host name or IP</label><input id="host" value="${v(p.host)}" placeholder="myibmi.company.com"></div>
    <div><label for="user">User profile</label><input id="user" value="${v(p.user)}" placeholder="MYUSER"></div>
    <div><label for="port">SSH port</label><input id="port" type="number" value="${v(p.port)}"></div>
  </div></fieldset>

  <fieldset><legend>Sign-in</legend><div class="grid">
    <div class="full"><label for="authType">Method</label>
      <select id="authType">
        <option value="password" ${sel(p.authType, 'password')}>Password</option>
        <option value="key" ${sel(p.authType, 'key')}>SSH private key</option>
      </select></div>
    <div class="full" id="keyRow"><label for="privateKeyPath">Private key file</label>
      <div class="row"><input id="privateKeyPath" value="${v(p.privateKeyPath)}"><button class="secondary" id="browse" type="button">Browse…</button></div></div>
    <div class="full"><label for="password" id="pwLabel">Password</label>
      <input id="password" type="password" placeholder="${hasPassword ? '•••••• (saved — leave empty to keep)' : ''}">
      <div class="check" style="margin-top:6px"><input id="savePassword" type="checkbox" ${hasPassword || !this.existing ? 'checked' : ''}><label for="savePassword" style="margin:0">Remember securely (VS Code secret store)</label></div></div>
  </div></fieldset>

  <fieldset><legend>Libraries</legend><div class="grid">
    <div class="full"><label for="libraries">Library list</label><input id="libraries" value="${v(p.libraries.join(' '))}" placeholder="MYLIB QGPL">
      <div class="hint">Separated by spaces or commas, top first. These appear in the Libraries view and are used for compiles and SQL.</div></div>
    <div><label for="currentLibrary">Current library</label><input id="currentLibrary" value="${v(p.currentLibrary)}" placeholder="MYLIB"></div>
    <div><label for="objectLibrary">Compile objects into</label><input id="objectLibrary" value="${v(p.objectLibrary)}" placeholder="(same as source)"></div>
  </div></fieldset>

  <details><summary>Advanced: SQL engine &amp; IFS</summary>
  <fieldset><legend>SQL</legend><div class="grid">
    <div><label for="sqlEngine">SQL engine</label>
      <select id="sqlEngine">
        <option value="auto" ${sel(p.sqlEngine, 'auto')}>Automatic (recommended)</option>
        <option value="mapepire-ssh" ${sel(p.sqlEngine, 'mapepire-ssh')}>Mapepire over SSH (zero install, needs Java)</option>
        <option value="mapepire-daemon" ${sel(p.sqlEngine, 'mapepire-daemon')}>Mapepire daemon</option>
        <option value="db2util" ${sel(p.sqlEngine, 'db2util')}>db2util over SSH</option>
      </select>
      <div class="hint">Automatic tries Mapepire over SSH, then a Mapepire daemon, then db2util.</div></div>
    <div><label for="mapepirePort">Mapepire daemon port</label><input id="mapepirePort" type="number" value="${v(p.mapepirePort)}"></div>
    <div class="full"><label for="ifsHome">IFS start directory</label><input id="ifsHome" value="${v(p.ifsHome)}" placeholder="(your home directory)"></div>
  </div></fieldset></details>

  <div id="status"></div>
  <div class="actions">
    <button id="save" type="button">Save connection</button>
    <button id="test" class="secondary" type="button">Test connection</button>
  </div>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const ids = ['name','host','port','user','authType','password','privateKeyPath','libraries','currentLibrary','objectLibrary','sqlEngine','mapepirePort','ifsHome'];
  function data() {
    const d = {}; ids.forEach(i => d[i] = $(i).value); d.savePassword = $('savePassword').checked; return d;
  }
  function syncAuth() {
    const key = $('authType').value === 'key';
    $('keyRow').classList.toggle('hidden', !key);
    $('pwLabel').textContent = key ? 'Key passphrase (optional)' : 'Password';
  }
  function status(kind, text) { const s = $('status'); s.className = kind; s.textContent = text; }
  $('authType').addEventListener('change', syncAuth); syncAuth();
  $('browse').addEventListener('click', () => vscode.postMessage({ type: 'browseKey' }));
  $('save').addEventListener('click', () => vscode.postMessage({ type: 'save', data: data() }));
  $('test').addEventListener('click', () => vscode.postMessage({ type: 'test', data: data() }));
  ['user','libraries','currentLibrary','objectLibrary'].forEach(i => $(i).addEventListener('blur', () => { $(i).value = $(i).value.toUpperCase(); }));
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'keyPath') $('privateKeyPath').value = m.path;
    if (m.type === 'errors') status('error', m.errors.join('\\n'));
    if (m.type === 'status') status(m.kind, m.text);
  });
  $('name').focus();
</script>
</body></html>`;
  }
}
