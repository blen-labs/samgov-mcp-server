import { createHash } from 'node:crypto';

export type Refusal = { code: string; message: string; retry_after: string };

export type Consume = (
  bucket: string,
  max: number,
  seconds: number,
) => Promise<{ allowed: boolean; retryAfter: number; firstRefusal: boolean }>;

// Sorts object keys so equal arguments sent in a different key order hash identically.
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  return value;
}

/**
 * Catches an assistant stuck in a loop: the same tool call with the same arguments, many
 * times in a short window. Kept in process memory on purpose, so search arguments (even
 * hashed) are never written to the database. Each replica counts separately.
 */
export class RepeatGuard {
  private seen = new Map<string, { count: number; resetsAt: number }>();

  constructor(
    readonly max = 5,
    readonly windowMs = 10 * 60_000,
    private now = () => Date.now(),
  ) {}

  /**
   * Records the call; returns seconds until it may repeat, or 0 when allowed. Counted per
   * actor when one is given, so members of one organization do not trip each other.
   */
  check(tenantId: string, name: string, args: unknown, actor?: string): number {
    const now = this.now();
    if (this.seen.size > 10_000)
      for (const [k, v] of this.seen) if (v.resetsAt <= now) this.seen.delete(k);
    if (this.seen.size > 10_000) this.seen.clear();
    const key = createHash('sha256')
      .update(JSON.stringify([tenantId, actor ?? null, name, stable(args)]))
      .digest('base64url');
    const entry = this.seen.get(key);
    if (!entry || entry.resetsAt <= now) {
      this.seen.set(key, { count: 1, resetsAt: now + this.windowMs });
      return 0;
    }
    entry.count++;
    return entry.count > this.max ? Math.ceil((entry.resetsAt - now) / 1000) : 0;
  }
}

/**
 * Budget safeguards for tool calls, checked before any SAM.gov request: a repeated-call
 * breaker and a per-organization daily cap. Returns a refusal for the assistant, or
 * undefined when the call may proceed.
 */
export function createUsageLimits(options: {
  consume: Consume;
  dailyLimit: number;
  repeat?: RepeatGuard;
  alert?: (event: { event: string; tenant_id: string }) => void;
}) {
  const repeat = options.repeat ?? new RepeatGuard();
  const alert = options.alert ?? ((event) => console.warn(JSON.stringify(event)));
  return async (
    tenantId: string,
    call: { name: string; arguments: unknown },
    actor?: string,
  ): Promise<Refusal | undefined> => {
    const wait = repeat.check(tenantId, call.name, call.arguments, actor);
    if (wait)
      return {
        code: 'REPEATED_CALL',
        message: `This exact request was already made ${repeat.max} times in the last ${repeat.windowMs / 60_000} minutes. Its results will not change: use the earlier results, change the arguments, or stop retrying.`,
        retry_after: String(wait),
      };
    const day = await options.consume(`tenant-day:${tenantId}`, options.dailyLimit, 86_400);
    if (!day.allowed) {
      // Once per window, not per refused call. Never include arguments: they can contain
      // what the organization is searching for.
      if (day.firstRefusal) alert({ event: 'tenant_daily_limit_reached', tenant_id: tenantId });
      return {
        code: 'DAILY_LIMIT',
        message: `This organization has used its ${options.dailyLimit} SAM.gov requests for the day. Retry after ${day.retryAfter} seconds, or ask the service operator to raise the limit.`,
        retry_after: String(day.retryAfter),
      };
    }
    return undefined;
  };
}
