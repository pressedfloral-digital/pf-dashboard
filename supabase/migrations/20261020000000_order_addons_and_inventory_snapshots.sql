-- Each order's non-status add-ons (Backing, Glass, …) from the PF API's
-- /Orders/{uuid}, so the Inventory tab reads them instead of making one
-- request per scheduled order. /api/cron/refresh-order-addons keeps them
-- current; a failed fetch only sets last_error, keeping the last good
-- add_ons and fetched_at. See src/lib/orderAddOns.ts.
create table if not exists pf_order_addons (
  order_number    text primary key,
  order_uuid      uuid not null,
  add_ons         jsonb not null,
  fetched_at      timestamptz not null,   -- last successful fetch
  last_attempt_at timestamptz not null default now(),
  last_error      text
);
create index if not exists pf_order_addons_fetched_at_idx on pf_order_addons (fetched_at);
alter table pf_order_addons enable row level security;

-- The last successful /api/design-inventory build per location, shown while
-- a fresh one builds and kept if that refresh fails. See
-- src/lib/inventorySnapshots.ts.
create table if not exists pf_inventory_snapshots (
  location     text primary key,
  payload      jsonb not null,
  generated_at timestamptz not null
);
alter table pf_inventory_snapshots enable row level security;

-- pf_order_uuids was created with RLS enabled from the SQL editor; record it.
alter table pf_order_uuids enable row level security;
