// Export generators for the Schema Explorer: Markdown data dictionary,
// Mermaid ER diagram, and engine-specific COMMENT statements.

import type { ParsedSchema, ParsedTable } from './schema-parser';

export interface Annotations {
  /** table key -> comment */
  tables: Record<string, string>;
  /** "tableKey.columnName(lower)" -> comment */
  columns: Record<string, string>;
}

export function effectiveTableComment(t: ParsedTable, ann: Annotations): string {
  return ann.tables[t.key] ?? t.comment ?? '';
}

export function effectiveColumnComment(t: ParsedTable, colName: string, ann: Annotations): string {
  const key = `${t.key}.${colName.toLowerCase()}`;
  if (ann.columns[key] !== undefined) return ann.columns[key];
  const col = t.columns.find(c => c.name.toLowerCase() === colName.toLowerCase());
  return col?.comment ?? '';
}

const mdEscape = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function toMarkdown(schema: ParsedSchema, ann: Annotations): string {
  const lines: string[] = ['# Data Dictionary', ''];
  for (const t of schema.tables) {
    const tc = effectiveTableComment(t, ann);
    lines.push(`## ${t.name}`);
    if (tc) lines.push('', tc);
    lines.push('', '| Column | Type | Nullable | Key | Description |', '|---|---|---|---|---|');
    for (const c of t.columns) {
      const keys: string[] = [];
      if (c.isPrimaryKey) keys.push('PK');
      if (t.foreignKeys.some(fk => fk.columns.includes(c.name.toLowerCase()))) keys.push('FK');
      if (c.isUnique) keys.push('UQ');
      const cc = effectiveColumnComment(t, c.name, ann);
      lines.push(`| ${mdEscape(c.name)} | \`${mdEscape(c.type)}\` | ${c.nullable ? 'yes' : 'no'} | ${keys.join(', ')} | ${mdEscape(cc)} |`);
    }
    if (t.foreignKeys.length) {
      lines.push('', '**Relationships:**', '');
      for (const fk of t.foreignKeys) {
        lines.push(`- \`${fk.columns.join(', ')}\` → \`${fk.refTable}${fk.refColumns.length ? ` (${fk.refColumns.join(', ')})` : ''}\``);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

const mermaidIdent = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
// Mermaid types can't contain spaces or parens
const mermaidType = (s: string) => s.replace(/\(.*\)/, '').trim().replace(/\s+/g, '_') || 'unknown';

export function toMermaid(schema: ParsedSchema, ann: Annotations): string {
  const lines: string[] = ['erDiagram'];
  for (const t of schema.tables) {
    lines.push(`  ${mermaidIdent(t.name)} {`);
    for (const c of t.columns) {
      const keys: string[] = [];
      if (c.isPrimaryKey) keys.push('PK');
      if (t.foreignKeys.some(fk => fk.columns.includes(c.name.toLowerCase()))) keys.push('FK');
      if (!keys.length && c.isUnique) keys.push('UK');
      const cc = effectiveColumnComment(t, c.name, ann);
      const commentPart = cc ? ` "${cc.replace(/"/g, "'")}"` : '';
      lines.push(`    ${mermaidType(c.type)} ${mermaidIdent(c.name)}${keys.length ? ' ' + keys.join(',') : ''}${commentPart}`);
    }
    lines.push('  }');
  }
  const keyToName = new Map(schema.tables.map(t => [t.key, t.name]));
  for (const t of schema.tables) {
    for (const fk of t.foreignKeys) {
      const target = keyToName.get(fk.refTable);
      if (!target) continue;
      // FK column nullable => optional relationship
      const col = t.columns.find(c => fk.columns.includes(c.name.toLowerCase()));
      const many = col?.nullable ? 'o{' : '|{';
      lines.push(`  ${mermaidIdent(target)} ||--${many} ${mermaidIdent(t.name)} : "${fk.columns.join(', ')}"`);
    }
  }
  return lines.join('\n');
}

export type CommentDialect = 'postgres' | 'mysql' | 'sqlserver';

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Generate comment DDL. 'postgres' output (COMMENT ON) also works for
 * Oracle and DB2.
 */
export function toCommentSql(schema: ParsedSchema, ann: Annotations, dialect: CommentDialect): string {
  const lines: string[] = [];
  for (const t of schema.tables) {
    const tc = effectiveTableComment(t, ann);
    const qualified = t.schema ? `${t.schema}.${t.name}` : t.name;

    if (tc) {
      if (dialect === 'postgres') {
        lines.push(`COMMENT ON TABLE ${qualified} IS ${sqlString(tc)};`);
      } else if (dialect === 'mysql') {
        lines.push(`ALTER TABLE ${qualified} COMMENT = ${sqlString(tc)};`);
      } else {
        lines.push(
          `EXEC sp_addextendedproperty 'MS_Description', ${sqlString(tc)}, 'SCHEMA', '${t.schema ?? 'dbo'}', 'TABLE', '${t.name}';`
        );
      }
    }

    for (const c of t.columns) {
      const cc = effectiveColumnComment(t, c.name, ann);
      if (!cc) continue;
      if (dialect === 'postgres') {
        lines.push(`COMMENT ON COLUMN ${qualified}.${c.name} IS ${sqlString(cc)};`);
      } else if (dialect === 'mysql') {
        // MySQL requires the full column definition to set a comment
        const nullPart = c.nullable ? '' : ' NOT NULL';
        const defPart = c.defaultValue ? ` DEFAULT ${c.defaultValue}` : '';
        lines.push(`ALTER TABLE ${qualified} MODIFY COLUMN ${c.name} ${c.type}${nullPart}${defPart} COMMENT ${sqlString(cc)};`);
      } else {
        lines.push(
          `EXEC sp_addextendedproperty 'MS_Description', ${sqlString(cc)}, 'SCHEMA', '${t.schema ?? 'dbo'}', 'TABLE', '${t.name}', 'COLUMN', '${c.name}';`
        );
      }
    }
  }
  if (!lines.length) return '-- No comments or annotations to export yet.';
  if (dialect === 'mysql') {
    lines.unshift('-- Note: MySQL column comments require restating the column definition.', '-- Review generated MODIFY COLUMN statements before running them.', '');
  }
  return lines.join('\n');
}

export function toJson(schema: ParsedSchema, ann: Annotations): string {
  const out = schema.tables.map(t => ({
    name: t.name,
    schema: t.schema,
    comment: effectiveTableComment(t, ann) || undefined,
    primaryKey: t.primaryKey,
    columns: t.columns.map(c => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      default: c.defaultValue,
      comment: effectiveColumnComment(t, c.name, ann) || undefined,
    })),
    foreignKeys: t.foreignKeys.map(fk => ({
      columns: fk.columns,
      references: { table: fk.refTable, columns: fk.refColumns },
    })),
  }));
  return JSON.stringify({ tables: out }, null, 2);
}
