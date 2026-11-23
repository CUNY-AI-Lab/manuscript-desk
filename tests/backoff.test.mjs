import test from 'node:test';
import assert from 'node:assert/strict';
import { RATE_LIMIT_RETRIES, backoffDelay, isRateLimited, pause, retryAfterOf } from '../lib/calls/backoff.js';
import { createApi } from '../web/shared/api.js';

test('a rate-limit refusal is told apart from a spent allowance and other failures', () => {
  assert.equal(isRateLimited({ code: 'upstream_rate_limited', status: 429 }), true);
  assert.equal(isRateLimited({ code: 'rate_limited' }), true);
  assert.equal(isRateLimited({ code: 'http_429' }), true);
  assert.equal(isRateLimited({ code: 'anything', status: 429 }), true);
  assert.equal(isRateLimited({ code: 'quota_exceeded', status: 429 }), false);
  assert.equal(isRateLimited({ code: 'upstream_timeout', status: 504 }), false);
  assert.equal(isRateLimited(undefined), false);
});

test('pauses double from two seconds, or follow a Retry-After, never beyond thirty seconds', () => {
  assert.equal(RATE_LIMIT_RETRIES, 3);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(retry => backoffDelay(retry)), [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(backoffDelay(1, 5), 5000);
  assert.equal(backoffDelay(1, 3600), 30000);
  assert.equal(backoffDelay(2, 0), 4000);
  assert.deepEqual(['7', ' 12 ', 9, '0', '-1', 'Wed, 21 Oct 2026 07:28:00 GMT', null, undefined].map(retryAfterOf), [7, 12, 9, undefined, undefined, undefined, undefined, undefined]);
});

test('a pause ends early when the run is stopped', async () => {
  const controller = new AbortController();
  const waiting = pause(60000, controller.signal);
  controller.abort(new Error('stopped'));
  await assert.rejects(waiting, /stopped/);
  await pause(1);
  await assert.rejects(pause(10, AbortSignal.abort(new Error('already'))), /already/);
});

test('the page\'s API client keeps a refusal\'s status and Retry-After', async () => {
  const api = createApi({
    fetchImpl: async () => Response.json({ error: { code: 'upstream_rate_limited', message: 'Too many requests.' } }, { status: 429, headers: { 'x-should-retry': 'true', 'retry-after': '6' } }),
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
  });
  await assert.rejects(api.post('/api/settings', {}), error => error.code === 'upstream_rate_limited' && error.status === 429 && error.retry === true && error.retryAfter === 6);
});
