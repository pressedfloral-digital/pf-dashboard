-- Replaces state_sales_monthly with raw, one-row-per-order facts instead of
-- a pre-aggregated monthly bucket. A pre-aggregated table locks in a single
-- granularity (month) up front; storing the raw order->state->date->revenue
-- fact lets any rollup (week, month, week-of-year across years, month-of-
-- year across years) be computed at read time from one source of truth —
-- needed for the Growth & Distribution tab's seasonal reassignment planner
-- (src/app/api/distribution-estimate/route.ts), which needs both week-of-
-- year and month-of-year views of the same history.
drop table if exists state_sales_monthly;

create table shopify_order_state_facts (
  order_id    bigint primary key,
  state_code  text not null,
  order_date  date not null,
  revenue     numeric not null default 0,
  synced_at   timestamptz not null default now()
);

create index shopify_order_state_facts_date_idx  on shopify_order_state_facts (order_date);
create index shopify_order_state_facts_state_idx on shopify_order_state_facts (state_code);
