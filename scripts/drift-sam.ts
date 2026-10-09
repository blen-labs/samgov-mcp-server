// Scheduled check for SAM.gov API changes that would break this server.
// Fails only on drift (a changed response shape) or a rejected key. SAM.gov outages are
// reported as warnings, so an outage does not look like an API change.
import { searchOpportunities, SamError } from '../src/opportunities.js';

const key = process.env.SAM_GOV_API_KEY;
if (!key) {
  console.log('::warning::SAM_GOV_API_KEY is not set; skipping the SAM.gov drift check.');
  process.exit(0);
}
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const end = new Date();
const start = new Date(end.getTime() - 7 * 86_400_000);
// Fields every result needs for the tool to be useful. A rename upstream shows up here.
const required = ['noticeId', 'title', 'postedDate'] as const;

try {
  const result = await searchOpportunities(
    { posted_from: isoDay(start), posted_to: isoDay(end), limit: 10 },
    key,
  );
  if (result.opportunities.length === 0) {
    console.log(
      '::warning::SAM.gov returned no opportunities for the last 7 days; fields not checked.',
    );
    process.exit(0);
  }
  const missing = required.filter((field) =>
    result.opportunities.some((item) => (item as Record<string, unknown>)[field] == null),
  );
  if (missing.length) {
    console.log(`::error::SAM.gov results are missing expected fields: ${missing.join(', ')}.`);
    process.exit(1);
  }
  console.log(`SAM.gov response shape OK (${result.opportunities.length} records checked).`);
} catch (error) {
  const code = error instanceof SamError ? error.code : 'INTERNAL_ERROR';
  if (code === 'INVALID_RESPONSE') {
    console.log('::error::SAM.gov response no longer matches the expected format (API drift).');
    process.exit(1);
  }
  if (code === 'KEY_REJECTED') {
    console.log('::error::SAM.gov rejected the monitoring key. Renew the SAM_GOV_MONITOR_API_KEY secret.');
    process.exit(1);
  }
  // Outages, rate limits, and SAM.gov's ambiguous 404 are not drift.
  console.log(
    `::warning::SAM.gov unavailable during the drift check (${code}); not an API change.`,
  );
}
