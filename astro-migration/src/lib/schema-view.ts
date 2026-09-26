import type { ParsedSchema, ParsedTable } from './schema-parser.ts';

export const MAX_DIAGRAM_TABLES = 150;
export const MAX_TABLE_RESULTS = 60;

export function matchingTables(schema: ParsedSchema, query: string, schemaName = ''): ParsedTable[] {
  const needle = query.trim().toLocaleLowerCase();
  return schema.tables.filter(table =>
    (!schemaName || (table.schema ?? '') === schemaName) &&
    (!needle || `${table.schema ?? ''}.${table.name}`.toLocaleLowerCase().includes(needle) ||
      table.columns.some(column => column.name.toLocaleLowerCase().includes(needle)))
  );
}

export function neighborhood(schema: ParsedSchema, key: string, hops: 1 | 2): ParsedTable[] {
  const byKey = new Map(schema.tables.map(table => [table.key, table]));
  const adjacent = new Map(schema.tables.map(table => [table.key, new Set<string>()]));
  for (const table of schema.tables) {
    for (const fk of table.foreignKeys) {
      if (!byKey.has(fk.refTable)) continue;
      adjacent.get(table.key)!.add(fk.refTable);
      adjacent.get(fk.refTable)!.add(table.key);
    }
  }
  const seen = new Set([key]);
  let frontier = [key];
  for (let step = 0; step < hops; step++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const other of adjacent.get(current) ?? []) {
        if (!seen.has(other)) { seen.add(other); next.push(other); }
      }
    }
    frontier = next;
  }
  return schema.tables.filter(table => seen.has(table.key));
}
