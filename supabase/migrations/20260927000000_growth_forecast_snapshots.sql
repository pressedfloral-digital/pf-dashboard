-- What the Growth & Distribution tab actually forecast for a week, frozen
-- the first time the tab is opened during that week. The Utah % suggestion
-- (src/app/api/distribution-estimate) and the rolling growth multiplier are
-- recomputed live on every load, so without this a past week can only show
-- a reconstruction using today's routing/history — not what we planned
-- with at the time. Insert-once: a row is never overwritten, so it stays an
-- honest record to measure forecast accuracy against.
create table growth_forecast_snapshots (
  week_of     date primary key,
  ut_pct      numeric not null check (ut_pct between 0 and 100),
  multiplier  numeric not null check (multiplier >= 0),
  captured_by text,
  captured_at timestamptz not null default now()
);
