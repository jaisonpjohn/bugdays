import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetadataSchema } from '../src/lib/schema-metadata.ts';
import { metadataQueries } from '../src/lib/schema-metadata-queries.ts';
import { toMermaid, toMarkdown } from '../src/lib/schema-export.ts';

const columns = `table_schema,table_name,column_name,data_type,ordinal_position,is_nullable,is_primary_key,column_comment
public,customers,id,bigint,1,NO,YES,"Surrogate, key"
public,customers,name,"varchar(200)",2,YES,NO,"Preferred\nname"
public,orders,id,bigint,1,NO,YES,
public,orders,customer_id,bigint,2,NO,NO,`;
const foreignKeys = `table_schema,table_name,column_name,constraint_name,ordinal_position,foreign_table_schema,foreign_table_name,foreign_column_name
public,orders,customer_id,fk_orders_customer,1,public,customers,id`;

test('catalog CSV imports columns, comments, primary keys and relationships', () => {
  const schema = parseMetadataSchema(columns, foreignKeys);
  assert.equal(schema.tables.length, 2);
  assert.equal(schema.warnings.length, 0);
  const customer = schema.tables.find(table => table.name === 'customers');
  const order = schema.tables.find(table => table.name === 'orders');
  assert.deepEqual(customer.primaryKey, ['id']);
  assert.equal(customer.columns[0].comment, 'Surrogate, key');
  assert.equal(customer.columns[1].comment, 'Preferred\nname');
  assert.equal(order.foreignKeys[0].refTable, 'customers');
  assert.deepEqual(order.foreignKeys[0].columns, ['customer_id']);
});

test('JSON catalog object groups composite foreign keys and duplicate names by schema', () => {
  const data = {
    columns: [
      { table_schema: 'a', table_name: 'users', column_name: 'id', data_type: 'int', keyseq: 1 },
      { table_schema: 'b', table_name: 'users', column_name: 'id', data_type: 'int', keyseq: 2 },
      { table_schema: 'b', table_name: 'orders', column_name: 'user_id', data_type: 'int' },
      { table_schema: 'b', table_name: 'orders', column_name: 'tenant_id', data_type: 'int' },
    ],
    foreignKeys: [
      { table_schema: 'b', table_name: 'orders', column_name: 'tenant_id', constraint_name: 'orders_users', ordinal_position: 2, foreign_table_schema: 'b', foreign_table_name: 'users', foreign_column_name: 'tenant_id' },
      { table_schema: 'b', table_name: 'orders', column_name: 'user_id', constraint_name: 'orders_users', ordinal_position: 1, foreign_table_schema: 'b', foreign_table_name: 'users', foreign_column_name: 'id' },
    ],
  };
  const schema = parseMetadataSchema(JSON.stringify(data), JSON.stringify(data.foreignKeys));
  assert.deepEqual(schema.tables.map(table => table.key), ['a.users', 'b.users', 'orders']);
  assert.equal(schema.tables[1].columns[0].isPrimaryKey, true);
  assert.equal(schema.tables[2].foreignKeys[0].refTable, 'b.users');
  assert.deepEqual(schema.tables[2].foreignKeys[0].columns, ['user_id', 'tenant_id']);
  const mermaid = toMermaid(schema, { tables: {}, columns: {} });
  assert.match(mermaid, /a_users \{/);
  assert.match(mermaid, /b_users \{/);
  assert.match(mermaid, /b_users \|\|--o\{ orders/);
  assert.match(toMarkdown(schema, { tables: {}, columns: {} }), /## b\.users/);
});

test('inline foreign key rows and unknown SQLite types are accepted', () => {
  const schema = parseMetadataSchema(JSON.stringify([
    { table_name: 'parent', column_name: 'id', type: '' },
    { table_name: 'child', column_name: 'parent_id', type: 'INTEGER', foreign_table_name: 'parent', foreign_column_name: 'id' },
  ]));
  assert.equal(schema.tables[0].columns[0].type, 'unknown');
  assert.equal(schema.tables[1].foreignKeys.length, 1);
});

test('malformed metadata is rejected or warned without inventing tables', () => {
  assert.throws(() => parseMetadataSchema('table_name,column_name\n"unterminated'), /unclosed quoted/);
  assert.throws(() => parseMetadataSchema('{'), /Invalid JSON/);
  assert.throws(() => parseMetadataSchema('table_name,column_name\nfoo,bar,baz'), /row 2 has 3 cells/);
  assert.throws(() => parseMetadataSchema('table_name,column_name\nfoo,'), /No usable columns/);
  const parsed = parseMetadataSchema(`table_name,column_name,data_type\nfoo,id,int\n,id,int`);
  assert.equal(parsed.tables.length, 1);
  assert.match(parsed.warnings.join(' '), /row 2.*skipped/);
  assert.throws(() => parseMetadataSchema('x'.repeat(10 * 1024 * 1024 + 1)), /10 MB/);
});

test('every engine has both read-only column and relationship queries', () => {
  assert.deepEqual(Object.keys(metadataQueries), ['postgres', 'mysql', 'sqlserver', 'oracle', 'db2', 'sqlite']);
  for (const entry of Object.values(metadataQueries)) {
    assert.match(entry.columns, /^SELECT\b/i);
    assert.match(entry.foreignKeys, /^SELECT\b/i);
    assert.match(entry.columns, /AS table_name|\.table_name|\.TABLE_NAME|AS table_name/i);
    assert.match(entry.foreignKeys, /foreign_table_name/i);
  }
});
