// Dialect-tolerant SQL DDL parser for the Schema Explorer.
// Understands the CREATE TABLE / ALTER TABLE / COMMENT ON subset emitted by
// pg_dump, mysqldump, Oracle DBMS_METADATA, db2look and SSMS "Script Table".
// Everything runs in the browser — no SQL is sent anywhere.

export interface ParsedColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  defaultValue?: string;
  comment?: string;
  /** Set when the column has an inline REFERENCES clause */
  references?: { table: string; column?: string };
}

export interface ParsedForeignKey {
  name?: string;
  columns: string[];
  refTable: string;   // normalized lookup key (lowercase, schema kept if given)
  refColumns: string[];
}

export interface ParsedTable {
  name: string;       // display name (original case, without quotes)
  key: string;        // normalized lookup key
  schema?: string;
  columns: ParsedColumn[];
  primaryKey: string[];
  foreignKeys: ParsedForeignKey[];
  comment?: string;
  /** Source statements that involve this table: CREATE, ALTERs, COMMENT ON, indexes, triggers */
  ddl: string[];
}

export interface ParsedSchema {
  tables: ParsedTable[];
  /** Human-readable notes about statements that were skipped or partially understood */
  warnings: string[];
  /** Stable fingerprint of the structure — used to key annotations in localStorage */
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// Statement splitting (string/comment/dollar-quote aware)
// ---------------------------------------------------------------------------

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    const two = sql.substr(i, 2);

    // Line comment
    if (two === '--') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (two === '/*') {
      i += 2;
      while (i < n && sql.substr(i, 2) !== '*/') i++;
      i += 2;
      continue;
    }
    // Single-quoted string ('' escape)
    if (ch === "'") {
      current += ch; i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { current += "''"; i += 2; continue; }
        if (sql[i] === '\\' && sql[i + 1] === "'") { current += "\\'"; i += 2; continue; }
        current += sql[i];
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    // Double-quoted identifier
    if (ch === '"' || ch === '`') {
      const quote = ch;
      current += ch; i++;
      while (i < n && sql[i] !== quote) { current += sql[i]; i++; }
      if (i < n) { current += quote; i++; }
      continue;
    }
    // Bracketed identifier [x] (SQL Server)
    if (ch === '[') {
      current += ch; i++;
      while (i < n && sql[i] !== ']') { current += sql[i]; i++; }
      if (i < n) { current += ']'; i++; }
      continue;
    }
    // Dollar quoting $tag$ ... $tag$ (Postgres function bodies)
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          current += sql.slice(i, end + tag.length);
          i = end + tag.length;
          continue;
        }
      }
    }
    // Statement terminator
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

// ---------------------------------------------------------------------------
// Identifier helpers
// ---------------------------------------------------------------------------

function unquoteIdent(raw: string): string {
  const s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith('`') && s.endsWith('`'))
  ) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1);
  return s;
}

/** Split a possibly schema-qualified name into parts, respecting quotes */
function splitQualified(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of raw.trim()) {
    if (quote) {
      if ((quote === '[' && ch === ']') || ch === quote) { quote = null; }
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '[') { quote = '['; continue; }
    if (ch === '.') { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.filter(p => p.length > 0);
}

/** Normalized lookup key: last (or last two) name parts, lowercased */
export function tableKey(raw: string): string {
  const parts = splitQualified(raw);
  const name = parts[parts.length - 1];
  return name.toLowerCase();
}

function columnList(raw: string): string[] {
  return raw.split(',').map(c => unquoteIdent(c.trim()).toLowerCase()).filter(Boolean);
}

/** Split a parenthesized body on commas at depth 0 (string-aware) */
function splitBody(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (quote === "'" && ch === "'" && body[i + 1] === "'") { current += "'"; i++; continue; }
      if ((quote === '[' && ch === ']') || ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '[') { quote = '['; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { items.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/** Extract a string literal value ('' unescaped) */
function unquoteString(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

// ---------------------------------------------------------------------------
// CREATE TABLE parsing
// ---------------------------------------------------------------------------

const CONSTRAINT_STARTERS = /^(constraint\b|primary\s+key|foreign\s+key|unique\b|check\s*\(|key\s|index\s|fulltext|spatial|exclude|like\s|period\s)/i;

// Keywords that terminate the data type portion of a column definition
const TYPE_BOUNDARY = /\s+(not\s+null|null\b|default\b|primary\s+key|references\b|unique\b|check\b|constraint\b|comment\b|auto_increment\b|autoincrement\b|generated\b|identity\b|collate\b|character\s+set\b|on\s+update\b|with\s+default\b|serial\b)/i;

function parseColumnDef(def: string, warnings: string[], tableName: string): ParsedColumn | null {
  // Extract column name
  const nameMatch = /^("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$#]*))\s+/.exec(def);
  if (!nameMatch) return null;
  const name = nameMatch[2] ?? nameMatch[3] ?? nameMatch[4] ?? nameMatch[5];
  let rest = def.slice(nameMatch[0].length).trim();

  // Data type: everything up to the first boundary keyword
  const boundary = TYPE_BOUNDARY.exec(rest);
  let type = (boundary ? rest.slice(0, boundary.index) : rest).trim();
  const flags = boundary ? rest.slice(boundary.index) : '';
  if (!type) {
    warnings.push(`${tableName}.${name}: could not determine data type`);
    type = '?';
  }

  const col: ParsedColumn = {
    name,
    type: type.replace(/\s+/g, ' '),
    nullable: !/not\s+null/i.test(flags),
    isPrimaryKey: /primary\s+key/i.test(flags),
    isUnique: /\bunique\b/i.test(flags),
  };

  // serial / identity / auto_increment imply not null
  if (/serial|identity|auto_increment|autoincrement/i.test(def)) col.nullable = false;

  // Value forms: string literal, (possibly nested) parenthesized expr, or bare token
  const defMatch = /default\s+((?:'(?:[^']|'')*')|\((?:[^()]|\([^()]*\))*\)|[^\s,]+(?:\s*\([^)]*\))?)/i.exec(flags);
  if (defMatch) col.defaultValue = defMatch[1];

  const refMatch = /references\s+([\w$#."`[\]]+)\s*(?:\(([^)]*)\))?/i.exec(flags);
  if (refMatch) {
    col.references = {
      table: tableKey(refMatch[1]),
      column: refMatch[2] ? columnList(refMatch[2])[0] : undefined,
    };
  }

  const commentMatch = /comment\s+('(?:[^']|'')*')/i.exec(flags);
  if (commentMatch) col.comment = unquoteString(commentMatch[1]);

  return col;
}

function parseCreateTable(stmt: string, warnings: string[]): ParsedTable | null {
  const headMatch = /^create\s+(?:or\s+replace\s+)?(?:global\s+temporary\s+|local\s+temporary\s+|temporary\s+|temp\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w$#."`[\]]+)\s*\(/i.exec(stmt);
  if (!headMatch) return null;

  const rawName = headMatch[1];
  const parts = splitQualified(rawName);
  const name = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;

  // Find matching close paren for the body
  const openIdx = headMatch[0].length - 1;
  let depth = 0;
  let closeIdx = -1;
  let quote: string | null = null;
  for (let i = openIdx; i < stmt.length; i++) {
    const ch = stmt[i];
    if (quote) {
      if (quote === "'" && ch === "'" && stmt[i + 1] === "'") { i++; continue; }
      if ((quote === '[' && ch === ']') || ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '[') { quote = '['; continue; }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
  }
  if (closeIdx === -1) {
    warnings.push(`CREATE TABLE ${name}: unbalanced parentheses — skipped`);
    return null;
  }

  const body = stmt.slice(openIdx + 1, closeIdx);
  const tail = stmt.slice(closeIdx + 1);

  const table: ParsedTable = {
    name,
    key: name.toLowerCase(),
    schema,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    ddl: [],
  };

  // MySQL table-level comment: ) ENGINE=InnoDB COMMENT='...'
  const tableCommentMatch = /comment\s*=?\s*('(?:[^']|'')*')/i.exec(tail);
  if (tableCommentMatch) table.comment = unquoteString(tableCommentMatch[1]);

  for (const item of splitBody(body)) {
    if (CONSTRAINT_STARTERS.test(item)) {
      // Table-level primary key
      const pkMatch = /primary\s+key\s*(?:\w*\s*)?\(([^)]*)\)/i.exec(item);
      if (pkMatch && !/foreign\s+key/i.test(item)) {
        table.primaryKey.push(...columnList(pkMatch[1]));
        continue;
      }
      // Foreign key
      const fkMatch = /(?:constraint\s+([\w$#"`[\]]+)\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+([\w$#."`[\]]+)\s*(?:\(([^)]*)\))?/i.exec(item);
      if (fkMatch) {
        table.foreignKeys.push({
          name: fkMatch[1] ? unquoteIdent(fkMatch[1]) : undefined,
          columns: columnList(fkMatch[2]),
          refTable: tableKey(fkMatch[3]),
          refColumns: fkMatch[4] ? columnList(fkMatch[4]) : [],
        });
        continue;
      }
      // Unique constraint on a single column
      const uqMatch = /unique(?:\s+key|\s+index)?\s*(?:[\w$#"`[\]]*\s*)?\(([^)]*)\)/i.exec(item);
      if (uqMatch) {
        const cols = columnList(uqMatch[1]);
        if (cols.length === 1) {
          const col = table.columns.find(c => c.name.toLowerCase() === cols[0]);
          if (col) col.isUnique = true;
        }
        continue;
      }
      // KEY/INDEX/CHECK/etc. — structurally irrelevant here
      continue;
    }

    const col = parseColumnDef(item, warnings, name);
    if (col) {
      table.columns.push(col);
      if (col.isPrimaryKey) table.primaryKey.push(col.name.toLowerCase());
      if (col.references) {
        table.foreignKeys.push({
          columns: [col.name.toLowerCase()],
          refTable: col.references.table,
          refColumns: col.references.column ? [col.references.column] : [],
        });
      }
    }
  }

  // Mark PK flags on columns from table-level PK
  for (const pkCol of table.primaryKey) {
    const col = table.columns.find(c => c.name.toLowerCase() === pkCol);
    if (col) { col.isPrimaryKey = true; col.nullable = false; }
  }

  return table;
}

// ---------------------------------------------------------------------------
// ALTER TABLE / COMMENT ON parsing
// ---------------------------------------------------------------------------

function applyAlterTable(stmt: string, tables: Map<string, ParsedTable>, warnings: string[]) {
  const headMatch = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w$#."`[\]]+)\s+/i.exec(stmt);
  if (!headMatch) return;
  const key = tableKey(headMatch[1]);
  const table = tables.get(key);
  if (!table) return; // FK to a table outside the pasted DDL — fine

  const rest = stmt.slice(headMatch[0].length);

  // ADD [CONSTRAINT x] FOREIGN KEY (...) REFERENCES t (...)
  const fkRe = /(?:constraint\s+([\w$#"`[\]]+)\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+([\w$#."`[\]]+)\s*(?:\(([^)]*)\))?/gi;
  let m: RegExpExecArray | null;
  while ((m = fkRe.exec(rest)) !== null) {
    table.foreignKeys.push({
      name: m[1] ? unquoteIdent(m[1]) : undefined,
      columns: columnList(m[2]),
      refTable: tableKey(m[3]),
      refColumns: m[4] ? columnList(m[4]) : [],
    });
  }

  // ADD [CONSTRAINT x] PRIMARY KEY (...)
  const pkMatch = /(?:constraint\s+[\w$#"`[\]]+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(rest);
  if (pkMatch && !/foreign\s+key/i.test(rest.slice(0, pkMatch.index))) {
    const cols = columnList(pkMatch[1]);
    for (const c of cols) {
      if (!table.primaryKey.includes(c)) table.primaryKey.push(c);
      const col = table.columns.find(x => x.name.toLowerCase() === c);
      if (col) { col.isPrimaryKey = true; col.nullable = false; }
    }
  }
}

function applyCommentOn(stmt: string, tables: Map<string, ParsedTable>) {
  const tblMatch = /^comment\s+on\s+table\s+([\w$#."`[\]]+)\s+is\s+('(?:[^']|'')*'|null)/i.exec(stmt);
  if (tblMatch) {
    const table = tables.get(tableKey(tblMatch[1]));
    if (table && tblMatch[2].toLowerCase() !== 'null') table.comment = unquoteString(tblMatch[2]);
    return;
  }
  const colMatch = /^comment\s+on\s+column\s+([\w$#."`[\]]+)\s+is\s+('(?:[^']|'')*'|null)/i.exec(stmt);
  if (colMatch) {
    const parts = splitQualified(colMatch[1]);
    if (parts.length < 2) return;
    const colName = parts[parts.length - 1].toLowerCase();
    const tblName = parts[parts.length - 2].toLowerCase();
    const table = tables.get(tblName);
    const col = table?.columns.find(c => c.name.toLowerCase() === colName);
    if (col && colMatch[2].toLowerCase() !== 'null') col.comment = unquoteString(colMatch[2]);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseSchema(sql: string): ParsedSchema {
  const warnings: string[] = [];
  const tables = new Map<string, ParsedTable>();
  const statements = splitStatements(sql);

  // Pass 1: tables
  for (const stmt of statements) {
    if (/^create\s/i.test(stmt)) {
      const table = parseCreateTable(stmt, warnings);
      if (table) {
        if (tables.has(table.key)) warnings.push(`Duplicate table ${table.name} — later definition wins`);
        table.ddl.push(stmt + ';');
        tables.set(table.key, table);
      }
    }
  }

  const attachDdl = (rawName: string | undefined, stmt: string) => {
    if (!rawName) return;
    const table = tables.get(tableKey(rawName));
    if (table) table.ddl.push(stmt + ';');
  };

  // Pass 2: alters + comments (may reference tables defined later in the file)
  for (const stmt of statements) {
    if (/^alter\s+table\s/i.test(stmt)) {
      applyAlterTable(stmt, tables, warnings);
      attachDdl(/^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w$#."`[\]]+)/i.exec(stmt)?.[1], stmt);
    } else if (/^comment\s+on\s/i.test(stmt)) {
      applyCommentOn(stmt, tables);
      const m = /^comment\s+on\s+(?:table|column)\s+([\w$#."`[\]]+)/i.exec(stmt);
      if (m) {
        // For COMMENT ON COLUMN t.c the table is the second-to-last part
        const parts = splitQualified(m[1]);
        const isColumn = /^comment\s+on\s+column/i.test(stmt);
        const tbl = isColumn ? parts[parts.length - 2] : parts[parts.length - 1];
        attachDdl(tbl, stmt);
      }
    } else if (/^create\s+(?:unique\s+)?index\s/i.test(stmt)) {
      attachDdl(/\son\s+([\w$#."`[\]]+)/i.exec(stmt)?.[1], stmt);
    } else if (/^create\s+(?:or\s+replace\s+)?trigger\s/i.test(stmt)) {
      attachDdl(/\son\s+([\w$#."`[\]]+)/i.exec(stmt)?.[1], stmt);
    }
  }

  const list = [...tables.values()];

  // Note dangling FK targets (referenced table not in the paste)
  for (const t of list) {
    for (const fk of t.foreignKeys) {
      if (!tables.has(fk.refTable)) {
        warnings.push(`${t.name}: foreign key references "${fk.refTable}" which is not in the pasted DDL`);
      }
    }
  }

  // Fingerprint: structure only (names), so annotations survive comment edits
  const canonical = list
    .map(t => `${t.key}(${t.columns.map(c => c.name.toLowerCase()).sort().join(',')})`)
    .sort()
    .join(';');
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0;
  }
  const fingerprint = (hash >>> 0).toString(36);

  return { tables: list, warnings, fingerprint };
}
