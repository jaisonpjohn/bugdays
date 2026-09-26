// WS-Security UsernameToken generation is deliberately send-time only.
const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const PROFILE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0';
const SECURITY = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0';

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('The SOAP request XML is not well formed.');
  return doc;
}

const base64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));

export async function usernameTokenRequest(xml: string, username: string, password: string, mode: 'text' | 'digest'): Promise<string> {
  if (!username || !password) throw new Error('Enter a WS-Security username and password before sending.');
  const doc = parseXml(xml);
  const envelope = doc.documentElement;
  if (envelope.localName !== 'Envelope' || !['http://schemas.xmlsoap.org/soap/envelope/', 'http://www.w3.org/2003/05/soap-envelope'].includes(envelope.namespaceURI || '')) throw new Error('The request needs a SOAP 1.1 or 1.2 Envelope before a UsernameToken can be added.');
  const soapNs = envelope.namespaceURI;
  const body = Array.from(envelope.children).find(child => child.localName === 'Body' && child.namespaceURI === soapNs);
  if (!body) throw new Error('The SOAP Envelope has no Body.');
  let header = Array.from(envelope.children).find(child => child.localName === 'Header' && child.namespaceURI === soapNs);
  if (!header) {
    header = doc.createElementNS(soapNs, `${envelope.prefix || 'soap'}:Header`);
    envelope.insertBefore(header, body);
  }
  if (Array.from(header.children).some(child => child.localName === 'Security' && child.namespaceURI === WSSE)) {
    throw new Error('This envelope already has a WS-Security header. Remove it or turn off the UsernameToken helper.');
  }
  const created = new Date().toISOString();
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  let passwordValue = password;
  if (mode === 'digest') {
    const createdBytes = new TextEncoder().encode(created);
    const passwordBytes = new TextEncoder().encode(password);
    const input = new Uint8Array(nonce.length + createdBytes.length + passwordBytes.length);
    input.set(nonce);
    input.set(createdBytes, nonce.length);
    input.set(passwordBytes, nonce.length + createdBytes.length);
    passwordValue = base64(new Uint8Array(await crypto.subtle.digest('SHA-1', input)));
  }
  const add = (parent: Element, ns: string, name: string, value?: string): Element => {
    const node = doc.createElementNS(ns, `${ns === WSSE ? 'wsse' : 'wsu'}:${name}`);
    if (value !== undefined) node.textContent = value;
    parent.appendChild(node);
    return node;
  };
  const security = add(header, WSSE, 'Security');
  security.setAttribute('xmlns:wsse', WSSE);
  security.setAttribute('xmlns:wsu', WSU);
  const token = add(security, WSSE, 'UsernameToken');
  add(token, WSSE, 'Username', username);
  add(token, WSSE, 'Password', passwordValue).setAttribute('Type', `${PROFILE}#Password${mode === 'digest' ? 'Digest' : 'Text'}`);
  add(token, WSSE, 'Nonce', base64(nonce)).setAttribute('EncodingType', `${SECURITY}#Base64Binary`);
  add(token, WSU, 'Created', created);
  const timestamp = add(security, WSU, 'Timestamp');
  add(timestamp, WSU, 'Created', created);
  add(timestamp, WSU, 'Expires', new Date(Date.parse(created) + 5 * 60_000).toISOString());
  return new XMLSerializer().serializeToString(doc);
}

/** Strip the entire SOAP Header before a request enters a share link or local storage. */
export function requestWithoutSoapHeader(xml: string): string {
  try {
    const doc = parseXml(xml);
    const envelope = doc.documentElement;
    if (envelope.localName !== 'Envelope') return '';
    const headers = Array.from(envelope.children).filter(child => child.localName === 'Header' && child.namespaceURI === envelope.namespaceURI);
    for (const header of headers) header.replaceChildren();
    return new XMLSerializer().serializeToString(doc);
  } catch { return ''; }
}
