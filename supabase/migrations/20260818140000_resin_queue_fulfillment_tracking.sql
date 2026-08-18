-- Tracks resin fulfillment-split automation and Georgia->Utah transfer detection.
-- fulfillment_split_at: set once the resin line item has been split into its
--   own fulfillment order and assigned to match its Georgia/Utah tag.
-- transferred_to_utah_at: set the first time a Georgia-origin item's
--   fulfillment order is observed at the Utah location (staff manually moved
--   it in Shopify after physically shipping the flowers) — surfaced on the
--   ops dashboard as "transferred to UT on <date>".
ALTER TABLE resin_queue ADD COLUMN IF NOT EXISTS fulfillment_split_at timestamptz;
ALTER TABLE resin_queue ADD COLUMN IF NOT EXISTS transferred_to_utah_at timestamptz;
