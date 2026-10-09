import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError, showLog } from '../core/log';
import { assertSystemName, isValidSystemName, sqlString } from '../core/util';
import {
  CallGraph, DYNAMIC_TYPE, Direction, DynamicRef, GraphNode, NODE_H, NODE_W, PgmRef, addDynamicCalls, buildCallGraph, impactSummary, layoutGraph, toMermaid,
} from '../core/callGraph';
import { findDynamicCalls } from '../rpg/callScan';
import { SourceReader, SourceRef, eachLimited, languageOf, openSourceAtLine, sourceLabel, sourcesOfPrograms } from './sourceScan';
import { escapeHtml, nonce } from './webviewUtil';

type ObjArg = { library: string; name: string; type?: string; text?: string };

export interface Scope {
  key: string; profileId: string; system: string; libs: string[]; refs: PgmRef[]; at: Date;
  /** Dynamic calls found by scanning program sources (key LIB/NAME), and the programs already scanned. */
  dynamic?: Map<string, DynamicRef[]>; scanned?: Set<string>; sources?: Map<string, SourceRef>; notScanned?: number;
}

/** At most this many programs are scanned for dynamic calls at a time. */
const MAX_DYNAMIC_SCAN = 150;
const scopes = new Map<string, Scope>();

function s(r: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) { const v = r[n]; if (v !== null && v !== undefined && String(v).trim()) { return String(v).trim(); } }
  return '';
}

/** IBM-supplied objects (QCMDEXC, QSYSPRT…) that would only clutter the graph. */
function isSystemRef(r: PgmRef): boolean {
  const lib = r.refLib.toUpperCase();
  return /^Q/.test(r.refName) && (lib === '' || lib === '*LIBL' || lib.startsWith('QSYS') || lib === 'QGPL');
}

/** Build (or reuse) the cross-reference of every program in the given libraries. */
export async function crossReference(conn: IbmiConnection, libs: string[], refresh: boolean): Promise<Scope> {
  const key = `${conn.profile.id}:${libs.join(',')}`;
  const cached = scopes.get(key);
  if (cached && !refresh) { return cached; }
  await conn.sql('VALUES 1', 1);
  if (!conn.sqlKeepsJob) {
    throw new Error('The call graph needs the Mapepire SQL engine (it builds a cross-reference in QTEMP). Change the SQL engine in the connection settings.');
  }
  const hideSystem = vscode.workspace.getConfiguration('vanthrex').get<boolean>('callGraph.hideSystemObjects', true);
  const refs = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Building the program cross-reference…' },
    async progress => {
      let first = true;
      for (const lib of libs) {
        progress.report({ message: lib });
        const cmd = `DSPPGMREF PGM(${lib}/*ALL) OUTPUT(*OUTFILE) OBJTYPE(*ALL) OUTFILE(QTEMP/SLKCGREF) OUTMBR(*FIRST ${first ? '*REPLACE' : '*ADD'})`;
        try { await conn.sql(`CALL QSYS2.QCMDEXC(${sqlString(cmd)})`, 1); first = false; }
        catch (e) { log(`DSPPGMREF ${lib}: ${errorMessage(e)}`); }
      }
      if (first) { throw new Error('Could not build the cross-reference (DSPPGMREF failed for every library). See the log for details.'); }
      const rows = await conn.rows<Record<string, unknown>>('SELECT * FROM QTEMP/SLKCGREF', 500000);
      return rows.map(r => ({
        lib: s(r, 'WHLIB'), pgm: s(r, 'WHPNAM'), pgmType: s(r, 'WHSPKG', 'WHOBJT'), text: s(r, 'WHTEXT'),
        refLib: s(r, 'WHLNAM'), refName: s(r, 'WHFNAM'), refType: s(r, 'WHOTYP'), usage: Number(s(r, 'WHFUSG')) || undefined,
      })).filter(r => r.pgm && r.refName && !r.refName.startsWith('*') && !(hideSystem && isSystemRef(r)));
    });
  const scope: Scope = { key, profileId: conn.profile.id, system: conn.profile.name, libs, refs, at: new Date() };
  scopes.set(key, scope);
  log(`Cross-reference for ${libs.join(', ')}: ${refs.length} references`);
  return scope;
}

export async function pickLibraries(conn: IbmiConnection, root: ObjArg): Promise<string[] | undefined> {
  const libl = [...new Set([conn.profile.currentLibrary, ...conn.profile.libraries, root.library].filter(Boolean) as string[])].map(l => l.toUpperCase());
  const pick = await vscode.window.showQuickPick([
    { label: '$(library) My library list', detail: libl.join(', '), value: 'libl' },
    { label: `$(folder) Only ${root.library}`, value: 'one' },
    { label: '$(edit) These libraries…', value: 'custom' },
  ], { title: `${root.library}/${root.name} — which libraries hold the programs to analyse?` });
  if (!pick) { return undefined; }
  if (pick.value === 'libl') { return libl; }
  if (pick.value === 'one') { return [root.library]; }
  const v = await vscode.window.showInputBox({ title: 'Libraries', prompt: 'Library names separated by commas or spaces', value: libl.join(', '), ignoreFocusOut: true });
  const libs = (v ?? '').toUpperCase().split(/[\s,]+/).filter(Boolean);
  for (const l of libs) { if (!isValidSystemName(l)) { throw new Error(`"${l}" is not a valid library name.`); } }
  return libs.length ? libs : undefined;
}

const COLORS: Record<string, string> = {
  '*PGM': 'var(--vscode-charts-blue, #3794ff)', '*SRVPGM': 'var(--vscode-charts-purple, #b180d7)',
  '*MODULE': 'var(--vscode-charts-purple, #b180d7)', '*FILE': 'var(--vscode-charts-green, #89d185)',
  '*DTAARA': 'var(--vscode-charts-yellow, #cca700)', '*DTAQ': 'var(--vscode-charts-orange, #d18616)',
  [DYNAMIC_TYPE]: 'var(--vscode-charts-red, #f14c4c)',
};

function renderSvg(g: CallGraph): { svg: string; width: number; height: number } {
  const l = layoutGraph(g);
  const pos = new Map(l.nodes.map(n => [n.id, n]));
  const edges = g.edges.map(e => {
    const a = pos.get(e.from); const b = pos.get(e.to);
    if (!a || !b) { return ''; }
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
    const backward = x2 <= x1;
    const d = backward
      ? `M${a.x + NODE_W / 2},${a.y + NODE_H} C${a.x + NODE_W / 2},${a.y + NODE_H + 60} ${b.x + NODE_W / 2},${b.y + NODE_H + 60} ${b.x + NODE_W / 2},${b.y + NODE_H}`
      : `M${x1},${y1} C${x1 + 45},${y1} ${x2 - 45},${y2} ${x2},${y2}`;
    const label = e.label ? `<text class="elabel" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}">${escapeHtml(e.label)}</text>` : '';
    return `<path class="edge${e.dynamic ? ' dyn' : ''}" d="${d}" marker-end="url(#arrow)"/>${label}`;
  }).join('');
  const nodes = l.nodes.map(n => {
    const color = COLORS[n.type] ?? 'var(--vscode-foreground)';
    const dyn = n.type === DYNAMIC_TYPE;
    const shown = dyn ? `? ${n.name}` : n.name;
    const name = shown.length > 18 ? shown.substring(0, 17) + '…' : shown;
    const meta = dyn ? 'run-time target' : `${n.lib} · ${n.type}`;
    return `<g class="node${n.id === g.root ? ' root' : ''}${dyn ? ' dyn' : ''}" data-id="${escapeHtml(n.id)}" transform="translate(${n.x},${n.y})">` +
      `<title>${escapeHtml(`${n.lib}/${n.name} ${n.type}${n.text ? ' — ' + n.text : ''}`)}</title>` +
      `<rect width="${NODE_W}" height="${NODE_H}" rx="6" style="stroke:${color}"/>` +
      `<rect width="6" height="${NODE_H}" rx="3" style="fill:${color};stroke:none"/>` +
      `<text class="name" x="14" y="16">${escapeHtml(name)}</text>` +
      `<text class="meta" x="14" y="31">${escapeHtml(meta)}</text></g>`;
  }).join('');
  return { svg: `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker></defs>${edges}${nodes}`, width: l.width, height: l.height };
}

class CallGraphPanel {
  private static current?: CallGraphPanel;
  private readonly panel: vscode.WebviewPanel;
  private graph?: CallGraph;

  static show(manager: ConnectionManager, root: ObjArg, scope: Scope, direction: Direction, depth: number): void {
    if (!CallGraphPanel.current) { CallGraphPanel.current = new CallGraphPanel(manager); }
    CallGraphPanel.current.set(root, scope, direction, depth);
  }

  private root!: ObjArg; private scope!: Scope; private direction: Direction = 'both'; private depth = 2; private hideFiles = false;

  private constructor(private readonly manager: ConnectionManager) {
    this.panel = vscode.window.createWebviewPanel('vanthrex.callGraph', 'Call graph', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.onDidDispose(() => { CallGraphPanel.current = undefined; });
    this.panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => {
      logError(e); vscode.window.showErrorMessage(errorMessage(e));
    }));
  }

  private set(root: ObjArg, scope: Scope, direction: Direction, depth: number): void {
    Object.assign(this, { root, scope, direction, depth });
    this.render();
    this.panel.reveal();
  }

  private render(): void {
    const max = vscode.workspace.getConfiguration('vanthrex').get<number>('callGraph.maxNodes', 200);
    const refs = this.hideFiles ? this.scope.refs.filter(r => r.refType !== '*FILE') : this.scope.refs;
    const rootType = this.root.type && this.root.type !== '*ALL' ? this.root.type : '*PGM';
    const graph = buildCallGraph({ lib: this.root.library, name: this.root.name, type: rootType, text: this.root.text }, refs, this.direction, this.depth, max);
    this.graph = this.scope.dynamic ? addDynamicCalls(graph, this.scope.dynamic) : graph;
    this.panel.title = `Call graph: ${this.root.name}`;
    this.panel.webview.html = this.html(this.graph);
  }

  private async onMessage(m: { type: string; [k: string]: unknown }): Promise<void> {
    if (m.type === 'set') {
      if (m.direction) { this.direction = m.direction as Direction; }
      if (typeof m.depth === 'number') { this.depth = Math.min(8, Math.max(1, m.depth)); }
      if (typeof m.hideFiles === 'boolean') { this.hideFiles = m.hideFiles; }
      this.render();
    } else if (m.type === 'mermaid' && this.graph) {
      await vscode.env.clipboard.writeText('```mermaid\n' + toMermaid(this.graph) + '\n```\n');
      vscode.window.showInformationMessage('Mermaid diagram copied — paste it into a Markdown file, wiki or pull request.');
    } else if (m.type === 'dynamic') {
      await this.findDynamicCalls();
    } else if (m.type === 'refresh') {
      const conn = this.manager.require();
      if (conn.profile.id !== this.scope.profileId) {
        throw new Error(`This graph was built on ${this.scope.system}; switch back to it to rebuild the cross-reference.`);
      }
      this.scope = await crossReference(conn, this.scope.libs, true);
      this.render();
    } else if (m.type === 'node' && this.graph) {
      const n = this.graph.nodes.find(x => x.id === m.id);
      if (n) { await this.nodeActions(n); }
    }
  }

  /** Scan the sources of the programs in the graph for calls whose target is a variable. */
  private async findDynamicCalls(): Promise<void> {
    const conn = this.manager.require();
    if (conn.profile.id !== this.scope.profileId) {
      throw new Error(`This graph was built on ${this.scope.system}; switch back to it to scan its sources.`);
    }
    const scope = this.scope;
    scope.dynamic ??= new Map(); scope.scanned ??= new Set(); scope.sources ??= new Map(); scope.notScanned ??= 0;
    const programs = (this.graph?.nodes ?? [])
      .filter(n => (n.type === '*PGM' || n.type === '*SRVPGM') && n.lib !== '*LIBL' && !scope.scanned!.has(`${n.lib}/${n.name}`))
      .map(n => ({ lib: n.lib, name: n.name }));
    if (!programs.length) { vscode.window.showInformationMessage('Every program in this graph has already been scanned for dynamic calls.'); return; }
    const batch = programs.slice(0, MAX_DYNAMIC_SCAN);
    let found = 0; let skipped = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Finding dynamic calls…', cancellable: true },
      async (progress, token) => {
        progress.report({ message: `locating the source of ${batch.length} program(s)…` });
        const sources = await sourcesOfPrograms(conn, batch);
        const work: SourceRef[] = [];
        for (const p of batch) {
          const key = `${p.lib}/${p.name}`;
          const refs = (sources.get(key) ?? []).filter(r => sourceLabel(r) && languageOf(r) !== 'other');
          if (!refs.length) { skipped++; scope.scanned!.add(key); }
          work.push(...refs);
        }
        const reader = new SourceReader(conn);
        let done = 0;
        await eachLimited(work, 4, async r => {
          progress.report({ message: `${++done}/${work.length} ${sourceLabel(r)}`, increment: 100 / Math.max(1, work.length) });
          try {
            const text = await reader.read(r);
            const lang = languageOf(r);
            const copied = lang === 'rpg' ? (await reader.copiedPrototypes(text, r)).prototypes : [];
            const calls = findDynamicCalls(text, lang, copied);
            const label = sourceLabel(r);
            scope.sources!.set(label, r);
            if (calls.length) {
              const list = scope.dynamic!.get(r.program) ?? [];
              list.push(...calls.map(c => ({ kind: c.kind, target: c.target, line: c.line, source: label })));
              scope.dynamic!.set(r.program, list);
              found += calls.length;
            }
          } catch (e) { skipped++; log(`Dynamic calls: could not read ${sourceLabel(r)}: ${errorMessage(e)}`); }
          scope.scanned!.add(r.program);
        }, token);
      });
    scope.notScanned! += skipped;
    this.render();
    const more = programs.length > batch.length ? ` ${programs.length - batch.length} more program(s) remain — click the button again to continue.` : '';
    vscode.window.showInformationMessage(
      `${found} dynamic call(s) found in ${batch.length} program(s).${skipped ? ` ${skipped} could not be scanned (no RPG/CL source found).` : ''}${more}`);
  }

  private async nodeActions(n: GraphNode): Promise<void> {
    type A = vscode.QuickPickItem & { run: () => unknown };
    if (n.type === DYNAMIC_TYPE) {
      const parent = this.graph?.edges.find(e => e.to === n.id)?.from;
      const owner = this.graph?.nodes.find(x => x.id === parent);
      const refs = (owner && this.scope.dynamic?.get(`${owner.lib}/${owner.name}`) || [])
        .filter(r => r.target.toUpperCase() === n.name.toUpperCase());
      const items: A[] = refs.map(r => ({
        label: `$(go-to-file) ${r.source} line ${r.line}`, description: `${r.kind} name in ${r.target}`,
        run: () => { const src = this.scope.sources?.get(r.source); return src ? openSourceAtLine(src, r.line) : undefined; },
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: `Dynamic ${refs[0]?.kind ?? 'call'}: target held in ${n.name}`,
        placeHolder: 'The called object is decided at run time, so it is not in the cross-reference. Open the call:',
      });
      if (pick) { await pick.run(); }
      return;
    }
    const o = { library: n.lib, name: n.name, type: n.type };
    const isProgram = ['*PGM', '*SRVPGM', '*MODULE'].includes(n.type);
    const actions: A[] = [
      { label: '$(target) Center the graph on this object', run: () => this.set({ ...o, text: n.text }, this.scope, this.direction, this.depth) },
      { label: '$(info) Object information', run: () => vscode.commands.executeCommand('vanthrex.objectInfo', o) },
    ];
    if (isProgram) { actions.push({ label: '$(go-to-file) Open source', run: () => vscode.commands.executeCommand('vanthrex.openProgramSource', o) }); }
    if (n.type === '*SRVPGM' && n.lib !== '*LIBL') { actions.push({ label: '$(symbol-method) Who calls each exported procedure?', run: () => vscode.commands.executeCommand('vanthrex.procedureCallers', o) }); }
    if (n.type === '*FILE') { actions.push({ label: '$(table) Edit data', run: () => vscode.commands.executeCommand('vanthrex.editData', o) }); }
    actions.push({ label: '$(sparkle) Ask AI to explain this object', run: () => vscode.commands.executeCommand('vanthrex.ai.open', `/object ${n.lib}/${n.name} ${n.type}`) });
    actions.push({ label: '$(clippy) Copy qualified name', run: () => vscode.env.clipboard.writeText(`${n.lib}/${n.name}`) });
    if (n.lib === '*LIBL') { actions.splice(1, 0, { label: '$(warning) Library not resolved (*LIBL) — it is outside the analysed libraries', run: () => undefined }); }
    const pick = await vscode.window.showQuickPick(actions, { title: `${n.lib}/${n.name} ${n.type}`, placeHolder: n.text || undefined });
    if (pick) { await pick.run(); }
  }

  private html(g: CallGraph): string {
    const n = nonce();
    const { svg, width, height } = renderSvg(g);
    const impact = impactSummary(g);
    const callees = g.nodes.filter(x => x.depth > 0 && x.type !== DYNAMIC_TYPE).length;
    const dynamicCount = g.nodes.filter(x => x.type === DYNAMIC_TYPE).length;
    const root = g.nodes.find(x => x.id === g.root)!;
    const summary = [
      this.direction !== 'callees' ? `<b>${impact.programs}</b> program(s) in ${impact.libraries.length ? escapeHtml(impact.libraries.join(', ')) : 'no library'} use it` : '',
      this.direction !== 'callers' ? `it uses <b>${callees}</b> object(s)` : '',
      this.scope.dynamic ? `<b>${dynamicCount}</b> dynamic call target(s) shown` : '',
    ].filter(Boolean).join(' · ');
    const btn = (label: string, attrs: string, active = false) => `<button ${attrs} class="${active ? 'on' : ''}">${label}</button>`;
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; overflow: hidden; }
  header { padding: 8px 14px; border-bottom: 1px solid var(--vscode-editorWidget-border, #8883); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  h1 { font-size: 1.15em; margin: 0 12px 0 0; } .sub { color: var(--vscode-descriptionForeground); width: 100%; font-size: .92em; }
  button { padding: 3px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.on, button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .sep { width: 1px; height: 20px; background: var(--vscode-editorWidget-border, #8884); }
  svg { width: 100vw; height: calc(100vh - 92px); cursor: grab; display: block; }
  .node rect { fill: var(--vscode-editorWidget-background); stroke-width: 1.5; }
  .node:hover rect:first-of-type { fill: var(--vscode-list-hoverBackground); } .node { cursor: pointer; }
  .node.root rect:first-of-type { stroke-width: 3; }
  .name { fill: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); font-size: 13px; font-weight: 600; }
  .meta { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  .edge { fill: none; stroke: var(--vscode-descriptionForeground); stroke-opacity: .7; stroke-width: 1.2; }
  .arrowhead { fill: var(--vscode-descriptionForeground); } .elabel { fill: var(--vscode-descriptionForeground); font-size: 10px; text-anchor: middle; }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .edge.dyn { stroke-dasharray: 5 4; stroke: var(--vscode-charts-red, #f14c4c); }
  .node.dyn rect:first-of-type { stroke-dasharray: 5 3; }
</style></head><body>
<header>
  <h1>${escapeHtml(`${root.lib}/${root.name}`)} <span class="sub" style="width:auto">${escapeHtml(root.type)}</span></h1>
  ${btn('◀ Callers (impact)', 'data-dir="callers"', this.direction === 'callers')}
  ${btn('Both', 'data-dir="both"', this.direction === 'both')}
  ${btn('Callees ▶', 'data-dir="callees"', this.direction === 'callees')}
  <span class="sep"></span>
  ${btn('−', 'id="less" title="Fewer levels"')}<span>Depth ${this.depth}</span>${btn('+', 'id="more" title="More levels"')}
  <span class="sep"></span>
  ${btn(this.hideFiles ? 'Show files' : 'Hide files', 'id="files"')}
  ${btn('Fit', 'id="fit"')}
  ${btn('Find dynamic calls', 'id="dynamic" title="Scan the programs\' source for CALLs whose program or procedure name is in a variable (DSPPGMREF cannot see them)"')}
  ${btn('Copy as Mermaid', 'id="mermaid"')}
  ${btn('Rebuild cross-reference', 'id="refresh"')}
  <div class="sub">${summary || 'No references found.'} — analysed ${escapeHtml(this.scope.libs.join(', '))} on ${escapeHtml(this.scope.system)} at ${this.scope.at.toLocaleTimeString()}.
  Click an object for actions; drag to pan, scroll to zoom.${g.truncated ? ' <span class="warn">The graph was cut at the node limit (setting vanthrex.callGraph.maxNodes).</span>' : ''}</div>
</header>
<svg id="g" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${svg}</svg>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const svg = document.getElementById('g');
  const full = { x: 0, y: 0, w: ${width}, h: ${height} };
  let vb = { ...full };
  const apply = () => svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
  document.querySelectorAll('[data-dir]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'set', direction: b.dataset.dir })));
  document.getElementById('less').addEventListener('click', () => vscode.postMessage({ type: 'set', depth: ${this.depth - 1} }));
  document.getElementById('more').addEventListener('click', () => vscode.postMessage({ type: 'set', depth: ${this.depth + 1} }));
  document.getElementById('files').addEventListener('click', () => vscode.postMessage({ type: 'set', hideFiles: ${!this.hideFiles} }));
  document.getElementById('mermaid').addEventListener('click', () => vscode.postMessage({ type: 'mermaid' }));
  document.getElementById('dynamic').addEventListener('click', () => vscode.postMessage({ type: 'dynamic' }));
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('fit').addEventListener('click', () => { vb = { ...full }; apply(); });
  let drag, moved = false;
  svg.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY, vb: { ...vb } }; moved = false; svg.style.cursor = 'grabbing'; });
  window.addEventListener('mouseup', () => { drag = undefined; svg.style.cursor = 'grab'; });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    const k = vb.w / svg.clientWidth;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) moved = true;
    vb.x = drag.vb.x - (e.clientX - drag.x) * k; vb.y = drag.vb.y - (e.clientY - drag.y) * k; apply();
  });
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const r = svg.getBoundingClientRect();
    const px = vb.x + (e.clientX - r.left) / r.width * vb.w, py = vb.y + (e.clientY - r.top) / r.height * vb.h;
    vb = { x: px - (px - vb.x) * f, y: py - (py - vb.y) * f, w: vb.w * f, h: vb.h * f }; apply();
  }, { passive: false });
  svg.addEventListener('click', e => {
    const node = e.target.closest('.node');
    if (node && !moved) vscode.postMessage({ type: 'node', id: node.dataset.id });
  });
</script></body></html>`;
  }
}

async function askRoot(): Promise<ObjArg | undefined> {
  const v = await vscode.window.showInputBox({
    title: 'Call graph & impact analysis', prompt: 'LIBRARY/OBJECT and optionally its type (*PGM, *SRVPGM, *FILE, *DTAARA…)',
    placeHolder: 'MYLIB/ORDENTRY *PGM', ignoreFocusOut: true,
  });
  if (!v?.trim()) { return undefined; }
  const [path, type] = v.trim().toUpperCase().split(/\s+/);
  const [library, name] = path.split('/');
  if (!name) { throw new Error('Use LIBRARY/OBJECT, for example MYLIB/ORDENTRY.'); }
  return { library: assertSystemName(library, 'library'), name: assertSystemName(name, 'object name'), type: type || '*PGM' };
}

export async function openCallGraph(manager: ConnectionManager, arg: ObjArg | undefined, direction?: Direction): Promise<void> {
  const conn = manager.require();
  const root = arg?.library && arg.name ? arg : await askRoot();
  if (!root) { return; }
  const libs = await pickLibraries(conn, root);
  if (!libs) { return; }
  const scope = await crossReference(conn, libs, false);
  const depth = vscode.workspace.getConfiguration('vanthrex').get<number>('callGraph.depth', 2);
  CallGraphPanel.show(manager, root, scope, direction ?? (root.type === '*FILE' ? 'callers' : 'both'), depth);
}

export function registerCallGraph(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]) => {
    try { await fn(...a); } catch (e) {
      logError(e);
      const c = await vscode.window.showErrorMessage(errorMessage(e), 'Show Log');
      if (c) { showLog(); }
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.callGraph', guard((n?: ObjArg) => openCallGraph(manager, n))),
    vscode.commands.registerCommand('vanthrex.impactAnalysis', guard((n?: ObjArg) => openCallGraph(manager, n, 'callers'))),
    manager.onDidChange(() => scopes.clear()),
  );
}
