async function localAccessPermissionState(): Promise<PermissionState | null> {
  if (!navigator.permissions?.query) return null;
  for (const name of ['loopback-network', 'local-network-access']) {
    try { return (await navigator.permissions.query({ name: name as PermissionName })).state; }
    catch { /* This permission name is not available in every browser. */ }
  }
  return null;
}

export function createLocalBridgeAccessGuard() {
  const dialog = document.getElementById('bridge-access-dialog') as HTMLDialogElement;
  const address = document.getElementById('bridge-access-url') as HTMLElement;
  const continueButton = document.getElementById('bridge-access-continue') as HTMLButtonElement;
  const cancelButton = document.getElementById('bridge-access-cancel') as HTMLButtonElement;
  const acknowledged = new Set<string>();
  let currentAddress = '';
  let resolvePending: ((allowed: boolean) => void) | null = null;
  let pending: Promise<boolean> | null = null;

  function finish(allowed: boolean) {
    if (allowed) acknowledged.add(currentAddress);
    const resolve = resolvePending;
    resolvePending = null;
    pending = null;
    if (dialog.open) dialog.close();
    resolve?.(allowed);
  }

  continueButton.addEventListener('click', () => finish(true));
  cancelButton.addEventListener('click', () => finish(false));
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });

  return async function confirmLocalBridgeAccess(bridgeUrl: string): Promise<boolean> {
    const normalized = bridgeUrl.trim().replace(/\/+$/, '');
    if (acknowledged.has(normalized)) return true;
    const permission = await localAccessPermissionState();
    if (permission === 'granted' || permission === 'denied') return true;
    if (pending) return false;
    currentAddress = normalized;
    address.textContent = normalized;
    dialog.showModal();
    pending = new Promise<boolean>((resolve) => { resolvePending = resolve; });
    return pending;
  };
}
