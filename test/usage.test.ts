import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageLimits, RepeatGuard } from '../src/usage.js';

test('RepeatGuard blocks the same call after the limit, regardless of key order', () => {
  let now = 0;
  const guard = new RepeatGuard(2, 60_000, () => now);
  assert.equal(guard.check('org-a', 'search', { a: 1, b: 2 }), 0);
  assert.equal(guard.check('org-a', 'search', { b: 2, a: 1 }), 0);
  assert.equal(guard.check('org-a', 'search', { a: 1, b: 2 }), 60);
  assert.equal(guard.check('org-b', 'search', { a: 1, b: 2 }), 0, 'tenants are separate');
  assert.equal(guard.check('org-a', 'search', { a: 1, b: 3 }), 0, 'different arguments pass');
  now = 60_000;
  assert.equal(guard.check('org-a', 'search', { a: 1, b: 2 }), 0, 'window resets');
});

test('usage limits enforce the daily cap and alert without arguments', async () => {
  const alerts: unknown[] = [];
  const buckets: string[] = [];
  let allowed = true;
  const limit = createUsageLimits({
    consume: async (bucket, max, seconds) => {
      buckets.push(`${bucket}|${max}|${seconds}`);
      return { allowed, retryAfter: 120 };
    },
    dailyLimit: 50,
    repeat: new RepeatGuard(1, 60_000, () => 0),
    alert: (event) => alerts.push(event),
  });
  const call = { name: 'get_sam_opportunities', arguments: { keyword: 'secret project' } };
  assert.equal(await limit('org-a', call), undefined);
  assert.deepEqual(buckets, ['tenant-day:org-a|50|86400']);
  const repeated = await limit('org-a', call);
  assert.equal(repeated?.code, 'REPEATED_CALL');
  assert.equal(buckets.length, 1, 'a refused repeat does not use the daily budget');
  allowed = false;
  const capped = await limit('org-a', { ...call, arguments: { keyword: 'other' } });
  assert.equal(capped?.code, 'DAILY_LIMIT');
  assert.equal(capped?.retry_after, '120');
  assert.deepEqual(alerts, [{ event: 'tenant_daily_limit_reached', tenant_id: 'org-a' }]);
  assert.ok(!JSON.stringify(alerts).includes('secret project'));
});
