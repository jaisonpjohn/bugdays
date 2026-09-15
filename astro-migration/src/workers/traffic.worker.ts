import { analyzeTraffic, collectLookupIps } from '../lib/traffic-analysis';

self.onmessage = async event => {
  try {
    const { text, mode, dataset, phase } = event.data;
    if (phase === 'extract') {
      self.postMessage({ type: 'addresses', addresses: collectLookupIps(text, mode) });
      return;
    }
    const report = await analyzeTraffic(text, mode, dataset, percent => self.postMessage({ type: 'progress', percent }));
    self.postMessage({ type: 'result', report });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not analyze this input.' });
  }
};
