-- Manual changes to the Inventory tab's Katana order list, per location.
-- 'add'    = put a Katana component on the order list: `quantity` (in the
--            component's Katana stock unit) needed by the week of `need_by`.
-- 'remove' = take a component off the order list until the row is deleted.
-- Deleting a row undoes the change.
create table inventory_order_adjustments (
  id          uuid primary key default gen_random_uuid(),
  location    text not null check (location in ('Utah', 'Georgia')),
  kind        text not null check (kind in ('add', 'remove')),
  variant_id  bigint not null,
  quantity    numeric check (quantity > 0),
  need_by     date,
  note        text,
  created_by  text,
  created_at  timestamptz not null default now(),
  check (kind = 'remove' or (quantity is not null and need_by is not null))
);

create index inventory_order_adjustments_location on inventory_order_adjustments (location);
-- One standing removal per component per location.
create unique index inventory_order_adjustments_one_remove
  on inventory_order_adjustments (location, variant_id) where kind = 'remove';
