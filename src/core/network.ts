// Network test (ping) and HTTP calls made from the IBM i. Pure functions (no vscode import), unit tested.


export function pingCommand(host: string, packets = 3): string {
  const h = host.trim();
  if (!/^[A-Za-z0-9.:\-_]{1,255}$/.test(h)) { throw new Error('Enter a host name or IP address.'); }
  return `PING RMTSYS('${h}') NBRPKT(${Math.max(1, Math.min(20, packets))}) WAITTIME(2)`;
}

export function parsePing(output: string): { ok: boolean; sent?: number; received?: number; avgMs?: number; text: string } {
  const m = /(\d+)\s+of\s+(\d+)\s+(?:successful|réussi|erfolgreich)/i.exec(output);
  const avg = /(?:average|moyen|Durchschnitt)[^0-9]*([\d.,]+)/i.exec(output);
  const text = output.split('\n').map(l => l.trim()).filter(l => /TCP32|successful|average|Verifying|unknown|not/i.test(l)).slice(0, 6).join('\n');
  if (!m) { return { ok: false, text: text || output.trim().split('\n').slice(-3).join('\n') }; }
  return { ok: Number(m[1]) > 0, received: Number(m[1]), sent: Number(m[2]), avgMs: avg ? Number(avg[1].replace(',', '.')) : undefined, text };
}

/** The JSON options string of QSYS2.HTTP_GET / HTTP_POST for some headers. */
export function httpOptions(headers: Record<string, string>, opts: { sslTolerate?: boolean; timeoutSeconds?: number } = {}): string {
  const o: Record<string, unknown> = {};
  if (Object.keys(headers).length) { o.header = Object.entries(headers).map(([k, v]) => `${k},${v}`).join(','); }
  if (opts.sslTolerate) { o.sslTolerate = 'true'; }
  if (opts.timeoutSeconds) { o.ioTimeout = opts.timeoutSeconds * 1000; }
  return JSON.stringify(o);
}

/** Parse "Name: value" lines into a header object. */
export function parseHeaders(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of input.split(/[\n;]+/)) {
    const m = /^\s*([A-Za-z0-9-]+)\s*:\s*(.+?)\s*$/.exec(l);
    if (m) { if (/,/.test(m[2])) { throw new Error(`Header ${m[1]}: commas are not allowed in a value here.`); } out[m[1]] = m[2]; }
  }
  return out;
}

export function prettyBody(body: string): { text: string; language: string } {
  const t = body.trim();
  if (/^[[{]/.test(t)) { try { return { text: JSON.stringify(JSON.parse(t), null, 2), language: 'json' }; } catch { /* not JSON */ } }
  if (/^</.test(t)) { return { text: t, language: /^<!doctype html|<html/i.test(t) ? 'html' : 'xml' }; }
  return { text: body, language: 'plaintext' };
}

export function httpStatus(headerJsonOrText: string): number | undefined {
  const m = /"HTTP_STATUS_CODE"\s*:\s*"?(\d{3})|HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(headerJsonOrText);
  return m ? Number(m[1] ?? m[2]) : undefined;
}
