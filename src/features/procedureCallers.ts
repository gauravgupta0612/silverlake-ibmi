// "Who calls each exported procedure?" — procedure-level impact analysis for a service program.
// Programs bound to the service program come from QSYS2.BOUND_SRVPGM_INFO (or the DSPPGMREF cross-reference);
// their sources (and /COPY prototypes) are then scanned for calls to each exported procedure.

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/manager';
import { IbmiConnection } from '../core/connection';
import { errorMessage, log, logError, showLog } from '../core/log';
import { assertSystemName, sqlString } from '../core/util';
import { ProcCall, findProcedureCalls } from '../rpg/callScan';
import { crossReference, pickLibraries } from './callGraphView';
import { Report, showReport } from './reportPanel';
import { SourceReader, SourceRef, eachLimited, languageOf, openSourceAtLine, sourceLabel, sourcesOfPrograms } from './sourceScan';

type ObjArg = { library: string; name: string; type?: string; text?: string };

const ALLOWED = new Set(['vanthrex.openSourceAtLine', 'vanthrex.objectInfo', 'vanthrex.serviceProgramInfo', 'vanthrex.callGraph', 'vanthrex.sqlQuery']);
const v = (r: Record<string, unknown>, k: string) => String(r[k] ?? '').trim();

/** Programs (and service programs) in `libs` that are bound to LIB/SRVPGM. */
async function boundPrograms(conn: IbmiConnection, lib: string, name: string, libs: string[]): Promise<{ lib: string; name: string; type: string }[]> {
  try {
    const rows = await conn.rows<Record<string, unknown>>(
      `SELECT DISTINCT PROGRAM_LIBRARY, PROGRAM_NAME, OBJECT_TYPE FROM QSYS2.BOUND_SRVPGM_INFO ` +
      `WHERE BOUND_SERVICE_PROGRAM = ${sqlString(name)} AND BOUND_SERVICE_PROGRAM_LIBRARY IN (${sqlString(lib)}, '*LIBL') ` +
      `AND PROGRAM_LIBRARY IN (${libs.map(sqlString).join(', ')})`, 20000);
    return rows.map(r => ({ lib: v(r, 'PROGRAM_LIBRARY'), name: v(r, 'PROGRAM_NAME'), type: v(r, 'OBJECT_TYPE') || '*PGM' }))
      .filter(p => !(p.lib === lib && p.name === name));
  } catch (e) {
    log(`BOUND_SRVPGM_INFO not available (${errorMessage(e)}); using the DSPPGMREF cross-reference.`);
    const scope = await crossReference(conn, libs, false);
    const seen = new Map<string, { lib: string; name: string; type: string }>();
    for (const r of scope.refs) {
      if (r.refName !== name || r.refType.toUpperCase().replace(/^\*?/, '*') !== '*SRVPGM') { continue; }
      if (r.refLib && !['*LIBL', lib].includes(r.refLib.toUpperCase())) { continue; }
      if (r.lib === lib && r.pgm === name) { continue; }
      seen.set(`${r.lib}/${r.pgm}`, { lib: r.lib, name: r.pgm, type: (r.pgmType || '').toUpperCase() === 'V' ? '*SRVPGM' : '*PGM' });
    }
    return [...seen.values()];
  }
}

interface Found extends ProcCall { program: string; source: SourceRef; }

export async function procedureCallers(manager: ConnectionManager, o: ObjArg): Promise<void> {
  const conn = manager.require();
  const lib = assertSystemName(o.library, 'library'), name = assertSystemName(o.name, 'service program');

  const exports = (await conn.rows<Record<string, unknown>>(
    `SELECT SYMBOL_NAME FROM QSYS2.PROGRAM_EXPORT_IMPORT_INFO WHERE PROGRAM_LIBRARY = ${sqlString(lib)} ` +
    `AND PROGRAM_NAME = ${sqlString(name)} AND OBJECT_TYPE = '*SRVPGM' AND SYMBOL_USAGE = '*PROCEXP'`, 10000))
    .map(r => String(r.SYMBOL_NAME ?? '').trim()).filter(Boolean);
  if (!exports.length) { throw new Error(`${lib}/${name} exports no procedures (or it is not a service program).`); }

  const libs = await pickLibraries(conn, { library: lib, name, type: '*SRVPGM' });
  if (!libs) { return; }

  const found: Found[] = [];
  const notScanned: { program: string; module: string; reason: string }[] = [];
  const guessedSources = new Set<string>();
  let scanned = 0;
  let programs: { lib: string; name: string; type: string }[] = [];

  const cancelled = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Who calls the procedures of ${lib}/${name}?`, cancellable: true },
    async (progress, token) => {
      progress.report({ message: 'finding bound programs…' });
      programs = await boundPrograms(conn, lib, name, libs);
      if (!programs.length) { return false; }
      progress.report({ message: `locating the source of ${programs.length} program(s)…` });
      const sources = await sourcesOfPrograms(conn, programs);
      const work: SourceRef[] = [];
      for (const p of programs) {
        const key = `${p.lib}/${p.name}`;
        const refs = sources.get(key);
        if (!refs?.length) { notScanned.push({ program: key, module: '', reason: 'No source information is recorded for this program.' }); continue; }
        for (const r of refs) {
          if (!sourceLabel(r)) { notScanned.push({ program: key, module: r.module, reason: 'No source recorded for this module.' }); }
          else if (languageOf(r) === 'other') { notScanned.push({ program: key, module: r.module, reason: `${r.type || 'This'} source is not scanned (RPG and CL only).` }); }
          else { work.push(r); }
        }
      }
      const reader = new SourceReader(conn);
      let done = 0;
      await eachLimited(work, 4, async r => {
        progress.report({ message: `${++done}/${work.length} ${sourceLabel(r)}`, increment: 100 / work.length });
        try {
          const text = await reader.read(r);
          const lang = languageOf(r);
          const copied = lang === 'rpg' ? await reader.copiedPrototypes(text, r) : { prototypes: [], missing: [] };
          const calls = findProcedureCalls(text, lang, exports, copied.prototypes);
          if (calls.some(c => c.guessed)) { guessedSources.add(sourceLabel(r)); }
          found.push(...calls.map(c => ({ ...c, program: r.program, source: r })));
          scanned++;
        } catch (e) {
          notScanned.push({ program: r.program, module: r.module, reason: `Could not read ${sourceLabel(r)}: ${errorMessage(e)}` });
        }
      }, token);
      return token.isCancellationRequested;
    });
  if (cancelled) { vscode.window.showInformationMessage('Stopped — the results below cover the sources scanned so far.'); }

  // ---- report
  found.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.program.localeCompare(b.program) || a.line - b.line);
  const byExport = new Map<string, Found[]>(exports.map(e => [e, []]));
  for (const f of found) { byExport.get(f.symbol)?.push(f); }
  const withCalls = new Set(found.map(f => f.program));
  const unused = exports.filter(e => !byExport.get(e)!.length);
  const report: Report = {
    title: `Who calls ${name}?`,
    subtitle: `${exports.length} exported procedure(s) of ${lib}/${name} · ${programs.length} bound program(s) in ${libs.join(', ')} · ` +
      `${scanned} source(s) scanned · ${found.length} call(s) found.`,
    actions: [
      { label: 'Modules & exports', command: 'vanthrex.serviceProgramInfo', args: [{ library: lib, name, type: '*SRVPGM' }] },
      { label: 'Call graph', command: 'vanthrex.callGraph', args: [{ library: lib, name, type: '*SRVPGM' }] },
      { label: 'Run SQL query…', command: 'vanthrex.sqlQuery', args: [{ library: lib, name, type: '*SRVPGM' }] },
    ],
    tables: [
      {
        title: 'Exported procedures', columns: ['Procedure', 'Calls', 'Programs'], filter: true,
        rows: exports.map(e => {
          const calls = byExport.get(e)!;
          return [e, calls.length, [...new Set(calls.map(c => c.program))].sort().join(', ') || 'no caller found'];
        }),
        rowClass: exports.map(e => byExport.get(e)!.length ? undefined : 'different'),
      },
      {
        title: 'Calls', columns: ['Procedure', 'Program', 'Source', 'Line', 'Code', 'Found by'], filter: true,
        rows: found.map(f => [f.symbol, f.program, sourceLabel(f.source), f.line, f.code.substring(0, 120),
            f.guessed ? 'name only (prototype not found)' : f.via === f.symbol ? 'symbol' : `prototype ${f.via}`]),
        rowActions: found.map(f => ({ label: 'Open the source at this line', command: 'vanthrex.openSourceAtLine', args: [f.source, f.line] })),
        rowClass: found.map(f => f.guessed ? 'different' : undefined),
        empty: 'No calls found.',
      },
      {
        title: 'Bound, but no call found', columns: ['Program', 'Type'],
        rows: programs.filter(p => !withCalls.has(`${p.lib}/${p.name}`) && !notScanned.some(n => n.program === `${p.lib}/${p.name}` && !n.module))
          .map(p => [`${p.lib}/${p.name}`, p.type]),
        empty: 'Every scanned program calls at least one exported procedure.',
      },
      {
        title: 'Not scanned', columns: ['Program', 'Module', 'Reason'], filter: true,
        rows: notScanned.map(n => [n.program, n.module, n.reason]),
        empty: 'Every bound module was scanned.',
      },
    ],
    note: [
      unused.length ? `${unused.length} exported procedure(s) have no caller in the analysed libraries (marked on the left) — check other libraries before removing them.` : '',
      guessedSources.size ? `Calls marked on the left were matched by name: their prototype was not found (its /COPY member could not be read).` : '',
      'Calls through procedure pointers set at run time, and sources changed after the program was compiled, are not seen. Click a call to open the source at that line.',
    ].filter(Boolean).join(' '),
  };
  showReport('procedureCallers', report, ALLOWED);
}

export function registerProcedureCallers(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const guard = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]) => {
    try { await fn(...a); } catch (e) {
      logError(e);
      const c = await vscode.window.showErrorMessage(errorMessage(e), 'Show Log');
      if (c) { showLog(); }
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.procedureCallers', guard(async (n?: ObjArg) => {
      let o = n?.library && n.name ? n : undefined;
      if (!o) {
        const s = await vscode.window.showInputBox({ title: 'Who calls each exported procedure?', prompt: 'Service program: LIBRARY/NAME', placeHolder: 'MYLIB/CUSTSRV', ignoreFocusOut: true });
        if (!s?.trim()) { return; }
        const [library, name] = s.trim().toUpperCase().split('/');
        if (!name) { throw new Error('Use LIBRARY/NAME, for example MYLIB/CUSTSRV.'); }
        o = { library, name, type: '*SRVPGM' };
      }
      await procedureCallers(manager, o);
    })),
    vscode.commands.registerCommand('vanthrex.openSourceAtLine', guard((ref: SourceRef, line: number) => openSourceAtLine(ref, line))),
  );
}
