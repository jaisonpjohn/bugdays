import { schemaFingerprint, type ParsedColumn, type ParsedForeignKey, type ParsedSchema, type ParsedTable } from './schema-parser.ts';

type Row = Record<string, unknown>;
const MAX_TEXT_LENGTH = 10 * 1024 * 1024;
const MAX_ROWS = 100_000;

function csvRows(text: string): Row[] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && !cell) quoted = true;
    else if (char === ',') { record.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      record.push(cell); cell = '';
      if (record.some(value => value.trim())) records.push(record);
      record = [];
      if (records.length > MAX_ROWS + 1) throw new Error('Too many metadata rows (100,000 maximum).');
    } else cell += char;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted cell.');
  record.push(cell);
  if (record.some(value => value.trim())) records.push(record);
  const [headers, ...values] = records;
  if (!headers?.length) return [];
  return values.map((fields, index) => {
    if (fields.length !== headers.length) throw new Error(`CSV row ${index + 2} has ${fields.length} cells; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, column) => [header, fields[column]]));
  });
}

function rowsFromInput(text: string, property?: 'columns' | 'foreignKeys'): Row[] {
  if (text.length > MAX_TEXT_LENGTH) throw new Error('Metadata import is limited to 10 MB. Export one schema at a time.');
  const trimmed = text.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return [];
  let rows: unknown;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { rows = JSON.parse(trimmed); }
    catch { throw new Error('Invalid JSON. Paste an array of rows or export CSV instead.'); }
    if (!Array.isArray(rows) && rows && typeof rows === 'object') {
      const data = rows as Record<string, unknown>;
      rows = property ? data[property] ?? data.rows : data.rows;
    }
  } else rows = csvRows(trimmed);
  if (!Array.isArray(rows)) throw new Error('Expected CSV with a header row or a JSON array of row objects.');
  if (rows.length > MAX_ROWS) throw new Error('Too many metadata rows (100,000 maximum).');
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Every metadata row must be an object.');
  return rows as Row[];
}

function normalized(row: Row): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'), value]));
}

function field(row: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return '';
}

function truthy(value: string): boolean {
  return /^(?:yes|y|true|t|pri)$/i.test(value) || (/^\d+$/.test(value) && Number(value) > 0);
}

function nullable(value: string): boolean {
  return !/^(?:no|n|false|f|0)$/i.test(value);
}

function rowTable(row: Record<string, unknown>): { schema?: string; name: string; identity: string } {
  const name = field(row, 'table_name', 'tabname');
  const schema = field(row, 'table_schema', 'schema_name', 'tabschema', 'owner') || undefined;
  return { schema, name, identity: `${schema ?? ''}\u0000${name}`.toLowerCase() };
}

/** Import CSV/JSON rows from catalog or information_schema queries; nothing is uploaded. */
export function parseMetadataSchema(columnsInput: string, foreignKeysInput = ''): ParsedSchema {
  const columnRows = rowsFromInput(columnsInput, 'columns').map(normalized);
  if (!columnRows.length) throw new Error('Paste column metadata as CSV or JSON first.');
  const warnings: string[] = [];
  const tables = new Map<string, ParsedTable>();
  const order = new Map<string, Map<string, number>>();
  for (const [index, row] of columnRows.entries()) {
    const table = rowTable(row);
    const columnName = field(row, 'column_name', 'colname');
    const type = field(row, 'column_type', 'data_type', 'typename', 'type') || 'unknown';
    if (!table.name || !columnName) {
      warnings.push(`Column row ${index + 1}: needs table_name and column_name — skipped`);
      continue;
    }
    if (!tables.has(table.identity)) {
      tables.set(table.identity, { name: table.name, key: table.name.toLowerCase(), schema: table.schema, columns: [], primaryKey: [], foreignKeys: [], ddl: [], comment: field(row, 'table_comment') || undefined });
      order.set(table.identity, new Map());
    }
    const target = tables.get(table.identity)!;
    if (target.columns.some(column => column.name.toLowerCase() === columnName.toLowerCase())) {
      warnings.push(`${table.name}.${columnName}: duplicate column row — skipped`);
      continue;
    }
    const isPrimaryKey = truthy(field(row, 'is_primary_key', 'primary_key', 'column_key', 'pk', 'keyseq'));
    const column: ParsedColumn = {
      name: columnName,
      type,
      nullable: nullable(field(row, 'is_nullable', 'nullable', 'nulls')) && !isPrimaryKey,
      isPrimaryKey,
      isUnique: truthy(field(row, 'is_unique')) || field(row, 'column_key').toUpperCase() === 'UNI',
      defaultValue: field(row, 'column_default', 'default', 'dflt_value') || undefined,
      comment: field(row, 'column_comment', 'comments') || undefined,
    };
    target.columns.push(column);
    if (isPrimaryKey) target.primaryKey.push(columnName.toLowerCase());
    const position = Number(field(row, 'ordinal_position', 'colno', 'cid'));
    order.get(table.identity)!.set(columnName.toLowerCase(), Number.isFinite(position) ? position : index);
  }
  const list = [...tables.values()];
  if (!list.length) throw new Error(`No usable columns found. ${warnings.slice(0, 2).join(' ')}`);
  for (const [identity, table] of tables) {
    const positions = order.get(identity)!;
    table.columns.sort((a, b) => (positions.get(a.name.toLowerCase()) ?? 0) - (positions.get(b.name.toLowerCase()) ?? 0));
  }
  const counts = new Map<string, number>();
  for (const table of list) counts.set(table.key, (counts.get(table.key) ?? 0) + 1);
  for (const table of list) if ((counts.get(table.key) ?? 0) > 1 && table.schema) table.key = `${table.schema.toLowerCase()}.${table.key}`;
  const byIdentity = new Map([...tables].map(([identity, table]) => [identity, table]));
  const byKey = new Map(list.map(table => [table.key, table]));
  const relationshipRows = [...columnRows.filter(row => field(row, 'foreign_table_name', 'referenced_table_name', 'ref_table_name')),
    ...rowsFromInput(foreignKeysInput, 'foreignKeys').map(normalized)];
  const groups = new Map<string, { table: ParsedTable; fk: ParsedForeignKey; columns: Array<{ position: number; column: string; refColumn: string }> }>();
  for (const [index, row] of relationshipRows.entries()) {
    const source = rowTable(row);
    const targetName = field(row, 'foreign_table_name', 'referenced_table_name', 'ref_table_name');
    const targetSchema = field(row, 'foreign_table_schema', 'referenced_table_schema', 'ref_table_schema') || source.schema || '';
    const sourceColumn = field(row, 'column_name', 'colname');
    const targetColumn = field(row, 'foreign_column_name', 'referenced_column_name', 'ref_column_name');
    const sourceTable = byIdentity.get(source.identity);
    if (!sourceTable || !sourceColumn || !targetName) {
      warnings.push(`Relationship row ${index + 1}: missing source table, column or referenced table — skipped`);
      continue;
    }
    const target = byIdentity.get(`${targetSchema}\u0000${targetName}`.toLowerCase()) ?? byKey.get(targetName.toLowerCase());
    const constraint = field(row, 'constraint_name', 'fk_name') || `${sourceColumn}->${targetName}`;
    const groupKey = `${sourceTable.key}\u0000${constraint}\u0000${target?.key ?? targetName.toLowerCase()}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { table: sourceTable, fk: { name: constraint, columns: [], refTable: target?.key ?? targetName.toLowerCase(), refColumns: [] }, columns: [] });
    const position = Number(field(row, 'ordinal_position', 'position', 'seq'));
    groups.get(groupKey)!.columns.push({ position: Number.isFinite(position) ? position : index, column: sourceColumn.toLowerCase(), refColumn: targetColumn.toLowerCase() });
  }
  for (const { table, fk, columns } of groups.values()) {
    columns.sort((a, b) => a.position - b.position);
    fk.columns = columns.map(item => item.column);
    fk.refColumns = columns.map(item => item.refColumn).filter(Boolean);
    if (!table.foreignKeys.some(existing => existing.name === fk.name && existing.refTable === fk.refTable)) table.foreignKeys.push(fk);
    if (!byKey.has(fk.refTable)) warnings.push(`${table.name}: referenced table ${fk.refTable} is not in the imported columns`);
  }
  return { tables: list, warnings, fingerprint: schemaFingerprint(list) };
}
