-- Reconciliation flag: set when a sync no longer finds this line item among
-- the currently-open, Georgia/Utah-tagged resin orders (fulfilled, cancelled,
-- un-tagged, or the line item id changed via a Shopify order edit). Without
-- this, resin_queue only ever grows — a row that stops matching the search
-- just sits there forever since nothing else touches it, so the "queue"
-- silently accumulates months of already-completed orders. Soft-delete
-- (not a hard DELETE) so the history stays available for reporting later;
-- the active-queue endpoints filter to cleared_at IS NULL.
ALTER TABLE resin_queue ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
