-- Classifies which "Blooms Process" selection (if any) a resin line item's
-- order carries, scoped to just necklace/locket/ring (the actual resin
-- products) — not footprint/handprint/paw print/mini frame, which aren't
-- resin work even though they share the same product family naming.
--   'recreate'  = "Help me customize after purchase" — customer supplies a
--                 photo, no physical delivery to wait on.
--   'send_own'  = "I'll send in my own" — customer is mailing something in,
--                 still needs to physically arrive like a normal order.
--   NULL        = no Blooms Process line item on this order at all.
ALTER TABLE resin_queue ADD COLUMN IF NOT EXISTS blooms_process_type text;
