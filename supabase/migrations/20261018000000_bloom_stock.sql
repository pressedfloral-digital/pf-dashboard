-- Bloom-stock work (Handprint / Paw Print / Footprint frames, Bloom
-- Arrangement Recreation) done by Utah designers as an extra part of their
-- role. See src/lib/bloomStock.ts.
--
-- Fully independent of team_member_week_actuals, which nothing here ever
-- reads or writes. Hours come from Rippling's Recreation department (hours
-- upload) or are typed in Bloom Stock Historicals; bloom-stock CPO is
-- computed from these tables plus Recreation pay in weekly_labor_cost.

create table bloom_stock_week_actuals (
  location     text not null,
  week_of      date not null,
  member_name  text not null,
  hours        numeric(10,2) not null default 0 check (hours >= 0),
  entered_by   text,
  updated_at   timestamptz not null default now(),
  primary key (location, week_of, member_name)
);

-- One row per Shopify line item a team member logged as completed. The queue
-- drops these even before Shopify marks them fulfilled.
create table bloom_stock_completions (
  id           uuid primary key default gen_random_uuid(),
  location     text not null,
  week_of      date not null,
  member_name  text not null,
  order_name   text not null,
  order_id     text not null,
  line_item_id text not null unique,
  product_key  text not null,
  units        numeric(10,2) not null check (units > 0),
  created_by   text not null,
  created_at   timestamptz not null default now()
);
create index bloom_stock_completions_week_idx
  on bloom_stock_completions (location, week_of);
