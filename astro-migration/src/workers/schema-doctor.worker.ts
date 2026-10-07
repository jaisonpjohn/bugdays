import { diagnoseSchema, formatDoctorJson } from '../lib/schema-doctor.ts';
self.onmessage = event => {
  const { id, input, operation } = event.data;
  if (operation === 'format') {
    try { self.postMessage({ id, formatted: formatDoctorJson(input) }); }
    catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : 'Could not format this input.' }); }
  } else self.postMessage({ id, report: diagnoseSchema(input) });
};
