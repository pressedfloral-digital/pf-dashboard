# Batched assignment counts

Deploy the companion `pressed-floral-api-master` change providing
`POST /OrderProducts/ForUser/Counts/Batch` **before** deploying this dashboard.
There is intentionally no fallback to the old per-person/per-day fan-out.
If the endpoint is missing or fails, this dashboard reports a refresh error;
existing same-scope values retain their last successful timestamp. A fresh view
shows unknown counts, not fabricated zeroes.

A batch covers at most 200 distinct account UUIDs and seven inclusive UTC calendar
days. The backend counts order-product rows (not quantity) by each department's
current owner and assignment timestamp, across all statuses. Deleted orders and
order products are omitted. Product titles containing "bloom arrangement recreation"
(case-insensitive) are excluded in the same query. This replaces the old proportional
exclusion estimate, so affected multi-stage counts may correctly change.

Duplicate accounts are summed. Unmatched names remain explicitly unmatched. A
complete account/day response, including explicit zeroes, is required before values
are used. Historical weekly totals sum the same daily snapshot; manual locks in the
historical sync are unchanged.

Refreshes wait five minutes after completion. Matching requests share in-flight
work in the browser and dashboard process. Successful backend batches are cached
for five minutes per process with their original timestamps. These are not distributed
locks: separate instances may each request a batch. The API limits these reports to
two concurrent queries per instance, rejects excess requests before querying, and
uses a 15-second command timeout. The dashboard does not immediately retry a busy
batch. The older API endpoints remain available to other consumers.

Verification before rollout:
- `npm run test:assignment-counts` (Node 22.15+), `npx tsc --noEmit`, changed-file ESLint.
- Companion API PostgreSQL and controller tests.
- After API deployment, compare a known staff/week including duplicate accounts and
  excluded multi-stage products against independent DB results, then deploy dashboard.
- Confirm one batch request per roster/week, visible refresh failures, correct scope
  changes, and falling legacy count-request volume in Datadog. Old open dashboard
  tabs need a reload to pick up the new code. Confirm database pool errors subside;
  this fix does not establish that dashboard traffic was the only connection holder.
