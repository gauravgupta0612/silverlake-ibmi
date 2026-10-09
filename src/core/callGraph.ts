// Program call graph / impact analysis from DSPPGMREF records (pure module, unit tested).

/** One DSPPGMREF record: program LIB/PGM references object REFLIB/REFNAME of type REFTYPE. */
export interface PgmRef {
  lib: string;
  pgm: string;
  pgmType?: string;   // *PGM / *SRVPGM / *MODULE / *SQLPKG
  text?: string;
  refLib: string;     // may be *LIBL or blank
  refName: string;
  refType: string;    // *PGM, *SRVPGM, *FILE, *DTAARA, ...
  usage?: number;     // file usage bits: 1 input, 2 output, 4 update, 8 unspecified
}

export interface GraphNode {
  id: string;         // LIB/NAME*TYPE
  lib: string;
  name: string;
  type: string;
  text: string;
  depth: number;      // 0 = root, < 0 callers, > 0 callees
}

export interface GraphEdge { from: string; to: string; label: string; dynamic?: boolean; }

export interface CallGraph {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export type Direction = 'callers' | 'callees' | 'both';

const LIBL = new Set(['', '*LIBL', '*CURLIB']);

export function nodeId(lib: string, name: string, type: string): string {
  return `${lib || '*LIBL'}/${name}${type}`;
}

export function usageLabel(usage?: number): string {
  if (!usage) { return ''; }
  const parts: string[] = [];
  if (usage & 1) { parts.push('input'); }
  if (usage & 2) { parts.push('output'); }
  if (usage & 4) { parts.push('update'); }
  return parts.join('/');
}

function normType(t?: string): string {
  const v = (t ?? '').trim().toUpperCase();
  if (!v) { return '*PGM'; }
  if (v === 'P') { return '*PGM'; }
  if (v === 'V') { return '*SRVPGM'; }
  if (v === 'M') { return '*MODULE'; }
  if (v === 'S') { return '*SQLPKG'; }
  return v.startsWith('*') ? v : `*${v}`;
}

/**
 * Walk the references from a root object.
 * - callees: what the root uses (programs it calls, files it opens…), then what those use, …
 * - callers: programs that use the root, then programs that use those, … (the impact of a change).
 */
export function buildCallGraph(
  root: { lib: string; name: string; type: string; text?: string },
  refs: PgmRef[],
  direction: Direction,
  maxDepth: number,
  maxNodes = 200,
): CallGraph {
  const programs = new Map<string, PgmRef[]>();      // LIB/PGM -> refs it makes
  const libsOfName = new Map<string, Set<string>>();  // PGM name -> libraries it lives in
  const texts = new Map<string, string>();
  const types = new Map<string, string>();
  for (const r of refs) {
    const key = `${r.lib}/${r.pgm}`;
    (programs.get(key) ?? programs.set(key, []).get(key)!).push(r);
    (libsOfName.get(r.pgm) ?? libsOfName.set(r.pgm, new Set()).get(r.pgm)!).add(r.lib);
    if (r.text) { texts.set(key, r.text); }
    types.set(key, normType(r.pgmType));
  }
  const resolveLib = (lib: string, name: string) => {
    if (!LIBL.has(lib.toUpperCase())) { return lib; }
    const libs = libsOfName.get(name);
    return libs && libs.size === 1 ? [...libs][0] : '*LIBL';
  };

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let truncated = false;
  const addNode = (lib: string, name: string, type: string, depth: number): GraphNode | undefined => {
    const id = nodeId(lib, name, type);
    const existing = nodes.get(id);
    if (existing) { return existing; }
    if (nodes.size >= maxNodes) { truncated = true; return undefined; }
    const n: GraphNode = { id, lib: lib || '*LIBL', name, type, text: texts.get(`${lib}/${name}`) ?? '', depth };
    nodes.set(id, n);
    return n;
  };
  const addEdge = (from: string, to: string, label: string) => {
    const key = `${from}>${to}`;
    const e = edges.get(key);
    if (e) { if (label && !e.label.includes(label)) { e.label = [e.label, label].filter(Boolean).join(', '); } return; }
    edges.set(key, { from, to, label });
  };

  const rootType = normType(root.type);
  const rootNode = addNode(root.lib, root.name, rootType, 0)!;
  if (root.text) { rootNode.text = root.text; }

  if (direction !== 'callers') {
    let frontier: GraphNode[] = [rootNode];
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: GraphNode[] = [];
      for (const n of frontier) {
        const made = programs.get(`${n.lib}/${n.name}`) ?? (n.lib === '*LIBL'
          ? [...(libsOfName.get(n.name) ?? [])].flatMap(l => programs.get(`${l}/${n.name}`) ?? []) : []);
        for (const r of made) {
          const lib = resolveLib(r.refLib, r.refName);
          const type = normType(r.refType);
          const before = nodes.size;
          const child = addNode(lib, r.refName, type, depth);
          if (!child) { continue; }
          addEdge(n.id, child.id, type === '*FILE' ? usageLabel(r.usage) : '');
          if (nodes.size > before && (type === '*PGM' || type === '*SRVPGM' || type === '*MODULE')) { next.push(child); }
        }
      }
      frontier = next;
    }
  }

  if (direction !== 'callees') {
    let frontier: GraphNode[] = [rootNode];
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: GraphNode[] = [];
      for (const n of frontier) {
        for (const r of refs) {
          if (r.refName !== n.name || normType(r.refType) !== n.type) { continue; }
          const refLib = r.refLib.toUpperCase();
          if (!LIBL.has(refLib) && n.lib !== '*LIBL' && refLib !== n.lib) { continue; }
          const type = types.get(`${r.lib}/${r.pgm}`) ?? '*PGM';
          const before = nodes.size;
          const caller = addNode(r.lib, r.pgm, type, -depth);
          if (!caller) { continue; }
          addEdge(caller.id, n.id, n.type === '*FILE' ? usageLabel(r.usage) : '');
          if (nodes.size > before) { next.push(caller); }
        }
      }
      frontier = next;
    }
  }

  return { root: rootNode.id, nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

/** A call found in a program's source whose target is only known at run time. */
export interface DynamicRef { kind: 'program' | 'procedure'; target: string; line: number; source: string; }

export const DYNAMIC_TYPE = '*DYNAMIC';

/**
 * Add the dynamic calls found in the sources of the graph's programs (key LIB/NAME) as dashed
 * "?" nodes next to the program that makes them — DSPPGMREF cannot see these calls.
 */
export function addDynamicCalls(g: CallGraph, found: Map<string, DynamicRef[]>): CallGraph {
  const nodes = [...g.nodes];
  const edges = [...g.edges];
  for (const n of g.nodes) {
    const calls = found.get(`${n.lib}/${n.name}`);
    if (!calls?.length || n.type === DYNAMIC_TYPE) { continue; }
    const byTarget = new Map<string, DynamicRef[]>();
    for (const c of calls) { (byTarget.get(c.target.toUpperCase()) ?? byTarget.set(c.target.toUpperCase(), []).get(c.target.toUpperCase())!).push(c); }
    for (const [target, refs] of byTarget) {
      const id = `${n.id}?${target}`;
      const kind = refs[0].kind === 'program' ? 'program' : 'procedure';
      nodes.push({
        id, lib: '? dynamic', name: refs[0].target, type: DYNAMIC_TYPE, depth: n.depth + 0.5,
        text: `${kind} name in ${refs[0].target} — ${refs[0].source} line ${refs.map(r => r.line).join(', ')}`,
      });
      edges.push({ from: n.id, to: id, label: 'dynamic', dynamic: true });
    }
  }
  return { ...g, nodes, edges };
}

/** Programs affected by a change to the root (all callers, any depth in the graph). */
export function impactSummary(g: CallGraph): { programs: number; libraries: string[] } {
  const callers = g.nodes.filter(n => n.depth < 0 && n.type !== DYNAMIC_TYPE);
  return { programs: callers.length, libraries: [...new Set(callers.map(n => n.lib))].sort() };
}

export interface Positioned extends GraphNode { x: number; y: number; }

export const NODE_W = 190;
export const NODE_H = 38;
const COL_GAP = 90;
const ROW_GAP = 16;

/** Layered layout: one column per depth, callers on the left, callees on the right. */
export function layoutGraph(g: CallGraph): { nodes: Positioned[]; width: number; height: number } {
  const byDepth = new Map<number, GraphNode[]>();
  for (const n of g.nodes) { (byDepth.get(n.depth) ?? byDepth.set(n.depth, []).get(n.depth)!).push(n); }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const tallest = Math.max(1, ...[...byDepth.values()].map(v => v.length));
  const height = tallest * (NODE_H + ROW_GAP) + ROW_GAP;
  const out: Positioned[] = [];
  depths.forEach((d, ci) => {
    const col = byDepth.get(d)!.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    const offset = (height - col.length * (NODE_H + ROW_GAP)) / 2;
    col.forEach((n, i) => out.push({ ...n, x: 20 + ci * (NODE_W + COL_GAP), y: offset + i * (NODE_H + ROW_GAP) + ROW_GAP / 2 }));
  });
  return { nodes: out, width: 40 + depths.length * (NODE_W + COL_GAP) - COL_GAP, height };
}

/** Mermaid flowchart text (for docs, wikis, pull requests). */
export function toMermaid(g: CallGraph): string {
  const ids = new Map(g.nodes.map((n, i) => [n.id, `n${i}`]));
  const shape = (n: GraphNode) => {
    const label = `${n.lib}/${n.name}<br/>${n.type}`.replace(/"/g, "'");
    return n.type === DYNAMIC_TYPE ? `{{"? ${n.name.replace(/"/g, "'")}<br/>dynamic"}}`
      : n.type === '*FILE' ? `[("${label}")]` : n.type === '*SRVPGM' ? `[["${label}"]]` : `["${label}"]`;
  };
  const lines = ['flowchart LR'];
  for (const n of g.nodes) { lines.push(`  ${ids.get(n.id)}${shape(n)}`); }
  for (const e of g.edges) { lines.push(`  ${ids.get(e.from)} ${e.dynamic ? '-.->' : '-->'}${e.label ? `|${e.label}|` : ''} ${ids.get(e.to)}`); }
  lines.push(`  style ${ids.get(g.root)} stroke-width:3px`);
  return lines.join('\n');
}
