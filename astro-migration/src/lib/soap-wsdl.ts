// WSDL 1.1 / XML Schema request templates. All parsing happens in the browser.
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';
const SOAP11_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12_NS = 'http://www.w3.org/2003/05/soap-envelope';

type QName = { ns: string; name: string };
type Declaration = { node: Element; schemaNs: string; qualified: boolean };

export interface SoapMessagePart { name: string; element?: QName; type?: QName }
export interface SoapOperation {
  name: string;
  inputMessage: string;
  outputMessage: string;
  soapAction: string;
  style: 'document' | 'rpc';
  bodyNamespace: string;
  bodyParts: string[];
  bodyUse: 'literal' | 'encoded';
  encodingStyle: string;
}
export interface SoapContract {
  serviceName: string;
  namespace: string;
  endpoint: string;
  version: '1.1' | '1.2';
  operations: SoapOperation[];
  messages: Map<string, SoapMessagePart[]>;
  elements: Map<string, Declaration>;
  complexTypes: Map<string, Declaration>;
  simpleTypes: Map<string, Declaration>;
  warnings: string[];
  importedCount: number;
}
export interface LocalSoapDocument { name: string; xml: string }
export interface ParseSoapOptions {
  sourceName?: string;
  baseUrl?: string;
  localDocuments?: LocalSoapDocument[];
  fetchText?: (url: string) => Promise<string>;
}

const direct = (parent: Element, name: string): Element[] => Array.from(parent.children).filter(child => child.localName === name);
const first = (parent: Element, name: string): Element | undefined => direct(parent, name)[0];
const key = (qname: QName): string => `${qname.ns}\u0000${qname.name}`;
const validName = (name: string): boolean => /^[A-Za-z_][\w.-]*$/.test(name);
const textEscape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attributeEscape = (value: string): string => textEscape(value).replace(/"/g, '&quot;');
const commentEscape = (value: string): string => value.replace(/--/g, '- -').replace(/-$/, '- ');

function qname(value: string | null, context: Element, fallback = ''): QName | undefined {
  if (!value) return undefined;
  const parts = value.split(':');
  const name = parts.pop() || '';
  if (!validName(name) || parts.length > 1) return undefined;
  const ns = parts.length ? context.lookupNamespaceURI(parts[0]) : context.lookupNamespaceURI(null);
  return { ns: ns || fallback, name };
}

function xmlDocument(xml: string, label: string): Document {
  if (xml.length > 5 * 1024 * 1024) throw new Error(`${label} is larger than 5 MB.`);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error(`${label} is not well-formed XML.`);
  return doc;
}

function normalizedPath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** Load embedded and imported XSDs before generating operation templates. */
export async function parseSoapContract(xml: string, options: ParseSoapOptions = {}): Promise<SoapContract> {
  const sourceName = options.sourceName || 'WSDL';
  const doc = xmlDocument(xml, sourceName);
  const definitions = doc.documentElement;
  if (definitions.localName !== 'definitions') throw new Error('This is not a WSDL 1.1 definitions document.');
  const namespace = definitions.getAttribute('targetNamespace') || '';
  const warnings: string[] = [];
  const contract: SoapContract = {
    serviceName: definitions.getAttribute('name') || sourceName,
    namespace, endpoint: '', version: '1.1', operations: [],
    messages: new Map(), elements: new Map(), complexTypes: new Map(), simpleTypes: new Map(),
    warnings, importedCount: 0,
  };
  const localDocuments = options.localDocuments || [];
  const loaded = new Set<string>();

  async function loadSchema(schema: Element, source: string, inheritedNs: string, depth: number): Promise<void> {
    const schemaNs = schema.getAttribute('targetNamespace') || inheritedNs;
    const formQualified = schema.getAttribute('elementFormDefault') === 'qualified';
    for (const [tag, map] of [['element', contract.elements], ['complexType', contract.complexTypes], ['simpleType', contract.simpleTypes]] as const) {
      for (const declaration of direct(schema, tag)) {
        const name = declaration.getAttribute('name') || '';
        if (validName(name)) map.set(key({ ns: schemaNs, name }), { node: declaration, schemaNs, qualified: formQualified });
      }
    }
    for (const importNode of Array.from(schema.children).filter(child => child.localName === 'import' || child.localName === 'include')) {
      const location = importNode.getAttribute('schemaLocation') || '';
      if (!location) {
        const standardNs = importNode.getAttribute('namespace') || '';
        if (!['http://schemas.xmlsoap.org/soap/encoding/', 'http://schemas.xmlsoap.org/wsdl/', XSD_NS].includes(standardNs))
          warnings.push(`Schema ${importNode.localName} has no schemaLocation; add its XSD locally if a type is missing.`);
        continue;
      }
      if (depth >= 8 || loaded.size >= 24) { warnings.push(`Stopped following schema imports at ${location} (depth or document limit).`); continue; }
      const relative = normalizedPath(`${source.includes('/') && !/^https?:/i.test(source) ? source.slice(0, source.lastIndexOf('/') + 1) : ''}${location}`);
      const exact = localDocuments.find(item => item.name === location || normalizedPath(item.name) === relative);
      const basename = location.split('/').pop();
      const basenameMatches = exact ? [] : localDocuments.filter(item => item.name.split('/').pop() === basename);
      const local = exact || (basenameMatches.length === 1 ? basenameMatches[0] : undefined);
      let sourceId = local ? `local:${normalizedPath(local.name)}` : '';
      let content = local?.xml;
      if (!content) {
        const base = /^https?:/i.test(source) ? source : options.baseUrl;
        let resolved: URL;
        try { resolved = new URL(location, base); }
        catch { warnings.push(`Could not resolve ${location}. Add its XSD as a local file or pasted schema.`); continue; }
        if (!['http:', 'https:'].includes(resolved.protocol)) { warnings.push(`Skipped unsupported schema URL ${location}.`); continue; }
        sourceId = resolved.toString();
        if (!options.fetchText) { warnings.push(`Could not fetch ${location}. Add its XSD locally.`); continue; }
        if (loaded.has(sourceId)) continue;
        try { content = await options.fetchText(sourceId); }
        catch { warnings.push(`Could not load ${location}. Add its XSD locally or check browser/bridge access.`); continue; }
      }
      if (loaded.has(sourceId)) continue;
      loaded.add(sourceId);
      try {
        const imported = xmlDocument(content, location).documentElement;
        if (imported.localName !== 'schema') { warnings.push(`${location} is not an XSD schema.`); continue; }
        if (importNode.localName === 'include' && imported.getAttribute('targetNamespace') && imported.getAttribute('targetNamespace') !== schemaNs) {
          warnings.push(`${location} has a different namespace from its including schema.`);
        }
        contract.importedCount++;
        await loadSchema(imported, local ? local.name : sourceId, importNode.localName === 'include' ? schemaNs : '', depth + 1);
      } catch (error) { warnings.push(error instanceof Error ? error.message : `Could not parse ${location}.`); }
    }
  }

  for (const types of direct(definitions, 'types')) {
    for (const schema of direct(types, 'schema')) await loadSchema(schema, options.baseUrl || sourceName, '', 0);
    // Some widely used WSDLs (including NOAA NDFD) put XSD declarations
    // directly under wsdl:types rather than inside xsd:schema.
    const looseXsd = Array.from(types.children).filter(child => child.namespaceURI === XSD_NS && child.localName !== 'schema');
    if (looseXsd.length) {
      const schema = doc.createElementNS(XSD_NS, 'xsd:schema');
      schema.setAttribute('targetNamespace', namespace);
      for (const declaration of looseXsd) schema.appendChild(declaration.cloneNode(true));
      types.appendChild(schema);
      await loadSchema(schema, options.baseUrl || sourceName, '', 0);
    }
  }

  for (const message of direct(definitions, 'message')) {
    const name = message.getAttribute('name') || '';
    contract.messages.set(name, direct(message, 'part').map(part => ({
      name: part.getAttribute('name') || '',
      element: qname(part.getAttribute('element'), part, namespace),
      type: qname(part.getAttribute('type'), part, namespace),
    })));
  }

  const service = first(definitions, 'service');
  if (service?.getAttribute('name')) contract.serviceName = service.getAttribute('name')!;
  const port = service ? direct(service, 'port').find(candidate => direct(candidate, 'address').some(address => address.hasAttribute('location'))) : undefined;
  const address = port ? direct(port, 'address').find(candidate => candidate.hasAttribute('location')) : undefined;
  contract.endpoint = address?.getAttribute('location') || '';
  contract.version = address?.namespaceURI?.includes('/soap12/') ? '1.2' : '1.1';
  const bindingName = port ? qname(port.getAttribute('binding'), port, namespace)?.name : undefined;
  const binding = direct(definitions, 'binding').find(candidate => candidate.getAttribute('name') === bindingName) || direct(definitions, 'binding')[0];
  const bindingSoap = binding ? direct(binding, 'binding').find(candidate => /\/soap(?:12)?\/$/.test(candidate.namespaceURI || '')) : undefined;
  const bindingStyle = bindingSoap?.getAttribute('style') === 'rpc' ? 'rpc' : 'document';
  const portTypeName = binding ? qname(binding.getAttribute('type'), binding, namespace)?.name : undefined;
  const portType = direct(definitions, 'portType').find(candidate => candidate.getAttribute('name') === portTypeName) || direct(definitions, 'portType')[0];
  const bindingOperations = new Map<string, Element>();
  if (binding) for (const operation of direct(binding, 'operation')) bindingOperations.set(operation.getAttribute('name') || '', operation);
  if (portType) contract.operations = direct(portType, 'operation').map(operation => {
    const name = operation.getAttribute('name') || 'UnnamedOperation';
    const bound = bindingOperations.get(name);
    const soapOperation = bound ? direct(bound, 'operation').find(candidate => /\/soap(?:12)?\/$/.test(candidate.namespaceURI || '')) : undefined;
    const body = bound ? direct(first(bound, 'input') || bound, 'body').find(candidate => /\/soap(?:12)?\/$/.test(candidate.namespaceURI || '')) : undefined;
    return {
      name,
      inputMessage: qname(first(operation, 'input')?.getAttribute('message') || '', first(operation, 'input') || operation, namespace)?.name || '',
      outputMessage: qname(first(operation, 'output')?.getAttribute('message') || '', first(operation, 'output') || operation, namespace)?.name || '',
      soapAction: soapOperation?.getAttribute('soapAction') || '',
      style: soapOperation?.getAttribute('style') === 'rpc' ? 'rpc' : bindingStyle,
      bodyNamespace: body?.getAttribute('namespace') || namespace,
      bodyParts: body?.getAttribute('parts')?.trim().split(/\s+/).filter(Boolean) || [],
      bodyUse: body?.getAttribute('use') === 'encoded' ? 'encoded' : 'literal',
      encodingStyle: body?.getAttribute('encodingStyle') || '',
    };
  });
  return contract;
}

function builtInValue(type?: QName): string {
  if (!type || type.ns !== XSD_NS) return '?';
  if (/^(?:boolean)$/.test(type.name)) return 'false';
  if (/^(?:byte|short|int|integer|long|unsignedByte|unsignedShort|unsignedInt|unsignedLong|decimal|float|double|nonNegativeInteger|positiveInteger)$/.test(type.name)) return '0';
  if (type.name === 'date') return '2000-01-01';
  if (type.name === 'dateTime') return '2000-01-01T00:00:00Z';
  if (type.name === 'time') return '00:00:00Z';
  return '?';
}

/** Generate a structurally useful, namespace-correct editable sample envelope. */
export function generateSoapRequest(contract: SoapContract, operation: SoapOperation, version: '1.1' | '1.2' = contract.version): { xml: string; warnings: string[] } {
  const warnings: string[] = [];
  const prefixes = new Map<string, string>();
  if (contract.namespace) prefixes.set(contract.namespace, 'tns');
  const qualifiedName = (ns: string, name: string): string => {
    if (!ns) return name;
    if (!prefixes.has(ns)) prefixes.set(ns, `ns${prefixes.size}`);
    return `${prefixes.get(ns)}:${name}`;
  };
  const notes = (value: string, indent: number): string => `${' '.repeat(indent)}<!-- ${commentEscape(value)} -->\n`;

  function enumValues(node?: Element): string[] {
    if (!node) return [];
    const restriction = first(node, 'restriction');
    return restriction ? direct(restriction, 'enumeration').map(item => item.getAttribute('value') || '').filter(Boolean) : [];
  }

  function childElements(type: Element, visited = new Set<Element>()): Element[] {
    if (visited.has(type)) return [];
    visited.add(type);
    const extension = first(first(type, 'complexContent') || first(type, 'simpleContent') || type, 'extension');
    const base = extension ? qname(extension.getAttribute('base'), extension, contract.namespace) : undefined;
    const baseType = base ? contract.complexTypes.get(key(base)) : undefined;
    const output = baseType ? childElements(baseType.node, visited) : [];
    const scope = extension || type;
    const compositor = Array.from(scope.children).find(child => ['sequence', 'all', 'choice'].includes(child.localName));
    if (!compositor) return output;
    const collect = (parent: Element): Element[] => {
      const items: Element[] = [];
      for (const child of Array.from(parent.children)) {
        if (child.localName === 'element') items.push(child);
        else if (child.localName === 'sequence' || child.localName === 'all') items.push(...collect(child));
        else if (child.localName === 'choice') {
          const choices = collect(child);
          if (choices.length) items.push(choices[0]);
        }
      }
      return items;
    };
    return [...output, ...collect(compositor)];
  }

  function render(name: string, ns: string, source: Element | undefined, type: QName | undefined, schemaNs: string, formQualified: boolean, indent: number, depth: number, trace: Set<string>, encodedType?: QName): string {
    const padding = ' '.repeat(indent);
    const tag = qualifiedName(ns, name);
    const attributes = encodedType ? ` xsi:type="${attributeEscape(qualifiedName(encodedType.ns, encodedType.name))}"` : '';
    let note = '';
    if (source?.getAttribute('minOccurs') === '0') note += notes(`${name} is optional; remove if unused`, indent);
    const max = source?.getAttribute('maxOccurs') || '1';
    if (max === 'unbounded' || Number(max) > 1) note += notes(`repeat ${name} as needed (maxOccurs=${max})`, indent);
    const inlineComplex = source ? first(source, 'complexType') : undefined;
    const inlineSimple = source ? first(source, 'simpleType') : undefined;
    const namedComplex = type ? contract.complexTypes.get(key(type)) : undefined;
    const namedSimple = type ? contract.simpleTypes.get(key(type)) : undefined;
    const complex = inlineComplex || namedComplex?.node;
    const simple = inlineSimple || namedSimple?.node;
    const definition = complex ? (inlineComplex ? { schemaNs, qualified: formQualified } : namedComplex!) : undefined;
    const typeKey = type ? key(type) : '';
    if (complex && depth < 8 && (!typeKey || !trace.has(typeKey))) {
      const nextTrace = new Set(trace);
      if (typeKey) nextTrace.add(typeKey);
      const children = childElements(complex);
      if (children.length) {
        const body = children.map(child => {
          const ref = qname(child.getAttribute('ref'), child, definition!.schemaNs);
          const global = ref ? contract.elements.get(key(ref)) : undefined;
          const childName = ref?.name || child.getAttribute('name') || '';
          if (!validName(childName)) return '';
          const childNs = ref ? ref.ns : child.getAttribute('form') === 'qualified' || (!child.hasAttribute('form') && definition!.qualified) ? definition!.schemaNs : '';
          const actual = global?.node || child;
          const childType = qname(actual.getAttribute('type'), actual, global?.schemaNs || definition!.schemaNs);
          return render(childName, childNs, child, childType, global?.schemaNs || definition!.schemaNs, global?.qualified ?? definition!.qualified, indent + 2, depth + 1, nextTrace);
        }).filter(Boolean).join('\n');
        return `${note}${padding}<${tag}${attributes}>\n${body}\n${padding}</${tag}>`;
      }
      const extension = first(first(complex, 'complexContent') || first(complex, 'simpleContent') || complex, 'extension');
      if (extension) type = qname(extension.getAttribute('base'), extension, definition!.schemaNs);
      else return `${note}${padding}<${tag}${attributes}/>`;
    } else if (complex) {
      return `${note}${padding}<${tag}${attributes}>\n${notes('recursive or deeply nested type; fill this element manually', indent + 2)}${padding}</${tag}>`;
    }
    if (type && type.ns !== XSD_NS && !complex && !simple && type.name !== 'anyType') warnings.push(`Type ${type.name} was not found; ${name} needs manual XML.`);
    const allowed = enumValues(simple);
    if (allowed.length) note += notes(`allowed: ${allowed.slice(0, 8).join(' | ')}${allowed.length > 8 ? ' | …' : ''}`, indent);
    const value = allowed[0] || builtInValue(type);
    return `${note}${padding}<${tag}${attributes}>${textEscape(value)}</${tag}>`;
  }

  const parts = (contract.messages.get(operation.inputMessage) || []).filter(part => !operation.bodyParts.length || operation.bodyParts.includes(part.name));
  let body = '';
  if (operation.style === 'rpc') {
    const wrapper = qualifiedName(operation.bodyNamespace, operation.name);
    const params = parts.map(part => {
      const global = part.element ? contract.elements.get(key(part.element)) : undefined;
      const name = validName(part.name) ? part.name : part.element?.name || 'parameter';
      const partType = part.type || (global ? qname(global.node.getAttribute('type'), global.node, global.schemaNs) : undefined);
      return render(name, '', global?.node, partType, global?.schemaNs || contract.namespace, false, 6, 0, new Set(), operation.bodyUse === 'encoded' ? partType : undefined);
    }).join('\n');
    const encoding = operation.bodyUse === 'encoded'
      ? ` ${version === '1.2' ? 'soap12' : 'soap'}:encodingStyle="${attributeEscape(operation.encodingStyle || 'http://schemas.xmlsoap.org/soap/encoding/')}"`
      : '';
    body = `    <${wrapper}${encoding}>\n${params || '      <!-- Add RPC parameters here -->'}\n    </${wrapper}>`;
  } else {
    const items = parts.map(part => {
      if (part.element) {
        const global = contract.elements.get(key(part.element));
        if (!global) warnings.push(`Element ${part.element.name} was not found; add its XSD import or edit the request.`);
        const type = global ? qname(global.node.getAttribute('type'), global.node, global.schemaNs) : undefined;
        return render(part.element.name, part.element.ns, global?.node, type, global?.schemaNs || part.element.ns, global?.qualified || false, 4, 0, new Set());
      }
      if (part.type && validName(part.name)) return render(part.name, '', undefined, part.type, contract.namespace, false, 4, 0, new Set());
      return '';
    }).filter(Boolean);
    body = items.join('\n') || `    <!-- No input parts were declared for ${commentEscape(operation.name)} -->`;
  }
  const envelopePrefix = version === '1.2' ? 'soap12' : 'soap';
  const envelopeNs = version === '1.2' ? SOAP12_NS : SOAP11_NS;
  const namespaces = [...prefixes].map(([ns, prefix]) => ` xmlns:${prefix}="${attributeEscape(ns)}"`).join('') + (operation.style === 'rpc' && operation.bodyUse === 'encoded' ? ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' : '');
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<${envelopePrefix}:Envelope xmlns:${envelopePrefix}="${envelopeNs}"${namespaces}>\n  <${envelopePrefix}:Header/>\n  <${envelopePrefix}:Body>\n${body}\n  </${envelopePrefix}:Body>\n</${envelopePrefix}:Envelope>`,
    warnings,
  };
}
