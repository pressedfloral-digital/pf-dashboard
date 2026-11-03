-- Apply before dashboard PR135 deployment. No PF operational database change.
-- Service-role only: client users cannot read snapshots or acquire refresh locks.
begin;
set local lock_timeout = '3s';
create table public.pf_reporting_refreshes (
  key text primary key,
  payload jsonb,
  completed_at timestamptz,
  lease_owner uuid,
  lease_until timestamptz
);
alter table public.pf_reporting_refreshes enable row level security;
revoke all on public.pf_reporting_refreshes from public, anon, authenticated;
grant select, insert, update on public.pf_reporting_refreshes to service_role;

create function public.claim_pf_reporting_refresh(p_key text, p_owner uuid, p_seconds integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_owner is null or p_key is null or length(p_key) > 120 then raise exception 'invalid refresh key'; end if;
  insert into public.pf_reporting_refreshes(key) values(p_key) on conflict do nothing;
  update public.pf_reporting_refreshes
    set lease_owner = p_owner, lease_until = clock_timestamp() + make_interval(secs => greatest(30, least(300, p_seconds)))
    where key = p_key and (lease_until is null or lease_until <= clock_timestamp());
  return found;
end $$;
create function public.publish_pf_reporting_refresh(p_key text, p_owner uuid, p_payload jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_payload is null then raise exception 'complete payload required'; end if;
  update public.pf_reporting_refreshes set payload = p_payload, completed_at = clock_timestamp()
    where key = p_key and lease_owner = p_owner and lease_until > clock_timestamp();
  return found;
end $$;
create function public.release_pf_reporting_refresh(p_key text, p_owner uuid)
returns void language sql security invoker set search_path = '' as $$
  update public.pf_reporting_refreshes set lease_owner = null, lease_until = null
    where key = p_key and lease_owner = p_owner;
$$;
revoke all on function public.claim_pf_reporting_refresh(text,uuid,integer), public.publish_pf_reporting_refresh(text,uuid,jsonb), public.release_pf_reporting_refresh(text,uuid) from public, anon, authenticated;
grant execute on function public.claim_pf_reporting_refresh(text,uuid,integer), public.publish_pf_reporting_refresh(text,uuid,jsonb), public.release_pf_reporting_refresh(text,uuid) to service_role;
commit;
