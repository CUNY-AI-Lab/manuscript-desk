// Waiting out a rate-limit refusal. The Gateway answers a provider's "too many requests" with a
// retryable refusal (status 429, often with a Retry-After); asking again at once is refused again,
// so a run that met one lost that part. A refused call is asked again after a pause that doubles
// each time, or after the Retry-After the refusal gave (capped), a few times before it counts as a
// failure. A spent allowance (quota_exceeded) is not a rate limit and is never asked again.
// Pure: no DOM, no network.

export const RATE_LIMIT_RETRIES = 3;
const FIRST_PAUSE_MS = 2000;
const LONGEST_PAUSE_MS = 30000;

/** True for a refusal that a pause may cure: status 429 or a rate-limit code, but not a spent allowance. */
export function isRateLimited(failure) {
  const code = typeof failure?.code === 'string' ? failure.code : '';
  if (code.includes('quota')) return false;
  return failure?.status === 429 || /rate_?limit/u.test(code) || code === 'http_429' || code === 'too_many_requests';
}

/** How long to wait before retry number `retry` (1, 2, ...): the refusal's Retry-After if it gave one. */
export function backoffDelay(retry, retryAfter) {
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, LONGEST_PAUSE_MS);
  return Math.min(FIRST_PAUSE_MS * 2 ** (retry - 1), LONGEST_PAUSE_MS);
}

/** A pause that ends early, rejecting with the signal's reason, when the signal aborts. */
export function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The Retry-After of a refusal in seconds, when it is a whole number of seconds; else undefined. */
export function retryAfterOf(value) {
  const seconds = typeof value === 'string' && /^\d{1,6}$/u.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}
