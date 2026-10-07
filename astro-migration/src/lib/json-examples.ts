import LZString from 'lz-string';

// Public synthetic examples only; these links never create stored-share records.
export const apiResponse = {
  orders: [{ id: 'ORD-42', status: 'paid', total: 29.5, items: ['notebook', 'pen'] }],
  pagination: { page: 1, hasNext: false },
};
export const originalConfig = { service: { name: 'catalog', timeout: 15 }, regions: ['us', 'eu'], enabled: true };
export const modifiedConfig = { service: { name: 'catalog', timeout: 30 }, regions: ['eu', 'us'], enabled: true, retries: 3 };

export function jsonExampleLink(tool: 'json-formatter' | 'json-diff', action: string, data: Record<string, unknown>): string {
  return `/${tool}/#lz:${LZString.compressToEncodedURIComponent(JSON.stringify({ v: 1, t: tool, a: action, d: data }))}`;
}

export const formatterExample = jsonExampleLink('json-formatter', 'prettify', { json: JSON.stringify(apiResponse) });
export const exactJsonExample = '{"orderId":9007199254740993,"amount":10.50,"rate":1E2,"status":"queued","status":"paid"}';
export const exactFormatterExample = jsonExampleLink('json-formatter', 'prettify', { json: exactJsonExample, indent: '4' });
export const diffExample = jsonExampleLink('json-diff', 'compare', {
  json1: JSON.stringify(originalConfig), json2: JSON.stringify(modifiedConfig), ignoreKeyOrder: true, ignoreArrayOrder: false,
});
export const unorderedExample = jsonExampleLink('json-diff', 'compare', {
  json1: JSON.stringify(originalConfig), json2: JSON.stringify(modifiedConfig), ignoreKeyOrder: true, ignoreArrayOrder: true,
});

export const formatterFaqs = [
  { question: 'How do I format and validate JSON online?', answer: 'Paste JSON or open a local file, choose two spaces, four spaces, or tabs, and select Prettify. Compact minifies it; Validate checks syntax without changing the input. Errors show a line and column with a jump action. Undo restores the text before formatting.' },
  { question: 'What is the difference between a JSON formatter and a JSON validator?', answer: 'Formatting makes valid JSON easier to read. Syntax validation checks quotes, commas, brackets, and JSON values. This formatter does both, but it does not validate a document against a JSON Schema or an API contract.' },
  { question: 'Will formatting round large integers or remove duplicate keys?', answer: 'No. Prettify and Compact change only whitespace between tokens. Exact numeric digits, decimal zeros, exponents, string escapes, key order, and duplicate keys are preserved. Duplicate keys and large integers receive interoperability notes because another parser may discard or round them.' },
  { question: 'How do I copy a path from the JSON tree?', answer: 'Select a key or value, then use the selected-value panel to copy a jq accessor, a JSON Pointer, or the exact JSON value. Long arrays load in batches of 50; the tree displays at most 1,500 values. Files up to 10 MiB and nesting up to 128 levels are supported; large documents use a text-only editor with line numbers and search.' },
  { question: 'Is my JSON uploaded when I use the formatter?', answer: 'Formatting, validation, and tree rendering happen in your browser without uploading the input. Sharing is optional: an embedded link contains the data in its URL fragment, while the short-link option explicitly stores it. Anyone with a shared link can read its data.' },
];

export const diffFaqs = [
  { question: 'How do I compare two JSON files online?', answer: 'Copy each file’s contents into Original JSON and Modified JSON, then select Compare JSON. The result lists added, removed, and changed values with their paths, alongside highlighted versions of both documents.' },
  { question: 'Does a JSON diff ignore whitespace and object key order?', answer: 'Formatting whitespace does not affect the structural comparison. Ignore key order is enabled by default. Disable it to report changes in the parsed property order; use Text Diff to compare exact source formatting.' },
  { question: 'How can I compare JSON arrays regardless of order?', answer: 'Enable Ignore array order when positions do not matter. Equivalent items match in any position, including nested objects, while duplicate counts still matter. Leave it off for ranked results, coordinates, or other sequences.' },
  { question: 'Are null, missing fields, and different value types treated as equal?', answer: 'No. A missing field is an addition or removal; a present field changing to null is a modification. A number such as 1 differs from the string "1", and arrays differ from objects.' },
  { question: 'Can I share a JSON comparison with a teammate?', answer: 'Yes. Share comparison includes both inputs, comparison options, and the Compare action so the result can be reproduced. Processing is local; optional short links store the shared data. Remove credentials and personal values before making a shareable example.' },
];
