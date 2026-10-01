export type CurlTarget = 'fetch' | 'python' | 'curl';

export interface CurlRequest {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
  auth?: [string, string];
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  const source = command.replace(/\\\r?\n/g, ' ');
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote === 'single') {
      if (character === "'") quote = null;
      else current += character;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') quote = null;
      else if (character === '\\' && index + 1 < source.length) current += source[++index];
      else current += character;
      continue;
    }
    if (character === "'") { quote = 'single'; continue; }
    if (character === '"') { quote = 'double'; continue; }
    if (/\s/.test(character)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    if (character === '\\' && index + 1 < source.length) { current += source[++index]; continue; }
    current += character;
  }
  if (quote) throw new Error('Unclosed quote in the cURL command.');
  if (current) tokens.push(current);
  return tokens;
}

function splitHeader(value: string): [string, string] {
  const separator = value.indexOf(':');
  if (separator < 1) throw new Error(`Header "${value}" needs a name followed by a colon.`);
  return [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
}

function optionValue(tokens: string[], index: number, option: string): [string, number] {
  const equals = option.indexOf('=');
  if (equals > -1) return [option.slice(equals + 1), index];
  const value = tokens[index + 1];
  if (value === undefined) throw new Error(`${option} needs a value.`);
  return [value, index + 1];
}

function shortOptionValue(tokens: string[], index: number, option: string, shortName: string): [string, number] {
  if (option.length > shortName.length) return [option.slice(shortName.length), index];
  return optionValue(tokens, index, option);
}

export function parseCurl(command: string): CurlRequest {
  const tokens = shellTokens(command.trim());
  if (tokens[0] !== 'curl') throw new Error('Start with curl, then paste the full command.');
  const headers: Array<[string, string]> = [];
  const data: string[] = [];
  let method = '';
  let url = '';
  let auth: [string, string] | undefined;
  let useGet = false;
  let expectUrl = false;

  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (expectUrl) { url = token; expectUrl = false; continue; }
    if (token === '--url') { expectUrl = true; continue; }
    if (token.startsWith('--url=')) { url = token.slice(6); continue; }
    if (token === '-X' || token.startsWith('-X') || token === '--request' || token.startsWith('--request=')) { const [value, consumed] = token.startsWith('-X') ? shortOptionValue(tokens, index, token, '-X') : optionValue(tokens, index, token); method = value.toUpperCase(); index = consumed; continue; }
    if (token === '-H' || token.startsWith('-H') || token === '--header' || token.startsWith('--header=')) { const [value, consumed] = token.startsWith('-H') ? shortOptionValue(tokens, index, token, '-H') : optionValue(tokens, index, token); headers.push(splitHeader(value)); index = consumed; continue; }
    if (token === '-u' || token.startsWith('-u') || token === '--user' || token.startsWith('--user=')) { const [value, consumed] = token.startsWith('-u') ? shortOptionValue(tokens, index, token, '-u') : optionValue(tokens, index, token); const separator = value.indexOf(':'); auth = [separator < 0 ? value : value.slice(0, separator), separator < 0 ? '' : value.slice(separator + 1)]; index = consumed; continue; }
    if (token === '-d' || token.startsWith('-d') || token === '--data' || token === '--data-raw' || token === '--data-binary' || token.startsWith('--data=') || token.startsWith('--data-raw=') || token.startsWith('--data-binary=')) { const [value, consumed] = token.startsWith('-d') ? shortOptionValue(tokens, index, token, '-d') : optionValue(tokens, index, token); data.push(value); index = consumed; continue; }
    if (token === '-G' || token === '--get') { useGet = true; continue; }
    if (token === '--compressed' || token === '-s' || token === '--silent' || token === '-L' || token === '--location' || token === '-i' || token === '--include') continue;
    if (token.startsWith('-')) continue;
    if (!url) url = token;
  }
  if (expectUrl || !url) throw new Error('A cURL command needs a URL.');
  let body = data.length ? data.join('&') : undefined;
  if (useGet && body) {
    const join = url.includes('?') ? '&' : '?';
    url += `${join}${body}`;
    body = undefined;
  }
  return { method: useGet ? 'GET' : method || (body ? 'POST' : 'GET'), url, headers, ...(body === undefined ? {} : { body }), ...(auth ? { auth } : {}) };
}

function js(value: unknown) { return JSON.stringify(value, null, 2); }

export function generateCurlCode(request: CurlRequest, target: CurlTarget): string {
  if (target === 'curl') {
    const parts = [`curl -X ${request.method}`, ...request.headers.map(([name, value]) => `  -H ${JSON.stringify(`${name}: ${value}`)}`), ...(request.auth ? [`  -u ${JSON.stringify(request.auth.join(':'))}`] : []), ...(request.body === undefined ? [] : [`  --data-raw ${JSON.stringify(request.body)}`]), `  ${JSON.stringify(request.url)}`];
    return parts.join(' \\\n');
  }
  if (target === 'python') {
    const lines = ['import requests', '', 'response = requests.request(', `    ${JSON.stringify(request.method)},`, `    ${JSON.stringify(request.url)},`];
    if (request.headers.length) lines.push(`    headers=${js(Object.fromEntries(request.headers))},`);
    if (request.body !== undefined) lines.push(`    data=${JSON.stringify(request.body)},`);
    if (request.auth) lines.push(`    auth=${js(request.auth)},`);
    lines.push(')', 'response.raise_for_status()', 'print(response.text)');
    return lines.join('\n');
  }
  const hasHeaders = request.headers.length > 0 || request.auth !== undefined;
  const lines = request.auth
    ? [`const headers = ${js(Object.fromEntries(request.headers))};`, `headers.Authorization = 'Basic ' + btoa(${JSON.stringify(request.auth.join(':'))});`, '']
    : [];
  lines.push('const response = await fetch(', `  ${JSON.stringify(request.url)},`, '  {', `    method: ${JSON.stringify(request.method)},`);
  if (hasHeaders) lines.push(`    headers: ${request.auth ? 'headers' : js(Object.fromEntries(request.headers))},`);
  if (request.body !== undefined) lines.push(`    body: ${JSON.stringify(request.body)},`);
  lines.push('  },', ');', '', 'if (!response.ok) throw new Error(`HTTP ${response.status}`);', 'console.log(await response.text());');
  return lines.join('\n');
}
