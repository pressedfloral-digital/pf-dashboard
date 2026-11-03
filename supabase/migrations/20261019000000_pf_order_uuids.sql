-- Shopify order number → PF API order UUID. An order's UUID never changes, so
-- /api/design-inventory remembers each one here instead of paging through
-- every in-progress order on /OrderProducts/Search on every load; only
-- numbers it hasn't seen before are looked up. See src/lib/orderUuids.ts.

create table if not exists pf_order_uuids (
  order_number text primary key,
  order_uuid   uuid not null,
  created_at   timestamptz not null default now()
);
