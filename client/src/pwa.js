// Everything the app does with its service worker: registering it, clearing
// what it cached, push subscriptions, and the offline quick-add queue.
import { api } from './api.js';

// Must match API_CACHE in ../sw.js.
const API_CACHE = 'api-v1';
const OUTBOX_KEY = 'outbox-v1';

export function registerServiceWorker() {
  // Dev has no /sw.js (see vite.config.js); a worker there would only cache
  // stale hot-reload modules.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('service worker failed', err));
  });
}

// Drop cached API reads. `keepSession` keeps /auth/me so the app can still
// open offline — used on a workspace switch, where the person is the same but
// every other answer changes.
export async function clearApiCache({ keepSession = false } = {}) {
  if (!('caches' in window)) return;
  if (!keepSession) {
    await caches.delete(API_CACHE);
    return;
  }
  const cache = await caches.open(API_CACHE);
  for (const req of await cache.keys()) {
    if (new URL(req.url).pathname !== '/api/auth/me') await cache.delete(req);
  }
}

// ---------- offline quick-add ----------
// Only new tasks are queued: they don't conflict with anything, and quick
// capture is what people reach for on a phone with no signal. Each entry
// records whose it is, so a queue left behind by one account is never sent
// as another.

let currentUserId = null;
export function setCurrentUser(id) { currentUserId = id ?? null; }

function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch { return []; }
}
function writeOutbox(items) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(items)); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event('outbox-change'));
}

export function queueTask(body) {
  if (currentUserId == null) return false;
  writeOutbox([...readOutbox(), { userId: currentUserId, body, queuedAt: Date.now() }]);
  return true;
}

export function pendingTaskCount() {
  return readOutbox().filter((i) => i.userId === currentUserId).length;
}

export function clearOutbox() {
  writeOutbox(readOutbox().filter((i) => i.userId !== currentUserId));
}

let flushing = null;
// Send queued tasks in order. Stops at the first network failure (still
// offline) and keeps the rest; drops an entry the server rejects outright,
// since retrying it would fail forever. Returns how many were created.
export function flushOutbox() {
  if (flushing) return flushing;
  flushing = (async () => {
    let created = 0;
    for (const item of readOutbox()) {
      if (item.userId !== currentUserId) continue;
      try {
        await api.post('/tasks', item.body);
        created += 1;
      } catch (err) {
        if (err.offline || err.status === 401) break;
        console.warn('dropping queued task the server refused', item.body, err);
      }
      writeOutbox(readOutbox().filter((i) => i.queuedAt !== item.queuedAt || i.userId !== item.userId));
    }
    return created;
  })().finally(() => { flushing = null; });
  return flushing;
}

// ---------- push notifications ----------

// Why push can't be used here, or null if it can. Browsers only allow it on
// HTTPS (or localhost), and iOS only for apps added to the home screen.
export function pushUnavailableReason() {
  if (!window.isSecureContext) return 'Notifications need the app to be served over HTTPS.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return /iPhone|iPad/.test(navigator.userAgent)
      ? 'On iPhone and iPad, add the app to your Home Screen first (Share → Add to Home Screen), then open it from there.'
      : "This browser doesn't support push notifications.";
  }
  if (!import.meta.env.PROD) return 'Notifications only work in a production build (npm run build).';
  return null;
}

// getRegistration, not `ready`: `ready` never settles if the worker failed to
// register, which would hang sign-out.
async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

// Subscribed means: this browser has a subscription AND the server has it
// filed under the signed-in person.
export async function pushStatus() {
  if (pushUnavailableReason()) return { subscribed: false, permission: 'unsupported' };
  const sub = await currentSubscription();
  if (!sub) return { subscribed: false, permission: Notification.permission };
  const { subscribed } = await api.post('/push/status', { endpoint: sub.endpoint });
  return { subscribed, permission: Notification.permission };
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were blocked. Allow them in your browser settings to turn this on.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { public_key } = await api.get('/push/config');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(public_key) });
  }
  await api.post('/push/subscribe', { subscription: sub.toJSON() });
}

// Best effort: used on sign-out too, where failing must not block leaving.
export async function disablePush() {
  if (pushUnavailableReason()) return;
  const sub = await currentSubscription();
  if (!sub) return;
  try { await api.post('/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* server unreachable */ }
  await sub.unsubscribe();
}
