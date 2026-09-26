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
