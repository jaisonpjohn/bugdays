// "Paste Anything" detection engine.
// Given an arbitrary pasted blob, figure out what it is (JWT, base64, gzip,
// JSON, epoch, DDL, …), unwrap encodings recursively, and produce deep links
// into the right tools with the data preloaded (via the share-state hash).
// Everything runs in the browser — nothing is uploaded.

import { parseTerminalTable } from './ascii-table';

export interface ToolAction {
  label: string;
  toolId: string;      // matches the tool page's toolId (share state `t`)
  href: string;        // tool page path
  data: Record<string, any>; // share-state payload (keys = data-share-key)
  action?: string;     // share-state action to replay on load
}

export interface Detection {
  id: string;
  title: string;
  confidence: number;    // 0..100
  chain?: string[];      // e.g. ['Base64', 'GZip', 'JSON']
  note?: string;
  preview?: string;
  primary?: ToolAction;
  secondary?: ToolAction;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printableRatio(s: string): number {
  if (!s.length) return 0;
  let ok = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 0xfffd)) ok++;
  }
  return ok / [...s].length;
}

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch { return null; }
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

async function gunzip(bytes: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  } catch { return null; }
}

function tryJson(s: string): any | undefined {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

function b64UrlDecode(part: string): string | null {
  const pad = part.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = b64ToBytes(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return bytes ? bytesToText(bytes) : null;
}

const clip = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + '…' : s);

// What is some unwrapped inner content? (shallow re-sniff for chains)
function innerKind(s: string): { label: string; tool?: ToolAction } | null {
  const t = s.trim();
  if (tryJson(t) !== undefined) {
    return { label: 'JSON', tool: { label: 'Format the JSON', toolId: 'json-formatter', href: '/json-formatter', data: { json: t }, action: 'prettify' } };
  }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(t) && t.split('.').length === 3) {
    const header = b64UrlDecode(t.split('.')[0]);
    if (header && tryJson(header)?.alg) {
      return { label: 'JWT', tool: { label: 'Decode the JWT', toolId: 'jwt-decoder', href: '/jwt-decoder', data: { jwt: t } } };
    }
  }
  if (/^\s*</.test(t) && /<\/|\/>/.test(t)) {
    return { label: 'XML', tool: { label: 'Format the XML', toolId: 'xml-formatter', href: '/xml-formatter', data: { xml: t }, action: 'format' } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Individual detectors
// ---------------------------------------------------------------------------

type Detector = (input: string) => Promise<Detection | null> | Detection | null;

const detectJwt: Detector = (input) => {
  const t = input.trim();
  if (!/^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/.test(t)) return null;
  const [h, p] = t.split('.');
  const header = b64UrlDecode(h);
  const payload = b64UrlDecode(p);
  const headerObj = header ? tryJson(header) : undefined;
  if (!headerObj?.alg) return null;
  let preview = '';
  const payloadObj = payload ? tryJson(payload) : undefined;
  if (payloadObj) {
    preview = JSON.stringify(payloadObj, null, 2);
    if (payloadObj.exp) {
      const expired = payloadObj.exp * 1000 < Date.now();
      preview += `\n\n// ${expired ? '⚠ expired' : 'expires'} ${new Date(payloadObj.exp * 1000).toISOString()}`;
    }
  }
  return {
    id: 'jwt', title: 'JWT token', confidence: 98,
    note: `Signed with ${headerObj.alg}${headerObj.typ ? ` · type ${headerObj.typ}` : ''}`,
    preview: clip(preview),
    primary: { label: 'Open in JWT Decoder', toolId: 'jwt-decoder', href: '/jwt-decoder', data: { jwt: t } },
  };
};

const detectJson: Detector = (input) => {
  const t = input.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  const parsed = tryJson(t);
  if (parsed !== undefined) {
    const kind = Array.isArray(parsed) ? `array of ${parsed.length}` : `object with ${Object.keys(parsed).length} keys`;
    return {
      id: 'json', title: 'JSON', confidence: 96,
      note: `Valid JSON — ${kind}`,
      primary: { label: 'Open in JSON Formatter', toolId: 'json-formatter', href: '/json-formatter', data: { json: t }, action: 'prettify' },
      secondary: Array.isArray(parsed)
        ? { label: 'Generate an ASCII table', toolId: 'ascii-table-generator', href: '/ascii-table-generator', data: { input: t, format: 'json' }, action: 'generate' }
        : undefined,
    };
  }
  return {
    id: 'json-broken', title: 'JSON (invalid)', confidence: 45,
    note: 'Looks like JSON but does not parse — the formatter will pinpoint the error',
    primary: { label: 'Find the error in JSON Formatter', toolId: 'json-formatter', href: '/json-formatter', data: { json: t }, action: 'prettify' },
  };
};

const detectCertificate: Detector = (input) => {
  const trimmed = input.trim();
  const certificateCount = (trimmed.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
  const isBundle = /-----BEGIN (?:PKCS7|CMS)-----/.test(trimmed);
  if (!certificateCount && !isBundle) return null;
  return {
    id: 'certificate',
    title: isBundle ? 'PKCS#7 certificate bundle' : certificateCount > 1 ? 'PEM certificate chain' : 'X.509 certificate',
    confidence: 99,
    note: isBundle ? 'Inspect the certificates and export the bundle' : `${certificateCount} public certificate${certificateCount === 1 ? '' : 's'} found`,
    primary: {
      label: 'Inspect and convert certificate',
      toolId: 'certificate-inspector',
      href: '/certificate-inspector',
      data: { certificate: input },
      action: 'inspect',
    },
  };
};

const detectDataUriImage: Detector = (input) => {
  const t = input.trim();
  if (!/^data:image\/[a-z+.-]+;base64,/i.test(t)) return null;
  return {
    id: 'data-uri', title: 'Image (data URI)', confidence: 98,
    note: `${t.match(/^data:(image\/[a-z+.-]+)/i)?.[1]} · ~${Math.round((t.length * 3) / 4 / 1024)} KB`,
    primary: { label: 'View in Image ↔ Base64', toolId: 'image-base64', href: '/image-base64', data: { base64: t } },
  };
};

const detectBase64: Detector = async (input) => {
  // Real base64 is never space-separated (newline wraps are fine, PEM-style)
  if (/ /.test(input.trim())) return null;
  const t = input.replace(/\s+/g, '');
  if (t.length < 8 || t.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  if (!/[A-Za-z]/.test(t)) return null; // pure digits → likely a number, not base64
  const bytes = b64ToBytes(t);
  if (!bytes) return null;

  // GZip inside?
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const text = await gunzip(bytes);
    if (text !== null) {
      const inner = innerKind(text);
      const chain = ['Base64', 'GZip', inner?.label ?? 'Text'];
      return {
        id: 'gzip-b64', title: 'GZip compressed, Base64 encoded', confidence: 97,
        chain,
        preview: clip(text),
        primary: { label: 'Open in GZip & Base64', toolId: 'gzip-base64', href: '/gzip-base64', data: { input: t }, action: 'decompress' },
        secondary: inner?.tool,
      };
    }
    return {
      id: 'gzip-b64', title: 'GZip data, Base64 encoded', confidence: 90,
      chain: ['Base64', 'GZip'],
      note: 'Decompression not supported in this browser',
      primary: { label: 'Open in GZip & Base64', toolId: 'gzip-base64', href: '/gzip-base64', data: { input: t }, action: 'decompress' },
    };
  }

  // Image inside?
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
  if (isPng || isJpg || isGif) {
    return {
      id: 'b64-image', title: `Base64-encoded ${isPng ? 'PNG' : isJpg ? 'JPEG' : 'GIF'} image`, confidence: 97,
      chain: ['Base64', 'Image'],
      primary: { label: 'View in Image ↔ Base64', toolId: 'image-base64', href: '/image-base64', data: { base64: t } },
    };
  }

  // Text inside?
  const text = bytesToText(bytes);
  if (printableRatio(text) > 0.9) {
    const inner = innerKind(text);
    // Plain short words ("test") base64-decode to garbage that is still printable;
    // demand either decent length or a recognized inner format before claiming.
    const confidence = inner ? 92 : t.length >= 16 ? 70 : 35;
    return {
      id: 'base64', title: 'Base64-encoded text', confidence,
      chain: ['Base64', inner?.label ?? 'Text'],
      preview: clip(text),
      primary: { label: 'Open in Base64 Decoder', toolId: 'base64', href: '/base64-encoder-decoder', data: { input: t }, action: 'decode' },
      secondary: inner?.tool,
    };
  }
  return {
    id: 'base64-bin', title: 'Base64 (binary payload)', confidence: 30,
    note: `Decodes to ${bytes.length} bytes of binary data`,
    primary: { label: 'Open in Base64 Decoder', toolId: 'base64', href: '/base64-encoder-decoder', data: { input: t }, action: 'decode' },
  };
};

const detectUrlEncoded: Detector = (input) => {
  const t = input.trim();
  if (!/%[0-9A-Fa-f]{2}/.test(t)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(t.replace(/\+/g, '%20')); } catch { return null; }
  if (decoded === t) return null;
  const inner = innerKind(decoded);
  return {
    id: 'urlencoded', title: 'URL-encoded text', confidence: inner ? 90 : 80,
    chain: ['URL encoding', inner?.label ?? 'Text'],
    preview: clip(decoded),
    primary: { label: 'Open in URL Decoder', toolId: 'url-encoder', href: '/url-encoder', data: { input: t }, action: 'decode' },
    secondary: inner?.tool,
  };
};

const detectUrl: Detector = (input) => {
  const t = input.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return null;
  try {
    const u = new URL(t);
    const params = [...u.searchParams.keys()];
    return {
      id: 'url', title: 'URL', confidence: 85,
      note: `${u.hostname}${u.pathname !== '/' ? ' · ' + u.pathname : ''}${params.length ? ` · ${params.length} query param${params.length > 1 ? 's' : ''}` : ''}`,
      primary: { label: 'Decode in URL Encoder', toolId: 'url-encoder', href: '/url-encoder', data: { input: t }, action: 'decode' },
    };
  } catch { return null; }
};

const detectQueryString: Detector = (input) => {
  const t = input.trim();
  if (!/^[\w%.~+-]+=[^&\s]*(&[\w%.~+-]+=[^&\s]*)+$/.test(t)) return null;
  return {
    id: 'querystring', title: 'Query string', confidence: 75,
    note: `${t.split('&').length} parameters`,
    primary: { label: 'Decode in URL Encoder', toolId: 'url-encoder', href: '/url-encoder', data: { input: t }, action: 'decode' },
  };
};

const detectEpoch: Detector = (input) => {
  const t = input.trim();
  if (!/^\d{10}$|^\d{13}$|^\d{16}$|^\d{19}$/.test(t)) return null;
  const unit = t.length === 10 ? 'seconds' : t.length === 13 ? 'milliseconds' : t.length === 16 ? 'microseconds' : 'nanoseconds';
  const sec = Math.floor(Number(t) / Math.pow(10, t.length - 10));
  const date = new Date(sec * 1000);
  if (date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) return null;
  return {
    id: 'epoch', title: `Unix timestamp (${unit})`, confidence: 92,
    preview: `UTC:   ${date.toISOString()}\nLocal: ${date.toString()}`,
    primary: { label: 'Open in DateTime Converter', toolId: 'datetime-converter', href: '/datetime-converter', data: { unixSec: String(sec) } },
  };
};

const detectIsoDate: Detector = (input) => {
  const t = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(t)) return null;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return null;
  return {
    id: 'isodate', title: 'ISO 8601 date/time', confidence: 90,
    preview: `Epoch seconds: ${Math.floor(ms / 1000)}\nLocal: ${new Date(ms).toString()}`,
    primary: { label: 'Open in DateTime Converter', toolId: 'datetime-converter', href: '/datetime-converter', data: { unixSec: String(Math.floor(ms / 1000)) } },
  };
};

const detectUuid: Detector = (input) => {
  const t = input.trim();
  const m = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{12}$/i.exec(t);
  if (!m) return null;
  const version = parseInt(m[1], 16);
  const note = version === 4 ? 'v4 (random)' : version === 7 ? 'v7 (timestamp-ordered)' : version === 1 ? 'v1 (MAC + time)' : `v${version}`;
  let preview: string | undefined;
  if (version === 7) {
    const ms = parseInt(t.replace(/-/g, '').slice(0, 12), 16);
    preview = `Embedded timestamp: ${new Date(ms).toISOString()}`;
  }
  return { id: 'uuid', title: 'UUID', confidence: 98, note: `UUID ${note}`, preview };
};

const detectDdl: Detector = (input) => {
  if (!/\bcreate\s+(or\s+replace\s+)?(temporary\s+|temp\s+|unlogged\s+)?table\b/i.test(input)) return null;
  const tableCount = (input.match(/\bcreate\s+(or\s+replace\s+)?(temporary\s+|temp\s+|unlogged\s+)?table\b/gi) || []).length;
  return {
    id: 'ddl', title: 'SQL schema (DDL)', confidence: 96,
    note: `${tableCount} CREATE TABLE statement${tableCount > 1 ? 's' : ''} — view relationships as an ER diagram`,
    primary: { label: 'Open in Schema Explorer', toolId: 'schema-explorer', href: '/schema-explorer', data: { ddl: input }, action: 'explore' },
  };
};

const detectXml: Detector = (input) => {
  const t = input.trim();
  if (!t.startsWith('<')) return null;
  if (!/<\/[\w:-]+>|\/>/.test(t)) return null;
  const isHtml = /^<!doctype html|<html[\s>]/i.test(t);
  return {
    id: 'xml', title: isHtml ? 'HTML' : 'XML', confidence: isHtml ? 70 : 90,
    primary: { label: 'Open in XML Formatter', toolId: 'xml-formatter', href: '/xml-formatter', data: { xml: t }, action: 'format' },
  };
};

const detectYaml: Detector = (input) => {
  const t = input.trim();
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('<')) return null;
  const lines = t.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) return null;
  const kvLines = lines.filter(l => /^\s*[\w."'-]+:(\s|$)/.test(l) || /^\s*-\s+/.test(l));
  if (kvLines.length / lines.length < 0.6) return null;
  return {
    id: 'yaml', title: 'YAML', confidence: 65,
    primary: { label: 'Open in YAML Viewer', toolId: 'yaml-formatter', href: '/yaml-formatter', data: { yaml: t }, action: 'parse' },
    secondary: { label: 'Convert to JSON', toolId: 'yaml-json-converter', href: '/yaml-json-converter', data: { yaml: t } },
  };
};

const detectToml: Detector = (input) => {
  const t = input.trim();
  if (!/^\s*\[[\w."-]+\]\s*$/m.test(t) || !/^\s*[\w."-]+\s*=\s*\S/m.test(t)) return null;
  return {
    id: 'toml', title: 'TOML', confidence: 78,
    primary: { label: 'Open in TOML Viewer', toolId: 'toml-viewer', href: '/toml-viewer', data: { toml: t } },
  };
};

const detectCsv: Detector = (input) => {
  const lines = input.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;
  for (const sep of [',', '\t', ';']) {
    const counts = lines.slice(0, 8).map(l => l.split(sep).length - 1);
    if (counts[0] >= 1 && counts.every(c => c === counts[0])) {
      return {
        id: 'csv', title: sep === '\t' ? 'TSV (tab-separated)' : 'CSV', confidence: 60,
        note: `${lines.length} rows × ${counts[0] + 1} columns`,
        primary: { label: 'Convert to JSON', toolId: 'csv-json-converter', href: '/csv-json-converter', data: { input: input.trim() }, action: 'csvToJson' },
        secondary: { label: 'Generate an ASCII table', toolId: 'ascii-table-generator', href: '/ascii-table-generator', data: { input: input.trim(), format: sep === '\t' ? 'tsv' : 'csv' }, action: 'generate' },
      };
    }
  }
  return null;
};

const detectAsciiTable: Detector = (input) => {
  const trimmed = input.trim();
  const lines = trimmed.split('\n').filter(line => line.trim());
  if (lines.length < 2) return null;

  // The parser deliberately accepts loose fixed-width output. Magic Box needs
  // stronger evidence so ordinary prose and source code are not called tables.
  const hasUnicodeBox = /[┌┐└┘├┤┬┴┼╭╮╯╰╔╗╚╝╠╣╦╩╬│┃║]/u.test(trimmed);
  const hasAsciiBorder = lines.some(line => /^\s*\+(?:[-=_]{2,}\+){2,}\s*$/.test(line));
  const pipeRows = lines.filter(line => (line.match(/[|│┃║]/g) || []).length >= 2).length;
  const hasFixedUnderline = lines.some(line => /^\s*[-=_—─━═]{2,}(?:\s{2,}[-=_—─━═]{2,})+\s*$/u.test(line));
  const tabRows = lines.filter(line => line.split(/\t+/).length >= 2).length;
  const spacedRows = lines.filter(line => line.trim().split(/ {2,}/).length >= 2).length;
  const hasStrongEvidence = hasUnicodeBox
    || hasAsciiBorder
    || pipeRows >= 2
    || hasFixedUnderline
    || tabRows >= 2
    || (lines.length >= 3 && spacedRows >= 3);
  if (!hasStrongEvidence) return null;

  try {
    const parsed = parseTerminalTable(input);
    const columns = parsed.rows[0]?.length || 0;
    if (parsed.rows.length < 2 || columns < 2) return null;
    const confidence = hasUnicodeBox || hasAsciiBorder
      ? 97
      : pipeRows >= 2 || hasFixedUnderline
        ? 91
        : tabRows >= 2
          ? 84
          : 72;
    return {
      id: 'ascii-table',
      title: 'Terminal / ASCII table',
      confidence,
      note: `${parsed.rows.length} rows × ${columns} columns · ${parsed.formatLabel}`,
      primary: {
        label: 'Open in ASCII Table Converter',
        toolId: 'ascii-table-converter',
        href: '/ascii-table-converter',
        data: { table: input },
        action: 'convert',
      },
    };
  } catch {
    return null;
  }
};

const detectCron: Detector = (input) => {
  const t = input.trim();
  const fields = t.split(/\s+/);
  if (fields.length < 5 || fields.length > 7) return null;
  if (!fields.every(f => /^[\d*/,\-A-Za-z?#LW]+$/.test(f))) return null;
  if (!t.includes('*') && !/\d/.test(t)) return null;
  return {
    id: 'cron', title: 'Cron expression', confidence: 82,
    primary: { label: 'Explain in Cron Parser', toolId: 'cron-parser', href: '/cron-parser', data: { cron: t } },
  };
};

const detectColor: Detector = (input) => {
  const t = input.trim();
  const isHex = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t) && (t.startsWith('#') || /[a-f]/i.test(t));
  const isFn = /^(rgba?|hsla?)\(\s*[\d.,%\s/]+\)$/i.test(t);
  if (!isHex && !isFn) return null;
  return {
    id: 'color', title: 'Color', confidence: isHex && t.startsWith('#') ? 95 : 75,
    primary: { label: 'Open in Color Converter', toolId: 'color-converter', href: '/color-converter', data: { hex: t.startsWith('#') || isFn ? t : '#' + t } },
  };
};

const detectIpCidr: Detector = (input) => {
  const t = input.trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/.exec(t);
  if (!m) return null;
  if ([m[1], m[2], m[3], m[4]].some(o => Number(o) > 255)) return null;
  return {
    id: 'cidr', title: m[5] ? 'CIDR range' : 'IPv4 address', confidence: 94,
    primary: { label: 'Open in CIDR Calculator', toolId: 'cidr-calculator', href: '/cidr-calculator', data: { cidr: m[5] ? t : t + '/32' } },
  };
};

const detectUnixPerms: Detector = (input) => {
  const t = input.trim();
  const octal = /^[0-7]{3,4}$/.test(t);
  const symbolic = /^[dlbcps-][rwxsStT-]{9}$/.test(t);
  if (!octal && !symbolic) return null;
  return {
    id: 'perms', title: 'Unix file permissions', confidence: octal ? 60 : 92,
    primary: { label: 'Open in Unix Permissions', toolId: 'unix-permissions', href: '/unix-permissions', data: { perms: symbolic ? t.slice(1) : t } },
  };
};

const detectHex: Detector = (input) => {
  const t = input.trim().replace(/^0x/i, '');
  if (t.length < 8 || t.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(t)) return null;
  if (/^\d+$/.test(t)) return null; // all digits → probably a number
  const bytes = new Uint8Array(t.match(/../g)!.map(h => parseInt(h, 16)));
  const text = bytesToText(bytes);
  const lengths: Record<number, string> = { 32: 'MD5', 40: 'SHA-1', 64: 'SHA-256', 128: 'SHA-512' };
  const hashGuess = lengths[t.length];
  if (printableRatio(text) > 0.9) {
    return { id: 'hex', title: 'Hex-encoded text', confidence: 55, chain: ['Hex', 'Text'], preview: clip(text) };
  }
  if (hashGuess) {
    return {
      id: 'hash', title: `Hash digest (${hashGuess}-sized)`, confidence: 70,
      note: `${t.length} hex chars = ${t.length / 2} bytes — matches ${hashGuess}`,
      primary: { label: 'Open Hash Generator', toolId: 'hash-generator', href: '/hash-generator', data: {} },
    };
  }
  return { id: 'hex-bin', title: 'Hex string', confidence: 40, note: `${t.length / 2} bytes of binary data` };
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const DETECTORS: Detector[] = [
  detectJwt, detectDataUriImage, detectJson, detectDdl, detectCertificate, detectXml,
  detectEpoch, detectIsoDate, detectUuid, detectColor, detectIpCidr,
  detectCron, detectUnixPerms, detectUrl, detectUrlEncoded, detectQueryString,
  detectBase64, detectHex, detectToml, detectAsciiTable, detectYaml, detectCsv,
];

export async function detect(input: string): Promise<Detection[]> {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const results: Detection[] = [];
  for (const d of DETECTORS) {
    try {
      const r = await d(input);
      if (r) results.push(r);
    } catch { /* a broken detector must never break the box */ }
  }

  results.sort((a, b) => b.confidence - a.confidence);

  // Fallback so the box never comes up empty-handed
  if (!results.length || results[0].confidence < 50) {
    const lines = trimmed.split('\n').length;
    results.push({
      id: 'text', title: 'Plain text', confidence: 20,
      note: `${lines} line${lines > 1 ? 's' : ''}, ${trimmed.length} characters`,
      primary: { label: 'Diff against another text', toolId: 'text-diff', href: '/text-diff', data: { text1: trimmed } },
    });
  }
  return results;
}
