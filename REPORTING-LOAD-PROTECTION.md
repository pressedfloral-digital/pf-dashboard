# Reporting availability without increasing core load

The production add-on cron launches 15 monthly reports concurrently and retries overload. The API admits one report, so the burst fails even while core reads are healthy. This change serializes the client, removes automatic retries, and adds durable coordination for the scan and add-on cron.

- Shared client budget: one active fetch including body consumption, 32 waiting jobs, 10-second request/queue deadline, 60-second overload cooldown (respect longer Retry-After up to5minutes). Duplicate GETs share in-flight work. No automatic retries or count fallback fanout.
- Bulk scans are sequential and fail as a whole; failed months cannot become zero/missing totals or reach status-snapshot cleanup.
- The 15-month pipeline scan publishes only complete results to a service-role-only Supabase table, with a30-minute freshness limit. A180-second fenced lease prevents simultaneous refresh across Vercel instances; a120-second scan budget stops new months. Missing migration/storage fails closed, never bypasses coordination. Previous complete payload remains stored on failure. Inventory's existing last-good snapshot UI remains visible on failed refresh and now displays order-data freshness.
- Add-on cron uses a separate300-second lease and one enrichment worker through the same client budget. It retains the230-second start-work deadline and saved per-order results. Overload stops further enrichment. Missing UUIDs/failures/unattempted items are explicitly deferred, not `ok:true`; successful per-order saves let the next run resume remaining work. Inventory enrichment also uses one worker.
- Process limits are not fleet limits. API report queue PR keeps one executing report per API process and only bounded waiters, holding no database/shared slots. Pool10/shared7 remain unchanged.

## Rollout order
1. Merge/deploy the companion API report queue PR and confirm serving SHA/core acceptance.
2. Apply `supabase/migrations/20261028233000_reporting_refresh_coordination.sql` to the **pf-dashboard Supabase database**, not the core PF database. This migration has NOT been applied to production by this task. Verify service-role RPC access and anon/authenticated denial. It adds one table and three owner-fenced RPCs; no existing customer rows are changed.
3. Merge PR135; confirm the exact production deployment/asset. A deployment before migration intentionally defers pipeline/cron refresh; prior saved inventory is retained.
4. Observe the next natural :10/:40 add-on refresh (do not trigger writes just to test). Require complete pipeline snapshot/freshness, explicit add-on progress and no silent partial success. Verify Inventory preserves saved data during refresh, then updates after success. Check report completion/queue wait and Hub/app count/search/details/archive outcomes together. A cron HTTP200 alone is insufficient.

If rolling dashboard code back, the additive table can remain unused; do not drop complete snapshots during an incident. Restoring old dashboard code also restores burst/retry behavior.

## Validation
18 Node tests, TypeScript and focused ESLint pass. Integration coverage runs15 reports with duplicate callers, asserts one upstream active, and aborts on503 without later months, retries, or status-snapshot DB writes. Refresh coordinator tests cover competing owners, failure retention, expired-owner fencing and unavailable storage. Disposable PostgreSQL16 migration/permission/fencing tests pass; CI repeats them. No production migration, cron invocation, load test or native-device acceptance has been performed.
