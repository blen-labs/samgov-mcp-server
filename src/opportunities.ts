import { VERSION } from './version.js';
import { z } from 'zod';

export const SAM_ENDPOINT = 'https://api.sam.gov/opportunities/v2/search';

const DAY = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;

// Accept ISO dates, which models produce reliably, and SAM.gov's own MM/dd/yyyy.
function parseDate(value: string): Date | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const sam = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : sam ? [sam[3], sam[1], sam[2]] : [];
  if (!year) return;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  )
    return;
  return date;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const samDay = (date: Date) => {
  const [year, month, day] = isoDay(date).split('-');
  return `${month}/${day}/${year}`;
};
const today = () => parseDate(isoDay(new Date()))!;

function postedRange(value: { posted_from?: string; posted_to?: string }) {
  const to = value.posted_to ? parseDate(value.posted_to) : today();
  const from = value.posted_from
    ? parseDate(value.posted_from)
    : to && new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY);
  return { from, to };
}

const date = z
  .string()
  .refine((value) => !!parseDate(value), 'Use a valid YYYY-MM-DD (or MM/dd/yyyy) date');
const filter = z.string().trim().min(1).max(200);

export const NOTICE_TYPES = {
  justification: 'u',
  presolicitation: 'p',
  award_notice: 'a',
  sources_sought: 'r',
  special_notice: 's',
  solicitation: 'o',
  sale_of_surplus_property: 'g',
  combined_synopsis_solicitation: 'k',
  intent_to_bundle: 'i',
} as const;
const procurementCodes = Object.values(NOTICE_TYPES) as [string, ...string[]];

export const opportunityInput = z
  .object({
    posted_from: date
      .optional()
      .describe(
        `First posted date, YYYY-MM-DD. Default: ${DEFAULT_RANGE_DAYS} days before posted_to. Maximum range one year.`,
      ),
    posted_to: date.optional().describe('Last posted date, YYYY-MM-DD. Default: today (UTC).'),
    keyword: filter
      .optional()
      .describe('Search the notice title only, not description or attachments.'),
    notice_id: filter.optional().describe('SAM.gov notice ID (32 hexadecimal characters).'),
    solicitation_number: filter.optional(),
    organization_name: filter.optional().describe('Department, agency, or office name.'),
    organization_code: filter.optional(),
    notice_type: z
      .enum(Object.keys(NOTICE_TYPES) as [keyof typeof NOTICE_TYPES])
      .optional()
      .describe('Notice type, e.g. solicitation, sources_sought, award_notice.'),
    procurement_type: z
      .enum(procurementCodes)
      .optional()
      .describe('SAM.gov single-letter notice type code. Prefer notice_type.'),
    set_aside: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,20}$/)
      .optional()
      .describe('Set-aside code, e.g. SBA, 8A, WOSB, SDVOSBC, HZC.'),
    state: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional()
      .describe('Place-of-performance state, two-letter code.'),
    naics: z
      .string()
      .regex(/^\d{2,6}$/)
      .optional()
      .describe('NAICS code, e.g. 541512.'),
    classification_code: z
      .string()
      .regex(/^[A-Za-z0-9]{2,4}$/)
      .optional()
      .describe('Product Service Code (PSC), e.g. DA01.'),
    response_deadline_from: date.optional().describe('Earliest response deadline, YYYY-MM-DD.'),
    response_deadline_to: date.optional().describe('Latest response deadline, YYYY-MM-DD.'),
    limit: z.number().int().min(1).max(100).default(10),
    offset: z
      .number()
      .int()
      .min(0)
      .max(100000)
      .default(0)
      .describe('Zero-based page index, not a row offset. Use next_offset from a previous result.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { from: start, to: end } = postedRange(value);
    if (start && end) {
      const maximum = new Date(start);
      maximum.setUTCFullYear(maximum.getUTCFullYear() + 1);
      if (maximum.getUTCMonth() !== start.getUTCMonth()) maximum.setUTCDate(0);
      if (end < start || end > maximum)
        ctx.addIssue({
          code: 'custom',
          path: ['posted_to'],
          message: 'Posted date range must be ordered and no longer than one year',
        });
    }
    const deadlineFrom = value.response_deadline_from && parseDate(value.response_deadline_from);
    const deadlineTo = value.response_deadline_to && parseDate(value.response_deadline_to);
    if (deadlineFrom && deadlineTo && deadlineTo < deadlineFrom)
      ctx.addIssue({
        code: 'custom',
        path: ['response_deadline_to'],
        message: 'Response deadline range must be ordered',
      });
    if (
      value.notice_type &&
      value.procurement_type &&
      NOTICE_TYPES[value.notice_type] !== value.procurement_type
    )
      ctx.addIssue({
        code: 'custom',
        path: ['procurement_type'],
        message: 'notice_type and procurement_type disagree; use notice_type only',
      });
  });

export type OpportunityInput = z.input<typeof opportunityInput>;
export type Fetch = typeof globalThis.fetch;

const value = z.union([z.string(), z.number(), z.boolean()]);
export const opportunityOutput = z.object({
  source: z.string(),
  retrieved_at: z.string(),
  total: z.number().int(),
  opportunities: z.array(
    z
      .object({
        url: z.string().optional(),
        placeOfPerformance: z.string().optional(),
        award: z
          .object({
            date: value.optional(),
            amount: value.optional(),
            awardee: value.optional(),
            awardeeUei: value.optional(),
          })
          .optional(),
      })
      .catchall(value),
  ),
  limit: z.number().int(),
  offset: z.number().int(),
  next_offset: z.number().int().nullable(),
  date_range: z.object({ from: z.string(), to: z.string() }),
});
export type OpportunityOutput = z.infer<typeof opportunityOutput>;

export class SamError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = 'SamError';
  }
}

export type SamOptions = {
  maxRetries?: number;
  /** Overridable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

const backoff = (attempt: number) => 500 * 2 ** attempt + Math.floor(Math.random() * 250);

function retryAfter(response: Response) {
  const raw = response.headers.get('retry-after');
  return raw && /^\d{1,8}$/.test(raw) ? raw : undefined;
}

// Sends one search, retrying transient failures. The URL contains the key: never surface it.
async function samGet(
  url: URL,
  fetcher: Fetch,
  signal: AbortSignal | undefined,
  options: SamOptions,
) {
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? wait;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { Accept: 'application/json', 'User-Agent': `SAMgov-MCP/${VERSION}` },
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
    } catch {
      // Fetch exceptions can include the URL containing the secret. Never propagate them.
      if (attempt < maxRetries && !signal?.aborted) {
        await sleep(backoff(attempt), signal).catch(() => {});
        if (!signal?.aborted) continue;
      }
      throw new SamError(
        'UPSTREAM_UNAVAILABLE',
        signal?.aborted
          ? 'The search was cancelled.'
          : 'SAM.gov could not be reached after several attempts. Retry in a few minutes.',
      );
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    if (RETRYABLE.has(response.status) && attempt < maxRetries) {
      const seconds = retryAfter(response);
      const delay = seconds ? Math.min(Number(seconds) * 1000, 5000) : backoff(attempt);
      try {
        await sleep(delay, signal);
        continue;
      } catch {
        // Cancelled while waiting: report the last upstream response.
      }
    }
    throw toSamError(response, attempt + 1);
  }
}

function toSamError(response: Response, attempts: number) {
  const { status } = response;
  if (status === 401 || status === 403)
    return new SamError(
      'KEY_REJECTED',
      `SAM.gov rejected this organization's API key (HTTP ${status}). SAM.gov keys expire and must be renewed periodically (personal keys every 90 days). Ask an organization administrator to reconnect with a current key, then retry.`,
    );
  if (status === 429) {
    const seconds = retryAfter(response);
    return new SamError(
      'RATE_LIMITED',
      `SAM.gov's request limit for this organization's key is used up.${seconds ? ` Retry after ${seconds} seconds.` : ' Retry later.'}`,
      seconds,
    );
  }
  if (status === 400)
    return new SamError(
      'BAD_REQUEST',
      'SAM.gov rejected the search parameters (HTTP 400). Check codes such as set_aside, classification_code, and organization_code.',
    );
  if (status === 404)
    return new SamError(
      'UPSTREAM_ERROR',
      'SAM.gov returned HTTP 404 with no data. SAM.gov uses this response for service outages as well as some empty searches, so zero matches are not confirmed. Retry later; if it persists, the SAM.gov API may be unavailable.',
    );
  return new SamError(
    'UPSTREAM_ERROR',
    `SAM.gov returned HTTP ${status}${attempts > 1 ? ` after ${attempts} attempts` : ''}. Retry in a few minutes.`,
  );
}

const upstreamResponse = z.object({
  totalRecords: z.number().int().nonnegative(),
  opportunitiesData: z.array(z.record(z.string(), z.unknown())),
});

// Allow-list fields rather than returning upstream request URLs or key-bearing links.
const fields = [
  'noticeId',
  'title',
  'solicitationNumber',
  'fullParentPathName',
  'fullParentPathCode',
  'postedDate',
  'type',
  'baseType',
  'typeOfSetAside',
  'typeOfSetAsideDescription',
  'responseDeadLine',
  'naicsCode',
  'classificationCode',
  'active',
] as const;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export async function searchOpportunities(
  input: OpportunityInput,
  apiKey: string,
  fetcher: Fetch = fetch,
  signal?: AbortSignal,
  options: SamOptions = {},
): Promise<OpportunityOutput> {
  const args = opportunityInput.parse(input);
  if (!apiKey.trim())
    throw new SamError(
      'KEY_REQUIRED',
      'No SAM.gov key is connected. Ask an organization administrator to add one while reconnecting.',
    );
  const range = postedRange(args) as { from: Date; to: Date };
  const url = new URL(SAM_ENDPOINT);
  const params: Record<string, string | number | undefined> = {
    postedFrom: samDay(range.from),
    postedTo: samDay(range.to),
    title: args.keyword,
    noticeid: args.notice_id,
    solnum: args.solicitation_number,
    organizationName: args.organization_name,
    organizationCode: args.organization_code,
    ptype: args.notice_type ? NOTICE_TYPES[args.notice_type] : args.procurement_type,
    typeOfSetAside: args.set_aside,
    state: args.state,
    ncode: args.naics,
    ccode: args.classification_code,
    rdlfrom: args.response_deadline_from && samDay(parseDate(args.response_deadline_from)!),
    rdlto: args.response_deadline_to && samDay(parseDate(args.response_deadline_to)!),
    limit: args.limit,
    offset: args.offset,
  };
  for (const [parameter, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(parameter, String(value));
  url.searchParams.set('api_key', apiKey);
  const response = await samGet(url, fetcher, signal, options);
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
    if (
      (data.totalRecords === 0 && data.opportunitiesData.length > 0) ||
      (args.offset * args.limit < data.totalRecords && data.opportunitiesData.length === 0)
    )
      throw new Error();
  } catch {
    throw new SamError(
      'INVALID_RESPONSE',
      'SAM.gov returned an invalid or oversized response; no results can be confirmed.',
    );
  }
  const safe = (value: unknown): string | number | boolean | undefined => {
    if (typeof value === 'string') {
      const text = value.split(apiKey).join('[REDACTED]').trim().slice(0, 5000);
      return text || undefined;
    }
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value).includes(apiKey) ? '[REDACTED]' : value;
  };
  const opportunities = data.opportunitiesData.slice(0, args.limit).map((item) => {
    // Null and empty upstream fields are dropped to save tokens.
    const result: OpportunityOutput['opportunities'][number] = {};
    for (const field of fields) {
      const value = safe(item[field]);
      if (value !== undefined) result[field] = value;
    }
    const place = record(item.placeOfPerformance);
    const location = [safe(record(place.city).name), safe(record(place.state).code)]
      .filter((part) => part !== undefined)
      .join(', ');
    if (location) result.placeOfPerformance = location;
    const award = record(item.award);
    const awardee = record(award.awardee);
    const details = Object.fromEntries(
      Object.entries({
        date: safe(award.date),
        amount: safe(award.amount),
        awardee: safe(awardee.name),
        awardeeUei: safe(awardee.ueiSAM),
      }).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(details).length) result.award = details;
    if (typeof result.noticeId === 'string' && /^[a-fA-F0-9]{32}$/.test(result.noticeId)) {
      result.url = `https://sam.gov/opp/${result.noticeId}/view`;
    }
    return result;
  });
  const hasMore = (args.offset + 1) * args.limit < data.totalRecords;
  return {
    source: SAM_ENDPOINT,
    retrieved_at: new Date().toISOString(),
    total: data.totalRecords,
    opportunities,
    limit: args.limit,
    offset: args.offset,
    next_offset: hasMore ? args.offset + 1 : null,
    date_range: { from: isoDay(range.from), to: isoDay(range.to) },
  };
}

export type KeyCheck =
  | { status: 'valid'; warning?: string }
  | { status: 'rejected'; message: string }
  | { status: 'unverified'; warning: string };

/**
 * Checks a key with one small search when an administrator saves it. Only a definite
 * rejection blocks saving: SAM.gov outages must not stop organizations from connecting.
 */
export async function checkSamKey(apiKey: string, fetcher: Fetch = fetch): Promise<KeyCheck> {
  const to = today();
  try {
    await searchOpportunities(
      { posted_from: isoDay(new Date(to.getTime() - DAY)), posted_to: isoDay(to), limit: 1 },
      apiKey,
      fetcher,
      undefined,
      { maxRetries: 0 },
    );
    return { status: 'valid' };
  } catch (error) {
    const code = error instanceof SamError ? error.code : 'INTERNAL_ERROR';
    if (code === 'KEY_REJECTED')
      return {
        status: 'rejected',
        message:
          'SAM.gov rejected this key. Check that it is current and authorized for public opportunity searches.',
      };
    if (code === 'RATE_LIMITED')
      return {
        status: 'valid',
        warning: 'Saved. SAM.gov reports this key has no requests left right now.',
      };
    return {
      status: 'unverified',
      warning: 'Saved, but SAM.gov could not be reached to check the key. Try a search later.',
    };
  }
}
