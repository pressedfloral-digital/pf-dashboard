-- Order-number adjustments to auto-synced Historicals order counts. Instead
-- of typing over a synced count (which locks it as 'manual' and hides what
-- the sync found), a manager adds an order the sync missed or removes one it
-- shouldn't have counted. The synced orders stay visible in the drill-down.
--
-- team_member_week_actuals.actual_orders stays the number every rollup reads
-- (KPIs, Scorecards, Scheduling); it's now synced_orders plus the net of these
-- adjustments. See src/lib/orderAdjustments.ts.

alter table team_member_week_actuals
  add column if not exists synced_orders numeric(10,2);

-- Every existing auto row's count came straight from the sync.
update team_member_week_actuals
  set synced_orders = actual_orders
  where orders_source = 'auto' and synced_orders is null;

create table order_count_adjustments (
  id           uuid primary key default gen_random_uuid(),
  -- Same key as the team_member_week_actuals row it adjusts.
  location     text not null,
  department   text not null,
  week_of      date not null,
  member_name  text not null,
  order_name   text not null,
  action       text not null check (action in ('add', 'remove')),
  -- Order products this order is worth in the count (an order can have
  -- several products; the count is per product).
  products     numeric(10,2) not null default 1 check (products > 0),
  note         text,
  created_by   text not null,
  created_by_name text,
  created_at   timestamptz not null default now(),
  unique (location, department, week_of, member_name, order_name)
);
create index order_count_adjustments_row_idx
  on order_count_adjustments (location, department, week_of);
