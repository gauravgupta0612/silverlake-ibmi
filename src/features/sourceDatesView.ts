import * as vscode from 'vscode';
import { MEMBER_SCHEME, sourceRecords, sourceRecordsChanged } from './fileSystems';
import { SourceRecord, dateToSrcDate, diffLines, formatSeq, formatSrcDate, srcDateToDate } from '../core/sourceDates';

type Display = 'date' | 'seq-date' | 'off';

/**
 * Shows SEU-style sequence numbers and change dates in front of every line of a member,
 * marks lines you changed (not yet saved) and lets you highlight lines changed since a date.
 */
export function registerSourceDates(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('silverlake');
  const display = (): Display => cfg().get<Display>('sourceDates.display', 'date');
  const style = (): 'seu' | 'iso' => cfg().get<string>('sourceDates.format', 'yymmdd') === 'iso' ? 'iso' : 'seu';

  const baseDeco = vscode.window.createTextEditorDecorationType({
    before: { color: new vscode.ThemeColor('editorLineNumber.foreground'), margin: '0 1.4em 0 0' },
  });
  const changedDeco = vscode.window.createTextEditorDecorationType({
    before: { color: new vscode.ThemeColor('editorWarning.foreground'), margin: '0 1.4em 0 0', fontWeight: 'bold' },
  });
  const sinceDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  /** Per document: highlight lines changed on/after this YYMMDD. */
  const since = new Map<string, number>();
  const timers = new Map<string, NodeJS.Timeout>();

  /** Current per-line record (undefined = changed / new since it was read). */
  const currentRecords = (doc: vscode.TextDocument): (SourceRecord | undefined)[] | undefined => {
    const original = sourceRecords.get(doc.uri.toString());
    if (!original) { return undefined; }
    const lines: string[] = [];
    for (let i = 0; i < doc.lineCount; i++) { lines.push(doc.lineAt(i).text.replace(/\s+$/, '')); }
    const map = diffLines(original.map(r => r.text.replace(/\s+$/, '')), lines);
    return map.map(i => (i >= 0 ? original[i] : undefined));
  };

  const render = (editor: vscode.TextEditor) => {
    const doc = editor.document;
    if (doc.uri.scheme !== MEMBER_SCHEME) { return; }
    const mode = display();
    const recs = mode === 'off' ? undefined : currentRecords(doc);
    if (!recs) {
      editor.setDecorations(baseDeco, []);
      editor.setDecorations(changedDeco, []);
      editor.setDecorations(sinceDeco, []);
      return;
    }
    const today = formatSrcDate(dateToSrcDate(new Date()), style());
    const base: vscode.DecorationOptions[] = [];
    const changed: vscode.DecorationOptions[] = [];
    const hi: vscode.Range[] = [];
    const sinceDate = since.get(doc.uri.toString());
    recs.forEach((r, line) => {
      if (line === doc.lineCount - 1 && !doc.lineAt(line).text && !r) { return; }
      const range = new vscode.Range(line, 0, line, 0);
      const date = r ? formatSrcDate(r.date, style()) : today;
      const seq = r ? formatSeq(r.seq) : '  new  ';
      const contentText = mode === 'seq-date' ? `${seq} ${date}` : date;
      (r ? base : changed).push({ range, renderOptions: { before: { contentText } } });
      if (sinceDate && (!r || dateKey(r.date) >= dateKey(sinceDate))) { hi.push(new vscode.Range(line, 0, line, 0)); }
    });
    editor.setDecorations(baseDeco, base);
    editor.setDecorations(changedDeco, changed);
    editor.setDecorations(sinceDeco, hi);
  };

  const renderAll = () => vscode.window.visibleTextEditors.forEach(render);
  const schedule = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      vscode.window.visibleTextEditors.filter(e => e.document === doc).forEach(render);
    }, 250));
  };

  context.subscriptions.push(
    baseDeco, changedDeco, sinceDeco,
    vscode.window.onDidChangeVisibleTextEditors(renderAll),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.document.uri.scheme === MEMBER_SCHEME) { schedule(e.document); } }),
    sourceRecordsChanged.event(uri => vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === uri.toString()).forEach(render)),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('silverlake.sourceDates')) { renderAll(); } }),

    vscode.languages.registerHoverProvider({ scheme: MEMBER_SCHEME }, {
      provideHover(doc, pos) {
        if (pos.character > 0 || display() === 'off') { return undefined; }
        const recs = currentRecords(doc);
        if (!recs) { return undefined; }
        const r = recs[pos.line];
        const md = new vscode.MarkdownString(r
          ? `**Line ${pos.line + 1}** · sequence ${formatSeq(r.seq)}  \nLast changed: ${r.date ? srcDateToDate(r.date)?.toDateString() ?? r.date : 'unknown'}`
          : `**Line ${pos.line + 1}** · changed by you (not saved yet) — it gets today's date when you save.`);
        return new vscode.Hover(md);
      },
    }),

    vscode.commands.registerCommand('silverlake.toggleSourceDates', async () => {
      const next: Record<Display, Display> = { date: 'seq-date', 'seq-date': 'off', off: 'date' };
      const value = next[display()];
      await cfg().update('sourceDates.display', value, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Source dates: ${value === 'off' ? 'hidden' : value === 'date' ? 'dates' : 'sequence numbers and dates'}`, 3000);
    }),

    vscode.commands.registerCommand('silverlake.changedSince', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== MEMBER_SCHEME || !sourceRecords.has(editor.document.uri.toString())) {
        vscode.window.showInformationMessage('Open a source member (with source dates available) first.');
        return;
      }
      const pick = await vscode.window.showQuickPick([
        { label: 'Last 7 days', days: 7 }, { label: 'Last 30 days', days: 30 }, { label: 'Last 90 days', days: 90 },
        { label: 'Since a date…', days: -1 }, { label: 'Clear highlight', days: 0 },
      ], { title: 'Highlight lines changed since…' });
      if (!pick) { return; }
      const key = editor.document.uri.toString();
      if (pick.days === 0) { since.delete(key); render(editor); return; }
      let from: Date;
      if (pick.days > 0) {
        from = new Date(Date.now() - pick.days * 86_400_000);
      } else {
        const v = await vscode.window.showInputBox({
          title: 'Since date', placeHolder: 'YYYY-MM-DD',
          validateInput: s => /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? undefined : 'Use YYYY-MM-DD',
        });
        if (!v) { return; }
        from = new Date(`${v.trim()}T00:00:00`);
      }
      since.set(key, dateToSrcDate(from));
      render(editor);
      const recs = currentRecords(editor.document) ?? [];
      const lines = recs.map((r, i) => ({ r, i })).filter(x => !x.r || dateKey(x.r.date) >= dateKey(dateToSrcDate(from)));
      const go = await vscode.window.showQuickPick(lines.map(x => ({
        label: `$(diff-modified) Line ${x.i + 1}`,
        description: x.r ? formatSrcDate(x.r.date, 'iso') : 'unsaved change',
        detail: editor.document.lineAt(x.i).text.trim() || '(blank)',
        line: x.i,
      })), { title: `${lines.length} line(s) changed since ${from.toISOString().slice(0, 10)} — pick one to jump to it`, matchOnDetail: true });
      if (go) {
        const pos = new vscode.Position(go.line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
  );
  renderAll();
}

/** Comparable value for a YYMMDD date (handles the 1940-2039 window). */
function dateKey(yymmdd: number): number {
  const d = srcDateToDate(yymmdd);
  return d ? d.getTime() : 0;
}
