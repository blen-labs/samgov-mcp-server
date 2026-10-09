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
  // A rename upstream empties the field on every record; one sparse notice is not drift.
  const missing = required.filter((field) =>
    result.opportunities.every((item) => (item as Record<string, unknown>)[field] == null),
  );
  if (missing.length) {
    console.log(`::error::SAM.gov results are missing expected fields: ${missing.join(', ')}.`);
    process.exit(1);
  }
  console.log(`SAM.gov response shape OK (${result.opportunities.length} records checked).`);
} catch (error) {
  if (!(error instanceof SamError)) {
    // An unexpected exception is breakage in this client, not an outage.
    console.log(
      `::error::The drift check failed unexpectedly (${error instanceof Error ? error.name : 'unknown error'}).`,
    );
    process.exit(1);
  }
  const code = error.code;
  if (code === 'INVALID_RESPONSE') {
    console.log('::error::SAM.gov response no longer matches the expected format (API drift).');
    process.exit(1);
  }
  if (code === 'BAD_REQUEST') {
    // This search is fixed and valid, so a 400 means SAM.gov changed its parameters.
    console.log('::error::SAM.gov rejected the drift-check search parameters (API drift).');
    process.exit(1);
  }
  if (code === 'KEY_REJECTED') {
    console.log(
      '::error::SAM.gov rejected the monitoring key. Renew the SAM_GOV_MONITOR_API_KEY secret.',
    );
    process.exit(1);
  }
  // Outages, rate limits, and SAM.gov's ambiguous 404 are not drift.
  console.log(
    `::warning::SAM.gov unavailable during the drift check (${code}); not an API change.`,
  );
}
