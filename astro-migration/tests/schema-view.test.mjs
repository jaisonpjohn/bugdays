import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchema } from '../src/lib/schema-parser.ts';
import { matchingTables, neighborhood } from '../src/lib/schema-view.ts';

const schema = parseSchema(`CREATE TABLE public.customers (id int PRIMARY KEY, email text);
CREATE TABLE public.orders (id int PRIMARY KEY, customer_id int REFERENCES public.customers(id));
CREATE TABLE sales.invoices (id int PRIMARY KEY, order_id int REFERENCES public.orders(id));
CREATE TABLE sales.audit (id int PRIMARY KEY);`);

test('table browser matches names, columns and schema', () => {
  assert.deepEqual(matchingTables(schema, 'email').map(table => table.name), ['customers']);
  assert.deepEqual(matchingTables(schema, '', 'sales').map(table => table.name), ['invoices', 'audit']);
  assert.deepEqual(matchingTables(schema, 'order', 'sales').map(table => table.name), ['invoices']);
});

test('one- and two-hop neighborhoods include incoming and outgoing FKs', () => {
  assert.deepEqual(neighborhood(schema, 'customers', 1).map(table => table.name), ['customers', 'orders']);
  assert.deepEqual(neighborhood(schema, 'customers', 2).map(table => table.name), ['customers', 'orders', 'invoices']);
});
