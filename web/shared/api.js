// Same-origin client for the Worker's /manuscript/api routes. No DOM access, so it loads under Node.
// It never retries: a caller may retry once when an ApiError says `retry` (the Worker's
// x-should-retry header). A lost CAIL session (401) restarts sign-in at the launch path at most once
// per page and once a minute (see restartSignIn); otherwise it rejects with an ApiError carrying
// signInUrl, so the page can offer a "Sign in with CUNY" link instead.
import { retryAfterOf } from '../../lib/calls/backoff.js';

// Only a missing or ended session is cured by signing in again. invalid_credential (an assertion
// that fails verification) is not: sending the page through sign-in again would loop.
const LOST_SESSION = new Set(['authentication_required', 'session_invalid']);
const RESTART_KEY = 'manuscript-signin-restart';
const RESTART_WINDOW_MS = 60000;
export const LAUNCH_PATH = '/launch/manuscript';
const LAUNCH = /^\/launch\/[a-z0-9-]+$/;
// A little longer than the Worker's own three-minute deadline, so its answer arrives first.
const BROWSER_TIMEOUT_MS = 185000;

export class ApiError extends Error {
  constructor({ code, message, status = 0, retry = false, requestId = null, retryAfter, signInUrl }) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, { code, status, retry, requestId, ...(retryAfter ? { retryAfter } : {}), ...(signInUrl ? { signInUrl } : {}) });
  }
}

export function createApi({
  fetchImpl = (...args) => fetch(...args),
  location = globalThis.location,
  base = '/manuscript',
  storage,
  now = Date.now,
  onLostSession,
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  let restarted = false;
  // A lost CAIL session needs a full-page navigation to the launch path so sign-in restarts. It happens
  // at most once per page, and only when sessionStorage can record it, so that no more than one
  // automatic restart happens per minute across reloads. Otherwise (storage unavailable, or a restart
  // in the last minute) the error carries signInUrl and the page shows a "Sign in with CUNY" link.
  function restartSignIn() {
    if (restarted) return false;
    try {
      const last = Number(storage.getItem(RESTART_KEY));
      if (last && now() - last < RESTART_WINDOW_MS) return false;
      const stamp = String(now());
      storage.setItem(RESTART_KEY, stamp);
      if (storage.getItem(RESTART_KEY) !== stamp) return false;
    } catch { return false; }
    restarted = true;
    return true;
  }
  async function call(method, path, body, signal) {
    const init = {
      method,
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-cail-request-id': randomUUID() },
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(BROWSER_TIMEOUT_MS)]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, init);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error?.name === 'TimeoutError') throw new ApiError({ code: 'request_timeout', message: 'The request took longer than three minutes. Try again, or choose another model.' });
      throw new ApiError({ code: 'network_error', message: 'The CUNY AI Lab service could not be reached. Check your connection and try again.' });
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError({ code: 'unreadable_response', status: response.status, message: 'The CUNY AI Lab service sent an answer this page could not read. Try again later.' });
    }
    if (response.ok) return data;
    const envelope = data?.error;
    const code = typeof envelope?.code === 'string' ? envelope.code : 'service_unavailable';
    const message = typeof envelope?.message === 'string' && envelope.message ? envelope.message : 'The CUNY AI Lab service is unavailable. Try again later.';
    const requestId = typeof envelope?.request_id === 'string' ? envelope.request_id : null;
    if (response.status === 401 && LOST_SESSION.has(code)) {
      const signInUrl = new URL(typeof envelope?.launch === 'string' && LAUNCH.test(envelope.launch) ? envelope.launch : LAUNCH_PATH, location.href).href;
      // The page is leaving: this call and any other that finds the session lost meanwhile never
      // settle, so nothing reports a failure on the way out. The work is saved first.
      if (restarted) return new Promise(() => {});
      if (restartSignIn()) {
        try {
          await onLostSession?.();
        } catch {}
        location.assign(signInUrl);
        return new Promise(() => {});
      }
      throw new ApiError({ code, status: 401, message, requestId, signInUrl });
    }
    throw new ApiError({
      code,
      status: response.status,
      message,
      retry: response.headers.get('x-should-retry') === 'true',
      retryAfter: retryAfterOf(response.headers.get('retry-after')),
      requestId,
    });
  }
  return {
    get: (path, { signal } = {}) => call('GET', path, undefined, signal),
    post: (path, body, { signal } = {}) => call('POST', path, body, signal),
  };
}
