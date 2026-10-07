// Browser-native XML inspection. Never evaluate or upload message content.
export const SOAP_NAMESPACES = {
  '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
  '1.2': 'http://www.w3.org/2003/05/soap-envelope',
} as const;
export type SoapVersion = keyof typeof SOAP_NAMESPACES;
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const XML = 'http://www.w3.org/XML/1998/namespace';
const child = (node: Element, name: string, ns: string | null) => [...node.children].find(item => item.localName === name && item.namespaceURI === ns);

export function parseSoapXml(xml: string): Document {
  if (xml.length > 5 * 1024 * 1024) throw new Error('XML is larger than 5 MB. Use a smaller request or response.');
  // SOAP excludes DTDs. Also prevents expansion/entity surprises in pasted XML.
  if (/<!DOCTYPE\s/i.test(xml)) throw new Error('SOAP messages cannot contain a DOCTYPE.');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.getElementsByTagNameNS('http://www.mozilla.org/newlayout/xml/parsererror.xml', 'parsererror').length) throw new Error('The XML is not well formed. Check matching tags, attributes, and namespace declarations.');
  return doc;
}

export function soapEnvelope(xml: string, expected?: SoapVersion): { doc: Document; version: SoapVersion; body: Element } {
  const doc = parseSoapXml(xml);
  const root = doc.documentElement;
  const version = (Object.keys(SOAP_NAMESPACES) as SoapVersion[]).find(item => SOAP_NAMESPACES[item] === root.namespaceURI);
  if (root.localName !== 'Envelope' || !version) throw new Error('Use a SOAP Envelope with the SOAP 1.1 or SOAP 1.2 namespace, not just an operation element.');
  if (expected && expected !== version) throw new Error(`The XML envelope is SOAP ${version}, but SOAP ${expected} is selected. Match the version before sending.`);
  const children = [...root.children];
  const bodies = children.filter(item => item.localName === 'Body' && item.namespaceURI === root.namespaceURI);
  const headers = children.filter(item => item.localName === 'Header' && item.namespaceURI === root.namespaceURI);
  if (bodies.length !== 1 || headers.length > 1 || (headers[0] && children.indexOf(headers[0]) > children.indexOf(bodies[0]))) throw new Error('A SOAP envelope needs exactly one Body and at most one Header, before the Body.');
  return { doc, version, body: bodies[0] };
}

/** Only replace SOAP namespace nodes. Business fields, text, and CDATA remain intact. */
export function changeSoapVersion(xml: string, version: SoapVersion): string {
  const { doc, version: oldVersion } = soapEnvelope(xml);
  if (version === oldVersion) return xml;
  if (doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature').length) throw new Error('This envelope is signed. Changing its version would invalidate the signature; use an unsigned request.');
  const oldNs = SOAP_NAMESPACES[oldVersion], newNs = SOAP_NAMESPACES[version];
  function replace(node: Element, depth = 0): Element {
    if (depth > 200) throw new Error('The XML is too deeply nested to change versions safely. Edit the envelope namespace manually.');
    const result = doc.createElementNS(node.namespaceURI === oldNs ? newNs : node.namespaceURI, node.tagName);
    for (const attr of [...node.attributes]) {
      if (attr.namespaceURI === XMLNS) {
        // Keep payload namespace bindings; the serializer supplies necessary overrides.
        result.setAttributeNS(XMLNS, attr.name, attr.value === oldNs && node.namespaceURI === oldNs ? newNs : attr.value);
      } else result.setAttributeNS(attr.namespaceURI === oldNs ? newNs : attr.namespaceURI, attr.name, attr.value);
    }
    for (const item of [...node.childNodes]) result.appendChild(item.nodeType === Node.ELEMENT_NODE ? replace(item as Element, depth + 1) : item.cloneNode(true));
    return result;
  }
  doc.replaceChild(replace(doc.documentElement), doc.documentElement);
  return new XMLSerializer().serializeToString(doc);
}

/** Readable element-only XML; never trim leaf text, mixed content, CDATA or xml:space. */
export function readableSoapXml(xml: string): string {
  if (!xml.trim()) return xml;
  const doc = parseSoapXml(xml);
  if (doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature').length) return xml;
  function indent(node: Element, depth: number): void {
    if (depth > 80 || node.getAttributeNS(XML, 'space') === 'preserve') return;
    const nodes = [...node.childNodes];
    if (!node.children.length || nodes.some(item => item.nodeType === Node.CDATA_SECTION_NODE || (item.nodeType === Node.TEXT_NODE && item.textContent?.trim()))) return;
    for (const item of nodes) if (item.nodeType === Node.TEXT_NODE) node.removeChild(item);
    for (const item of [...node.childNodes]) {
      node.insertBefore(doc.createTextNode(`\n${'  '.repeat(depth + 1)}`), item);
      if (item.nodeType === Node.ELEMENT_NODE) indent(item as Element, depth + 1);
    }
    node.appendChild(doc.createTextNode(`\n${'  '.repeat(depth)}`));
  }
  indent(doc.documentElement, 0);
  return new XMLSerializer().serializeToString(doc);
}

export interface SoapFault { code: string; subcodes: string[]; reasons: string[]; actor: string; detail: string }
export interface SoapInspection { version?: SoapVersion; fault?: SoapFault; note?: string }

export function inspectSoapResponse(xml: string): SoapInspection {
  let envelope: ReturnType<typeof soapEnvelope>;
  try { envelope = soapEnvelope(xml); }
  catch { return { note: xml.trim() ? 'The response is not a valid SOAP envelope. Inspect the body and HTTP headers.' : 'The server returned an empty body.' }; }
  const { body, version } = envelope;
  const ns = SOAP_NAMESPACES[version];
  const fault = child(body, 'Fault', ns);
  if (!fault) return { version };
  if (version === '1.1') {
    const value = (name: string) => child(fault, name, null) || child(fault, name, ns);
    return { version, fault: {
      code: value('faultcode')?.textContent || '', subcodes: [], reasons: [value('faultstring')?.textContent || 'No fault reason supplied.'],
      actor: value('faultactor')?.textContent || '', detail: value('detail') ? new XMLSerializer().serializeToString(value('detail')!) : '',
    } };
  }
  const code = child(fault, 'Code', ns);
  const subcodes: string[] = [];
  let subcode = code && child(code, 'Subcode', ns);
  while (subcode && subcodes.length < 20) { subcodes.push(child(subcode, 'Value', ns)?.textContent || ''); subcode = child(subcode, 'Subcode', ns); }
  const reason = child(fault, 'Reason', ns);
  const detail = child(fault, 'Detail', ns);
  return { version, fault: {
    code: code ? child(code, 'Value', ns)?.textContent || '' : '', subcodes,
    reasons: reason ? [...reason.children].filter(item => item.localName === 'Text' && item.namespaceURI === ns).map(item => `${item.getAttributeNS(XML, 'lang') ? `[${item.getAttributeNS(XML, 'lang')}] ` : ''}${item.textContent || ''}`) : ['No fault reason supplied.'],
    actor: [child(fault, 'Node', ns)?.textContent, child(fault, 'Role', ns)?.textContent].filter(Boolean).join(' · '),
    detail: detail ? new XMLSerializer().serializeToString(detail) : '',
  } };
}

/** Bound decoded response bytes before buffering or parsing, including chunked responses. */
export async function readSoapBody(response: Response, maxBytes = 5 * 1024 * 1024): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('Response is larger than 5 MB. Narrow the request or use a desktop client for this payload.'); }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally { reader.releaseLock(); }
}
