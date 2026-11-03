-- Run only against a disposable database after the reporting migration.
begin;
set local role service_role;
do $$
declare a uuid := '11111111-1111-1111-1111-111111111111'; b uuid := '22222222-2222-2222-2222-222222222222';
begin
  if not public.claim_pf_reporting_refresh('fixture',a,180) then raise exception 'first lease failed'; end if;
  if public.claim_pf_reporting_refresh('fixture',b,180) then raise exception 'second owner acquired live lease'; end if;
  if public.publish_pf_reporting_refresh('fixture',b,'[2]') then raise exception 'nonowner published'; end if;
  if not public.publish_pf_reporting_refresh('fixture',a,'[1]') then raise exception 'owner publish failed'; end if;
  update public.pf_reporting_refreshes set lease_until=clock_timestamp()-interval '1 second' where key='fixture';
  if public.publish_pf_reporting_refresh('fixture',a,'[99]') then raise exception 'expired owner published'; end if;
  if not public.claim_pf_reporting_refresh('fixture',b,180) then raise exception 'expired lease not reclaimed'; end if;
  perform public.release_pf_reporting_refresh('fixture',a);
  if public.claim_pf_reporting_refresh('fixture',a,180) then raise exception 'old owner cleared new lease'; end if;
  perform public.release_pf_reporting_refresh('fixture',b);
  if (select payload from public.pf_reporting_refreshes where key='fixture') <> '[1]'::jsonb then raise exception 'last complete payload lost'; end if;
end $$;
reset role;
do $$
begin
  if has_table_privilege('anon','public.pf_reporting_refreshes','SELECT') or has_table_privilege('authenticated','public.pf_reporting_refreshes','UPDATE') then raise exception 'client table access'; end if;
  if has_function_privilege('anon','public.claim_pf_reporting_refresh(text,uuid,integer)','EXECUTE') or has_function_privilege('authenticated','public.publish_pf_reporting_refresh(text,uuid,jsonb)','EXECUTE') then raise exception 'client RPC access'; end if;
end $$;
rollback;
