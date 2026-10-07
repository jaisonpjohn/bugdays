import { formatJson, JsonFormatError } from '../lib/json-formatter.ts';
self.onmessage = event => {
  try {
    const { text, action, indent } = event.data;
    self.postMessage({ ok: true, result: formatJson(text, action, indent) });
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof JsonFormatError ? error.message : 'Unable to process this document. Try a smaller input.', offset: error instanceof JsonFormatError ? error.offset : null });
  }
};
