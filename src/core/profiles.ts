import * as vscode from 'vscode';

export type SqlEngineKind = 'auto' | 'mapepire-ssh' | 'mapepire-daemon' | 'db2util';
export type AuthType = 'password' | 'key';

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authType: AuthType;
  privateKeyPath?: string;
  /** User portion of the library list, top first. */
  libraries: string[];
  currentLibrary?: string;
  /** Library where compiled objects go. Empty = same as the source library. */
  objectLibrary?: string;
  sqlEngine: SqlEngineKind;
  mapepirePort: number;
  ifsHome?: string;
}

const PROFILES_KEY = 'vanthrex.profiles';
const LAST_KEY = 'vanthrex.lastProfile';

export class ProfileStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionProfile[] {
    return this.context.globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find(p => p.id === id);
  }

  async save(profile: ConnectionProfile): Promise<void> {
    const all = this.list().filter(p => p.id !== profile.id);
    all.push(profile);
    all.sort((a, b) => a.name.localeCompare(b.name));
    await this.context.globalState.update(PROFILES_KEY, all);
    this._onDidChange.fire();
  }

  async remove(id: string): Promise<void> {
    await this.context.globalState.update(PROFILES_KEY, this.list().filter(p => p.id !== id));
    await this.context.secrets.delete(this.secretKey(id));
    this._onDidChange.fire();
  }

  getPassword(id: string): Thenable<string | undefined> {
    return this.context.secrets.get(this.secretKey(id));
  }

  async setPassword(id: string, password: string | undefined): Promise<void> {
    if (password) {
      await this.context.secrets.store(this.secretKey(id), password);
    } else {
      await this.context.secrets.delete(this.secretKey(id));
    }
  }

  get lastUsed(): string | undefined {
    return this.context.globalState.get<string>(LAST_KEY);
  }

  setLastUsed(id: string): Thenable<void> {
    return this.context.globalState.update(LAST_KEY, id);
  }

  private secretKey(id: string): string {
    return `vanthrex.password.${id}`;
  }
}

export function newProfile(): ConnectionProfile {
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: '',
    host: '',
    port: 22,
    user: '',
    authType: 'password',
    libraries: [],
    sqlEngine: 'auto',
    mapepirePort: 8076,
  };
}
