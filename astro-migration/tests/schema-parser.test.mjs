import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchema, splitStatements } from '../src/lib/schema-parser.ts';

// Small, representative extracts from the public Chinook, Oracle HR, Sakila,
// and Pagila schema scripts. DML and bulk data are intentionally omitted.
test('SSMS GO batches, including GO n, do not swallow SQL Server tables', () => {
  const schema = parseSchema(`SET ANSI_NULLS ON
GO
CREATE TABLE [dbo].[Artist] ([ArtistId] int NOT NULL, CONSTRAINT [PK_Artist] PRIMARY KEY CLUSTERED ([ArtistId] ASC))
GO 2
CREATE TABLE [dbo].[Album] ([AlbumId] int NOT NULL, [ArtistId] int NOT NULL, CONSTRAINT [PK_Album] PRIMARY KEY CLUSTERED ([AlbumId] ASC))
GO
ALTER TABLE [dbo].[Album] WITH CHECK ADD CONSTRAINT [FK_Album_Artist] FOREIGN KEY([ArtistId]) REFERENCES [dbo].[Artist] ([ArtistId])
GO`);
  assert.equal(schema.tables.length, 2);
  assert.equal(schema.tables.reduce((count, table) => count + table.foreignKeys.length, 0), 1);
  assert.deepEqual(schema.tables.find(table => table.name === 'Album').primaryKey, ['albumid']);
  assert.deepEqual(schema.warnings, []);
});

test('SQL*Plus directives and slash separators leave Oracle tables intact', () => {
  const schema = parseSchema(`REM Oracle HR excerpt
SET PAGESIZE 100
PROMPT Creating regions
CREATE TABLE regions (region_id NUMBER CONSTRAINT region_id_nn NOT NULL, region_name VARCHAR2(25));
/
CREATE TABLE countries (country_id CHAR(2) CONSTRAINT country_id_nn NOT NULL, region_id NUMBER);
ALTER TABLE countries ADD (CONSTRAINT countr_reg_fk FOREIGN KEY (region_id) REFERENCES regions(region_id));
/
SET NAMES 'utf8';`);
  assert.equal(schema.tables.length, 2);
  assert.equal(schema.tables.find(table => table.name === 'countries').foreignKeys.length, 1);
  assert.deepEqual(schema.warnings, []);
});

test('procedure bodies and temporary tables cannot become phantom schema tables', () => {
  const schema = parseSchema(`CREATE TABLE customer (id int PRIMARY KEY);
DELIMITER //
CREATE PROCEDURE rewards_report()
BEGIN
  CREATE TEMPORARY TABLE tmpCustomer (id int);
  INSERT INTO tmpCustomer VALUES (1);
END//
DELIMITER ;
CREATE TEMPORARY TABLE scratch (id int);
CREATE TABLE orders (id int PRIMARY KEY, customer_id int REFERENCES customer(id));`);
  assert.deepEqual(schema.tables.map(table => table.name), ['customer', 'orders']);
  assert.equal(schema.tables[1].foreignKeys.length, 1);
  assert.deepEqual(schema.warnings, []);
});

test('PostgreSQL dollar-quoted functions do not hide following tables', () => {
  const schema = parseSchema(`CREATE FUNCTION public.f() RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  RETURN 1;
END;
$$;
CREATE TABLE public.after_function (id integer PRIMARY KEY);`);
  assert.deepEqual(schema.tables.map(table => table.name), ['after_function']);
});

test('attached and PARTITION OF children fold into the parent', () => {
  const schema = parseSchema(`CREATE TABLE public.payment (id integer PRIMARY KEY, paid_at timestamp) PARTITION BY RANGE (paid_at);
CREATE TABLE public.payment_2025 (id integer, paid_at timestamp);
ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_2025 FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE public.payment_2026 PARTITION OF public.payment FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`);
  assert.equal(schema.tables.length, 1);
  assert.equal(schema.tables[0].partitionCount, 2);
});

test('unreadable CREATE TABLE definitions name the skipped table, including zero-table input', () => {
  const schema = parseSchema('CREATE TABLE bad_table AS SELECT 1;');
  assert.equal(schema.tables.length, 0);
  assert.match(schema.warnings.join(' '), /bad_table.*skipped/i);
});

test('line separators inside string literals are not treated as batches', () => {
  const statements = splitStatements("CREATE TABLE notes (body text DEFAULT 'line one\\nGO\\nline two');\\nGO\\nCREATE TABLE people (id int);");
  assert.equal(statements.length, 2);
});

test('tables with the same name in different schemas retain the correct foreign-key target', () => {
  const schema = parseSchema(`CREATE TABLE auth.users (id int PRIMARY KEY);
CREATE TABLE app.users (id int PRIMARY KEY);
CREATE TABLE app.orders (id int PRIMARY KEY, user_id int REFERENCES app.users(id));`);
  assert.deepEqual(schema.tables.map(table => table.key), ['auth.users', 'app.users', 'orders']);
  assert.equal(schema.tables.find(table => table.name === 'orders').foreignKeys[0].refTable, 'app.users');
});
