-- Monthly order count + revenue by customer shipping state, pulled from
-- Shopify (src/app/api/cron/sync-state-sales/route.ts). Feeds the Growth &
-- Distribution tab's Shipping & CPO Impact table so a state's reassignment
-- "opportunity" can be weighted by how much volume it actually represents,
-- not just a flat $/order figure — and so reassigning a state can show its
-- effect on the overall Utah/Georgia order-volume distribution %.
create table state_sales_monthly (
  state_code   text not null,
  month        date not null, -- first of month, e.g. 2026-09-01
  order_count  integer not null default 0,
  revenue      numeric not null default 0,
  synced_at    timestamptz not null default now(),
  primary key (state_code, month)
);

create index state_sales_monthly_month_idx on state_sales_monthly (month);
