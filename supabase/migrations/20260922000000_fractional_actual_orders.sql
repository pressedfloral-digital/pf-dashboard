-- Allow fractional production credit in Historicals (e.g. 0.5 of an order
-- when two preservationists split one). actual_orders was integer, so a
-- ".5" typed in HistoricalsSection was rejected by Postgres and the save
-- silently failed. actual_hours is already numeric; match it.
alter table team_member_week_actuals
  alter column actual_orders type numeric(10,2) using actual_orders::numeric;
