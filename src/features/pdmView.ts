// PDM in one screen: Work with Libraries / Objects / Members using PDM, with the PDM option numbers,
// F-keys, subset, position to, F13 repeat, user-defined options (F16) and a command line.

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, logError } from '../core/log';
import { sqlString } from '../core/util';
import {
  DEFAULT_USER_OPTIONS, PdmLevel, PdmRow, PdmTarget, Subset, addMemberCommand, changesSomething, clError, objectStatus, printMemberCommand, typeCounts, applySubset, changeMemberCommand, copyMemberCommand,
  createLibraryCommand, createModuleCommand, deleteObjectCommand, duplicateObjectCommand, libraryTextCommand, moveObjectCommand,
  objectTextCommand, optionsFor, parseEntries, parsePdmCommand, removeMemberCommand, renameMemberCommand, renameObjectCommand, rowsToCsv,
  substitutePdm, validUserOptionCode,
} from '../core/pdm';
import { memberUri } from './fileSystems';
import { showReport } from './reportPanel';
import { escapeHtml, nonce } from './webviewUtil';

type Row = Record<string, unknown>;
const s = (r: Row | undefined, k: string) => String(r?.[k] ?? '').trim();
const ALLOWED = new Set(['vanthrex.v22.gotoLine', 'vanthrex.pdm']);
const RECENT_KEY = 'vanthrex.pdm.recent';

/** Translated option labels (the core keeps English ones). */
function optionLabel(label: string): string {
  const t: Record<string, string> = {
    'Edit': vscode.l10n.t('Edit'), 'Copy': vscode.l10n.t('Copy'), 'Delete': vscode.l10n.t('Delete'), 'Display': vscode.l10n.t('Display'),
    'Rename': vscode.l10n.t('Rename'), 'Display description': vscode.l10n.t('Display description'), 'Change text and type': vscode.l10n.t('Change text and type'),
    'Compile': vscode.l10n.t('Compile'), 'Create module': vscode.l10n.t('Create module'), 'Local history': vscode.l10n.t('Local history'),
    'Find string': vscode.l10n.t('Find string'), 'Compare (two members)': vscode.l10n.t('Compare (two members)'), 'Git history': vscode.l10n.t('Git history'),
    'Unused code': vscode.l10n.t('Unused code'), 'Hard-coded libraries': vscode.l10n.t('Hard-coded libraries'),
    'Display (object information)': vscode.l10n.t('Display (object information)'), 'Move': vscode.l10n.t('Move'),
    'Work with (members of a source file)': vscode.l10n.t('Work with (members)'), 'Change text': vscode.l10n.t('Change text'),
    'Copy (duplicate)': vscode.l10n.t('Copy (duplicate)'), 'Run (call program)': vscode.l10n.t('Run (call program)'),
    'Change data (edit table)': vscode.l10n.t('Change data (edit table)'), 'Debug': vscode.l10n.t('Debug'), 'Where used': vscode.l10n.t('Where used'),
    'Who has it locked': vscode.l10n.t('Who has it locked'), 'What depends on this file': vscode.l10n.t('What depends on this file'),
    'Display objects': vscode.l10n.t('Display objects'), 'Work with objects': vscode.l10n.t('Work with objects'),
    'Work with source files': vscode.l10n.t('Work with source files'), 'Add to library list': vscode.l10n.t('Add to library list'),
    'Set as current library': vscode.l10n.t('Set as current library'),
  };
  return t[label] ?? label;
}

function userOptions(): Record<string, string> {
  const own = vscode.workspace.getConfiguration('vanthrex').get<Record<string, string>>('pdm.userOptions', {}) ?? {};
  return Object.fromEntries(Object.entries({ ...DEFAULT_USER_OPTIONS, ...own }).filter(([, v]) => typeof v === 'string' && v.trim()));
}

interface Loc { level: PdmLevel; library?: string; file?: string; subset: Subset }

class PdmPanel {
  static current?: PdmPanel;
  private readonly panel: vscode.WebviewPanel;
  private loc: Loc = { level: 'libraries', subset: {} };
  private readonly back: Loc[] = [];
  private rows: PdmRow[] = [];
  private statuses: Record<string, string> = {};
  private message = '';
  private busy = false;
  private retry: Record<string, string> = {};
  /** Members removed by the last option 4, with their source, so F9 can put them back. */
  private lastDeleted: { library: string; file: string; name: string; type: string; text: string; source: string }[] = [];
  private readonly previewCache = new Map<string, string>();

  constructor(private readonly manager: ConnectionManager, private readonly state: vscode.Memento, private readonly storage?: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel('vanthrex.pdm', 'PDM', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => { PdmPanel.current = undefined; });
    this.panel.webview.onDidReceiveMessage(m => { void this.onMessage(m); });
  }

  static show(manager: ConnectionManager, state: vscode.Memento, storage?: vscode.Uri): PdmPanel {
    if (!PdmPanel.current) { PdmPanel.current = new PdmPanel(manager, state, storage); } else { PdmPanel.current.panel.reveal(); }
    return PdmPanel.current;
  }

  private get conn(): IbmiConnection { return this.manager.require(); }
  private key(r: PdmRow): string { return `${r.name}|${r.type}`; }

  // ------------------------------------------------------------ navigation

  async go(t: PdmTarget, remember = true): Promise<void> {
    const lib = t.library?.trim().toUpperCase();
    const file = t.file?.trim().toUpperCase();
    const next: Loc = { level: t.level, library: lib, file, subset: { name: t.name, type: t.type } };
    if (next.level === 'members' && (!lib || lib === '*LIBL' || lib === '*CURLIB')) { next.library = await this.resolveFile(file ?? '', lib); }
    if (next.level === 'objects' && (!lib || lib === '*CURLIB')) { next.library = this.conn.profile.currentLibrary?.toUpperCase() || 'QGPL'; }
    if (remember && this.rowsLoaded()) { this.back.push(this.loc); }
    this.loc = next;
    this.statuses = {};
    this.message = '';
    await this.load();
    if (next.level !== 'libraries' || next.subset.name) { await this.remember(next); }
  }

  private loaded = false;
  private rowsLoaded(): boolean { return this.loaded; }

  private async resolveFile(file: string, lib?: string): Promise<string> {
    if (!file) { throw new Error(vscode.l10n.t('Enter the source file.')); }
    const p = this.conn.profile;
    if (lib === '*CURLIB') { return p.currentLibrary?.toUpperCase() || 'QGPL'; }
    const libs = [...new Set([p.currentLibrary, ...p.libraries].filter(Boolean).map(l => String(l).toUpperCase()))];
    if (!libs.length) { throw new Error(vscode.l10n.t('Your library list is empty: use LIB/FILE.')); }
    const rows = await this.conn.rows<Row>(`SELECT SYSTEM_TABLE_SCHEMA AS L FROM QSYS2.SYSTABLES WHERE SYSTEM_TABLE_NAME = ${sqlString(file)} AND SYSTEM_TABLE_SCHEMA IN (${libs.map(sqlString).join(', ')})`, 50);
    const found = libs.find(l => rows.some(r => s(r, 'L') === l));
    if (!found) { throw new Error(vscode.l10n.t('File {0} was not found in your library list.', file)); }
    return found;
  }

  private async remember(l: Loc): Promise<void> {
    const label = l.level === 'members' ? `WRKMBRPDM FILE(${l.library}/${l.file})` : l.level === 'objects' ? `WRKOBJPDM LIB(${l.library})` : `WRKLIBPDM LIB(${l.subset.name})`;
    const list = this.state.get<string[]>(RECENT_KEY, []).filter(x => x !== label);
    await this.state.update(RECENT_KEY, [label, ...list].slice(0, 15));
  }

  async load(): Promise<void> {
    const l = this.loc;
    this.panel.title = l.level === 'members' ? `PDM · ${l.library}/${l.file}` : l.level === 'objects' ? `PDM · ${l.library}` : vscode.l10n.t('PDM · Libraries');
    this.post({ t: 'busy', on: true });
    try {
      this.rows = l.level === 'members' ? await this.members(l.library!, l.file!) : l.level === 'objects' ? await this.objects(l.library!) : await this.libraries(l.subset.name);
      this.loaded = true;
    } catch (e) {
      logError(e);
      this.rows = [];
      this.message = errorMessage(e).split('\n')[0];
    }
    this.send();
  }

  private async members(lib: string, file: string): Promise<PdmRow[]> {
    const rows = await this.conn.rows<Row>(
      `SELECT SYSTEM_TABLE_MEMBER AS N, COALESCE(SOURCE_TYPE, '') AS T, COALESCE(PARTITION_TEXT, '') AS X, ` +
      `VARCHAR(COALESCE(LAST_SOURCE_UPDATE_TIMESTAMP, LAST_CHANGE_TIMESTAMP)) AS C, NUMBER_ROWS AS R ` +
      `FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(file)} ORDER BY 1`, 50000);
    const objLib = (this.conn.profile.objectLibrary || lib).toUpperCase();
    const [locks, objs] = await Promise.all([
      this.conn.rows<Row>(`SELECT SYSTEM_TABLE_MEMBER AS M, MAX(JOB_NAME) AS J FROM QSYS2.OBJECT_LOCK_INFO WHERE SYSTEM_OBJECT_SCHEMA = ${sqlString(lib)} ` +
        `AND SYSTEM_OBJECT_NAME = ${sqlString(file)} AND OBJECT_TYPE = '*FILE' AND SYSTEM_TABLE_MEMBER IS NOT NULL GROUP BY SYSTEM_TABLE_MEMBER`, 5000).catch(() => [] as Row[]),
      this.conn.rows<Row>(`SELECT OBJNAME AS N, OBJTYPE AS T, VARCHAR(OBJCREATED) AS C FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(objLib)}, '*PGM *MODULE *FILE *CMD *MENU')) X`, 50000).catch(() => [] as Row[]),
    ]);
    const lockBy = new Map(locks.map(r => [s(r, 'M'), s(r, 'J')]));
    const byName = new Map<string, { type: string; created: string }[]>();
    for (const o of objs) { const k = s(o, 'N'); if (!byName.has(k)) { byName.set(k, []); } byName.get(k)!.push({ type: s(o, 'T'), created: s(o, 'C') }); }
    return rows.map(r => ({
      name: s(r, 'N'), type: s(r, 'T'), text: s(r, 'X'), changed: s(r, 'C').slice(0, 16), size: Number(r.R ?? 0),
      lockedBy: lockBy.get(s(r, 'N')) ?? '', objStatus: objectStatus(s(r, 'T'), s(r, 'C'), byName.get(s(r, 'N')) ?? []),
    }));
  }

  private async objects(lib: string): Promise<PdmRow[]> {
    const rows = await this.conn.rows<Row>(
      `SELECT O.OBJNAME AS N, O.OBJTYPE AS T, CASE WHEN O.OBJTYPE = '*FILE' AND EXISTS (SELECT 1 FROM QSYS2.SYSTABLES S WHERE S.SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} ` +
      `AND S.SYSTEM_TABLE_NAME = O.OBJNAME AND S.FILE_TYPE = 'S') THEN 'PF-SRC' ELSE COALESCE(O.OBJATTRIBUTE, '') END AS A, COALESCE(O.OBJTEXT, '') AS X, ` +
      `VARCHAR(O.CHANGE_TIMESTAMP) AS C, O.OBJSIZE AS Z FROM TABLE(QSYS2.OBJECT_STATISTICS(${sqlString(lib)}, '*ALL')) O ORDER BY O.OBJNAME, O.OBJTYPE`, 50000);
    return rows.map(r => ({ name: s(r, 'N'), type: s(r, 'T'), attribute: s(r, 'A'), text: s(r, 'X'), changed: s(r, 'C').slice(0, 16), size: Number(r.Z ?? 0) }));
  }

  private async libraries(generic?: string): Promise<PdmRow[]> {
    const g = generic?.trim().toUpperCase();
    if (g && g !== '*LIBL' && g !== '*USRLIBL') {
      const like = g === '*ALL' || g === '*ALLUSR' ? '%' : g.replace(/\*/g, '%');
      const rows = await this.conn.rows<Row>(`SELECT OBJNAME AS N, COALESCE(OBJATTRIBUTE, '') AS A, COALESCE(OBJTEXT, '') AS X FROM TABLE(QSYS2.OBJECT_STATISTICS('QSYS', '*LIB')) ` +
        `WHERE OBJNAME LIKE ${sqlString(like)}${g === '*ALLUSR' ? " AND OBJNAME NOT LIKE 'Q%' AND OBJNAME NOT LIKE '#%'" : ''} ORDER BY 1`, 5000);
      return rows.map(r => ({ name: s(r, 'N'), type: s(r, 'A') || '*PROD', text: s(r, 'X') }));
    }
    const p = this.conn.profile;
    const libs = [...new Set([p.currentLibrary, ...p.libraries].filter(Boolean).map(x => String(x).toUpperCase()))];
    if (!libs.length) { return []; }
    const rows = await this.conn.rows<Row>(`SELECT OBJNAME AS N, COALESCE(OBJATTRIBUTE, '') AS A, COALESCE(OBJTEXT, '') AS X FROM TABLE(QSYS2.OBJECT_STATISTICS('QSYS', '*LIB')) ` +
      `WHERE OBJNAME IN (${libs.map(sqlString).join(', ')})`, 500).catch(() => [] as Row[]);
    return libs.map(n => { const r = rows.find(x => s(x, 'N') === n); return { name: n, type: n === p.currentLibrary?.toUpperCase() ? 'CUR' : (s(r, 'A') || 'USR'), text: s(r, 'X') }; });
  }

  // ------------------------------------------------------------ webview

  private post(m: unknown): void { void this.panel.webview.postMessage(m); }

  private send(): void {
    const l = this.loc;
    let view: PdmRow[];
    try { view = l.level === 'libraries' ? this.rows : applySubset(this.rows, l.subset); } catch (e) { view = this.rows; this.message = errorMessage(e); }
    const opts = optionsFor(l.level).map(o => ({ code: o.code, label: optionLabel(o.label) }));
    const user = Object.keys(userOptions()).filter(k => validUserOptionCode(k, l.level)).sort();
    this.post({
      t: 'data', level: l.level, library: l.library ?? '', file: l.file ?? '', subset: l.subset, canBack: this.back.length > 0,
      rows: view.map(r => ({ k: this.key(r), name: r.name, type: r.type, attribute: r.attribute ?? '', text: r.text, changed: r.changed ?? '', size: r.size ?? '', lock: r.lockedBy ?? '', obj: r.objStatus ?? '' })),
      total: this.rows.length, options: opts, user, statuses: this.statuses, message: this.message, retry: this.retry,
      types: typeCounts(this.rows), canUndo: this.lastDeleted.length > 0,
      objLib: l.level === 'members' ? (this.conn.profile.objectLibrary || l.library || '').toUpperCase() : '',
    });
    this.retry = {};
  }

  private async onMessage(m: { t: string; [k: string]: unknown }): Promise<void> {
    if (m.t === 'preview') { await this.preview(String(m.k)); return; }
    if (this.busy && m.t !== 'ready') { this.post({ t: 'note', text: vscode.l10n.t('Still working on the previous request…') }); return; }
    this.busy = true;
    try {
      switch (m.t) {
        case 'ready': if (this.loaded) { this.send(); } break;
        case 'enter': await this.enter(m.entries as { k: string; option: string }[], String(m.params ?? '')); break;
        case 'key': await this.key2(String(m.key)); break;
        case 'subset': this.loc.subset = m.subset as Subset; if (this.loc.level === 'libraries') { await this.load(); } else { this.message = ''; this.send(); } break;
        case 'goto': await this.go({ level: m.level as PdmLevel, library: String(m.library ?? ''), file: String(m.file ?? '') }); break;
        case 'open': await this.defaultAction(String(m.k)); break;
      }
    } catch (e) {
      logError(e);
      this.message = errorMessage(e).split('\n')[0];
      this.send();
    } finally {
      this.busy = false;
      this.post({ t: 'busy', on: false });
    }
  }

  /** F-keys arrive from VS Code key bindings (so F5 / F12 do not start debugging or go to definition). */
  async key2(key: string): Promise<void> {
    switch (key) {
      case 'F3': this.panel.dispose(); return;
      case 'F12': { const prev = this.back.pop(); if (prev) { this.loc = prev; this.statuses = {}; this.message = ''; await this.load(); } else { this.panel.dispose(); } return; }
      case 'F5': this.statuses = {}; this.message = ''; await this.load(); return;
      case 'F6': await this.create(); return;
      case 'F16': await editUserOptions(this.loc.level); this.send(); return;
      case 'F21': await this.exportList(); return;
      case 'F9': await this.undoDelete(); return;
      case 'F13': case 'F17': case 'F23': this.post({ t: 'key', key }); return;
    }
  }

  // ------------------------------------------------------------ options

  private async enter(entries: { k: string; option: string }[], params: string): Promise<void> {
    const l = this.loc;
    const user = userOptions();
    const userCodes = Object.keys(user).filter(k => validUserOptionCode(k, l.level));
    const byKey = new Map(this.rows.map(r => [this.key(r), r]));
    const list = parseEntries(entries.map((e, i) => ({ index: i, option: e.option })), [...optionsFor(l.level).map(o => o.code), ...userCodes])
      .map(e => ({ option: e.option, row: byKey.get(entries[e.index].k) })).filter((e): e is { option: string; row: PdmRow } => !!e.row);
    if (!list.length) {
      if (params.trim()) { await this.commandLine(params.trim()); }
      return;
    }
    this.statuses = {};
    this.retry = {};
    this.message = '';
    let changed = false;
    // Many rows with options that change things: say what will happen first.
    const changing = list.filter(e => changesSomething(l.level, e.option, userCodes) && e.option !== '4');
    if (changing.length > 10) {
      const yes = vscode.l10n.t('Continue');
      const go = await vscode.window.showWarningMessage(vscode.l10n.t('Run {0} changing option(s) ({1})?', changing.length, [...new Set(changing.map(e => e.option))].join(', ')), { modal: true }, yes);
      if (go !== yes) { list.forEach(e => { this.retry[this.key(e.row)] = e.option; }); this.message = vscode.l10n.t('Nothing done.'); this.send(); return; }
    }
    const ok = (r: PdmRow, msg = '✓') => { this.statuses[this.key(r)] = msg; };
    const optionOf = new Map(list.map(e => [this.key(e.row), e.option]));
    const fail = (r: PdmRow, e: unknown) => {
      this.statuses[this.key(r)] = `✗ ${errorMessage(e).split('\n')[0]}`;
      this.retry[this.key(r)] = optionOf.get(this.key(r)) ?? '';      // keep the option on the row, like PDM, to fix and retry
    };
    const run = async (r: PdmRow, cmd: string) => {
      const res = await this.conn.runCL(cmd);
      if (!res.ok) { throw new Error(clError(res.stdout, res.stderr)); }
      changed = true; ok(r);
    };

    // Options that act on the whole batch first.
    const deletes = list.filter(e => e.option === '4');
    if (deletes.length) {
      const names = deletes.map(e => (l.level === 'objects' ? `${e.row.name} ${e.row.type}` : e.row.name)).join(', ');
      const yes = vscode.l10n.t('Delete');
      const go = await vscode.window.showWarningMessage(vscode.l10n.t('Delete {0} item(s) from {1}? {2}', deletes.length, l.level === 'members' ? `${l.library}/${l.file}` : l.library ?? '', names.slice(0, 600)), { modal: true }, yes);
      if (go === yes && l.level === 'members') { this.lastDeleted = []; }
      for (const e of deletes) {
        if (go !== yes) { this.statuses[this.key(e.row)] = vscode.l10n.t('not deleted'); this.retry[this.key(e.row)] = '4'; continue; }
        try {
          if (l.level === 'members') {
            if (e.row.lockedBy) { throw new Error(vscode.l10n.t('In use by {0}.', e.row.lockedBy)); }
            // Keep a copy first, so F9 can bring it back.
            let source: string | undefined;
            try { source = await this.conn.readMember(l.library!, l.file!, e.row.name); } catch (x) {
              const anyway = vscode.l10n.t('Delete anyway');
              if (await vscode.window.showWarningMessage(vscode.l10n.t('{0} could not be backed up ({1}). Delete it anyway?', e.row.name, errorMessage(x).split('\n')[0]), { modal: true }, anyway) !== anyway) {
                this.statuses[this.key(e.row)] = vscode.l10n.t('not deleted'); continue;
              }
            }
            await run(e.row, removeMemberCommand(l.library!, l.file!, e.row.name));
            if (source !== undefined) {
              this.lastDeleted.push({ library: l.library!, file: l.file!, name: e.row.name, type: e.row.type, text: e.row.text, source });
              await this.backupToDisk(l.library!, l.file!, e.row.name, e.row.type, source);
            }
          } else {
            await run(e.row, deleteObjectCommand(l.library!, e.row.name, e.row.type));
          }
        } catch (x) { fail(e.row, x); }
      }
      if (this.lastDeleted.length) { this.message = vscode.l10n.t('{0} member(s) deleted. F9 puts them back.', this.lastDeleted.length); }
    }
    const compare = list.filter(e => e.option === '54');
    if (compare.length) {
      if (compare.length !== 2) { this.message = vscode.l10n.t('Option 54 compares two members: type it on exactly two rows.'); } else {
        const [a, b] = compare.map(e => memberUri(l.library!, l.file!, e.row.name, e.row.type));
        await vscode.commands.executeCommand('vscode.diff', a, b, `${compare[0].row.name} ↔ ${compare[1].row.name}`);
        compare.forEach(e => ok(e.row));
      }
    }
    const finds = list.filter(e => e.option === '25');
    if (finds.length) { await this.findString(finds.map(e => e.row)); }
    let copyTo: string | undefined; let moveTo: string | undefined; let navigated = false;
    const rest = list.filter(e => !['4', '54', '25'].includes(e.option));
    const loop = async (tok?: vscode.CancellationToken, progress?: vscode.Progress<{ message?: string; increment?: number }>) => {
    for (const { option, row: r } of rest) {
      if (tok?.isCancellationRequested) { this.statuses[this.key(r)] = vscode.l10n.t('cancelled'); this.retry[this.key(r)] = option; continue; }
      progress?.report({ message: `${option} ${r.name}`, increment: 100 / rest.length });
      try {
        const uri = l.level === 'members' ? memberUri(l.library!, l.file!, r.name, r.type) : undefined;
        const obj = { library: l.library!, name: r.name, type: r.type, attribute: r.attribute ?? '', text: r.text };
        if (userCodes.includes(option)) {
          const cmd = substitutePdm(user[option], { library: l.level === 'libraries' ? r.name : l.library!, file: l.file, name: r.name, type: r.type, attribute: r.attribute,
            objectLibrary: this.conn.profile.objectLibrary || this.conn.profile.currentLibrary || l.library || 'QGPL', user: this.conn.user, text: r.text });
          await run(r, `${cmd}${params.trim() ? ` ${params.trim()}` : ''}`);
          continue;
        }
        if (l.level === 'members') {
          switch (option) {
            case '2': await vscode.window.showTextDocument(uri!, { preview: false }); ok(r); break;
            case '5': await vscode.window.showTextDocument(uri!, { preview: true }); await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession'); ok(r); break;
            case '3': {
              copyTo = copyTo ?? await ask(vscode.l10n.t('Copy members to (LIBRARY/FILE)'), `${l.library}/${l.file}`);
              if (!copyTo) { return; }
              const [tl, tf] = copyTo.toUpperCase().split('/');
              const same = tl === l.library && tf === l.file;
              const to = await ask(vscode.l10n.t('Copy {0} as', r.name), same ? '' : r.name, true);
              if (!to) { continue; }
              const exists = await this.conn.rows(`SELECT 1 AS X FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(tl)} AND SYSTEM_TABLE_NAME = ${sqlString(tf ?? '')} AND SYSTEM_TABLE_MEMBER = ${sqlString(to.toUpperCase())}`, 1).catch(() => []);
              if (exists.length && await vscode.window.showWarningMessage(vscode.l10n.t('{0} already exists in {1}. Replace it?', to.toUpperCase(), copyTo.toUpperCase()), { modal: true }, vscode.l10n.t('Replace')) !== vscode.l10n.t('Replace')) { continue; }
              await run(r, copyMemberCommand(l.library!, l.file!, r.name, tl, tf ?? '', to)); break;
            }
            case '6': await run(r, printMemberCommand(l.library!, l.file!, r.name)); this.message = vscode.l10n.t('Printed to your output queue — see the Spooled Files view.'); break;
            case '7': {
              const to = await ask(vscode.l10n.t('Rename {0} to', r.name), r.name, true);
              if (!to || to.toUpperCase() === r.name) { break; }
              if (this.rows.some(x => x.name === to.toUpperCase())) { throw new Error(vscode.l10n.t('{0} already exists.', to.toUpperCase())); }
              if (r.lockedBy) { throw new Error(vscode.l10n.t('In use by {0}.', r.lockedBy)); }
              await run(r, renameMemberCommand(l.library!, l.file!, r.name, to)); break;
            }
            case '8': await this.describeMember(r); ok(r); break;
            case '13': {
              const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Text of {0}', r.name), value: r.text, ignoreFocusOut: true });
              if (text === undefined) { continue; }
              const type = await vscode.window.showInputBox({ title: vscode.l10n.t('Source type of {0}', r.name), value: r.type, ignoreFocusOut: true });
              if (type === undefined) { continue; }
              await run(r, changeMemberCommand(l.library!, l.file!, r.name, text, type)); break;
            }
            case '14': await vscode.commands.executeCommand('vanthrex.compile', { resourceUri: uri }); ok(r); break;
            case '15': await run(r, createModuleCommand(l.library!, l.file!, r.name, r.type, this.conn.profile.objectLibrary || this.conn.profile.currentLibrary || l.library!)); break;
            case '16': await vscode.commands.executeCommand('vanthrex.showHistory', uri); ok(r); break;
            case 'GH': await vscode.commands.executeCommand('vanthrex.git.memberHistory', uri); ok(r); break;
            case 'UC': await vscode.window.showTextDocument(uri!, { preview: false }); await vscode.commands.executeCommand('vanthrex.unusedCode'); ok(r); break;
            case 'HL': await vscode.window.showTextDocument(uri!, { preview: false }); await vscode.commands.executeCommand('vanthrex.hardcodedLibraries'); ok(r); break;
          }
        } else if (l.level === 'objects') {
          switch (option) {
            case '5': case '8': await vscode.commands.executeCommand('vanthrex.objectInfo', obj); ok(r); break;
            case '7': {
              const to = await ask(vscode.l10n.t('Rename {0} {1} to', r.name, r.type), r.name, true);
              if (!to || to.toUpperCase() === r.name) { break; }
              if (this.rows.some(x => x.name === to.toUpperCase() && x.type === r.type)) { throw new Error(vscode.l10n.t('{0} {1} already exists.', to.toUpperCase(), r.type)); }
              await run(r, renameObjectCommand(l.library!, r.name, r.type, to)); break;
            }
            case '11': { moveTo = moveTo ?? await ask(vscode.l10n.t('Move objects to library'), '', true); if (!moveTo) { return; } await run(r, moveObjectCommand(l.library!, r.name, r.type, moveTo)); break; }
            case '12': if (r.type !== '*FILE') { throw new Error(vscode.l10n.t('Option 12 works on files.')); } await this.go({ level: 'members', library: l.library, file: r.name }); navigated = true; return;
            case '13': { const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Text of {0}', r.name), value: r.text, ignoreFocusOut: true }); if (text !== undefined) { await run(r, objectTextCommand(l.library!, r.name, r.type, text)); } break; }
            case '15': {
              const toLib = await ask(vscode.l10n.t('Copy {0} {1} to library', r.name, r.type), l.library!, true);
              if (!toLib) { continue; }
              const to = await ask(vscode.l10n.t('New name'), r.name, true);
              if (to) { await run(r, duplicateObjectCommand(l.library!, r.name, r.type, toLib, to)); }
              break;
            }
            case '16': if (r.type !== '*PGM') { throw new Error(vscode.l10n.t('Option 16 calls programs.')); } await vscode.commands.executeCommand('vanthrex.objectCall', obj); ok(r); break;
            case '18': if (r.type !== '*FILE') { throw new Error(vscode.l10n.t('Option 18 works on files.')); } await vscode.commands.executeCommand('vanthrex.editData', obj); ok(r); break;
            case '34': if (r.type !== '*PGM') { throw new Error(vscode.l10n.t('Option 34 debugs programs.')); } await vscode.commands.executeCommand('vanthrex.debugProgram', obj); ok(r); break;
            case 'WU': await vscode.commands.executeCommand('vanthrex.whereUsed', obj); ok(r); break;
            case 'LK': await vscode.commands.executeCommand('vanthrex.objectLocks', obj); ok(r); break;
            case 'DP': await vscode.commands.executeCommand('vanthrex.tableDependents', obj); ok(r); break;
          }
        } else {
          switch (option) {
            case '5': case '12': await this.go({ level: 'objects', library: r.name }); navigated = true; return;
            case 'SF': await this.go({ level: 'objects', library: r.name, type: 'PF-SRC' }); navigated = true; return;
            case '8': await vscode.commands.executeCommand('vanthrex.objectInfo', { library: 'QSYS', name: r.name, type: '*LIB' }); ok(r); break;
            case '13': { const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Text of {0}', r.name), value: r.text, ignoreFocusOut: true }); if (text !== undefined) { await run(r, libraryTextCommand(r.name, text)); } break; }
            case 'LL': await this.manager.updateActiveProfile(p => { if (!p.libraries.map(x => x.toUpperCase()).includes(r.name)) { p.libraries = [r.name, ...p.libraries]; } }); ok(r); break;
            case 'CL': await vscode.commands.executeCommand('vanthrex.setCurrentLibrary', { kind: 'library', library: r.name, current: false }); ok(r); break;
          }
        }
      } catch (e) { fail(r, e); }
    }
    };
    if (rest.length > 1) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('PDM: {0} option(s)', rest.length), cancellable: true }, (p, tok) => loop(tok, p));
    } else { await loop(); }
    if (navigated) { return; }
    const failed = Object.values(this.statuses).filter(x => x.startsWith('✗')).length;
    if (!this.message) { this.message = failed ? vscode.l10n.t('{0} option(s) failed — see the Status column.', failed) : vscode.l10n.t('Done.'); }
    if (changed) { await this.load(); void vscode.commands.executeCommand('vanthrex.refreshLibraries'); } else { this.send(); }
  }

  private async defaultAction(k: string): Promise<void> {
    const r = this.rows.find(x => this.key(x) === k);
    if (!r) { return; }
    const option = this.loc.level === 'members' ? '2' : this.loc.level === 'libraries' ? '12' : r.type === '*FILE' ? '12' : '5';
    await this.enter([{ k, option }], '');
  }

  private async commandLine(cmd: string): Promise<void> {
    const t = parsePdmCommand(cmd);
    if (t) { await this.go(t); return; }
    if (/^UNDO$/i.test(cmd)) { await this.undoDelete(); return; }
    const r = await this.conn.runCL(cmd);
    const lines = `${r.stdout}\n${r.stderr}`.split('\n').map(x => x.trim()).filter(Boolean);
    this.message = r.ok ? `✓ ${lines.pop() ?? vscode.l10n.t('Command ended normally.')}` : `✗ ${clError(r.stdout, r.stderr)}`;
    if (r.ok) { await this.load(); } else { this.send(); }
  }

  private async create(): Promise<void> {
    const l = this.loc;
    if (l.level === 'members') {
      const name = await ask(vscode.l10n.t('New member in {0}/{1}', l.library!, l.file!), '', true);
      if (!name) { return; }
      const types = [...new Set(this.rows.map(r => r.type).filter(Boolean))];
      const type = await vscode.window.showInputBox({ title: vscode.l10n.t('Source type'), value: types[0] ?? 'RPGLE', ignoreFocusOut: true });
      if (type === undefined) { return; }
      const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Text (optional)'), ignoreFocusOut: true }) ?? '';
      const r = await this.conn.runCL(addMemberCommand(l.library!, l.file!, name, type, text));
      if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
      await this.load();
      await vscode.window.showTextDocument(memberUri(l.library!, l.file!, name.toUpperCase(), type), { preview: false });
    } else if (l.level === 'objects') {
      await vscode.commands.executeCommand('vanthrex.newSourceFile', { kind: 'library', library: l.library, current: false });
      await this.load();
    } else {
      const name = await ask(vscode.l10n.t('New library'), '', true);
      if (!name) { return; }
      const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Text (optional)'), ignoreFocusOut: true }) ?? '';
      const kind = await vscode.window.showQuickPick(['*PROD', '*TEST'], { title: vscode.l10n.t('Library type') });
      if (!kind) { return; }
      const r = await this.conn.runCL(createLibraryCommand(name, text, kind === '*TEST'));
      if (!r.ok) { throw new Error((r.stderr || r.stdout).trim()); }
      this.message = vscode.l10n.t('Library {0} created.', name.toUpperCase());
      await this.load();
    }
  }

  /** Also keep deleted members on disk (extension storage), so nothing is lost if VS Code closes. */
  private async backupToDisk(lib: string, file: string, mbr: string, type: string, source: string): Promise<void> {
    if (!this.storage) { return; }
    try {
      const dir = vscode.Uri.joinPath(this.storage, 'pdm-deleted');
      await vscode.workspace.fs.createDirectory(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, `${lib}.${file}.${mbr}.${stamp}.${(type || 'txt').toLowerCase()}`), Buffer.from(source, 'utf8'));
    } catch (e) { logError(e); }
  }

  private async undoDelete(): Promise<void> {
    if (!this.lastDeleted.length) { this.message = vscode.l10n.t('Nothing to put back.'); this.send(); return; }
    const list = this.lastDeleted;
    const yes = vscode.l10n.t('Restore');
    if (await vscode.window.showInformationMessage(vscode.l10n.t('Put back {0} deleted member(s): {1}?', list.length, list.map(d => d.name).join(', ').slice(0, 400)), { modal: true }, yes) !== yes) { return; }
    const failed: string[] = [];
    for (const d of list) {
      try {
        const r = await this.conn.runCL(addMemberCommand(d.library, d.file, d.name, d.type, d.text));
        if (!r.ok) { throw new Error(clError(r.stdout, r.stderr)); }
        await this.conn.writeMember(d.library, d.file, d.name, d.source);
        this.statuses[`${d.name}|${d.type}`] = vscode.l10n.t('✓ restored');
      } catch (e) { failed.push(`${d.name}: ${errorMessage(e).split('\n')[0]}`); }
    }
    this.lastDeleted = failed.length ? list.filter(d => failed.some(f => f.startsWith(`${d.name}:`))) : [];
    this.message = failed.length ? `✗ ${failed.join('; ')}` : vscode.l10n.t('{0} member(s) restored.', list.length);
    await this.load();
  }

  /** First lines of a member for the preview pane (cached by member and change time). */
  private async preview(k: string): Promise<void> {
    const l = this.loc;
    const r = this.rows.find(x => this.key(x) === k);
    if (!r || l.level !== 'members') { return; }
    const ck = `${l.library}/${l.file}/${k}/${r.changed}`;
    try {
      let text = this.previewCache.get(ck);
      if (text === undefined) {
        text = (await this.conn.readMember(l.library!, l.file!, r.name)).split(/\r?\n/).slice(0, 300).join('\n');
        if (this.previewCache.size > 200) { this.previewCache.clear(); }
        this.previewCache.set(ck, text);
      }
      this.post({ t: 'preview', k, title: `${r.name}.${r.type.toLowerCase()} — ${r.text}`, text });
    } catch (e) {
      this.post({ t: 'preview', k, title: r.name, text: `✗ ${errorMessage(e).split('\n')[0]}` });
    }
  }

  private async describeMember(r: PdmRow): Promise<void> {
    const l = this.loc;
    const rows = await this.conn.rows<Row>(`SELECT * FROM QSYS2.SYSPARTITIONSTAT WHERE SYSTEM_TABLE_SCHEMA = ${sqlString(l.library!)} AND SYSTEM_TABLE_NAME = ${sqlString(l.file!)} AND SYSTEM_TABLE_MEMBER = ${sqlString(r.name)}`, 1);
    const d = rows[0];
    showReport('pdmMember', {
      title: `${l.library}/${l.file}(${r.name})`, subtitle: r.text,
      facts: [[vscode.l10n.t('Source type'), r.type], [vscode.l10n.t('Lines'), s(d, 'NUMBER_ROWS')], [vscode.l10n.t('Size (bytes)'), s(d, 'DATA_SIZE')],
        [vscode.l10n.t('Created'), s(d, 'CREATE_TIMESTAMP')], [vscode.l10n.t('Source last changed'), s(d, 'LAST_SOURCE_UPDATE_TIMESTAMP')],
        [vscode.l10n.t('Last changed'), s(d, 'LAST_CHANGE_TIMESTAMP')], [vscode.l10n.t('Last used'), s(d, 'LAST_USED_TIMESTAMP')], [vscode.l10n.t('Days used'), s(d, 'DAYS_USED_COUNT')]],
    }, ALLOWED);
  }

  private async findString(rows: PdmRow[]): Promise<void> {
    const l = this.loc;
    const text = await vscode.window.showInputBox({ title: vscode.l10n.t('Find string in {0} member(s)', rows.length), prompt: vscode.l10n.t('Text to find (not case sensitive)'), ignoreFocusOut: true });
    if (!text?.trim()) { return; }
    const needle = text.trim().toLowerCase();
    const hits: { m: PdmRow; line: number; src: string }[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Searching…'), cancellable: true }, async (p, tok) => {
      for (const m of rows) {
        if (tok.isCancellationRequested) { break; }
        p.report({ message: m.name, increment: 100 / rows.length });
        try {
          const src = await this.conn.readMember(l.library!, l.file!, m.name);
          src.split(/\r?\n/).forEach((x, i) => { if (x.toLowerCase().includes(needle)) { hits.push({ m, line: i, src: x.trim().slice(0, 160) }); } });
          this.statuses[this.key(m)] = '✓';
        } catch (e) { this.statuses[this.key(m)] = `✗ ${errorMessage(e).split('\n')[0]}`; }
      }
    });
    showReport('pdmFind', {
      title: vscode.l10n.t('"{0}" in {1}/{2}', text.trim(), l.library!, l.file!),
      subtitle: vscode.l10n.t('{0} line(s) in {1} member(s). Click a line to open it.', hits.length, new Set(hits.map(h => h.m.name)).size),
      tables: [{ title: vscode.l10n.t('Lines'), filter: true, columns: [vscode.l10n.t('Member'), vscode.l10n.t('Line'), vscode.l10n.t('Source')],
        rows: hits.map(h => [h.m.name, h.line + 1, h.src]),
        rowActions: hits.map(h => ({ label: vscode.l10n.t('Open'), command: 'vanthrex.v22.gotoLine', args: [memberUri(l.library!, l.file!, h.m.name, h.m.type).toString(), h.line] })),
        empty: vscode.l10n.t('Not found.') }],
    }, ALLOWED);
  }

  private async exportList(): Promise<void> {
    const l = this.loc;
    const target = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, defaultUri: vscode.Uri.file(`${l.file ?? l.library ?? 'libraries'}.csv`) });
    if (!target) { return; }
    let rows = this.rows;
    try { if (l.level !== 'libraries') { rows = applySubset(this.rows, l.subset); } } catch { /* keep all */ }
    await vscode.workspace.fs.writeFile(target, Buffer.from(rowsToCsv(rows, l.level), 'utf8'));
    this.message = vscode.l10n.t('{0} row(s) saved to {1}.', rows.length, target.fsPath);
    this.send();
  }

  // ------------------------------------------------------------ page

  private html(): string {
    const n = nonce();
    const L = {
      libraries: vscode.l10n.t('Work with Libraries Using PDM'), libs: vscode.l10n.t('Libraries'), objects: vscode.l10n.t('Work with Objects Using PDM'), members: vscode.l10n.t('Work with Members Using PDM'),
      library: vscode.l10n.t('Library'), file: vscode.l10n.t('File'), position: vscode.l10n.t('Position to'), subset: vscode.l10n.t('Subset'), name: vscode.l10n.t('Name'),
      type: vscode.l10n.t('Type'), attribute: vscode.l10n.t('Attribute'), text: vscode.l10n.t('Text'), changed: vscode.l10n.t('Changed'), since: vscode.l10n.t('Changed since'),
      size: vscode.l10n.t('Size / lines'), status: vscode.l10n.t('Status'), opt: vscode.l10n.t('Opt'), typeOptions: vscode.l10n.t('Type options, press Enter.'),
      params: vscode.l10n.t('Parameters or command'), enter: vscode.l10n.t('Enter'), user: vscode.l10n.t('User options'), of: vscode.l10n.t('of'),
      more: vscode.l10n.t('More…'), empty: vscode.l10n.t('(No items match)'), go: vscode.l10n.t('Go'), clear: vscode.l10n.t('Clear'),
      obj: vscode.l10n.t('Object'), lock: vscode.l10n.t('In use by'), needsCompile: vscode.l10n.t('Needs compile'), locked: vscode.l10n.t('In use'),
      preview: vscode.l10n.t('Preview'), stale: vscode.l10n.t('source newer'), none: vscode.l10n.t('not compiled'), current: vscode.l10n.t('up to date'),
      objIn: vscode.l10n.t('Objects in'), types: vscode.l10n.t('Types'), all: vscode.l10n.t('All'),
      keys: [['F3', vscode.l10n.t('Exit')], ['F5', vscode.l10n.t('Refresh')], ['F6', vscode.l10n.t('Create')], ['F9', vscode.l10n.t('Undo delete')], ['F12', vscode.l10n.t('Back')], ['F13', vscode.l10n.t('Repeat')],
        ['F16', vscode.l10n.t('User options')], ['F17', vscode.l10n.t('Subset')], ['F21', vscode.l10n.t('Export CSV')], ['F23', vscode.l10n.t('More options')]],
    };
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 6px 14px 90px; margin: 0; }
  h1 { font-size: 1.25em; margin: 6px 0; font-weight: 600; }
  .mono, table, input { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .hdr, .bar { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; margin: 4px 0; }
  label { color: var(--vscode-descriptionForeground); }
  input { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 2px; padding: 2px 5px; }
  input.n { width: 10ch; text-transform: uppercase; } input.t { width: 18ch; }
  button { padding: 3px 10px; border: none; border-radius: 2px; cursor: pointer; background: var(--vscode-button-secondaryBackground, #8883); color: var(--vscode-button-secondaryForeground, inherit); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { filter: brightness(1.1); }
  .legend { margin: 6px 0; color: var(--vscode-descriptionForeground); line-height: 1.6; }
  .legend b { color: var(--vscode-textLink-foreground); font-weight: 600; }
  .legend .more { display: none; } body.more .legend .more { display: inline; }
  table { border-collapse: collapse; width: 100%; margin-top: 4px; }
  th, td { padding: 2px 8px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--vscode-editorWidget-border, #8882); }
  th { position: sticky; top: 0; background: var(--vscode-editor-background); cursor: pointer; user-select: none; color: var(--vscode-descriptionForeground); font-weight: 600; }
  td.x { white-space: normal; } td.num { text-align: right; }
  td.o input { width: 3ch; text-transform: uppercase; text-align: center; padding: 1px 2px; }
  tr:hover td { background: var(--vscode-list-hoverBackground); }
  tr.sel td { background: var(--vscode-list-inactiveSelectionBackground); }
  .ok { color: var(--vscode-testing-iconPassed, #3a3); } .bad { color: var(--vscode-errorForeground); }
  .foot { position: fixed; left: 0; right: 0; bottom: 0; padding: 6px 14px; background: var(--vscode-editorWidget-background); border-top: 1px solid var(--vscode-editorWidget-border, #8884); }
  .foot input.cmd { flex: 1; min-width: 240px; }
  .keys { margin-top: 4px; color: var(--vscode-descriptionForeground); } .keys a { cursor: pointer; margin-right: 12px; color: var(--vscode-textLink-foreground); }
  #msg { min-height: 1.3em; margin: 2px 0; } .dim { color: var(--vscode-descriptionForeground); }
  #busy { visibility: hidden; } body.busy #busy { visibility: visible; }
  .crumb a { cursor: pointer; color: var(--vscode-textLink-foreground); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
  .chip { padding: 1px 8px; border-radius: 10px; cursor: pointer; border: 1px solid var(--vscode-editorWidget-border, #8884); color: var(--vscode-descriptionForeground); }
  .chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .warn { color: var(--vscode-editorWarning-foreground, #c90); }
  #main { display: block; } body.pv #main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 10px; }
  #pv { display: none; } body.pv #pv { display: block; position: sticky; top: 0; align-self: start; max-height: calc(100vh - 120px); overflow: auto;
    border: 1px solid var(--vscode-editorWidget-border, #8884); border-radius: 3px; padding: 6px 8px; background: var(--vscode-textCodeBlock-background, transparent); }
  #pv pre { margin: 4px 0 0; white-space: pre; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  #pvTitle { color: var(--vscode-descriptionForeground); }
  label.cb { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
</style></head><body>
<h1 id="title"></h1>
<div class="hdr mono">
  <span class="crumb" id="crumb"></span>
  <label>${escapeHtml(L.library)} <input class="n" id="lib"></label>
  <label id="fileBox">${escapeHtml(L.file)} <input class="n" id="file"></label>
  <button id="go">${escapeHtml(L.go)}</button>
  <label>${escapeHtml(L.position)} <input class="n" id="pos"></label>
  <span id="objLib" class="dim"></span>
  <label class="cb" id="pvBox"><input type="checkbox" id="pvOn">${escapeHtml(L.preview)}</label>
  <span id="busy" class="dim">⏳</span>
</div>
<div class="bar" id="subsetBar">
  <label>${escapeHtml(L.subset)}: ${escapeHtml(L.name)} <input class="n" id="sName" placeholder="*ALL"></label>
  <label>${escapeHtml(L.type)} <input class="n" id="sType" placeholder="*ALL"></label>
  <label id="sTextL">${escapeHtml(L.text)} <input class="t" id="sText"></label>
  <label id="sSinceL">${escapeHtml(L.since)} <input class="n" id="sSince" placeholder="YYYY-MM-DD"></label>
  <label class="cb" id="ncBox"><input type="checkbox" id="sNeeds">${escapeHtml(L.needsCompile)}</label>
  <label class="cb" id="lkBox"><input type="checkbox" id="sLocked">${escapeHtml(L.locked)}</label>
  <button id="clear">${escapeHtml(L.clear)}</button>
</div>
<div class="chips mono" id="chips"></div>
<div class="dim">${escapeHtml(L.typeOptions)}</div>
<div class="legend mono" id="legend"></div>
<div id="main"><div><table class="mono"><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table>
<div id="moreRow"></div></div><div id="pv"><div id="pvTitle" class="mono"></div><pre id="pvText"></pre></div></div>
<div class="foot">
  <div id="msg" class="mono"></div>
  <div class="bar"><label>${escapeHtml(L.params)}</label><input class="cmd" id="cmd"><button class="primary" id="enter">${escapeHtml(L.enter)}</button></div>
  <div class="keys mono">${L.keys.map(([k, t]) => `<a data-key="${k}">${k}=${escapeHtml(t)}</a>`).join('')}</div>
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const L = ${JSON.stringify(L).replace(/</g, '\\u003c')};
let D = null, shown = 0, sort = null, sortDir = 1;
const opts = new Map();     // row key -> option typed
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE = 400;

function cols() {
  if (!D) return [];
  if (D.level === 'members') return [['name', L.name], ['type', L.type], ['text', L.text], ['changed', L.changed], ['size', L.size], ['obj', L.obj], ['lock', L.lock]];
  if (D.level === 'objects') return [['name', L.name], ['type', L.type], ['attribute', L.attribute], ['text', L.text], ['changed', L.changed], ['size', L.size]];
  return [['name', L.library], ['type', L.type], ['text', L.text]];
}
function rows() {
  const r = D ? D.rows.slice() : [];
  if (sort) r.sort((a, b) => (typeof a[sort] === 'number' && typeof b[sort] === 'number' ? a[sort] - b[sort] : String(a[sort]).localeCompare(String(b[sort]))) * sortDir);
  return r;
}
function render() {
  if (!D) return;
  $('title').textContent = L[D.level] + (D.level === 'members' ? ' — ' + D.library + '/' + D.file : D.level === 'objects' ? ' — ' + D.library : '');
  $('lib').value = D.library; $('file').value = D.file;
  $('fileBox').style.display = D.level === 'members' ? '' : 'none';
  $('sSinceL').style.display = D.level === 'libraries' ? 'none' : '';
  $('sType').parentElement.style.display = D.level === 'libraries' ? 'none' : '';
  $('sTextL').style.display = D.level === 'libraries' ? 'none' : '';
  const mem = D.level === 'members';
  $('ncBox').style.display = mem ? '' : 'none'; $('lkBox').style.display = mem ? '' : 'none'; $('pvBox').style.display = mem ? '' : 'none';
  if (!mem) document.body.classList.remove('pv'); else document.body.classList.toggle('pv', $('pvOn').checked);
  $('objLib').textContent = mem && D.objLib ? L.objIn + ' ' + D.objLib : '';
  $('sNeeds').checked = !!D.subset.needsCompile; $('sLocked').checked = !!D.subset.locked;
  const cur = (D.subset.type || '').toUpperCase();
  $('chips').innerHTML = D.level === 'libraries' || D.types.length < 2 ? '' : '<span class="dim">' + esc(L.types) + ':</span>' +
    '<span class="chip' + (cur ? '' : ' on') + '" data-chip="">' + esc(L.all) + ' ' + D.total + '</span>' +
    D.types.map(([t, n]) => '<span class="chip' + (cur === t.toUpperCase() ? ' on' : '') + '" data-chip="' + esc(t) + '">' + esc(t) + ' ' + n + '</span>').join('');
  Object.entries(D.retry || {}).forEach(([k, v]) => { if (v) opts.set(k, v); });
  $('sName').value = D.subset.name || ''; $('sType').value = D.subset.type || ''; $('sText').value = D.subset.text || ''; $('sSince').value = D.subset.since || '';
  $('crumb').innerHTML = '<a data-goto="libraries">' + esc(L.libs) + '</a>' +
    (D.level !== 'libraries' ? ' › <a data-goto="objects">' + esc(D.library) + '</a>' : '') + (D.level === 'members' ? ' › ' + esc(D.file) : '');
  const many = D.options.length > 9;
  $('legend').innerHTML = D.options.map((o, i) => '<span class="' + (many && i >= 9 ? 'more' : '') + '"><b>' + esc(o.code) + '</b>=' + esc(o.label) + '&nbsp;&nbsp; </span>').join('') +
    (D.user.length ? '<span>' + esc(L.user) + ': ' + D.user.map(u => '<b>' + esc(u) + '</b>').join(' ') + '</span>' : '');
  $('head').innerHTML = '<th>' + esc(L.opt) + '</th>' + cols().map(([k, t]) => '<th data-sort="' + k + '">' + esc(t) + (sort === k ? (sortDir > 0 ? ' ▲' : ' ▼') : '') + '</th>').join('') + '<th>' + esc(L.status) + '</th>';
  shown = 0; $('body').innerHTML = ''; more();
  $('msg').textContent = D.message || (D.rows.length + ' ' + L.of + ' ' + D.total);
  $('msg').className = 'mono ' + (/^✗|failed/.test(D.message) ? 'bad' : '');
}
function rowHtml(r) {
  const st = D.statuses[r.k] || '';
  return '<tr data-k="' + esc(r.k) + '"><td class="o"><input maxlength="2" value="' + esc(opts.get(r.k) || '') + '"></td>' +
    cols().map(([k]) => k === 'obj' ? objCell(r.obj) : '<td class="' + (k === 'text' ? 'x' : k === 'size' ? 'num' : k === 'lock' ? 'warn' : '') + '">' + esc(k === 'size' && r[k] !== '' ? Number(r[k]).toLocaleString() : r[k]) + '</td>').join('') +
    '<td class="' + (st.startsWith('✗') ? 'bad' : 'ok') + '">' + esc(st) + '</td></tr>';
}
function objCell(o) {
  if (o === 'stale') return '<td class="warn" title="' + esc(L.stale) + '">⚠ ' + esc(L.stale) + '</td>';
  if (o === 'none') return '<td class="dim">○ ' + esc(L.none) + '</td>';
  if (o === 'current') return '<td class="ok" title="' + esc(L.current) + '">✓</td>';
  return '<td></td>';
}
let pvKey = '';
function askPreview(tr) {
  if (!tr || !document.body.classList.contains('pv') || tr.dataset.k === pvKey) return;
  pvKey = tr.dataset.k; [...document.querySelectorAll('tr.sel')].forEach(x => x.classList.remove('sel')); tr.classList.add('sel');
  $('pvTitle').textContent = '…'; vscode.postMessage({ t: 'preview', k: pvKey });
}
function more() {
  const all = rows();
  if (!all.length) { $('body').innerHTML = '<tr><td></td><td colspan="9" class="dim">' + esc(L.empty) + '</td></tr>'; $('moreRow').innerHTML = ''; return; }
  const next = all.slice(shown, shown + PAGE);
  $('body').insertAdjacentHTML('beforeend', next.map(rowHtml).join(''));
  shown += next.length;
  $('moreRow').innerHTML = shown < all.length ? '<button id="moreBtn">' + esc(L.more) + ' (' + (all.length - shown) + ')</button>' : '';
}
function entries() { return [...opts.entries()].filter(([, o]) => o.trim()).map(([k, option]) => ({ k, option })); }
function enter() {
  const e = entries(), params = $('cmd').value;
  if (!e.length && !params.trim()) return;
  opts.clear(); $('cmd').value = '';
  vscode.postMessage({ t: 'enter', entries: e, params });
}
function subset() {
  vscode.postMessage({ t: 'subset', subset: { name: $('sName').value.trim(), type: $('sType').value.trim(), text: $('sText').value.trim(), since: $('sSince').value.trim(),
    needsCompile: $('sNeeds').checked, locked: $('sLocked').checked } });
}
function position() {
  const v = $('pos').value.trim().toUpperCase(); if (!v) return;
  const all = rows(); let i = all.findIndex(r => r.name.toUpperCase() >= v); if (i < 0) i = all.length - 1;
  while (shown <= i && shown < all.length) more();
  const tr = $('body').children[i]; if (tr) { tr.scrollIntoView({ block: 'center' }); tr.querySelector('input').focus(); }
}
function repeat() {
  // F13: copy the first option typed to every row below it.
  const trs = [...$('body').querySelectorAll('tr[data-k]')];
  const i = trs.findIndex(tr => tr.querySelector('input').value.trim());
  if (i < 0) return;
  const v = trs[i].querySelector('input').value.trim().toUpperCase();
  rows().slice(i).forEach(r => opts.set(r.k, v));
  trs.slice(i).forEach(tr => { tr.querySelector('input').value = v; });
}
document.addEventListener('input', e => {
  const tr = e.target.closest('tr[data-k]');
  if (tr && e.target.tagName === 'INPUT') { opts.set(tr.dataset.k, e.target.value.toUpperCase()); }
});
document.addEventListener('keydown', e => {
  const cell = e.target.closest && e.target.closest('td.o');
  if (cell && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    // Move between option fields like on a 5250 screen.
    e.preventDefault();
    const tr = e.key === 'ArrowDown' ? cell.parentElement.nextElementSibling : cell.parentElement.previousElementSibling;
    if (!tr && e.key === 'ArrowDown' && $('moreBtn')) { more(); }
    const next = tr || (e.key === 'ArrowDown' ? cell.parentElement.nextElementSibling : null);
    if (next && next.querySelector('input')) { next.querySelector('input').focus(); askPreview(next); }
    return;
  }
  if (e.key !== 'Enter') return;
  const id = e.target.id;
  e.preventDefault();
  if (id === 'pos') position();
  else if (['sName', 'sType', 'sText', 'sSince'].includes(id)) subset();
  else if (id === 'lib' || id === 'file') go();
  else enter();
});
function go() {
  const lib = $('lib').value.trim(), file = $('file').value.trim();
  if (D && D.level === 'members' && file) vscode.postMessage({ t: 'goto', level: 'members', library: lib, file });
  else if (lib) vscode.postMessage({ t: 'goto', level: 'objects', library: lib });
  else vscode.postMessage({ t: 'goto', level: 'libraries' });
}
document.addEventListener('click', e => {
  const t = e.target;
  if (t.id === 'enter') enter();
  else if (t.id === 'go') go();
  else if (t.id === 'moreBtn') more();
  else if (t.id === 'clear') { ['sName', 'sType', 'sText', 'sSince'].forEach(i => { $(i).value = ''; }); $('sNeeds').checked = false; $('sLocked').checked = false; subset(); }
  else if (t.id === 'sNeeds' || t.id === 'sLocked') subset();
  else if (t.id === 'pvOn') { document.body.classList.toggle('pv', t.checked); pvKey = ''; }
  else if (t.dataset.chip !== undefined) { $('sType').value = t.dataset.chip; subset(); }
  else if (t.closest('tr[data-k]') && t.tagName !== 'INPUT') askPreview(t.closest('tr[data-k]'));
  else if (t.dataset.key) vscode.postMessage({ t: 'key', key: t.dataset.key });
  else if (t.dataset.sort) { sortDir = sort === t.dataset.sort ? -sortDir : 1; sort = t.dataset.sort; render(); }
  else if (t.dataset.goto === 'libraries') vscode.postMessage({ t: 'goto', level: 'libraries' });
  else if (t.dataset.goto === 'objects') vscode.postMessage({ t: 'goto', level: 'objects', library: D.library });
});
document.addEventListener('dblclick', e => {
  const tr = e.target.closest('tr[data-k]');
  if (tr && e.target.tagName !== 'INPUT') vscode.postMessage({ t: 'open', k: tr.dataset.k });
});
window.addEventListener('message', ev => {
  const m = ev.data;
  if (m.t === 'data') { D = m; render(); const first = $('body').querySelector('input'); if (first) first.focus(); }
  else if (m.t === 'busy') document.body.classList.toggle('busy', !!m.on);
  else if (m.t === 'note') { $('msg').textContent = m.text; }
  else if (m.t === 'preview' && m.k === pvKey) { $('pvTitle').textContent = m.title; $('pvText').textContent = m.text; }
  else if (m.t === 'key') {
    if (m.key === 'F13') repeat();
    else if (m.key === 'F17') $('sName').focus();
    else if (m.key === 'F23') document.body.classList.toggle('more');
  }
});
vscode.postMessage({ t: 'ready' });
</script></body></html>`;
  }
}

async function ask(title: string, value: string, systemName = false): Promise<string | undefined> {
  const v = await vscode.window.showInputBox({
    title, value, ignoreFocusOut: true,
    validateInput: x => (!systemName || /^[A-Za-z$#@][A-Za-z0-9$#@_.]{0,9}$/.test(x.trim()) ? undefined : vscode.l10n.t('1–10 characters, starting with a letter, $, # or @.')),
  });
  return v?.trim() || undefined;
}

/** F16: add, change or remove user-defined options (saved in vanthrex.pdm.userOptions). */
async function editUserOptions(level: PdmLevel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('vanthrex');
  const all = userOptions();
  const items: (vscode.QuickPickItem & { code?: string })[] = [
    { label: vscode.l10n.t('$(add) Add an option…') },
    ...Object.entries(all).sort().map(([code, cmd]) => ({ label: code, description: cmd, code })),
  ];
  const pickd = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('User-defined options (F16)'),
    placeHolder: vscode.l10n.t('Variables: &L library, &F file, &N name, &T type, &A attribute, &O object library, &U user, &X text'),
  });
  if (!pickd) { return; }
  let code = pickd.code;
  if (!code) {
    code = (await vscode.window.showInputBox({ title: vscode.l10n.t('Option code (1 or 2 characters)'), ignoreFocusOut: true,
      validateInput: x => (validUserOptionCode(x, level) ? undefined : vscode.l10n.t('Use 1–2 letters or digits that are not a PDM option number here.')) }))?.trim().toUpperCase();
    if (!code) { return; }
  } else {
    const what = await vscode.window.showQuickPick([vscode.l10n.t('Change'), vscode.l10n.t('Remove')], { title: code });
    if (!what) { return; }
    if (what === vscode.l10n.t('Remove')) {
      const own = { ...(cfg.get<Record<string, string>>('pdm.userOptions', {}) ?? {}) };
      if (code in DEFAULT_USER_OPTIONS) { own[code] = ''; } else { delete own[code]; }
      await cfg.update('pdm.userOptions', own, vscode.ConfigurationTarget.Global);
      return;
    }
  }
  const cmd = await vscode.window.showInputBox({ title: vscode.l10n.t('Command for option {0}', code), value: all[code] ?? 'CRTBNDRPG PGM(&O/&N) SRCFILE(&L/&F) SRCMBR(&N)', ignoreFocusOut: true });
  if (cmd === undefined) { return; }
  const own = { ...(cfg.get<Record<string, string>>('pdm.userOptions', {}) ?? {}), [code]: cmd.trim() };
  await cfg.update('pdm.userOptions', own, vscode.ConfigurationTarget.Global);
}

/** What the PDM command was started on: a tree node, a parsed PDM command, or nothing (ask). */
async function target(manager: ConnectionManager, state: vscode.Memento, a?: unknown): Promise<PdmTarget | undefined> {
  const n = a as { kind?: string; library?: string; file?: string; name?: string; type?: string; level?: PdmLevel } | string | undefined;
  if (typeof n === 'string') { return parsePdmCommand(n); }
  if (n?.level) { return n as PdmTarget; }
  if (n?.kind === 'srcfile') { return { level: 'members', library: n.library, file: n.file }; }
  if (n?.kind === 'library') { return { level: 'objects', library: n.library }; }
  if (n?.kind === 'folder') { return { level: 'objects', library: n.library, type: (n as { folder?: string }).folder === 'source' ? 'PF-SRC' : undefined }; }
  if (n?.kind === 'object' && n.type === '*FILE') { return { level: 'members', library: n.library, file: n.name }; }
  manager.require();
  const recent = state.get<string[]>(RECENT_KEY, []);
  const items: (vscode.QuickPickItem & { t?: PdmTarget; ask?: PdmLevel })[] = [
    { label: vscode.l10n.t('$(list-tree) Libraries in my library list'), description: 'WRKLIBPDM', t: { level: 'libraries' } },
    { label: vscode.l10n.t('$(file-code) Work with members…'), description: 'WRKMBRPDM', ask: 'members' },
    { label: vscode.l10n.t('$(package) Work with objects…'), description: 'WRKOBJPDM', ask: 'objects' },
    { label: vscode.l10n.t('$(search) Find libraries…'), description: 'WRKLIBPDM LIB(A*)', ask: 'libraries' },
    ...(recent.length ? [{ label: vscode.l10n.t('Recent'), kind: vscode.QuickPickItemKind.Separator }] : []),
    ...recent.map(r => ({ label: vscode.l10n.t('$(history) {0}', r), t: parsePdmCommand(r) })),
  ];
  const p = await vscode.window.showQuickPick(items, { title: 'PDM', placeHolder: vscode.l10n.t('Pick, or type a PDM command such as WRKMBRPDM FILE(MYLIB/QRPGLESRC)') });
  if (!p) { return undefined; }
  if (p.t) { return p.t; }
  const v = await vscode.window.showInputBox({
    title: p.description, ignoreFocusOut: true,
    prompt: p.ask === 'members' ? vscode.l10n.t('LIBRARY/FILE (or just FILE for the library list)') : p.ask === 'objects' ? vscode.l10n.t('Library') : vscode.l10n.t('Generic name, e.g. APP* (or *ALLUSR)'),
  });
  if (!v?.trim()) { return undefined; }
  const x = v.trim().toUpperCase();
  if (p.ask === 'members') { const [l, f] = x.includes('/') ? x.split('/') : ['*LIBL', x]; return { level: 'members', library: l, file: f }; }
  if (p.ask === 'objects') { return { level: 'objects', library: x }; }
  return { level: 'libraries', name: x };
}

export function registerPdm(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A) => {
    try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.pdm', guard(async (a?: unknown) => {
      const t = await target(manager, context.globalState, a);
      if (!t) { return; }
      await PdmPanel.show(manager, context.globalState, context.globalStorageUri).go(t, true);
    })),
    vscode.commands.registerCommand('vanthrex.pdm.key', guard(async (key?: string) => { if (PdmPanel.current && key) { await PdmPanel.current.key2(key); } })),
    vscode.commands.registerCommand('vanthrex.pdm.userOptions', guard(() => editUserOptions('members'))),
  );
}

/** For the CL runner: open PDM when someone types WRKMBRPDM / WRKOBJPDM / WRKLIBPDM / STRPDM. */
export function isPdmCommand(cmd: string): boolean { return !!parsePdmCommand(cmd); }
