import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkSamKey,
  opportunityInput,
  SamError,
  saveSamKey,
  searchOpportunities,
  type Fetch,
} from '../src/opportunities.js';

const instant = { sleep: async () => {} };

const input = opportunityInput.parse({
  posted_from: '10/01/2026',
  posted_to: '10/07/2026',
  offset: 2,
});
test('maps filters and uses page-index pagination without returning key-bearing upstream URLs', async () => {
  const fetcher: Fetch = async (request, options) => {
    const url = new URL(String(request));
    assert.equal(url.origin, 'https://api.sam.gov');
    assert.equal(url.searchParams.get('api_key'), 'secret-test-key');
    assert.equal(url.searchParams.get('offset'), '2');
    assert.equal(url.searchParams.get('title'), 'software');
    assert.equal(url.searchParams.get('ncode'), '541512');
    assert.equal(options?.redirect, 'error');
    return Response.json({
      totalRecords: 35,
      opportunitiesData: [
        {
          noticeId: 'a'.repeat(32),
          title: 'secret-test-key',
          links: [{ href: 'https://bad.example?api_key=secret-test-key' }],
        },
      ],
    });
  };
  const result = await searchOpportunities(
    { ...input, keyword: 'software', naics: '541512' },
    'secret-test-key',
    fetcher,
  );
  assert.equal(result.next_offset, 3);
  assert.equal(result.opportunities[0]?.url, `https://sam.gov/opp/${'a'.repeat(32)}/view`);
  assert.ok(!JSON.stringify(result).includes('secret-test-key'));
});

test('validates dates, numeric limits, and rejects key injection in tool arguments', () => {
  for (const change of [
    { posted_from: '02/30/2026' },
    { posted_to: '01/01/2026' },
    { posted_to: '10/02/2027' },
    { limit: 0 },
    { offset: 1.5 },
    { api_key: 'secret' },
  ]) {
    assert.equal(opportunityInput.safeParse({ ...input, ...change }).success, false);
  }
});

test('upstream failures remain errors and cannot expose response bodies or request secrets', async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      searchOpportunities(
        input,
        'secret-test-key',
        async () => new Response('secret-test-key', { status }),
        undefined,
        instant,
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('secret-test-key'));
        return true;
      },
    );
  }
  await assert.rejects(
    searchOpportunities(
      input,
      'secret-test-key',
      async () => {
        throw new Error('https://api.sam.gov/?api_key=secret-test-key');
      },
      undefined,
      instant,
    ),
    /could not be reached/,
  );
  await assert.rejects(
    searchOpportunities(input, 'secret-test-key', async () =>
      Response.json({ error: 'not results' }),
    ),
    /invalid or oversized/,
  );
});

test('concurrent users keep independent credentials', async () => {
  const seen: string[] = [];
  const fetcher: Fetch = async (request) => {
    seen.push(new URL(String(request)).searchParams.get('api_key')!);
    return Response.json({ totalRecords: 0, opportunitiesData: [] });
  };
  await Promise.all(['alice', 'bob'].map((key) => searchOpportunities(input, key, fetcher)));
  assert.deepEqual(seen.sort(), ['alice', 'bob']);
});

test('redacts keys reflected in notice identifiers, numeric fields, and synthesized URLs', async () => {
  const key = '12345678';
  const result = await searchOpportunities(input, key, async () =>
    Response.json({
      totalRecords: 30,
      opportunitiesData: [{ noticeId: key.repeat(4), title: key, solicitationNumber: Number(key) }],
    }),
  );
  assert.ok(!JSON.stringify(result).includes(key));
  assert.equal(result.opportunities[0]?.url, undefined);
});

test('cancels error response bodies and rejects contradictory or oversized results', async () => {
  let cancelled = false;
  await assert.rejects(
    searchOpportunities(
      input,
      'test-secret',
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 429 },
        ),
      undefined,
      instant,
    ),
    /request limit/,
  );
  assert.equal(cancelled, true);
  for (const data of [
    { totalRecords: 30, opportunitiesData: [] },
    { totalRecords: 0, opportunitiesData: [{ title: 'unexpected' }] },
  ]) {
    await assert.rejects(
      searchOpportunities(input, 'test-secret', async () => Response.json(data)),
      /invalid or oversized/,
    );
  }
  await assert.rejects(
    searchOpportunities(input, 'test-secret', async () => new Response('x'.repeat(5_000_001))),
    /invalid or oversized/,
  );
  assert.equal(
    opportunityInput.safeParse({ ...input, posted_from: '02/29/2024', posted_to: '03/01/2025' })
      .success,
    false,
  );
  assert.equal(
    opportunityInput.safeParse({ ...input, posted_from: '02/29/2024', posted_to: '02/28/2025' })
      .success,
    true,
  );
});

const empty = () => Response.json({ totalRecords: 0, opportunitiesData: [] });

test('accepts ISO dates, defaults to the last 30 days, and maps readable notice types', async () => {
  const seen: URL[] = [];
  const fetcher: Fetch = async (request) => {
    seen.push(new URL(String(request)));
    return empty();
  };
  const result = await searchOpportunities(
    {
      posted_from: '2026-10-01',
      posted_to: '2026-10-07',
      notice_type: 'sources_sought',
      response_deadline_from: '2026-10-10',
      response_deadline_to: '2026-11-01',
    },
    'k',
    fetcher,
  );
  assert.equal(seen[0]?.searchParams.get('postedFrom'), '10/01/2026');
  assert.equal(seen[0]?.searchParams.get('postedTo'), '10/07/2026');
  assert.equal(seen[0]?.searchParams.get('ptype'), 'r');
  assert.equal(seen[0]?.searchParams.get('rdlfrom'), '10/10/2026');
  assert.equal(seen[0]?.searchParams.get('rdlto'), '11/01/2026');
  assert.deepEqual(result.date_range, { from: '2026-10-01', to: '2026-10-07' });
  await searchOpportunities({}, 'k', fetcher);
  const from = new Date(result.date_range.from);
  const defaults = seen[1]!;
  const [m1, d1, y1] = defaults.searchParams.get('postedFrom')!.split('/');
  const [m2, d2, y2] = defaults.searchParams.get('postedTo')!.split('/');
  const span = Date.parse(`${y2}-${m2}-${d2}`) - Date.parse(`${y1}-${m1}-${d1}`);
  assert.equal(span, 30 * 86_400_000);
  assert.ok(from);
  for (const bad of [
    { notice_type: 'solicitation', procurement_type: 'r' },
    { response_deadline_from: '2026-11-01', response_deadline_to: '2026-10-01' },
    { posted_from: '2026-13-01' },
  ])
    assert.equal(opportunityInput.safeParse(bad).success, false, JSON.stringify(bad));
  assert.equal(
    opportunityInput.safeParse({ posted_from: '10/01/2026', posted_to: '2026-10-07' }).success,
    true,
  );
});

test('retries transient upstream failures but not 404, with actionable errors', async () => {
  let attempts = 0;
  const flaky: Fetch = async () => (++attempts < 3 ? new Response(null, { status: 503 }) : empty());
  await searchOpportunities(input, 'k', flaky, undefined, instant);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(
    searchOpportunities(
      input,
      'k',
      async () => {
        attempts++;
        return new Response(null, { status: 404 });
      },
      undefined,
      instant,
    ),
    /zero matches are not confirmed/,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    searchOpportunities(input, 'k', async () => new Response(null, { status: 502 }), undefined, {
      ...instant,
    }),
    /HTTP 502 after 3 attempts/,
  );
  await assert.rejects(
    searchOpportunities(input, 'k', async () => new Response(null, { status: 401 })),
    /administrator to reconnect/,
  );
  const delays: number[] = [];
  attempts = 0;
  await searchOpportunities(
    input,
    'k',
    async () =>
      ++attempts === 1
        ? new Response(null, { status: 429, headers: { 'Retry-After': '3' } })
        : empty(),
    undefined,
    { sleep: async (ms) => void delays.push(ms) },
  );
  assert.deepEqual(delays, [3000]);
  delays.length = 0;
  attempts = 0;
  await assert.rejects(
    searchOpportunities(
      input,
      'k',
      async () => {
        attempts++;
        return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
      },
      undefined,
      { sleep: async (ms) => void delays.push(ms) },
    ),
    (error: SamError) => error.code === 'RATE_LIMITED' && error.retryAfter === '60',
  );
  assert.equal(attempts, 1, 'must not retry before a long Retry-After cooldown ends');
  assert.deepEqual(delays, []);
});

test('returns place of performance and award details without null fields', async () => {
  const result = await searchOpportunities(input, 'k', async () =>
    Response.json({
      totalRecords: 1,
      opportunitiesData: [
        {
          noticeId: 'b'.repeat(32),
          title: 'Award',
          typeOfSetAside: null,
          placeOfPerformance: { city: { name: 'Arlington' }, state: { code: 'VA' } },
          award: { date: '2026-10-01', amount: '1000', awardee: { name: 'Acme', ueiSAM: 'UEI1' } },
        },
      ],
    }),
  );
  const [first] = result.opportunities;
  assert.equal(first?.placeOfPerformance, 'Arlington, VA');
  assert.deepEqual(first?.award, {
    date: '2026-10-01',
    amount: '1000',
    awardee: 'Acme',
    awardeeUei: 'UEI1',
  });
  assert.ok(!('typeOfSetAside' in first!));
});

test('key check rejects only definite refusals', async () => {
  assert.equal((await checkSamKey('k', async () => empty())).status, 'valid');
  assert.equal(
    (await checkSamKey('k', async () => new Response(null, { status: 403 }))).status,
    'rejected',
  );
  const limited = await checkSamKey('k', async () => new Response(null, { status: 429 }));
  assert.equal(limited.status, 'valid');
  assert.ok('warning' in limited && limited.warning);
  for (const status of [404, 503])
    assert.equal(
      (await checkSamKey('k', async () => new Response(null, { status }))).status,
      'unverified',
    );
});

test('reports a cancellation during a retry wait as cancelled', async () => {
  const controller = new AbortController();
  await assert.rejects(
    searchOpportunities(
      input,
      'k',
      async () => new Response(null, { status: 503 }),
      controller.signal,
      {
        sleep: async () => {
          controller.abort();
          throw new Error('aborted');
        },
      },
    ),
    (error: SamError) => error.code === 'UPSTREAM_UNAVAILABLE' && /cancelled/.test(error.message),
  );
});

test('saveSamKey checks format and SAM.gov before saving', async () => {
  const saved: string[] = [];
  const save = async (key: string) => (saved.push(key), true);
  assert.deepEqual(await saveSamKey('bad key!', save, async () => empty()), {
    status: 'invalid_format',
  });
  const rejected = await saveSamKey(
    'rejected-key',
    save,
    async () => new Response(null, { status: 403 }),
  );
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(saved, [], 'invalid and rejected keys are never saved');
  assert.deepEqual(await saveSamKey('valid-key', save, async () => empty()), {
    status: 'saved',
    verified: true,
  });
  const outage = await saveSamKey(
    'outage-key',
    save,
    async () => new Response(null, { status: 503 }),
  );
  assert.equal(outage.status === 'saved' && outage.verified, false);
  assert.deepEqual(saved, ['valid-key', 'outage-key']);
  assert.deepEqual(
    await saveSamKey(
      'valid-key',
      async () => false,
      async () => empty(),
    ),
    {
      status: 'forbidden',
    },
  );
});

test('passes on long upstream cooldowns and reports body timeouts as unavailable', async () => {
  const delays: number[] = [];
  await assert.rejects(
    searchOpportunities(
      input,
      'k',
      async () => new Response(null, { status: 503, headers: { 'Retry-After': '120' } }),
      undefined,
      { sleep: async (ms) => void delays.push(ms) },
    ),
    (error: SamError) => error.code === 'UPSTREAM_ERROR' && error.retryAfter === '120',
  );
  assert.deepEqual(delays, []);
  const dateDelays: number[] = [];
  const later = new Date(Date.now() + 60_000).toUTCString();
  await assert.rejects(
    searchOpportunities(
      input,
      'k',
      async () => new Response(null, { status: 429, headers: { 'Retry-After': later } }),
      undefined,
      { sleep: async (ms) => void dateDelays.push(ms) },
    ),
    (error: SamError) => error.code === 'RATE_LIMITED' && Number(error.retryAfter) > 5,
  );
  assert.deepEqual(dateDelays, [], 'an HTTP-date cooldown is honored too');
  const stalled = new ReadableStream({
    pull(controller) {
      controller.error(new DOMException('timed out', 'TimeoutError'));
    },
  });
  await assert.rejects(
    searchOpportunities(input, 'k', async () => new Response(stalled)),
    (error: SamError) => error.code === 'UPSTREAM_UNAVAILABLE' && /too long/.test(error.message),
  );
});
