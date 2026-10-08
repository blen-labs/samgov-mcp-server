import assert from 'node:assert/strict';
import test from 'node:test';
import { opportunityInput, searchOpportunities, type Fetch } from '../src/opportunities.js';

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
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('secret-test-key'));
        return true;
      },
    );
  }
  await assert.rejects(
    searchOpportunities(input, 'secret-test-key', async () => {
      throw new Error('https://api.sam.gov/?api_key=secret-test-key');
    }),
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
    ),
    /rate limit/,
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
