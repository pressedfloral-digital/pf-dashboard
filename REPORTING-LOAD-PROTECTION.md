# Protect the core API from dashboard reporting

The core API is shared with the hub and customer app. Dashboard freshness is lower priority.

This change bounds reporting HTTP work to two simultaneous requests per module/process, including response-body consumption, with a bounded queue and a ten-second total deadline. It removes automatic retries (including POST retries), shares identical in-flight GETs, and pauses new requests for at least sixty seconds after network/timeout/429/5xx failures. Retry-After can extend the pause to five minutes. Bulk read failures reject the report instead of converting missing data to null/zero. Direct report/debug/approval-sync paths use the same wrapper.

Existing assignment batching and its cache remain intact. GitHub reports deployment 7375720890 succeeded at 2026-10-28T02:40:27Z with source 35a5dad, which includes that batch fix; the old employee/day fan-out must not be asserted as the proven cause of the later incident.

Validation: twelve unit/integration tests, TypeScript, and lint of the changed shared client/budget/test. No production load test was run.

Limitations: this is a per-process/module budget, not a shared fleet-wide admission controller. Other services and instances can still consume database capacity. Client abort does not prove server SQL cancellation. The exact holders of production connections remain unverified. No claim that this alone prevents every recurrence.

Rollout: deploy alongside PF Platform's sync protection. Monitor core search latency, PostgreSQL 53300, pool timeouts, and dashboard refresh errors. Accept slower/unavailable reports during API overload. Verify existing views retain last successful results or show an explicit refresh error; do not interpret failed reports as zeros. Roll back by reverting this change. Use API-side caller-aware admission limits and connection activity diagnostics if saturation persists.
