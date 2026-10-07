export const schemaExample = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orderId: { type: 'integer' },
    status: { enum: ['pending', 'paid'] },
    items: { type: 'array', minItems: 1, items: { $ref: '#/$defs/item' } },
  },
  required: ['orderId', 'status', 'items'], additionalProperties: false,
  $defs: { item: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } }, required: ['sku', 'quantity'], additionalProperties: false } },
}, null, 2);
export const invalidExample = JSON.stringify({ orderId: '1042', status: 'PAID', items: [{ sku: 'DEMO-01', quantity: 0 }], debug: true }, null, 2);
export const validExample = JSON.stringify({ orderId: 1042, status: 'paid', items: [{ sku: 'DEMO-01', quantity: 2 }] }, null, 2);
export const structuredExample = JSON.stringify({ type: 'object', properties: { summary: { type: 'string' }, category: { type: ['string', 'null'], enum: ['billing', 'technical', null] } }, required: ['summary'] }, null, 2);
