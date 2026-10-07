import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import LZString from 'lz-string';

const wsdl = (schema: string, message: string, binding = '<soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>', body = '<soap:body use="literal"/>') => `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:tns="urn:test" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" targetNamespace="urn:test" name="ExampleService">
<types>${schema}</types>${message}
<portType name="ExamplePort"><operation name="Submit"><input message="tns:SubmitInput"/></operation></portType>
<binding name="ExampleBinding" type="tns:ExamplePort">${binding}<operation name="Submit"><soap:operation soapAction="urn:submit"/><input>${body}</input></operation></binding>
<service name="ExampleService"><port name="ExamplePort" binding="tns:ExampleBinding"><soap:address location="http://localhost:4321/mock-soap"/></port></service>
</definitions>`;

const wrapped = wsdl(`<xsd:schema targetNamespace="urn:test" xmlns:tns="urn:test">
<xsd:element name="Submit" type="tns:SubmitType"/>
<xsd:complexType name="SubmitType"><xsd:sequence><xsd:element name="request" type="tns:RequestType"/></xsd:sequence></xsd:complexType>
<xsd:complexType name="RequestType"><xsd:sequence><xsd:element name="id" type="xsd:int"/><xsd:element name="status" type="tns:Status" minOccurs="0"/><xsd:element name="tag" type="xsd:string" maxOccurs="unbounded"/></xsd:sequence></xsd:complexType>
<xsd:simpleType name="Status"><xsd:restriction base="xsd:string"><xsd:enumeration value="OPEN"/><xsd:enumeration value="CLOSED"/></xsd:restriction></xsd:simpleType>
</xsd:schema>`, '<message name="SubmitInput"><part name="parameters" element="tns:Submit"/></message>');

test.beforeEach(async ({ page }) => {
  await page.route('https://**/*', route => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cookie-notice-dismissed', 'true');
    localStorage.removeItem('bd-share-method');
    (window as any).__copied = '';
    (window as any).__errors = [];
    window.addEventListener('error', event => (window as any).__errors.push(event.message));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { (window as any).__copied = value; } } });
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__errors || [])).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

async function pasteContract(page: import('@playwright/test').Page, contract: string) {
  await page.goto('/soap-client/');
  await page.locator('#toggle-wsdl-input').click();
  await page.locator('#wsdl-xml').fill(contract);
  await page.locator('#parse-xml-btn').click();
  await expect(page.locator('#selected-operation')).toHaveText('Submit');
}

test('expands Java-style named and nested types with unqualified local parameters', async ({ page }) => {
  await pasteContract(page, wrapped);
  const xml = await page.locator('#request-xml').inputValue();
  expect(xml).toContain('<tns:Submit>');
  expect(xml).toContain('<request>');
  expect(xml).toContain('<id>0</id>');
  expect(xml).toContain('<status>OPEN</status>');
  expect(xml).toContain('status is optional');
  expect(xml).toContain('repeat tag as needed');
  expect(xml).not.toContain('Add parameters here');
  const namespaces = await page.locator('#request-xml').evaluate(element => {
    const doc = new DOMParser().parseFromString((element as HTMLTextAreaElement).value, 'text/xml');
    const wrapper = doc.getElementsByTagNameNS('urn:test', 'Submit')[0];
    return [wrapper?.namespaceURI, wrapper?.firstElementChild?.namespaceURI, wrapper?.firstElementChild?.firstElementChild?.namespaceURI];
  });
  expect(namespaces).toEqual(['urn:test', null, null]);
});

test('generates RPC message-part parameters and honors qualified schema elements', async ({ page }) => {
  const rpc = wsdl('', '<message name="SubmitInput"><part name="city" type="xsd:string"/><part name="days" type="xsd:int"/></message>', '<soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>', '<soap:body use="literal" namespace="urn:rpc"/>');
  await pasteContract(page, rpc);
  let xml = await page.locator('#request-xml').inputValue();
  expect(xml).toContain('<ns1:Submit>');
  expect(xml).toContain('<city>?</city>');
  expect(xml).toContain('<days>0</days>');
  const qualified = wsdl('<xsd:schema targetNamespace="urn:test" elementFormDefault="qualified" xmlns:tns="urn:test"><xsd:element name="Submit"><xsd:complexType><xsd:sequence><xsd:element name="id" type="xsd:int"/><xsd:element name="plain" form="unqualified" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element></xsd:schema>', '<message name="SubmitInput"><part name="parameters" element="tns:Submit"/></message>');
  await pasteContract(page, qualified);
  xml = await page.locator('#request-xml').inputValue();
  expect(xml).toContain('<tns:id>0</tns:id>');
  expect(xml).toContain('<plain>?</plain>');
});

test('handles NOAA-style loose XSD declarations and RPC/encoded message parts', async ({ page }) => {
  const noaaShape = wsdl('<xsd:simpleType name="productType"><xsd:restriction base="xsd:string"><xsd:enumeration value="time-series"/></xsd:restriction></xsd:simpleType><xsd:complexType name="WeatherParameters"><xsd:sequence><xsd:element name="temp" type="xsd:boolean"/></xsd:sequence></xsd:complexType>', '<message name="SubmitInput"><part name="latitude" type="xsd:decimal"/><part name="product" type="tns:productType"/><part name="weatherParameters" type="tns:WeatherParameters"/></message>', '<soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>', '<soap:body use="encoded" namespace="urn:test" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/>');
  await pasteContract(page, noaaShape);
  const xml = await page.locator('#request-xml').inputValue();
  expect(xml).toContain('soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"');
  expect(xml).toContain('<latitude xsi:type="ns1:decimal">0</latitude>');
  expect(xml).toContain('<product xsi:type="tns:productType">time-series</product>');
  expect(xml).toContain('<weatherParameters xsi:type="tns:WeatherParameters">');
  expect(xml).toContain('<temp>false</temp>');
});

test('loads relative imported and included schemas from several pasted documents', async ({ page }) => {
  const contract = wsdl('<xsd:schema targetNamespace="urn:test" xmlns:tns="urn:test"><xsd:import namespace="urn:external" schemaLocation="types/customer.xsd"/><xsd:element name="Submit" type="tns:SubmitType"/><xsd:complexType name="SubmitType"><xsd:sequence><xsd:element name="customer" type="ext:Customer" xmlns:ext="urn:external"/></xsd:sequence></xsd:complexType></xsd:schema>', '<message name="SubmitInput"><part name="parameters" element="tns:Submit"/></message>');
  await page.goto('/soap-client/');
  await page.locator('#toggle-wsdl-input').click();
  await page.locator('#wsdl-xml').fill(contract);
  await page.locator('#add-xsd-btn').click();
  await page.locator('[data-xsd-row] input').first().fill('types/customer.xsd');
  await page.locator('[data-xsd-row] textarea').first().fill('<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:external" targetNamespace="urn:external"><xsd:include schemaLocation="detail.xsd"/></xsd:schema>');
  await page.locator('#add-xsd-btn').click();
  await page.locator('[data-xsd-row] input').nth(1).fill('types/detail.xsd');
  await page.locator('[data-xsd-row] textarea').nth(1).fill('<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:external"><xsd:complexType name="Customer"><xsd:sequence><xsd:element name="name" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:schema>');
  await page.locator('#parse-xml-btn').click();
  await expect(page.locator('#request-xml')).toHaveValue(/<name>\?<\/name>/);
  await expect(page.locator('#target-namespace')).toContainText('2 linked XSDs');
});

test('fetches relative XSD imports from a WSDL URL', async ({ page }) => {
  const contract = wsdl('<xsd:schema targetNamespace="urn:test"><xsd:include schemaLocation="types/submit.xsd"/></xsd:schema>', '<message name="SubmitInput"><part name="parameters" element="tns:Submit"/></message>');
  await page.route('https://example.test/api?wsdl', route => route.fulfill({ body: contract, headers: { 'access-control-allow-origin': '*' } }));
  await page.route('https://example.test/types/submit.xsd', route => route.fulfill({ body: '<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test"><xsd:element name="Submit"><xsd:complexType><xsd:sequence><xsd:element name="id" type="xsd:int"/></xsd:sequence></xsd:complexType></xsd:element></xsd:schema>', headers: { 'access-control-allow-origin': '*' } }));
  await page.goto('/soap-client/');
  await page.locator('#wsdl-url').fill('https://example.test/api?wsdl');
  await page.locator('#parse-wsdl-btn').click();
  await expect(page.locator('#request-xml')).toHaveValue(/<id>0<\/id>/);
});

test('accepts a WSDL and XSD file together, and reports missing imports', async ({ page }) => {
  const contract = wsdl('<xsd:schema targetNamespace="urn:test"><xsd:include schemaLocation="fields.xsd"/></xsd:schema>', '<message name="SubmitInput"><part name="parameters" element="tns:Submit"/></message>');
  await page.goto('/soap-client/');
  await page.locator('#toggle-wsdl-input').click();
  await page.locator('#wsdl-file').setInputFiles([
    { name: 'service.wsdl', mimeType: 'text/xml', buffer: Buffer.from(contract) },
    { name: 'fields.xsd', mimeType: 'text/xml', buffer: Buffer.from('<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test"><xsd:element name="Submit" type="xsd:string"/></xsd:schema>') },
  ]);
  await expect(page.locator('#request-xml')).toHaveValue(/<tns:Submit>\?<\/tns:Submit>/);
  await expect(page.locator('#local-schema-count')).toContainText('1 XSD file');
  await page.locator('#wsdl-xml').fill(contract.replace('fields.xsd', 'unavailable.xsd'));
  await page.locator('#parse-xml-btn').click();
  await expect(page.locator('#contract-warnings')).toContainText('Could not resolve unavailable.xsd');
});

test('PasswordText is inserted only for sending; saved requests strip a manually entered SOAP header', async ({ page }) => {
  let sent = '';
  await page.route('http://localhost:4321/mock-soap?token=hidden', async route => {
    sent = route.request().postData() || '';
    await route.fulfill({ status: 200, contentType: 'text/xml', body: '<ok/>' });
  });
  await page.goto('/soap-client/');
  await page.locator('#endpoint-url').fill('http://localhost:4321/mock-soap?token=hidden');
  await page.locator('#request-xml').fill('<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/"><Body><Ping/></Body></Envelope>');
  await page.locator('#request-options').evaluate(element => (element as HTMLDetailsElement).open = true);
  await page.locator('#auth-type').selectOption('wsse-text');
  await page.locator('#auth-username').fill('plain-user');
  await page.locator('#auth-password').fill('plain-password');
  await page.locator('#send-btn').click();
  await expect(page.locator('#status-badge')).toContainText('200');
  expect(sent).toContain('plain-password');
  expect(sent).toContain('#PasswordText');
  expect(sent).toContain('UsernameToken');
  await page.locator('#request-xml').fill('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header><Secret>header-credential</Secret></soap:Header><soap:Body><Ping/></soap:Body></soap:Envelope>');
  page.once('dialog', dialog => dialog.accept('Header test'));
  await page.locator('#save-request-btn').click();
  const saved = await page.evaluate(() => localStorage.getItem('bugdays-soap-saved-v1') || '');
  expect(saved).not.toMatch(/header-credential|plain-user|plain-password|token=hidden/);
  await page.locator('#share-btn').click();
  await page.locator('#share-url-btn').click();
  const shared = await page.evaluate(() => (window as any).__copied as string);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(shared.split('#lz:')[1])!);
  expect(JSON.stringify(state)).not.toMatch(/header-credential|plain-user|plain-password|token=hidden/);
});

test('UsernameToken digest is valid per profile and stays out of saves, history and share links', async ({ page }) => {
  let sent = '';
  await page.route('http://localhost:4321/mock-soap', async route => {
    sent = route.request().postData() || '';
    await route.fulfill({ status: 200, contentType: 'text/xml', body: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ok/></soap:Body></soap:Envelope>' });
  });
  await pasteContract(page, wrapped);
  await page.locator('#request-options').evaluate(element => (element as HTMLDetailsElement).open = true);
  await page.locator('#auth-type').selectOption('wsse-digest');
  await page.locator('#auth-username').fill('test-user');
  await page.locator('#auth-password').fill('secret-password');
  await page.locator('#save-history').check();
  await page.locator('#send-btn').click();
  await expect(page.locator('#status-badge')).toContainText('200');
  expect(sent).toContain('UsernameToken');
  expect(sent).not.toContain('secret-password');
  const token = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const value = (name: string) => doc.getElementsByTagNameNS('*', name)[0]?.textContent || '';
    return { nonce: value('Nonce'), created: value('Created'), digest: value('Password'), type: doc.getElementsByTagNameNS('*', 'Password')[0]?.getAttribute('Type') };
  }, sent);
  const expected = createHash('sha1').update(Buffer.from(token.nonce, 'base64')).update(token.created).update('secret-password').digest('base64');
  expect(token.digest).toBe(expected);
  expect(token.type).toMatch(/#PasswordDigest$/);
  expect(await page.locator('#request-xml').inputValue()).not.toContain('UsernameToken');
  page.once('dialog', dialog => dialog.accept('Saved test'));
  await page.locator('#save-request-btn').click();
  const storage = await page.evaluate(() => `${localStorage.getItem('bugdays-soap-saved-v1')} ${localStorage.getItem('bugdays-soap-history-v1')}`);
  expect(storage).not.toContain('secret-password');
  expect(storage).not.toContain('test-user');
  expect(storage).not.toContain('UsernameToken');
  await page.locator('#saved-list button').first().click();
  await expect(page.locator('#auth-username')).toHaveValue('');
  await expect(page.locator('#auth-password')).toHaveValue('');
  await expect(page.locator('#auth-type')).toHaveValue('wsse-digest');
  await page.locator('#share-btn').click();
  await page.locator('#share-url-btn').click();
  const shared = await page.evaluate(() => (window as any).__copied as string);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(shared.split('#lz:')[1])!);
  expect(JSON.stringify(state)).not.toMatch(/secret-password|test-user|UsernameToken/);
});

const soap11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const soap12 = 'http://www.w3.org/2003/05/soap-envelope';
const envelope = (body: string, ns = soap11) => `<env:Envelope xmlns:env="${ns}"><env:Body>${body}</env:Body></env:Envelope>`;
async function directRequest(page: import('@playwright/test').Page, xml = envelope('<Ping/>')) {
  await page.goto('/soap-client/');
  await page.locator('#direct-mode-tab').click();
  await page.locator('#endpoint-url').fill('http://localhost:4321/mock-soap');
  await page.locator('#request-xml').fill(xml);
  await page.locator('#request-options').evaluate(el => (el as HTMLDetailsElement).open = true);
}

test('chooses SOAP rather than HTTP ports and exposes each binding with its endpoint and action', async ({ page }) => {
  const contract = wrapped.replace('xmlns:soap=', 'xmlns:http="http://schemas.xmlsoap.org/wsdl/http/" xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/" xmlns:soap=')
    .replace('<service name=', '<binding name="Twelve" type="tns:ExamplePort"><soap12:binding transport="http://schemas.xmlsoap.org/soap/http"/><operation name="Submit"><soap12:operation soapAction="urn:twelve"/><input><soap12:body use="literal"/></input></operation></binding><binding name="Http" type="tns:ExamplePort"><http:binding verb="GET"/></binding><service name=')
    .replace('<port name="ExamplePort"', '<port name="HttpPort" binding="tns:Http"><http:address location="https://example.test/not-soap"/></port><port name="TwelvePort" binding="tns:Twelve"><soap12:address location="https://example.test/twelve"/></port><port name="ExamplePort"');
  await pasteContract(page, contract);
  await expect(page.locator('#soap-port option')).toHaveCount(2);
  await expect(page.locator('#soap-version')).toHaveValue('1.2');
  await expect(page.locator('#endpoint-url')).toHaveValue('https://example.test/twelve');
  await expect(page.locator('#soap-action')).toHaveValue('urn:twelve');
  await page.locator('#soap-port').selectOption('port-1');
  await expect(page.locator('#soap-version')).toHaveValue('1.1');
  await expect(page.locator('#endpoint-url')).toHaveValue('http://localhost:4321/mock-soap');
  await expect(page.locator('#soap-action')).toHaveValue('urn:submit');
});

test('version changes preserve edited values, business namespaces, CDATA and arbitrary prefixes', async ({ page }) => {
  await pasteContract(page, wrapped);
  const original = envelope('<m:Submit xmlns:m="urn:test"><id>42</id><text>  soap:literal  </text><blob><![CDATA[<soap:fake> keep ]]></blob><m:Status>OPEN</m:Status></m:Submit>');
  await page.locator('#request-xml').fill(original);
  await page.locator('#soap-version').selectOption('1.2');
  const state = await page.locator('#request-xml').evaluate(el => {
    const doc = new DOMParser().parseFromString((el as HTMLTextAreaElement).value, 'text/xml');
    return { ns: doc.documentElement.namespaceURI, id: doc.getElementsByTagName('id')[0].textContent, text: doc.getElementsByTagName('text')[0].textContent, blob: doc.getElementsByTagName('blob')[0].textContent, wrapper: doc.getElementsByTagNameNS('urn:test', 'Submit').length, child: doc.getElementsByTagName('id')[0].namespaceURI };
  });
  expect(state).toEqual({ ns: soap12, id: '42', text: '  soap:literal  ', blob: '<soap:fake> keep ', wrapper: 1, child: null });
  await page.locator('#soap-version').selectOption('1.1');
  await expect(page.locator('#request-xml')).toHaveValue(/<id>42<\/id>/);
  await page.locator('#validate-request-btn').click();
  await expect(page.locator('#request-validation')).toContainText('Valid SOAP 1.1');
  // A default SOAP namespace must not swallow explicitly unqualified business fields.
  await page.locator('#request-xml').fill(`<Envelope xmlns="${soap11}"><Body><Ping xmlns=""><value>42</value></Ping></Body></Envelope>`);
  await page.locator('#soap-version').selectOption('1.2');
  expect(await page.locator('#request-xml').evaluate(el => new DOMParser().parseFromString((el as HTMLTextAreaElement).value, 'text/xml').getElementsByTagName('value')[0].namespaceURI)).toBeNull();
});

test('replacing an edited WSDL request is explicit and can be declined', async ({ page }) => {
  await pasteContract(page, wrapped);
  const edited = (await page.locator('#request-xml').inputValue()).replace('<id>0</id>', '<id>123</id>');
  await page.locator('#request-xml').fill(edited);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#regenerate-request-btn').click();
  await expect(page.locator('#request-xml')).toHaveValue(edited);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#regenerate-request-btn').click();
  await expect(page.locator('#request-xml')).toHaveValue(/<id>0<\/id>/);
});

test('validation blocks malformed, non-SOAP, missing/duplicate Body and mismatched-version requests', async ({ page }) => {
  let posts = 0;
  await page.route('http://localhost:4321/mock-soap', route => { posts++; return route.fulfill({ body: envelope('<ok/>') }); });
  await directRequest(page);
  for (const xml of ['<Envelope>', '<Ping/>', `<e:Envelope xmlns:e="${soap11}"/>`, `<e:Envelope xmlns:e="${soap11}"><e:Body/><e:Body/></e:Envelope>`, envelope('<Ping/>', soap12), `<!DOCTYPE env:Envelope [<!ENTITY x "x">]>${envelope('<Ping/>')}`]) {
    await page.locator('#request-xml').fill(xml);
    await page.locator('#send-btn').click();
    await expect(page.locator('#error-box')).toBeVisible();
  }
  expect(posts).toBe(0);
  await page.locator('#request-xml').fill(envelope('<Ping/>'));
  await page.locator('#validate-request-btn').click();
  await expect(page.locator('#error-box')).toBeHidden();
  await expect(page.locator('#request-validation')).toContainText('not XSD business rules');
  await page.locator('#request-xml').fill(envelope('<parsererror>ordinary business field</parsererror>'));
  await page.locator('#validate-request-btn').click();
  await expect(page.locator('#error-box')).toBeHidden();
});

test('XML formatting preserves significant text, mixed content, CDATA and xml:space', async ({ page }) => {
  const xml = envelope('<Data><value>  keep \n this  </value><text>Hello <b>bold</b> world.</text><c><![CDATA[<tag>   raw\n]]></c><space xml:space="preserve"><a/>  <b/></space></Data>');
  await directRequest(page, xml);
  await page.locator('#format-request-btn').click();
  const values = await page.locator('#request-xml').evaluate(el => {
    const doc = new DOMParser().parseFromString((el as HTMLTextAreaElement).value, 'text/xml');
    return ['value', 'text', 'c', 'space'].map(name => doc.getElementsByTagName(name)[0].textContent);
  });
  expect(values).toEqual(['  keep \n this  ', 'Hello bold world.', '<tag>   raw\n', '  ']);
});

test('SOAP 1.1 faults expose code, reason and details independently of HTTP 200', async ({ page }) => {
  await page.route('http://localhost:4321/mock-soap', route => route.fulfill({ status: 200, contentType: 'text/xml', body: envelope('<env:Fault><faultcode>env:Client</faultcode><faultstring>Customer not found &lt;script&gt;</faultstring><faultactor>urn:gateway</faultactor><detail><field>customerId</field></detail></env:Fault>') }));
  await directRequest(page);
  await page.locator('#send-btn').click();
  await expect(page.locator('#status-badge')).toContainText('SOAP Fault · 200');
  await expect(page.locator('#fault-summary')).toContainText('env:Client');
  await expect(page.locator('#fault-summary')).toContainText('Customer not found <script>');
  await expect(page.locator('#fault-detail')).toContainText('customerId');
  await expect(page.locator('#response-checks')).toContainText('Fault returned');
  await expect(page.locator('#fault-summary script')).toHaveCount(0);
});

test('SOAP 1.2 faults expose nested subcodes, multilingual reasons and role', async ({ page }) => {
  const fault = '<env:Fault><env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value>app:InvalidId</env:Value><env:Subcode><env:Value>app:Negative</env:Value></env:Subcode></env:Subcode></env:Code><env:Reason><env:Text xml:lang="en">Bad ID</env:Text><env:Text xml:lang="fr">ID incorrect</env:Text></env:Reason><env:Role>urn:validator</env:Role><env:Detail><field xmlns="urn:app">id</field></env:Detail></env:Fault>';
  await page.route('http://localhost:4321/mock-soap', route => route.fulfill({ status: 500, contentType: 'application/soap+xml', body: envelope(fault, soap12) }));
  await directRequest(page);
  await page.locator('#soap-version').selectOption('1.2');
  await page.locator('#send-btn').click();
  await expect(page.locator('#fault-summary')).toContainText('app:InvalidId → app:Negative');
  await expect(page.locator('#fault-summary')).toContainText('[en] Bad ID');
  await expect(page.locator('#fault-summary')).toContainText('[fr] ID incorrect');
  await expect(page.locator('#fault-summary')).toContainText('urn:validator');
});

test('business Fault elements are not SOAP faults and non-SOAP errors stay readable', async ({ page }) => {
  let body = envelope('<result xmlns="urn:business"><Fault>ordinary business value</Fault></result>');
  await page.route('http://localhost:4321/mock-soap', route => route.fulfill({ status: body.startsWith('<html') ? 401 : 200, body }));
  await directRequest(page);
  await page.locator('#send-btn').click();
  await expect(page.locator('#response-checks')).toContainText('No SOAP fault');
  await expect(page.locator('#soap-fault')).toBeHidden();
  body = '<html><body>Gateway authentication required</body></html>';
  await page.locator('#send-btn').click();
  await expect(page.locator('#status-badge')).toContainText('401');
  await expect(page.locator('#response-checks')).toContainText('Not SOAP');
  await expect(page.locator('#response-body')).toContainText('Gateway authentication required');
});

test('raw response and download retain exact text; copy follows the active headers tab', async ({ page }) => {
  const body = `<?xml version="1.0"?>\n${envelope('<x>  unchanged  </x>')}\n`;
  await page.route('http://localhost:4321/mock-soap', route => route.fulfill({ body, headers: { 'content-type': 'text/xml', 'x-test-result': 'yes', 'access-control-expose-headers': 'x-test-result' } }));
  await directRequest(page);
  await page.locator('#send-btn').click();
  await expect(page.locator('#download-response-btn')).toBeEnabled();
  await page.locator('#raw-response-btn').click();
  await page.locator('#copy-response-btn').click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe(body);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-response-btn').click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe(body);
  await page.locator('#response-headers-tab').click();
  await page.locator('#copy-response-btn').click();
  expect(await page.evaluate(() => (window as any).__copied)).toContain('x-test-result: yes');
});

test('in-flight requests are single-flight, cancellable and cannot export stale responses', async ({ page }) => {
  let calls = 0, stalled = false;
  await page.route('http://localhost:4321/mock-soap', async route => {
    calls++;
    if (stalled) { await new Promise(resolve => setTimeout(resolve, 500)); await route.fulfill({ body: envelope('<late/>') }).catch(() => {}); }
    else await route.fulfill({ body: envelope('<first/>') });
  });
  await directRequest(page);
  await page.locator('#send-btn').click();
  await expect(page.locator('#download-response-btn')).toBeEnabled();
  stalled = true;
  await page.locator('#send-btn').click();
  await expect(page.locator('#send-btn')).toBeDisabled();
  await page.locator('#send-btn').evaluate(el => el.dispatchEvent(new Event('click')));
  await expect(page.locator('#download-response-btn')).toBeDisabled();
  await page.locator('#cancel-request-btn').click();
  await expect(page.locator('#error-box')).toContainText('Request cancelled');
  await expect(page.locator('#send-btn')).toBeEnabled();
  await expect(page.locator('#response-content')).toBeHidden();
  await expect.poll(() => calls).toBe(2);
});

test('timeout and oversized response failures are actionable without fake CORS diagnosis', async ({ page }) => {
  let large = false;
  await page.route('http://localhost:4321/mock-soap', async route => {
    if (!large) await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ body: large ? 'x'.repeat(5 * 1024 * 1024 + 1) : envelope('<ok/>') }).catch(() => {});
  });
  await directRequest(page);
  await page.locator('#request-timeout').evaluate(el => { const option = new Option('test timeout', '50'); el.append(option); });
  await page.locator('#request-timeout').selectOption('50');
  await page.locator('#send-btn').click();
  await expect(page.locator('#error-box')).toContainText('timed out');
  await expect(page.locator('#error-box')).not.toContainText('CORS');
  large = true;
  await page.locator('#request-timeout').selectOption('30000');
  await page.locator('#send-btn').click();
  await expect(page.locator('#error-box')).toContainText('larger than 5 MB');
  await expect(page.locator('#download-response-btn')).toBeDisabled();
});

test('history captures the sent snapshot and restoring it clears old custom credentials', async ({ page }) => {
  await page.route('http://localhost:4321/mock-soap', async route => { await new Promise(resolve => setTimeout(resolve, 200)); await route.fulfill({ body: envelope('<ok/>') }); });
  await directRequest(page, envelope('<value>sent</value>'));
  await page.locator('#save-history').check();
  await page.locator('#send-btn').click();
  await page.locator('#request-xml').fill(envelope('<value>later edit</value>'));
  await expect(page.locator('#history-list')).toContainText('HTTP 200');
  const stored = await page.evaluate(() => localStorage.getItem('bugdays-soap-history-v1')!);
  expect(stored).toContain('sent'); expect(stored).not.toContain('later edit');
  await page.locator('#custom-headers').fill('Authorization: Bearer old-secret');
  await page.locator('#history-list button').first().click();
  await expect(page.locator('#custom-headers')).toHaveValue('');
  await expect(page.locator('#request-xml')).toHaveValue(/<value>sent<\/value>/);
});

test('prominent share restores a useful request without credentials or automatic POST, including legacy actions', async ({ page }) => {
  let posts = 0;
  await page.route('http://localhost:4321/mock-soap**', route => { posts++; return route.fulfill({ body: envelope('<ok/>') }); });
  await directRequest(page, `<env:Envelope xmlns:env="${soap11}"><env:Header secret="header-attribute"><secret>header-secret</secret></env:Header><env:Body><value>42</value></env:Body></env:Envelope>`);
  await page.locator('#endpoint-url').fill('http://u:p@localhost:4321/mock-soap?token=url-secret&region=test#access_token=fragment-secret');
  await page.locator('#custom-headers').fill('Authorization: Bearer header-token');
  await page.locator('#share-request-btn').click();
  await page.locator('#share-url-btn').click();
  const shared = await page.evaluate(() => (window as any).__copied as string);
  const state = JSON.parse(LZString.decompressFromEncodedURIComponent(shared.split('#lz:')[1])!);
  expect(JSON.stringify(state)).not.toMatch(/header-secret|header-attribute|url-secret|header-token|fragment-secret|u:p@/);
  expect(state.d.request).toContain('<value>42</value>');
  expect(state.d.endpoint).toContain('region=test'); expect(state.a).toBeUndefined();
  state.a = 'send';
  await page.goto('/soap-client/#lz:' + LZString.compressToEncodedURIComponent(JSON.stringify(state)));
  await expect(page.locator('#request-xml')).toHaveValue(/<value>42<\/value>/);
  await expect(page.locator('#auth-type')).toHaveValue('none');
  await expect(page.locator('#custom-headers')).toHaveValue('');
  expect(posts).toBe(0);
});

test('local bridge keeps the existing HTTP proxy path and explains setup when it is offline', async ({ page }) => {
  let target = '', contentType = '';
  await page.route('http://127.0.0.1:2345/**', async route => {
    target = route.request().url(); contentType = route.request().headers()['content-type'];
    await route.fulfill({ contentType: 'text/xml', body: envelope('<ok/>') });
  });
  await directRequest(page);
  await page.locator('#use-proxy').evaluate(el => el.closest('details')!.open = true);
  await page.locator('#use-proxy').check();
  await page.locator('#send-btn').click();
  await expect(page.locator('#bridge-access-dialog')).toBeVisible();
  await page.locator('#bridge-access-continue').click();
  await expect(page.locator('#status-badge')).toContainText('200');
  expect(target).toBe('http://127.0.0.1:2345/http://localhost:4321/mock-soap');
  expect(contentType).toBe('text/xml; charset=utf-8');
  await page.route('http://127.0.0.1:2345/**', route => route.abort());
  await page.locator('#send-btn').click();
  await expect(page.locator('#error-box')).toContainText('Check that it is running');
});

test('guide example loads without sending and the workspace survives client navigation', async ({ page }) => {
  await page.goto('/guides/test-soap-api-from-wsdl-soap-11-vs-12/');
  await page.locator('.guide-body a[href^="/soap-client/#lz:"]').click();
  await expect(page.locator('#request-xml')).toHaveValue(/<customerId>42<\/customerId>/);
  await expect(page.locator('#operations-section')).toBeHidden();
  await page.locator('#validate-request-btn').click();
  await expect(page.locator('#request-validation')).toContainText('Valid SOAP 1.1');
  await page.locator('a[href="/xml-formatter/"]').last().click();
  await page.goBack();
  await page.locator('#validate-request-btn').click();
  await expect(page.locator('#request-validation')).toContainText('Valid SOAP');
  await expect(page.locator('#share-request-btn')).toBeVisible();
});

test('SOAP 1.2 headers are case-insensitive, Basic auth supports Unicode and response versions are checked', async ({ page }) => {
  let sentHeaders: Record<string, string> = {};
  await page.route('http://localhost:4321/mock-soap', async route => { sentHeaders = route.request().headers(); await route.fulfill({ body: envelope('<ok/>') }); });
  await directRequest(page);
  await page.locator('#soap-version').selectOption('1.2');
  await page.locator('#soap-action').fill('urn:test');
  await page.locator('#auth-type').selectOption('basic');
  await page.locator('#auth-username').fill('café');
  await page.locator('#auth-password').fill('☕');
  await page.locator('#custom-headers').fill('content-type: invalid\nsoapaction: wrong\nauthorization: wrong');
  await page.locator('#send-btn').click();
  await expect(page.locator('#response-checks')).toContainText('Expected SOAP 1.2');
  expect(sentHeaders['content-type']).toBe('application/soap+xml; charset=utf-8; action="urn:test"');
  expect(sentHeaders.soapaction).toBeUndefined();
  expect(sentHeaders.authorization).toBe(`Basic ${Buffer.from('café:☕').toString('base64')}`);
});

test('signed envelopes are not reformatted or rewritten and malformed headers fail before sending', async ({ page }) => {
  const signed = envelope('<x><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo/></ds:Signature></x>');
  await directRequest(page, signed);
  await page.locator('#format-request-btn').click();
  await expect(page.locator('#request-xml')).toHaveValue(signed);
  await page.locator('#soap-version').selectOption('1.2');
  await expect(page.locator('#error-box')).toContainText('invalidate the signature');
  await expect(page.locator('#request-xml')).toHaveValue(signed);
  await page.locator('#soap-version').selectOption('1.1');
  await page.locator('#custom-headers').fill('Invalid header');
  await page.locator('#send-btn').click();
  await expect(page.locator('#error-box')).toContainText('Name: value');
  await page.locator('#custom-headers').fill('');
  await page.locator('#soap-action').fill('urn:☕');
  await page.locator('#send-btn').click();
  await expect(page.locator('#error-box')).toContainText('Percent-encode');
});

test('compact workspace, visible sharing, light/dark layouts and keyboard-accessible bridge setup', async ({ page }, testInfo) => {
  await page.goto('/soap-client/');
  await expect(page.locator('#operations-section')).toBeHidden();
  const input = await page.locator('#endpoint-url').boundingBox();
  expect(input!.y).toBeLessThan(750);
  await expect(page.locator('#share-request-btn')).toBeVisible();
  await page.screenshot({ path: `/private/tmp/bugdays-soap-${testInfo.project.name}-light.png`, fullPage: true });
  await page.locator('#load-demo-btn').click();
  await expect(page.locator('#selected-operation')).toHaveText('GetCustomer');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: `/private/tmp/bugdays-soap-${testInfo.project.name}-dark.png`, fullPage: true });
  await page.locator('#use-proxy').evaluate(el => el.closest('details')!.open = true);
  await page.locator('#proxy-info-btn').click();
  await expect(page.locator('#proxy-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#proxy-modal')).toBeHidden();
  await expect(page.locator('#proxy-info-btn')).toBeFocused();
});
