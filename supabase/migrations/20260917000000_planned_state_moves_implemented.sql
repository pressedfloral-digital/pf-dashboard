-- Lets a planned reassignment (planned_state_moves) be confirmed as actually
-- carried out. Set only by POST /api/planned-state-moves/implement — that
-- same request also flips state_location_routing.location to match, so
-- "implemented" always means the State Routing list and this record agree.
-- Left null, a plan keeps affecting forward-looking projections only (see
-- distribution-estimate's effectiveLocation) without changing what's
-- currently true.
alter table planned_state_moves add column implemented_at timestamptz;
