// Parser for the IBM i compiler events file (EVFEVENT, produced by OPTION(*EVENTF)).
// Pure module: no vscode dependency so it can be unit tested.

export interface EvfError {
  /** Source file (IFS / QSYS.LIB path) the error belongs to. */
  file: string;
  /** True when this is the source being compiled (not a /COPY member). */
  isMainFile: boolean;
  /** True when the line refers to compiler-generated source (e.g. after the SQL precompiler). */
  generated: boolean;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  messageId: string;
  severity: number;
  message: string;
}

interface FileRecord { id: string; name: string; }

/** Lines of an EVFEVENT member. Returns the errors of every processor block, de-duplicated. */
export function parseEvfEvent(content: string): EvfError[] {
  const lines = content.split(/\r?\n/);
  const errors: EvfError[] = [];
  let files = new Map<string, FileRecord>();
  let mainFileId: string | undefined;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) { continue; }
    const tokens = line.split(/\s+/);
    const record = tokens[0];

    if (record === 'PROCESSOR') {
      files = new Map();
      mainFileId = undefined;
      continue;
    }
    if (record === 'FILEID') {
      // FILEID <ver> <file-id> <line> <length> <name> <timestamp> <temp-flag>
      const id = tokens[2];
      const length = Number(tokens[4]);
      const rest = line.split(/\s+/).slice(5).join(' ');
      const name = Number.isFinite(length) && length > 0 ? rest.substring(0, length) : tokens[5];
      files.set(id, { id, name: name.trim() });
      if (!mainFileId) { mainFileId = id; }
      continue;
    }
    if (record === 'ERROR') {
      // ERROR <ver> <file-id> <annot> <stmt> <sLine> <sCol> <eLine> <eCol> <msgid> <sevChar> <sevNum> <len> <text>
      if (tokens.length < 13) { continue; }
      const fileId = tokens[2];
      const msgLen = Number(tokens[12]);
      const headerMatch = line.match(/^(\S+\s+){13}/);
      const textStart = headerMatch ? headerMatch[0].length : 0;
      let message = line.substring(textStart);
      if (Number.isFinite(msgLen) && msgLen > 0) { message = message.substring(0, msgLen); }
      const file = files.get(fileId)?.name ?? '';
      const generated = /\/QTEMP\.LIB\//i.test(file) || /^QTEMP\//i.test(file);
      errors.push({
        file,
        isMainFile: fileId === mainFileId,
        generated,
        line: Number(tokens[5]) || Number(tokens[4]) || 0,
        column: Number(tokens[6]) || 0,
        endLine: Number(tokens[7]) || Number(tokens[5]) || 0,
        endColumn: Number(tokens[8]) || 0,
        messageId: tokens[9],
        severity: Number(tokens[11]) || 0,
        message: message.trim(),
      });
    }
  }

  const seen = new Set<string>();
  return errors.filter(e => {
    const key = `${e.file}|${e.line}|${e.column}|${e.messageId}|${e.message}`;
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  });
}

/** Map a member reference to its parts, if it is one. */
export function parseQsysPath(path: string): { library: string; file: string; member: string } | undefined {
  // Compilers write members either as LIB/FILE(MEMBER) or as a /QSYS.LIB/... path.
  const short = path.match(/^([^/()\s]+)\/([^/()\s]+)\(([^)\s]+)\)$/);
  if (short) { return { library: short[1].toUpperCase(), file: short[2].toUpperCase(), member: short[3].toUpperCase() }; }
  const m = path.match(/^\/QSYS\.LIB\/(?:([^/]+)\.LIB\/)?([^/]+)\.FILE\/([^/]+)\.MBR$/i);
  if (!m) { return undefined; }
  return { library: (m[1] ?? 'QSYS').toUpperCase(), file: m[2].toUpperCase(), member: m[3].toUpperCase() };
}
