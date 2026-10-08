import { z } from 'zod';

export const SAM_ENDPOINT = 'https://api.sam.gov/opportunities/v2/search';

function parseDate(value: string): Date | undefined {
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!parts) return;
  const [, month, day, year] = parts;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day)) return;
  return date;
}

const date = z.string().refine(value => !!parseDate(value), 'Use a valid MM/dd/yyyy date');
const filter = z.string().trim().min(1).max(200);

export const opportunityInput = z.object({
  posted_from: date.describe('First posted date, MM/dd/yyyy; maximum range one year.'),
  posted_to: date.describe('Last posted date, MM/dd/yyyy.'),
  keyword: filter.optional().describe('Search the notice title only, not description or attachments.'),
  notice_id: filter.optional(),
  solicitation_number: filter.optional(),
  organization_name: filter.optional(),
  organization_code: filter.optional(),
  procurement_type: z.enum(['u', 'p', 'a', 'r', 's', 'o', 'g', 'k', 'i']).optional(),
  set_aside: z.string().regex(/^[A-Za-z0-9-]{1,20}$/).optional(),
  state: z.string().regex(/^[A-Z]{2}$/).optional(),
  naics: z.string().regex(/^\d{2,6}$/).optional(),
  classification_code: z.string().regex(/^[A-Za-z0-9]{2,4}$/).optional(),
  limit: z.number().int().min(1).max(100).default(10),
  offset: z.number().int().min(0).max(100000).default(0).describe('Zero-based page index, not a row offset. Increment by one for the next page.'),
}).strict().superRefine((value, ctx) => {
  const start = parseDate(value.posted_from);
  const end = parseDate(value.posted_to);
  if (!start || !end) return;
  const maximum = new Date(start);
  maximum.setUTCFullYear(maximum.getUTCFullYear() + 1);
  if (maximum.getUTCMonth() !== start.getUTCMonth()) maximum.setUTCDate(0);
  if (end < start || end > maximum) ctx.addIssue({ code: 'custom', path: ['posted_to'], message: 'Date range must be ordered and no longer than one year' });
});

export type OpportunityInput = z.infer<typeof opportunityInput>;
export type Fetch = typeof globalThis.fetch;

export class SamError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryAfter?: string) {
    super(message);
    this.name = 'SamError';
  }
}

const upstreamResponse = z.object({
  totalRecords: z.number().int().nonnegative(),
  opportunitiesData: z.array(z.record(z.string(), z.unknown())),
});

// Allow-list fields rather than returning upstream request URLs or key-bearing links.
const fields = ['noticeId', 'title', 'solicitationNumber', 'fullParentPathName', 'fullParentPathCode',
  'postedDate', 'type', 'baseType', 'typeOfSetAside', 'typeOfSetAsideDescription',
  'responseDeadLine', 'naicsCode', 'classificationCode', 'active'] as const;

export async function searchOpportunities(input: OpportunityInput, apiKey: string, fetcher: Fetch = fetch, signal?: AbortSignal) {
  const args = opportunityInput.parse(input);
  if (!apiKey.trim()) throw new SamError('KEY_REQUIRED', 'Connect your SAM.gov API key before searching.');
  const url = new URL(SAM_ENDPOINT);
  const mapping = {
    posted_from: 'postedFrom', posted_to: 'postedTo', keyword: 'title', notice_id: 'noticeid',
    solicitation_number: 'solnum', organization_name: 'organizationName', organization_code: 'organizationCode',
    procurement_type: 'ptype', set_aside: 'typeOfSetAside', state: 'state', naics: 'ncode',
    classification_code: 'ccode', limit: 'limit', offset: 'offset',
  } as const;
  for (const [key, parameter] of Object.entries(mapping)) {
    const value = args[key as keyof OpportunityInput];
    if (value !== undefined) url.searchParams.set(parameter, String(value));
  }
  url.searchParams.set('api_key', apiKey);
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'SAMgov-MCP/0.1.0' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
  } catch {
    // Fetch exceptions can include the URL containing the secret. Never propagate them.
    throw new SamError('UPSTREAM_UNAVAILABLE', 'SAM.gov could not be reached or the request was cancelled.');
  }
  if (!response.ok) await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) throw new SamError('KEY_REJECTED', 'SAM.gov rejected this key or its access permissions. Reconnect with a valid SAM.gov key.');
  if (response.status === 429) {
    const raw = response.headers.get('retry-after');
    const retryAfter = raw && /^\d{1,8}$/.test(raw) ? raw : undefined;
    throw new SamError('RATE_LIMITED', 'SAM.gov rate limit reached for this key. Retry later.', retryAfter);
  }
  if (!response.ok) throw new SamError('UPSTREAM_ERROR', `SAM.gov returned HTTP ${response.status}.`);
  let data: z.infer<typeof upstreamResponse>;
  try {
    // Read with a bound so unexpected responses cannot consume unlimited memory.
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 5_000_000) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    data = upstreamResponse.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if ((data.totalRecords === 0 && data.opportunitiesData.length > 0) ||
        (args.offset * args.limit < data.totalRecords && data.opportunitiesData.length === 0)) throw new Error();
  } catch {
    throw new SamError('INVALID_RESPONSE', 'SAM.gov returned an invalid or oversized response; no results can be confirmed.');
  }
  const opportunities = data.opportunitiesData.slice(0, args.limit).map(item => {
    const result: Record<string, string | number | boolean | null> = {};
    for (const field of fields) {
      const value = item[field];
      if (typeof value === 'string') result[field] = value.split(apiKey).join('[REDACTED]').slice(0, 5000);
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        result[field] = String(value).includes(apiKey) ? '[REDACTED]' : value;
      }
    }
    if (typeof result.noticeId === 'string' && /^[a-fA-F0-9]{32}$/.test(result.noticeId)) {
      result.url = `https://sam.gov/opp/${result.noticeId}/view`;
    }
    return result;
  });
  const hasMore = (args.offset + 1) * args.limit < data.totalRecords;
  return {
    source: SAM_ENDPOINT, retrieved_at: new Date().toISOString(), total: data.totalRecords,
    opportunities, limit: args.limit, offset: args.offset, next_offset: hasMore ? args.offset + 1 : null,
    date_range: { from: args.posted_from, to: args.posted_to },
  };
}
