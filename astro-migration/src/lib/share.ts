import LZString from 'lz-string';

// ========== Types ==========
interface ShareState {
  v: 1;                     // Version
  t: string;                // Tool ID (e.g., "base64", "text-diff")
  a?: string;               // Action to replay (e.g., "encode", "compare")
  d: Record<string, any>;   // Input data
}

interface ToolConfig {
  tool: string;
  actions?: Record<string, () => void>;
  beforeShare?: () => void;
  afterLoad?: () => void;
  customCollect?: () => Record<string, any>;
  customRestore?: (data: Record<string, any>) => void;
}

// ========== Constants ==========
// Above this URL length we warn the user (links may break in email clients,
// chat apps, and some proxies) — but the choice stays theirs.
const URL_WARN_LIMIT = 2000;
const MAX_DATA_SIZE = 1024 * 1024; // 1MB
const SHARE_API = 'https://api.bugdays.com';

// ========== State ==========
let currentToolId: string | null = null;
let toolConfigs: Map<string, ToolConfig> = new Map();
let lastAction: string | null = null;
let shareModalCallback: ((confirmed: boolean) => void) | null = null;

// ========== Public API ==========

/**
 * Initialize ShareManager for a tool page
 */
export function init(toolId: string) {
  currentToolId = toolId;

  // Attach click handler for share action buttons
  document.querySelectorAll('[data-share-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      lastAction = (btn as HTMLElement).dataset.shareAction || null;
    });
  });
}

/**
 * Register tool-specific configuration
 */
export function register(config: ToolConfig) {
  toolConfigs.set(config.tool, config);
}

/**
 * Collect state from all [data-share-key] elements
 */
export function collectState(): Record<string, any> {
  const config = currentToolId ? toolConfigs.get(currentToolId) : null;

  // Call beforeShare hook if exists
  if (config?.beforeShare) {
    config.beforeShare();
  }

  // Use custom collector if provided
  if (config?.customCollect) {
    return config.customCollect();
  }

  const data: Record<string, any> = {};

  document.querySelectorAll('[data-share-key]').forEach(el => {
    const key = (el as HTMLElement).dataset.shareKey;
    if (!key) return;

    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') {
        data[key] = el.checked;
      } else if (el.type === 'radio') {
        if (el.checked) {
          data[key] = el.value;
        }
      } else {
        data[key] = el.value;
      }
    } else if (el instanceof HTMLTextAreaElement) {
      data[key] = el.value;
    } else if (el instanceof HTMLSelectElement) {
      data[key] = el.value;
    } else if ((el as HTMLElement).isContentEditable) {
      data[key] = (el as HTMLElement).innerText;
    }
  });

  return data;
}

/**
 * Restore state to [data-share-key] elements
 */
export function restoreState(data: Record<string, any>) {
  const config = currentToolId ? toolConfigs.get(currentToolId) : null;

  // Use custom restorer if provided
  if (config?.customRestore) {
    config.customRestore(data);
    return;
  }

  for (const [key, value] of Object.entries(data)) {
    const el = document.querySelector(`[data-share-key="${key}"]`);
    if (!el) continue;

    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') {
        el.checked = Boolean(value);
      } else if (el.type === 'radio') {
        el.checked = el.value === value;
      } else {
        el.value = String(value);
      }
      // Trigger input event for reactive updates
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el instanceof HTMLTextAreaElement) {
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el instanceof HTMLSelectElement) {
      el.value = String(value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if ((el as HTMLElement).isContentEditable) {
      (el as HTMLElement).innerText = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Call afterLoad hook if exists
  if (config?.afterLoad) {
    config.afterLoad();
  }
}

export interface SharePrepared {
  stateJson: string;
  /** Raw (uncompressed) state size in bytes */
  rawBytes: number;
  /** Full share URL with the data embedded in the hash */
  url: string;
  /** Length of that URL in characters */
  urlLength: number;
  /** True when the URL exceeds the warn threshold — user should be warned */
  urlOverWarnLimit: boolean;
}

export type PrepareResult =
  | { ok: true; prepared: SharePrepared }
  | { ok: false; message: string };

/**
 * Collect and compress the current tool state, without deciding how to
 * share it. The UI presents both options (URL vs server) to the user.
 */
export function prepareShare(): PrepareResult {
  if (!currentToolId) {
    return { ok: false, message: 'Tool not initialized' };
  }

  const data = collectState();

  // Check if there's any data to share
  const hasData = Object.values(data).some(v =>
    v !== '' && v !== false && v !== null && v !== undefined
  );
  if (!hasData) {
    return { ok: false, message: 'Nothing to share' };
  }

  const state: ShareState = {
    v: 1,
    t: currentToolId,
    d: data
  };

  // Include last action if set
  if (lastAction) {
    state.a = lastAction;
  }

  const stateJson = JSON.stringify(state);
  const rawBytes = new TextEncoder().encode(stateJson).length;

  if (rawBytes > MAX_DATA_SIZE) {
    return { ok: false, message: 'Data too large (max 1MB)' };
  }

  const compressed = LZString.compressToEncodedURIComponent(stateJson);
  const url = `${location.origin}${location.pathname}#lz:${compressed}`;

  return {
    ok: true,
    prepared: {
      stateJson,
      rawBytes,
      url,
      urlLength: url.length,
      urlOverWarnLimit: url.length > URL_WARN_LIMIT,
    }
  };
}

/**
 * Copy the data-embedded URL to the clipboard (nothing leaves the browser)
 */
export async function shareViaUrl(prepared: SharePrepared): Promise<{ success: boolean; message: string }> {
  try {
    await navigator.clipboard.writeText(prepared.url);
    return { success: true, message: 'Link copied!' };
  } catch (e) {
    return { success: false, message: 'Could not copy - try again' };
  }
}

/**
 * Store data on the server (30-day retention) and copy a short link
 */
export async function shareViaServer(stateJson: string): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch(`${SHARE_API}/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'share', data: stateJson })
    });

    if (!res.ok) throw new Error('Store failed');

    const { id } = await res.json();
    const url = `${location.origin}${location.pathname}#kv:${id}`;
    await navigator.clipboard.writeText(url);

    return { success: true, message: 'Link copied!' };
  } catch (e) {
    return { success: false, message: 'Share failed - try again' };
  }
}

/**
 * Load state from URL hash on page load
 */
export async function loadFromUrl(): Promise<boolean> {
  const hash = location.hash.slice(1);
  if (!hash) return false;

  let stateJson: string | null = null;
  let expired = false;

  if (hash.startsWith('lz:')) {
    // Decompress from URL
    stateJson = LZString.decompressFromEncodedURIComponent(hash.slice(3));
  } else if (hash.startsWith('kv:')) {
    // Fetch from server
    try {
      const res = await fetch(`${SHARE_API}/get/${hash.slice(3)}`);
      if (res.ok) {
        const { data } = await res.json();
        stateJson = data;
      } else if (res.status === 410 || res.status === 404) {
        expired = true;
      }
    } catch (e) {
      expired = true;
    }
  }

  if (expired) {
    showExpiredNotice();
    // Clean up URL
    history.replaceState(null, '', location.pathname);
    return false;
  }

  if (!stateJson) return false;

  try {
    const state: ShareState = JSON.parse(stateJson);

    // Verify version
    if (state.v !== 1) {
      console.warn('Unsupported share state version:', state.v);
      return false;
    }

    // Verify tool matches current page
    if (state.t !== currentToolId) {
      console.warn('Share state tool mismatch:', state.t, 'vs', currentToolId);
      // Still try to restore - might be a renamed tool
    }

    // Restore the state
    restoreState(state.d);

    // Trigger action if specified
    if (state.a) {
      const config = currentToolId ? toolConfigs.get(currentToolId) : null;
      const actionFn = config?.actions?.[state.a];
      if (actionFn) {
        // Small delay to ensure DOM is ready
        setTimeout(actionFn, 50);
      }
    }

    // Clean up URL
    history.replaceState(null, '', location.pathname);

    return true;
  } catch (e) {
    console.error('Failed to parse share state:', e);
    return false;
  }
}

/**
 * Show expired notice banner
 */
function showExpiredNotice() {
  const notice = document.getElementById('share-expired-notice');
  if (notice) {
    notice.classList.remove('hidden');
  }
}

/**
 * Get current tool ID
 */
export function getToolId(): string | null {
  return currentToolId;
}

/**
 * Format bytes for display
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}

// Export as a namespace for cleaner imports
export const ShareManager = {
  init,
  register,
  collectState,
  restoreState,
  prepareShare,
  shareViaUrl,
  shareViaServer,
  loadFromUrl,
  getToolId,
  formatBytes
};
