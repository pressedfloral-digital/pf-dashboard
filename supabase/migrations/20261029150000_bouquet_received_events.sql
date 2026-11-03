-- Every time an order product entered Bouquet Received, from the PF API's
-- /OrderProducts/Changes feed. Preservation's turnaround KPI pairs these with
-- each order product's first bouquet photo upload. The feed is slow (~10s a
-- page), so /api/cron/sync-bouquet-received copies it here and the KPI route
-- only catches up the last few minutes. See src/lib/preservationTurnaround.ts.
create table if not exists pf_bouquet_received (
  history_uuid       uuid primary key,
  order_product_uuid uuid not null,
  order_number       text,
  location           text,
  entered_at         timestamptz not null
);
create index if not exists pf_bouquet_received_entered_at_idx on pf_bouquet_received (entered_at);
alter table pf_bouquet_received enable row level security;

-- How far each feed has been read (the Changes feed's nextCursor).
create table if not exists pf_sync_cursors (
  name       text primary key,
  cursor_at  timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table pf_sync_cursors enable row level security;
