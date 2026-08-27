-- Paid holidays (usePaidHolidays, src/components/dashboard/useScheduleSettings.ts)
-- write to schedule_settings under a location-agnostic 'Global' row so they
-- apply once, shared across Utah and Georgia — but the location check
-- constraint predates that convention and never allowed 'Global', so every
-- holiday save has been silently failing: the client shows an optimistic
-- chip in the UI, the POST to /api/schedule-settings 500s on the DB's check
-- constraint, and nothing actually persists (confirmed live — the row never
-- lands, and the holiday list is empty again on reload).
--
-- Widen the constraint to match reality: 'Utah'/'Georgia' (per-location
-- settings, the original two) plus 'Global' (shared across both).
alter table schedule_settings
  drop constraint if exists schedule_settings_location_check;

alter table schedule_settings
  add constraint schedule_settings_location_check
  check (location in ('Utah', 'Georgia', 'Global'));
