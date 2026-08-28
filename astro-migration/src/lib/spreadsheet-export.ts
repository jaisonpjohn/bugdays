const encoder = new TextEncoder();

export interface SpreadsheetOptions {
  sheetName?: string;
  headerRow?: boolean;
}

function xmlEscape(value: string): string {
  return value
    .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function columnReference(index: number): string {
  let value = index + 1;
  let reference = '';
  while (value > 0) {
    value--;
    reference = String.fromCharCode(65 + (value % 26)) + reference;
    value = Math.floor(value / 26);
  }
  return reference;
}

function sanitizeSheetName(value: string): string {
  return (value || 'Table').replace(/[\\/*?:\[\]]/g, ' ').trim().slice(0, 31) || 'Table';
}

function worksheetXml(rows: string[][], headerRow: boolean): string {
  const columnCount = Math.max(1, ...rows.map(row => row.length));
  const widths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const contentWidth = Math.max(
      8,
      ...rows.slice(0, 500).map(row => Array.from(row[columnIndex] || '').length + 2),
    );
    return Math.min(55, contentWidth);
  });
  const columns = widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('');
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = Array.from({ length: columnCount }, (_, columnIndex) => {
      const reference = `${columnReference(columnIndex)}${rowIndex + 1}`;
      const style = headerRow && rowIndex === 0 ? 1 : 2;
      return `<c r="${reference}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEscape(row[columnIndex] || '')}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const lastCell = `${columnReference(columnCount - 1)}${Math.max(1, rows.length)}`;
  const pane = headerRow && rows.length > 1
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    : '';
  const autoFilter = headerRow && rows.length > 1 ? `<autoFilter ref="A1:${lastCell}"/>` : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  <sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${columns}</cols>
  <sheetData>${sheetRows}</sheetData>
  ${autoFilter}
</worksheet>`;
}

function workbookXml(sheetName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView/></bookViews>
  <sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Aptos"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos Display"/><family val="2"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint16(offset, value, true);
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, true);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function zip(entries: ZipEntry[]): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.data);
    const localHeader = new Uint8Array(30 + name.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 0);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, entry.data.length);
    writeUint32(localHeader, 22, entry.data.length);
    writeUint16(localHeader, 26, name.length);
    localHeader.set(name, 30);
    localChunks.push(localHeader, entry.data);

    const centralHeader = new Uint8Array(46 + name.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, 0);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, entry.data.length);
    writeUint32(centralHeader, 24, entry.data.length);
    writeUint16(centralHeader, 28, name.length);
    writeUint32(centralHeader, 42, localOffset);
    centralHeader.set(name, 46);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + entry.data.length;
  }

  const centralDirectory = concatBytes(centralChunks);
  const end = new Uint8Array(22);
  writeUint32(end, 0, 0x06054b50);
  writeUint16(end, 8, entries.length);
  writeUint16(end, 10, entries.length);
  writeUint32(end, 12, centralDirectory.length);
  writeUint32(end, 16, localOffset);
  return concatBytes([...localChunks, centralDirectory, end]);
}

function textEntry(name: string, contents: string): ZipEntry {
  return { name, data: encoder.encode(contents) };
}

export function createXlsxBlob(rows: string[][], options: SpreadsheetOptions = {}): Blob {
  if (rows.length === 0) throw new Error('There is no table to export.');
  const sheetName = sanitizeSheetName(options.sheetName || 'Table');
  const entries: ZipEntry[] = [
    textEntry('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    textEntry('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    textEntry('xl/workbook.xml', workbookXml(sheetName)),
    textEntry('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    textEntry('xl/styles.xml', STYLES_XML),
    textEntry('xl/worksheets/sheet1.xml', worksheetXml(rows, options.headerRow !== false)),
  ];
  const bytes = zip(entries);
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function tableToDelimited(rows: string[][], delimiter: ',' | '\t', protectFormulas = true): string {
  return rows.map(row => row.map(value => {
    const protectedValue = protectFormulas && /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
    if (delimiter === '\t') return protectedValue.replace(/[\t\r\n]+/g, ' ');
    const escaped = protectedValue.replaceAll('"', '""');
    return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
  }).join(delimiter)).join('\r\n');
}

export function safeDownloadName(value: string): string {
  const safe = value.trim().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return safe || 'terminal-table';
}
