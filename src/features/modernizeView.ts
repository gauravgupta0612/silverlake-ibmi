// Modernization and editing aids: an SQL procedure / function over a program, DDS to SQL DDL, CRUD statements of a
// table, Expand SELECT *, Extract to a named constant, change-log entries, a clickable flowchart of a procedure, and
// matching IF / ELSE / ENDIF keywords highlighted in RPG and CL.
import * as os from 'os';
import * as vscode from 'vscode';
import { blockGroups, flowGraph, layoutFlow, matchingLines, scopes, scopeText, toMermaidFlow, FlowGraph } from '../core/flow';
import { changeLogEntry, constantInsertLine, constantName, crudSql, ddsToSql, entryPoints, starAt, wrapperSql, WrapParam } from '../core/modernize';
import { describeParm, programParameters } from '../core/programCall';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';
import { assertSystemName, sqlString } from '../core/util';
import { escapeHtml, nonce, page } from './ui/kit';

type Row = Record<string, unknown>;
const RPG_CL = [{ language: 'rpgle' }, { language: 'cl' }];
const memberName = (doc: vscode.TextDocument) => (doc.uri.path.split('/').pop() ?? 'SOURCE').replace(/\.[^.]*$/, '').toUpperCase();
const isFixedRpg = (doc: vscode.TextDocument) => doc.languageId === 'rpgle' && !/^\s*\*\*free/i.test(doc.lineAt(0).text);

// ---------------------------------------------------------------- SQL procedure over a program

async function sqlWrapper(manager: ConnectionManager): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || !['rpgle', 'cl'].includes(doc.languageId)) { vscode.window.showInformationMessage(vscode.l10n.t('Open the RPG or CL source of the program first.')); return; }
  const text = doc.getText();
  type Entry = { name: string; kind: 'program' | 'procedure'; params: WrapParam[]; returns?: string };
  let entries: Entry[] = doc.languageId === 'rpgle' ? entryPoints(text) : [];
  if (!entries.some(e => e.kind === 'program')) {
    const parms = programParameters(text, doc.languageId === 'cl' ? 'CLLE' : 'RPGLE');
    if (parms.length || doc.languageId === 'cl') { entries = [{ name: '', kind: 'program', params: parms.map(p => ({ name: p.name.replace(/^&/, ''), type: describeParm(p), mode: p.constant ? 'IN' : 'INOUT' })) }, ...entries]; }
  }
  if (!entries.length) { vscode.window.showWarningMessage(vscode.l10n.t('No program entry (dcl-pi, *ENTRY PLIST, PGM PARM) and no exported procedure found in this source.')); return; }
  const pick = entries.length === 1 ? entries[0] : await vscode.window.showQuickPick(entries.map(e => ({ label: e.kind === 'program' ? vscode.l10n.t('$(symbol-module) The program ({0} parameter(s))', e.params.length) : `$(symbol-method) ${e.name}`,
    description: e.kind === 'procedure' ? vscode.l10n.t('exported procedure{0}', e.returns ? ` → ${e.returns}` : '') : undefined, e })), { title: vscode.l10n.t('Make which entry callable from SQL?') }).then(p => p?.e);
  if (!pick) { return; }
  const conn = manager.connection;
  const lib = await vscode.window.showInputBox({ title: vscode.l10n.t('Library of the program object'), value: conn?.profile.currentLibrary ?? '', ignoreFocusOut: true });
  if (!lib?.trim()) { return; }
  const object = await vscode.window.showInputBox({ title: pick.kind === 'procedure' ? vscode.l10n.t('Service program that exports {0}', pick.name) : vscode.l10n.t('Program name'), value: memberName(doc).slice(0, 10), ignoreFocusOut: true });
  if (!object?.trim()) { return; }
  const name = (await vscode.window.showInputBox({ title: vscode.l10n.t('SQL name of the procedure'), value: (pick.kind === 'procedure' ? pick.name : object).toUpperCase(), ignoreFocusOut: true }))?.trim().toUpperCase();
  if (!name) { return; }
  const library = assertSystemName(lib.trim(), 'library');
  const r = wrapperSql({ schema: library, name, library, object: assertSystemName(object.trim(), 'object'), procedure: pick.kind === 'procedure' ? pick.name : undefined,
    language: doc.languageId === 'cl' ? 'CL' : 'RPGLE', params: pick.params, returns: pick.returns });
  const head = r.unknown.length ? `-- ${vscode.l10n.t('Check these parameters: their SQL type could not be decided ({0}). A data structure is passed as CHAR of its length.', r.unknown.join('; '))}\n` : '';
  const out = await vscode.workspace.openTextDocument({ language: 'sql', content: head + r.sql });
  await vscode.window.showTextDocument(out, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

// ---------------------------------------------------------------- DDS → SQL

async function ddsToSqlCommand(manager: ConnectionManager): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || (doc.languageId !== 'dds' && !/\.(pf|lf)$/i.test(doc.uri.path))) { vscode.window.showInformationMessage(vscode.l10n.t('Open the DDS source of a physical or logical file first.')); return; }
  const lib = await vscode.window.showInputBox({ title: vscode.l10n.t('Library of the SQL table'), value: manager.connection?.profile.currentLibrary ?? '', ignoreFocusOut: true });
  if (!lib?.trim()) { return; }
  const r = ddsToSql(doc.getText(), assertSystemName(lib.trim(), 'library'), memberName(doc).slice(0, 10));
  const out = await vscode.workspace.openTextDocument({ language: 'sql', content: r.notes.map(x => `-- ${x}`).join('\n') + '\n\n' + r.sql });
  await vscode.window.showTextDocument(out, { viewColumn: vscode.ViewColumn.Beside, preview: false });
}

// ---------------------------------------------------------------- CRUD statements

async function tableArg(a: unknown, title: string): Promise<{ library: string; name: string } | undefined> {
  const o = a as { library?: string; name?: string } | undefined;
  let lib = o?.library; let name = o?.name;
  if (!lib || !name) {
    const v = await vscode.window.showInputBox({ title, prompt: 'LIBRARY/TABLE', ignoreFocusOut: true, validateInput: x => (/^[^/\s]+\/[^/\s]+$/.test(x.trim()) ? undefined : 'LIBRARY/TABLE') });
    if (!v) { return undefined; }
    [lib, name] = v.trim().toUpperCase().split('/');
  }
  return { library: assertSystemName(lib, 'library'), name: assertSystemName(name, 'table') };
}

export async function tableColumns(manager: ConnectionManager, lib: string, name: string, system = true): Promise<{ table: string; cols: { name: string; type: string; length: number; scale: number; nullable: boolean; identity: boolean; generated: boolean }[] }> {
  const where = system ? `SYSTEM_TABLE_SCHEMA = ${sqlString(lib)} AND SYSTEM_TABLE_NAME = ${sqlString(name)}` : `TABLE_SCHEMA = ${sqlString(lib)} AND TABLE_NAME = ${sqlString(name)}`;
  const rows = await manager.require().rows<Row>(`SELECT TABLE_SCHEMA AS TS, TABLE_NAME AS TN, COLUMN_NAME AS N, DATA_TYPE AS T, LENGTH AS L, COALESCE(NUMERIC_SCALE, 0) AS S, IS_NULLABLE AS NL, ` +
    `COALESCE(IS_IDENTITY, 'NO') AS ID, COALESCE(HAS_DEFAULT, 'N') AS D FROM QSYS2.SYSCOLUMNS WHERE ${where} ORDER BY ORDINAL_POSITION`, 5000);
  if (!rows.length) { throw new Error(vscode.l10n.t('{0}/{1} was not found.', lib, name)); }
  const q = (x: string) => (/^[A-Z$#@_][A-Z0-9$#@_]*$/.test(x) ? x : `"${x.replace(/"/g, '""')}"`);
  return { table: `${q(String(rows[0].TS).trim())}.${q(String(rows[0].TN).trim())}`,
    cols: rows.map(r => ({ name: q(String(r.N).trim()), type: String(r.T).trim(), length: Number(r.L) || 0, scale: Number(r.S) || 0, nullable: String(r.NL).trim() === 'Y', identity: String(r.ID).trim() === 'YES', generated: /^[AEFIJ]$/.test(String(r.D).trim()) })) };
}

export async function primaryKey(manager: ConnectionManager, table: string): Promise<string[]> {
  const [schema, name] = table.split('.').map(x => x.replace(/^"|"$/g, ''));
  const rows = await manager.require().rows<Row>(`SELECT K.COLUMN_NAME AS C, C.CONSTRAINT_TYPE AS T FROM QSYS2.SYSCST C JOIN QSYS2.SYSKEYCST K ON K.CONSTRAINT_SCHEMA = C.CONSTRAINT_SCHEMA AND K.CONSTRAINT_NAME = C.CONSTRAINT_NAME ` +
    `WHERE C.TABLE_SCHEMA = ${sqlString(schema)} AND C.TABLE_NAME = ${sqlString(name)} AND C.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE') ORDER BY CASE C.CONSTRAINT_TYPE WHEN 'PRIMARY KEY' THEN 0 ELSE 1 END, C.CONSTRAINT_NAME, K.ORDINAL_POSITION`, 200).catch(() => [] as Row[]);
  const first = rows.filter(r => String(r.T) === String(rows[0]?.T));
  return first.map(r => String(r.C).trim());
}

async function crudCommand(manager: ConnectionManager, a?: unknown): Promise<void> {
  const t = await tableArg(a, vscode.l10n.t('SQL statements for which table?'));
  if (!t) { return; }
  const { table, cols } = await tableColumns(manager, t.library, t.name);
  const keys = await primaryKey(manager, table);
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: crudSql(table, cols, keys) });
  await vscode.window.showTextDocument(doc, { preview: false });
}

// ---------------------------------------------------------------- Expand SELECT *

async function expandStar(manager: ConnectionManager, uri: vscode.Uri, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  // The statement around the line: from a line with SELECT up to the line with FROM.
  let from = line; while (from > 0 && !/\bselect\b/i.test(doc.lineAt(from).text)) { from--; }
  let to = line; while (to < doc.lineCount - 1 && !/\bfrom\b/i.test(doc.lineAt(to).text) && to - from < 20) { to++; }
  const range = new vscode.Range(from, 0, to, doc.lineAt(to).text.length);
  const text = doc.getText(range);
  const star = starAt(text);
  if (!star?.table) { vscode.window.showInformationMessage(vscode.l10n.t('No SELECT * FROM table found here.')); return; }
  const parts = star.table.replace(/"/g, '').toUpperCase().split(/[./]/);
  const conn = manager.require();
  let lib = parts.length > 1 ? parts[0] : '';
  const name = parts[parts.length - 1];
  if (!lib) {
    const r = await conn.rows<Row>(`SELECT T.TABLE_SCHEMA AS S FROM QSYS2.SYSTABLES T JOIN QSYS2.LIBRARY_LIST_INFO L ON L.SCHEMA_NAME = T.TABLE_SCHEMA WHERE T.TABLE_NAME = ${sqlString(name)} ORDER BY L.ORDINAL_POSITION FETCH FIRST 1 ROW ONLY`, 1);
    lib = String(r[0]?.S ?? conn.profile.currentLibrary ?? '').trim();
    if (!lib) { throw new Error(vscode.l10n.t('{0} is not in the library list: qualify it with its library.', name)); }
  }
  const { cols } = await tableColumns(manager, lib, name, false).catch(() => tableColumns(manager, lib, name, true));
  const indent = ' '.repeat(Math.max(0, text.slice(0, star.start).split('\n').pop()!.length));
  const list = cols.map(c => c.name).join(`,\n${indent}`);
  const edit = new vscode.WorkspaceEdit();
  const pos = doc.positionAt(doc.offsetAt(range.start) + star.start);
  edit.replace(uri, new vscode.Range(pos, pos.translate(0, 1)), list);
  await vscode.workspace.applyEdit(edit);
}

// ---------------------------------------------------------------- Extract to constant

async function extractConstant(uri: vscode.Uri, range: vscode.Range): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const literal = doc.getText(range);
  const taken = new Set([...doc.getText().matchAll(/\bdcl-[csf]\s+([\w$#@]+)/gi)].map(m => m[1].toUpperCase()));
  const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Name of the constant'), value: constantName(literal, taken), validateInput: v => (/^[A-Za-z$#@_][\w$#@]*$/.test(v.trim()) ? taken.has(v.trim().toUpperCase()) ? vscode.l10n.t('{0} is already declared.', v.trim()) : undefined : vscode.l10n.t('Not a valid RPG name.')) });
  if (!name) { return; }
  const at = constantInsertLine(doc.getText());
  const full = doc.getText();
  const count = full.split(literal).length - 1;
  let all = false;
  if (count > 1) {
    const every = vscode.l10n.t('Replace all {0}', count); const one = vscode.l10n.t('Only this one');
    const c = await vscode.window.showQuickPick([every, one], { title: vscode.l10n.t('{0} appears {1} times', literal, count) });
    if (!c) { return; }
    all = c === every;
  }
  const edit = new vscode.WorkspaceEdit();
  if (all) {
    for (let i = 0; i < doc.lineCount; i++) {
      const l = doc.lineAt(i).text; let p = l.indexOf(literal);
      while (p >= 0) { if (!/^\s*dcl-c\b/i.test(l) && !l.slice(0, p).includes('//')) { edit.replace(uri, new vscode.Range(i, p, i, p + literal.length), name.trim()); } p = l.indexOf(literal, p + literal.length); }
    }
  } else { edit.replace(uri, range, name.trim()); }
  edit.insert(uri, new vscode.Position(at, 0), `${isFixedRpg(doc) ? '       ' : ''}dcl-c ${name.trim()} ${literal};\n`);
  await vscode.workspace.applyEdit(edit);
}

// ---------------------------------------------------------------- change log

async function changeLog(manager: ConnectionManager): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return; }
  const cfg = vscode.workspace.getConfiguration('vanthrex.editor');
  const template = cfg.get<string>('changeLogTemplate', '{date} {user} {ticket} {text}').replace(/\\n/g, '\n');
  const ticket = template.includes('{ticket}') ? await vscode.window.showInputBox({ title: vscode.l10n.t('Ticket or change request (optional)'), ignoreFocusOut: true }) : '';
  if (ticket === undefined) { return; }
  const text = await vscode.window.showInputBox({ title: vscode.l10n.t('What changed?'), ignoreFocusOut: true });
  if (text === undefined) { return; }
  const user = cfg.get<string>('changeLogUser', '') || manager.connection?.user || os.userInfo().username;
  const entry = changeLogEntry(template, { date: new Date().toISOString().slice(0, 10), user, ticket: ticket.trim(), text: text.trim() }, ed.document.languageId, isFixedRpg(ed.document));
  // After **FREE / the first comment block, or where the cursor is when the source has no header comments.
  const doc = ed.document;
  let at = /^\s*\*\*free/i.test(doc.lineAt(0).text) ? 1 : 0;
  const isComment = (l: string) => /^\s*(\/\/|--)/.test(l) || /^.{5}[ A-Za-z]?\*/.test(l) || /^\s*\/\*/.test(l);
  while (at < doc.lineCount && isComment(doc.lineAt(at).text)) { at++; }
  await ed.edit(e => e.insert(new vscode.Position(at, 0), entry + '\n'));
}

// ---------------------------------------------------------------- flowchart

export function flowSvg(g: FlowGraph): string {
  const l = layoutFlow(g);
  const kind = new Map(g.nodes.map(n => [n.id, n]));
  const shape = (b: { x: number; y: number; w: number; h: number }, k: string) => {
    const { x, y, w, h } = b;
    if (k === 'decision') { return `<polygon class="shape dec" points="${x + 14},${y} ${x + w - 14},${y} ${x + w},${y + h / 2} ${x + w - 14},${y + h} ${x + 14},${y + h} ${x},${y + h / 2}"/>`; }
    if (k === 'loop') { return `<rect class="shape loop" x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/><rect class="loopbar" x="${x}" y="${y}" width="6" height="${h}"/>`; }
    if (k === 'monitor' || k === 'handler') { return `<polygon class="shape mon" points="${x + 10},${y} ${x + w},${y} ${x + w - 10},${y + h} ${x},${y + h}"/>`; }
    if (k === 'start' || k === 'end' || k === 'return') { return `<rect class="shape term" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`; }
    return `<rect class="shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>`;
  };
  const boxes = l.boxes.map(b => {
    const n = kind.get(b.id)!;
    const ty = b.y + b.h / 2 - ((b.lines.length - 1) * 16) / 2 + 4;
    return `<g class="node ${n.line !== undefined ? 'link' : ''}" data-line="${n.line ?? ''}">${shape(b, n.kind)}${b.lines.map((t, i) => `<text x="${b.x + b.w / 2}" y="${ty + i * 16}" text-anchor="middle">${escapeHtml(t)}</text>`).join('')}<title>${escapeHtml(n.text.join('\n'))}${n.line !== undefined ? ` — line ${n.line + 1}` : ''}</title></g>`;
  }).join('');
  const edges = l.edges.map(e => {
    const d = 'M' + e.points.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
    // The label sits on the last vertical piece, just above the arrow: edges leaving the same box end in different places.
    const end = e.points[e.points.length - 1];
    const lx = e.back ? e.points[2][0] + 4 : end[0] + 5; const ly = e.back ? e.points[2][1] - 4 : end[1] - 6;
    return `<path class="edge${e.back ? ' back' : ''}${e.error ? ' err' : ''}" d="${d}" marker-end="url(#arr)"/>${e.label && e.label !== 'repeat' ? `<text class="lbl" x="${lx}" y="${ly}">${escapeHtml(e.label)}</text>` : ''}`;
  }).join('');
  return `<svg id="fc" xmlns="http://www.w3.org/2000/svg" width="${l.width}" height="${l.height}" viewBox="0 0 ${l.width} ${l.height}">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker></defs>${edges}${boxes}</svg>`;
}

const FLOW_CSS = `
 #wrap { overflow: auto; border: 1px solid var(--vscode-editorWidget-border, #8883); border-radius: 6px; height: calc(100vh - 64px); }
 svg { transform-origin: 0 0; font-family: var(--vscode-editor-font-family); font-size: 12px; }
 .shape { fill: var(--vscode-editor-background); stroke: var(--vscode-editorWidget-border, #888); stroke-width: 1.2; }
 .dec { stroke: var(--vscode-charts-orange, #d18616); } .loop { stroke: var(--vscode-charts-purple, #b180d7); } .loopbar { fill: var(--vscode-charts-purple, #b180d7); }
 .mon { stroke: var(--vscode-charts-red, #f14c4c); } .term { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-charts-green, #89d185); }
 text { fill: var(--vscode-foreground); } .lbl { fill: var(--vscode-descriptionForeground); font-size: 11px; }
 .edge { fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 1.3; } .edge.back { stroke: var(--vscode-charts-purple, #b180d7); stroke-dasharray: 4 3; }
 .edge.err { stroke: var(--vscode-charts-red, #f14c4c); stroke-dasharray: 3 3; } .arrow { fill: var(--vscode-descriptionForeground); }
 .node.link { cursor: pointer; } .node.link:hover .shape { stroke-width: 2.4; }`;

async function flowchartCommand(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const doc = ed?.document;
  if (!doc || !['rpgle', 'cl'].includes(doc.languageId)) { vscode.window.showInformationMessage(vscode.l10n.t('Open an RPG or CL source first.')); return; }
  const text = doc.getText();
  let scope = '*MAIN';
  if (doc.languageId === 'rpgle') {
    const all = scopes(text);
    // The procedure or subroutine the cursor is in comes first.
    const cursor = ed!.selection.active.line;
    const inside = all.filter(s => text.split(/\r?\n/).slice(0, cursor + 1).some(l => new RegExp(`^\\s*(dcl-proc|begsr)\\s+${s.name.replace(/[$#@]/g, '\\$&')}\\b`, 'i').test(l) || (l.toUpperCase().slice(6, 21).trim() === s.name && /^.{5}P/i.test(l)))).pop();
    if (all.length) {
      const items = [{ label: vscode.l10n.t('$(symbol-namespace) Main line'), id: '*MAIN' }, ...all.map(s => ({ label: `${s.kind === 'procedure' ? '$(symbol-method)' : '$(symbol-event)'} ${s.name}`, description: s.kind === 'procedure' ? vscode.l10n.t('procedure') : vscode.l10n.t('subroutine'), id: s.name }))];
      if (inside) { items.sort((a, b) => Number(b.id === inside.name) - Number(a.id === inside.name)); }
      const p = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Flowchart of which part?') });
      if (!p) { return; }
      scope = p.id;
    }
  }
  const title = scope === '*MAIN' ? memberName(doc) : scope;
  const g = flowGraph(scopeText(text, scope, doc.languageId), doc.languageId, title);
  if (g.nodes.length <= 2) { vscode.window.showInformationMessage(vscode.l10n.t('No statements found in {0}.', title)); return; }
  const panel = vscode.window.createWebviewPanel('vanthrex.flowchart', vscode.l10n.t('Flowchart — {0}', title), vscode.ViewColumn.Beside, { enableScripts: true });
  const n = nonce();
  panel.webview.html = page({ nonce: n, title, css: FLOW_CSS, body: `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap"><strong>${escapeHtml(title)}</strong>
<span class="vx-muted">${escapeHtml(vscode.l10n.t('{0} boxes · click a box to go to its line · Ctrl+wheel to zoom', g.nodes.length))}</span>
<button class="vx-btn" id="zi">+</button><button class="vx-btn" id="zo">−</button><button class="vx-btn" id="mer">${escapeHtml(vscode.l10n.t('Copy as Mermaid'))}</button></div><div id="wrap">${flowSvg(g)}</div>`,
  script: `const api = acquireVsCodeApi(); let z = 1; const svg = document.getElementById('fc');
const zoom = f => { z = Math.min(3, Math.max(.2, z * f)); svg.style.transform = 'scale(' + z + ')'; };
document.getElementById('zi').onclick = () => zoom(1.2); document.getElementById('zo').onclick = () => zoom(1 / 1.2);
document.getElementById('wrap').addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
document.getElementById('mer').onclick = () => api.postMessage({ type: 'mermaid' });
svg.addEventListener('click', e => { const g = e.target.closest('.node.link'); if (g && g.dataset.line !== '') { api.postMessage({ type: 'line', line: Number(g.dataset.line) }); } });` });
  panel.webview.onDidReceiveMessage(async m => {
    if (m?.type === 'line' && Number.isInteger(m.line)) {
      const e = await vscode.window.showTextDocument(doc, { viewColumn: ed?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false });
      const pos = new vscode.Position(Math.min(m.line, doc.lineCount - 1), 0);
      e.selection = new vscode.Selection(pos, pos); e.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
    if (m?.type === 'mermaid') { await vscode.env.clipboard.writeText('```mermaid\n' + toMermaidFlow(g) + '```\n'); vscode.window.setStatusBarMessage(vscode.l10n.t('Mermaid flowchart copied.'), 4000); }
  });
}

// ---------------------------------------------------------------- matching blocks

const cache = new WeakMap<vscode.TextDocument, { version: number; groups: { lines: number[] }[] }>();
function groupsOf(doc: vscode.TextDocument) {
  const c = cache.get(doc);
  if (c && c.version === doc.version) { return c.groups; }
  const groups = blockGroups(doc.getText(), doc.languageId);
  cache.set(doc, { version: doc.version, groups });
  return groups;
}
const keywordRange = (doc: vscode.TextDocument, line: number) => {
  const t = doc.lineAt(line).text;
  if (doc.languageId === 'rpgle' && /^.{5}[Cc]/.test(t) && t.slice(25, 35).trim()) { const s = 25 + (t.slice(25, 35).length - t.slice(25, 35).trimStart().length); return new vscode.Range(line, s, line, s + t.slice(25, 35).trim().length); }
  const m = /^(\s*(?:[A-Z_][\w]*:\s*)?)([A-Za-z-]+)/.exec(doc.languageId === 'rpgle' && !/^\s*\*\*free/i.test(doc.lineAt(0).text) ? t.slice(0, 80).replace(/^.{7}/, '       ') : t);
  return m ? new vscode.Range(line, m[1].length, line, m[1].length + m[2].length) : doc.lineAt(line).range;
};

export function registerModernize(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void> | void) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.sqlWrapper', wrap(() => sqlWrapper(manager))),
    vscode.commands.registerCommand('vanthrex.ddsToSql', wrap(() => ddsToSqlCommand(manager))),
    vscode.commands.registerCommand('vanthrex.crudSql', wrap((a?: unknown) => crudCommand(manager, a))),
    vscode.commands.registerCommand('vanthrex.expandStar', wrap((uri: vscode.Uri, line: number) => expandStar(manager, uri, line))),
    vscode.commands.registerCommand('vanthrex.extractConstant', wrap((uri?: vscode.Uri, range?: vscode.Range) => {
      const ed = vscode.window.activeTextEditor;
      if (uri && range) { return extractConstant(uri, range); }
      if (ed && !ed.selection.isEmpty) { return extractConstant(ed.document.uri, ed.selection); }
      vscode.window.showInformationMessage(vscode.l10n.t('Select a literal (a quoted text or a number) first.'));
    })),
    vscode.commands.registerCommand('vanthrex.changeLogEntry', wrap(() => changeLog(manager))),
    vscode.commands.registerCommand('vanthrex.flowchart', wrap(flowchartCommand)),
    vscode.commands.registerCommand('vanthrex.gotoMatchingBlock', wrap(() => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || !['rpgle', 'cl'].includes(ed.document.languageId)) { return; }
      const lines = matchingLines(ed.document.getText(), ed.document.languageId, ed.selection.active.line);
      if (lines.length < 2) { vscode.window.setStatusBarMessage(vscode.l10n.t('The cursor is not on IF, ELSE, DO, WHEN, MONITOR or their END.'), 3000); return; }
      const next = lines.find(l => l > ed.selection.active.line) ?? lines[0];
      const pos = new vscode.Position(next, keywordRange(ed.document, next).start.character);
      ed.selection = new vscode.Selection(pos, pos); ed.revealRange(new vscode.Range(pos, pos));
    })),
    vscode.languages.registerDocumentHighlightProvider(RPG_CL, {
      provideDocumentHighlights(doc, pos) {
        if (!vscode.workspace.getConfiguration('vanthrex.editor').get<boolean>('matchBlocks', true)) { return []; }
        const k = keywordRange(doc, pos.line);
        if (!k.contains(pos)) { return []; }
        const g = groupsOf(doc).filter(x => x.lines.includes(pos.line)).sort((a, b) => b.lines[0] - a.lines[0])[0];
        return g && g.lines.length > 1 ? g.lines.map(l => new vscode.DocumentHighlight(keywordRange(doc, l), vscode.DocumentHighlightKind.Text)) : [];
      },
    }),
    vscode.languages.registerCodeActionsProvider([{ language: 'sql' }, { language: 'rpgle' }], {
      provideCodeActions(doc, range) {
        const out: vscode.CodeAction[] = [];
        const line = doc.lineAt(range.start.line).text;
        if (/\bselect\s+(distinct\s+)?\*\s*($|from\b)/i.test(line) && manager.connection) {
          const a = new vscode.CodeAction(vscode.l10n.t('Expand SELECT * into the column list'), vscode.CodeActionKind.RefactorRewrite);
          a.command = { command: 'vanthrex.expandStar', title: '', arguments: [doc.uri, range.start.line] };
          out.push(a);
        }
        if (doc.languageId === 'rpgle') {
          const lit = range.isEmpty ? undefined : doc.getText(range);
          if (lit && (/^'([^']|'')*'$/.test(lit) || /^-?\d+(\.\d+)?$/.test(lit))) {
            const a = new vscode.CodeAction(vscode.l10n.t('Extract to a named constant (DCL-C)'), vscode.CodeActionKind.RefactorExtract);
            a.command = { command: 'vanthrex.extractConstant', title: '', arguments: [doc.uri, range] };
            out.push(a);
          }
        }
        return out;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite, vscode.CodeActionKind.RefactorExtract] }),
  );
}
