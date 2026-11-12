drop policy if exists "r24_installations_read_member_or_technician" on public.r24_installations;
create policy "r24_installations_read_member_or_technician" on public.r24_installations
for select to authenticated
using (
  public.r24_is_technician()
  or exists (
    select 1 from public.r24_installation_members m
    where m.installation_id = r24_installations.id
      and m.user_id = (select auth.uid())
  )
);

grant select on public.r24_user_roles, public.r24_installations, public.r24_installation_members,
  public.r24_devices, public.r24_zones, public.r24_settings, public.r24_programs,
  public.r24_events, public.r24_runtime to authenticated;
