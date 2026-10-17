// Member notes: notes on source lines, kept locally or shared through an IFS file.
import * as vscode from 'vscode';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { Note, noteKey, relocate } from '../core/memberNotes';
import { parseMemberPath, sqlString } from '../core/util';
import { MEMBER_SCHEME } from './fileSystems';

type Row = Record<string, unknown>;

const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();

class NotesStore {
  private cache?: { at: number; data: Record<string, Note[]> };
  readonly changed = new vscode.EventEmitter<void>();
  constructor(private readonly manager: ConnectionManager, private readonly state: vscode.Memento) {}

  private shared(): string { return (vscode.workspace.getConfiguration('vanthrex').get<string>('notes.sharedFile', '') ?? '').trim(); }

  async all(fresh = false): Promise<Record<string, Note[]>> {
    const path = this.shared(); const conn = this.manager.connection;
    if (!path || !conn) { return this.state.get<Record<string, Note[]>>('vanthrex.notes', {}); }
    if (!fresh && this.cache && Date.now() - this.cache.at < 60_000) { return this.cache.data; }
    let data: Record<string, Note[]> = {};
    try { data = JSON.parse((await conn.readStreamFile(path)).toString('utf8') || '{}'); } catch (e) { if (!/no such file|ENOENT|not found/i.test(errorMessage(e))) { logError(e); } }
    this.cache = { at: Date.now(), data };
    return data;
  }

  async update(key: string, change: (list: Note[]) => Note[]): Promise<void> {
    const path = this.shared(); const conn = this.manager.connection;
    if (!path || !conn) {
      const all = { ...this.state.get<Record<string, Note[]>>('vanthrex.notes', {}) };
      all[key] = change(all[key] ?? []); if (!all[key].length) { delete all[key]; }
      await this.state.update('vanthrex.notes', all);
    } else {
      const all = await this.all(true);            // read-modify-write, so teammates' notes are kept
      all[key] = change(all[key] ?? []); if (!all[key].length) { delete all[key]; }
      await conn.writeStreamFile(path, Buffer.from(JSON.stringify(all, null, 1), 'utf8'));
      this.cache = { at: Date.now(), data: all };
    }
    this.changed.fire();
  }
}

function keyOf(manager: ConnectionManager, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== MEMBER_SCHEME || !manager.connection) { return undefined; }
  const m = parseMemberPath(uri.path);
  return noteKey(manager.connection.profile.name, m.library, m.file, m.member);
}

// ================================================================ registration

export function registerMemberNotes(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  const notes = new NotesStore(manager, context.globalState);
  const deco = vscode.window.createTextEditorDecorationType({ after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' }, overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right });
  const render = async (ed?: vscode.TextEditor) => {
    if (!ed) { return; }
    const key = keyOf(manager, ed.document.uri);
    if (!key) { return; }
    const list = (await notes.all())[key] ?? [];
    const lines = Array.from({ length: ed.document.lineCount }, (_, i) => ed.document.lineAt(i).text);
    ed.setDecorations(deco, list.map(n => ({ n, line: relocate(n, lines) })).filter(x => x.line !== undefined).map(x => ({
      range: new vscode.Range(x.line!, Number.MAX_SAFE_INTEGER, x.line!, Number.MAX_SAFE_INTEGER),
      renderOptions: { after: { contentText: `📝 ${x.n.text.split('\n')[0].slice(0, 80)} — ${x.n.by}` } },
      hoverMessage: new vscode.MarkdownString(`**📝 ${x.n.by}** · ${new Date(x.n.at).toLocaleString()}\n\n${x.n.text}`),
    })));
  };
  const renderAll = () => { for (const ed of vscode.window.visibleTextEditors) { void render(ed); } };
  const lensEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    deco,
    notes.changed,
    lensEmitter,
    notes.changed.event(() => { renderAll(); lensEmitter.fire(); }),
    vscode.window.onDidChangeVisibleTextEditors(() => renderAll()),
    vscode.workspace.onDidSaveTextDocument(d => { if (d.uri.scheme === MEMBER_SCHEME) { renderAll(); } }),
    manager.onDidChange(() => renderAll()),
    vscode.languages.registerCodeLensProvider({ scheme: MEMBER_SCHEME }, {
      onDidChangeCodeLenses: lensEmitter.event,
      provideCodeLenses: async doc => {
        const key = keyOf(manager, doc.uri);
        const n = key ? ((await notes.all())[key] ?? []).length : 0;
        return n ? [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: vscode.l10n.t('📝 {0} note(s)', n), command: 'vanthrex.notes.show', arguments: [doc.uri] })] : [];
      },
    }),
    vscode.commands.registerCommand('vanthrex.notes.add', guard(async () => {
      const ed = vscode.window.activeTextEditor;
      const key = ed && keyOf(manager, ed.document.uri);
      if (!ed || !key) { throw new Error(vscode.l10n.t('Open a source member first.')); }
      const line = ed.selection.active.line;
      const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Note on line {0}', line + 1), prompt: ed.document.lineAt(line).text.trim().slice(0, 80), ignoreFocusOut: true });
      if (!text?.trim()) { return; }
      await notes.update(key, list => [...list, { id: `${Date.now()}`, line, snippet: ed.document.lineAt(line).text, text: text.trim(), by: manager.require().user, at: new Date().toISOString() }]);
    })),
    vscode.commands.registerCommand('vanthrex.notes.show', guard(async (uri?: vscode.Uri) => {
      const u = uri ?? vscode.window.activeTextEditor?.document.uri;
      const key = u && keyOf(manager, u);
      if (!u || !key) { throw new Error(vscode.l10n.t('Open a source member first.')); }
      const list = (await notes.all(true))[key] ?? [];
      const doc = await vscode.workspace.openTextDocument(u);
      const lines = Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);
      type Item = vscode.QuickPickItem & { n: Note };
      const delBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: vscode.l10n.t('Delete note') };
      const qp = vscode.window.createQuickPick<Item>();
      qp.title = vscode.l10n.t('Notes on {0}', u.path.split('/').slice(-1)[0]);
      qp.items = list.map(n => { const l = relocate(n, lines); return { n, label: `📝 ${n.text.split('\n')[0]}`, description: `${n.by} · ${new Date(n.at).toLocaleDateString()}`, detail: l === undefined ? vscode.l10n.t('(the line was changed or removed)') : vscode.l10n.t('Line {0}: {1}', l + 1, lines[l].trim().slice(0, 100)), buttons: [delBtn] }; });
      qp.onDidTriggerItemButton(async e => { await notes.update(key, l => l.filter(x => x.id !== e.item.n.id)); qp.items = qp.items.filter(i => i !== e.item); });
      qp.onDidAccept(async () => {
        const n = qp.selectedItems[0]?.n; qp.hide();
        const l = n ? relocate(n, lines) : undefined;
        if (l !== undefined) { await vscode.window.showTextDocument(u, { selection: new vscode.Range(l, 0, l, 0) }); }
      });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    })),
    vscode.commands.registerCommand('vanthrex.notes.all', guard(async () => {
      const sys = manager.require().profile.name.toUpperCase();
      const all = await notes.all(true);
      const items = Object.entries(all).filter(([k]) => k.startsWith(`${sys}|`)).flatMap(([k, list]) => list.map(n => ({ k, n })));
      if (!items.length) { vscode.window.showInformationMessage(vscode.l10n.t('No notes yet: right-click a line in a member → Add Note.')); return; }
      const p = await vscode.window.showQuickPick(items.map(x => ({ x, label: `📝 ${x.n.text.split('\n')[0]}`, description: x.k.split('|')[1], detail: `${x.n.by} · ${new Date(x.n.at).toLocaleString()}` })), { title: vscode.l10n.t('All notes on {0}', sys), matchOnDescription: true, matchOnDetail: true });
      if (!p) { return; }
      const m = /^[^|]+\|([^/]+)\/([^(]+)\(([^)]+)\)$/.exec(p.x.k);
      if (!m) { return; }
      const rows = await manager.require().rows<Row>(`SELECT COALESCE(SOURCE_TYPE, '') AS T FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(m[1])} AND SYSTEM_TABLE_NAME = ${sqlString(m[2])} AND SYSTEM_TABLE_MEMBER = ${sqlString(m[3])}`, 1);
      const uri = vscode.Uri.from({ scheme: MEMBER_SCHEME, path: `/${m[1]}/${m[2]}/${m[3]}.${(s(rows[0], 'T') || 'mbr').toLowerCase()}` });
      await vscode.commands.executeCommand('vanthrex.notes.show', uri);
    })),
  );
  renderAll();
}
