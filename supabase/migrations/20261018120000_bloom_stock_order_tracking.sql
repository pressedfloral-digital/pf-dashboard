-- Per-line-item workflow tracking for Bloom Stock Products — replaces the
-- team's "Custom Feet & Recreations" sheet (status, type, assignee, notes).
-- Independent table; nothing else reads or writes it. See
-- src/app/api/bloom-stock/tracking/route.ts.

create table bloom_stock_order_tracking (
  line_item_id text primary key,
  order_id     text not null,
  order_name   text not null,
  product_key  text not null,
  -- new | ready | waiting | hold | influencer | finished
  status       text not null default 'new',
  -- recreation | standard | rainbow — null = use what Shopify's Blooms
  -- Process add-on says
  type         text,
  assignee     text,
  notes        text,
  updated_by   text,
  updated_at   timestamptz not null default now()
);
