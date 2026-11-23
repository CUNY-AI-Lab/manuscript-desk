// Same-origin client for the Worker's /manuscript/api routes. No DOM access, so it loads under Node.
// It never retries: a caller may retry once when an ApiError says `retry` (the Worker's
// x-should-retry header). A lost session (401) runs onLostSession, then navigates the page to the
// launch path so sign-in restarts, and the call never settles.
import { retryAfterOf } from '../../lib/calls/backoff.js';

const LOST_SESSION = new Set(['authentication_required', 'invalid_credential', 'session_invalid']);
const LAUNCH_PATH = '/launch/manuscript';
const LAUNCH = /^\/launch\/[a-z0-9-]+$/;
// A little longer than the Worker's own three-minute deadline, so its answer arrives first.
const BROWSER_TIMEOUT_MS = 185000;

export class ApiError extends Error {
  constructor({ code, message, status = 0, retry = false, requestId = null, retryAfter }) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, { code, status, retry, requestId, ...(retryAfter ? { retryAfter } : {}) });
  }
}

export function createApi({
  fetchImpl = (...args) => fetch(...args),
  navigate = url => location.assign(url),
  base = '/manuscript',
  onLostSession,
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  let leaving = false;
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
    if (response.status === 401 && LOST_SESSION.has(code)) {
      // Calls in flight together may all find the session lost; the page navigates once, since a
      // second navigation would cancel the first.
      if (!leaving) {
        leaving = true;
        try {
          await onLostSession?.();
        } catch {}
        navigate(typeof envelope?.launch === 'string' && LAUNCH.test(envelope.launch) ? envelope.launch : LAUNCH_PATH);
      }
      return new Promise(() => {});
    }
    throw new ApiError({
      code,
      status: response.status,
      message: typeof envelope?.message === 'string' && envelope.message ? envelope.message : 'The CUNY AI Lab service is unavailable. Try again later.',
      retry: response.headers.get('x-should-retry') === 'true',
      retryAfter: retryAfterOf(response.headers.get('retry-after')),
      requestId: typeof envelope?.request_id === 'string' ? envelope.request_id : null,
    });
  }
  return {
    get: (path, { signal } = {}) => call('GET', path, undefined, signal),
    post: (path, body, { signal } = {}) => call('POST', path, body, signal),
  };
}
