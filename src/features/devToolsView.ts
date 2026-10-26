// Developer converters (packed / zoned / binary, EBCDIC hex, IBM i date formats, timestamps) and offline explanations of
// SQLCODE, SQLSTATE and RPG status codes — as a command and as hovers in RPG, SQL and CL sources.
import * as vscode from 'vscode';
import { checkCcsid, cleanHex, dateFormats, fromBinary, fromPacked, fromZoned, hexDump, hexToTextSql, parseDate, textToHexSql, timestampFormats, toBinary, toPacked, toZoned } from '../core/converters';
import { codeAt, explainAny, CodeInfo } from '../core/codes';
import { errorMessage, logError } from '../core/log';
import { ConnectionManager } from '../core/manager';

type Row = Record<string, unknown>;

/** The results as a list: picking one copies its value. */
async function showValues(title: string, rows: [string, string][]): Promise<void> {
  const pick = await vscode.window.showQuickPick(rows.map(([label, value]) => ({ label: value, description: label })), { title: `${title} — ${vscode.l10n.t('pick one to copy it')}`, matchOnDescription: true });
  if (pick) { await vscode.env.clipboard.writeText(pick.label); vscode.window.setStatusBarMessage(vscode.l10n.t('Copied {0}', pick.label), 3000); }
}

const selected = () => { const ed = vscode.window.activeTextEditor; return ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection).trim() : ''; };

async function numberTool(): Promise<void> {
  const kind = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(arrow-right) Hex → number'), id: 'read' as const, detail: vscode.l10n.t('Packed, zoned and binary readings of the bytes (from a DUMP, a hex view or DSPPFM)') },
    { label: vscode.l10n.t('$(arrow-left) Number → hex'), id: 'write' as const, detail: vscode.l10n.t('The bytes of a value as packed, zoned and binary') },
  ], { title: vscode.l10n.t('Packed / zoned / binary') });
  if (!kind) { return; }
  if (kind.id === 'read') {
    const hex = await vscode.window.showInputBox({ title: vscode.l10n.t('Hexadecimal bytes'), value: selected(), placeHolder: '0012345D', ignoreFocusOut: true, validateInput: v => { try { cleanHex(v); return undefined; } catch (e) { return errorMessage(e); } } });
    if (!hex) { return; }
    const scale = Number(await vscode.window.showInputBox({ title: vscode.l10n.t('Decimal positions'), value: '0', validateInput: v => (/^\d{1,2}$/.test(v.trim()) ? undefined : '0-63') }) ?? NaN);
    if (Number.isNaN(scale)) { return; }
    const h = cleanHex(hex); const out: [string, string][] = [];
    const tryIt = (label: string, f: () => string) => { try { out.push([label, f()]); } catch { /* not this format */ } };
    tryIt(vscode.l10n.t('Packed ({0} digits)', h.length - 1), () => fromPacked(h, scale));
    tryIt(vscode.l10n.t('Zoned ({0} digits)', h.length / 2), () => fromZoned(h, scale));
    tryIt(vscode.l10n.t('Binary signed ({0} bytes)', h.length / 2), () => fromBinary(h, true));
    tryIt(vscode.l10n.t('Binary unsigned ({0} bytes)', h.length / 2), () => fromBinary(h, false));
    out.push([vscode.l10n.t('Dump'), hexDump(h).replace(/\n/g, ' | ')]);
    await showValues(h, out);
    return;
  }
  const value = await vscode.window.showInputBox({ title: vscode.l10n.t('Value'), value: selected(), placeHolder: '-123.45', ignoreFocusOut: true });
  if (!value) { return; }
  const shape = await vscode.window.showInputBox({ title: vscode.l10n.t('Digits and decimals'), value: `${Math.max(1, value.replace(/[^0-9]/g, '').length)},${(value.split(/[.,]/)[1] ?? '').length}`, prompt: vscode.l10n.t('As in packed(7:2): 7,2'), validateInput: v => (/^\d{1,2}\s*[,:]\s*\d{1,2}$/.test(v.trim()) ? undefined : '7,2') });
  if (!shape) { return; }
  const [d, s] = shape.split(/[,:]/).map(x => Number(x.trim()));
  const out: [string, string][] = [];
  const tryIt = (label: string, f: () => string) => { try { out.push([label, f()]); } catch (e) { out.push([label, errorMessage(e)]); } };
  tryIt(vscode.l10n.t('Packed {0}:{1} ({2} bytes)', d, s, Math.floor(d / 2) + 1), () => toPacked(value, d, s));
  tryIt(vscode.l10n.t('Zoned {0}:{1} ({2} bytes)', d, s, d), () => toZoned(value, d, s));
  if (!s) { for (const b of [2, 4, 8] as const) { tryIt(vscode.l10n.t('Binary {0} bytes (int({1}))', b, b === 2 ? 5 : b === 4 ? 10 : 20), () => toBinary(value, b)); } }
  await showValues(value, out);
}

async function dateTool(): Promise<void> {
  const v = await vscode.window.showInputBox({ title: vscode.l10n.t('A date or a timestamp'), value: selected(), ignoreFocusOut: true,
    prompt: vscode.l10n.t('2026-03-31, 03/31/2026, 31.03.2026, 1260331 (*CYMD), 26/090 (*JUL), 2026090 (*LONGJUL), 2026-03-31-14.05.00.000000, epoch seconds…') });
  if (!v?.trim()) { return; }
  const t = v.trim();
  if (/^\d{9,14}$/.test(t) || /^\d{4}-\d{2}-\d{2}[-T ]\d{2}[.:]/.test(t)) { await showValues(t, timestampFormats(t)); return; }
  const p = parseDate(t);
  await showValues(vscode.l10n.t('{0} read as {1}', t, p.how), dateFormats(p.date));
}

async function ebcdicTool(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const conn = manager.require();
  const dir = await vscode.window.showQuickPick([{ label: vscode.l10n.t('$(arrow-right) Text → EBCDIC hex'), id: 'hex' }, { label: vscode.l10n.t('$(arrow-left) EBCDIC hex → text'), id: 'text' }], { title: vscode.l10n.t('EBCDIC (converted by the system)') });
  if (!dir) { return; }
  const ccsid = await vscode.window.showInputBox({ title: vscode.l10n.t('CCSID'), value: state.get<string>('vanthrex.ebcdic.ccsid', '37'), prompt: vscode.l10n.t('37 (US), 297 (France), 273 (Germany), 280 (Italy), 284 (Spain), 285 (UK), 500 (international), 1140-1149 (with €)…'),
    validateInput: x => { try { checkCcsid(x); return undefined; } catch (e) { return errorMessage(e); } } });
  if (!ccsid) { return; }
  await state.update('vanthrex.ebcdic.ccsid', ccsid.trim());
  const input = await vscode.window.showInputBox({ title: dir.id === 'hex' ? vscode.l10n.t('Text') : vscode.l10n.t('Hexadecimal bytes'), value: selected(), ignoreFocusOut: true });
  if (!input) { return; }
  const n = checkCcsid(ccsid);
  if (dir.id === 'hex') {
    const r = await conn.rows<Row>(textToHexSql(input, n), 1);
    const h = String(r[0]?.H ?? '');
    await showValues(input, [[`CCSID ${n}`, h], [vscode.l10n.t('Dump'), hexDump(h).replace(/\n/g, ' | ')], ['RPG', `x'${h}'`]]);
  } else {
    const r = await conn.rows<Row>(hexToTextSql(input, n), 1);
    await showValues(cleanHex(input), [[`CCSID ${n}`, String(r[0]?.T ?? '')]]);
  }
}

async function converters(manager: ConnectionManager, state: vscode.Memento): Promise<void> {
  const pick = await vscode.window.showQuickPick([
    { label: vscode.l10n.t('$(symbol-number) Packed / zoned / binary ↔ hex'), id: 'num' },
    { label: vscode.l10n.t('$(calendar) Date and timestamp formats (*ISO, *CYMD, *JUL, epoch…)'), id: 'date' },
    { label: vscode.l10n.t('$(symbol-string) Text ↔ EBCDIC hex for a CCSID'), id: 'ebcdic', description: manager.connection ? '' : vscode.l10n.t('needs a connection') },
    { label: vscode.l10n.t('$(question) Explain SQLCODE / SQLSTATE / RPG status'), id: 'code' },
  ], { title: vscode.l10n.t('Developer converters') });
  if (!pick) { return; }
  if (pick.id === 'num') { await numberTool(); }
  if (pick.id === 'date') { await dateTool(); }
  if (pick.id === 'ebcdic') { await ebcdicTool(manager, state); }
  if (pick.id === 'code') { await explainCode(); }
}

function codeMarkdown(c: CodeInfo): vscode.MarkdownString {
  const md = new vscode.MarkdownString(`**${c.kind} ${c.code}**${c.other ? ` · ${c.other}` : ''}\n\n${c.text}`);
  if (c.fix) { md.appendMarkdown(`\n\n$(lightbulb) ${c.fix}`); }
  md.supportThemeIcons = true;
  return md;
}

async function explainCode(arg?: string): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  const word = ed ? ed.document.getText(ed.selection.isEmpty ? ed.document.getWordRangeAtPosition(ed.selection.active, /'?-?[0-9A-Z]{3,7}'?/i) : ed.selection) : '';
  const v = arg ?? await vscode.window.showInputBox({ title: vscode.l10n.t('Explain a code'), value: word?.trim(), prompt: vscode.l10n.t('-803, SQL0204, SQLSTATE 23505, 01218, RNQ1211…') });
  if (!v?.trim()) { return; }
  const found = explainAny(v);
  if (!found.length) { vscode.window.showWarningMessage(vscode.l10n.t('"{0}" is not a known SQLCODE, SQLSTATE or RPG status.', v.trim())); return; }
  for (const c of found) {
    const more = c.kind === 'SQLCODE' && Number(c.code) !== 0 && Number(c.code) !== 100 ? vscode.l10n.t('Full Message Text') : undefined;
    const choice = await vscode.window.showInformationMessage(`${c.kind} ${c.code}${c.other ? ` (${c.other})` : ''}: ${c.text}${c.fix ? `  →  ${c.fix}` : ''}`, ...(more ? [more] : []));
    if (choice && more) { await vscode.commands.executeCommand('vanthrex.explainMessage', `SQL${String(Math.abs(Number(c.code))).padStart(4, '0')}`); }
  }
}

export function registerDevTools(context: vscode.ExtensionContext, manager: ConnectionManager): void {
  const wrap = (fn: (...a: never[]) => Promise<void>) => async (...a: never[]) => { try { await fn(...a); } catch (e) { logError(e); vscode.window.showErrorMessage(errorMessage(e)); } };
  context.subscriptions.push(
    vscode.commands.registerCommand('vanthrex.converters', wrap(() => converters(manager, context.globalState))),
    vscode.commands.registerCommand('vanthrex.convertNumber', wrap(numberTool)),
    vscode.commands.registerCommand('vanthrex.convertDate', wrap(dateTool)),
    vscode.commands.registerCommand('vanthrex.convertEbcdic', wrap(() => ebcdicTool(manager, context.globalState))),
    vscode.commands.registerCommand('vanthrex.explainCode', wrap((a?: string) => explainCode(typeof a === 'string' ? a : undefined))),
    vscode.languages.registerHoverProvider([{ language: 'rpgle' }, { language: 'sql' }, { language: 'cl' }], {
      provideHover(doc, pos) {
        if (!vscode.workspace.getConfiguration('vanthrex.editor').get<boolean>('explainCodes', true)) { return undefined; }
        const hit = codeAt(doc.lineAt(pos.line).text, pos.character);
        return hit ? new vscode.Hover(codeMarkdown(hit.code), new vscode.Range(pos.line, hit.start, pos.line, hit.end)) : undefined;
      },
    }),
  );
}
