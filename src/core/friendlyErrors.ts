// Plain-language explanations of IBM i and Db2 errors. Pure functions (no vscode import), unit tested.


interface Hint { test: RegExp; hint: string }

const HINTS: Hint[] = [
  { test: /Read-only connection/i, hint: 'This connection is protected as read-only. Change "Protection" in the connection settings to allow changes.' },
  { test: /java: not found|java.*No such file|UnsupportedClassVersionError/i, hint: 'Mapepire needs Java 11 or later on the IBM i (5770-JV1). Install it, or choose another SQL engine in the connection settings.' },
  { test: /All configured authentication methods failed|Authentication failed|CPF22E2|CPF22E3|CPF22E4/i, hint: 'The user or password was not accepted, or the profile is disabled / expired. Sign on with ACS or 5250 to check it.' },
  { test: /SQL0204.*\b(QSYS2|SYSTOOLS|SYSIBMADM)\b|\b(QSYS2|SYSTOOLS)\.[A-Z_]+ in [A-Z0-9]+ type \*N not found/i, hint: 'This IBM i service is not on your system yet. Install the latest Db2 for i PTF group (SF99xxx) or run "Vanthrex: Self-Check" to see which features your release supports.' },
  { test: /SQL0204|CPF9801|CPF9810|CPF9811|CPF9812|CPF9815|not found/i, hint: 'Check the name and the library list (status bar → quick menu → library list).' },
  { test: /SQL0551|SQL0552|CPF2189|CPF9802|CPF2207|CPF2217|CPF9820|CPF4AB8|not authorized/i, hint: 'You don\'t have the authority this needs. Right-click the object → "Check Authority…" shows what is missing and the GRTOBJAUT to fix it.' },
  { test: /SQL7008|not valid for operation.*journal/i, hint: 'The file is not journaled, so it can\'t be changed under commitment control. Add WITH NC to the statement, or start journaling the file (STRJRNPF).' },
  { test: /SQL0913|CPF3202|CPF3203|CPF3204|CPF1002|in use|allocated to another job/i, hint: 'Another job holds a lock on it. Right-click the object → "Who Has It Locked?" to see the job.' },
  { test: /SQL0443|SQL0440/i, hint: 'An IBM i service failed — the job log of the SQL job usually says why. Turn on "vanthrex.logging" and look at the Vanthrex log.' },
  { test: /SQL0104|SQL0199|Token .* was not valid/i, hint: 'SQL syntax error. Vanthrex uses system naming, so qualify objects as LIBRARY/TABLE.' },
  { test: /SQL0302|SQL0404|SQL0406/i, hint: 'A value is too long or does not fit the column.' },
  { test: /SQL0803/i, hint: 'A row with the same key already exists.' },
  { test: /SQL0530|SQL0532/i, hint: 'A referential constraint stopped the change (parent row missing or child rows exist).' },
  { test: /CPD0043|CPF0001|CPF0006|CPD0012|CPD0071/i, hint: 'The CL command has a parameter error. Press F4 in a CL source (or use the CL runner prompt) to check the parameters.' },
  { test: /CPF9897|CPF9898|CPF9999|MCH\d{4}/i, hint: 'The program ended with an error. Right-click the job → "Analyze Job Log" for the root cause.' },
  { test: /ECONNREFUSED|connect ETIMEDOUT|Timed out while waiting for handshake/i, hint: 'The IBM i did not answer on the SSH port. Check the host name and that SSH runs: STRTCPSVR SERVER(*SSHD).' },
  { test: /ECONNRESET|Not connected|No response from server|Channel open failure|socket hang up|EPIPE/i, hint: 'The connection was lost (network, sleep, or the SSH job ended). Reconnect from the Connections view; Vanthrex keeps your settings.' },
];

/** A plain-language hint for an IBM i / Db2 / SSH error, or undefined. */
export function explainError(message: string): string | undefined {
  return HINTS.find(h => h.test.test(message))?.hint;
}
