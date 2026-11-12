# Riegos24 multi-tenant architecture

## Product decision
- One Riegos24 application and one backend.
- Each customer signs in with an independent Supabase Auth email/password account.
- The installer/technical administrator can view and support every installation.
- Customers can access only installations where they are registered as a member.
- Smart Life remains optional as the device-pairing app; customer credentials for Smart Life are never collected by Riegos24.

## Runtime layout
- Render Node/Express remains the API and Tuya Cloud integration.
- Supabase Auth issues customer access tokens.
- Render validates access tokens against Supabase Auth and performs privileged database writes using the server-only service-role key.
- Supabase Postgres stores installations, membership, Tuya devices, zones, settings, programs, events and runtime state.
- The existing single-installation tables (riegos24_programs, riegos24_config, riegos24_events, riegos24_runtime) are retained unchanged while the new model is rolled out.

## New data model
- r24_user_roles: platform role (technician or customer).
- r24_installations: one physical site / irrigation system.
- r24_installation_members: user-to-installation membership (owner, operator, viewer).
- r24_devices: Tuya device ID assigned to one installation.
- r24_zones: device channels / irrigation zones.
- r24_settings, r24_programs, r24_events, r24_runtime: installation-scoped state.

## Security
- Customer access tokens must be validated server-side.
- Technician role is stored in r24_user_roles, never trusted from editable user metadata.
- RLS is enabled on all new tables. Authenticated users receive read-only SQL privileges and policies scope rows to the user's installation membership; writes and device commands go through the trusted backend.
- Supabase service-role and Tuya credentials must never be sent to the browser.
- Legacy endpoints continue using the existing API_ACCESS_KEY until the multi-user client has been fully migrated. Do not remove the legacy key or old tables during rollout.

## Tuya onboarding constraint
The first implementation stores a Tuya device ID per installation and uses the existing Tuya Cloud project credentials on Render. A device can only be registered after it is visible/authorized in that Tuya Cloud project. This does not automatically link a customer's separate Smart Life account. A formal Smart Life account-linking flow is a later integration step; do not ask customers for their Smart Life passwords.

## Rollout sequence
1. Additive database foundation and tenant RLS.
2. Supabase Auth login, session validation, technician bootstrap, customer invitations.
3. Technician console for creating installations and assigning Tuya device IDs / zones.
4. Customer installation picker and per-installation dashboard.
5. Migrate status, commands, sequential watering, schedules, climate decisions and history to installation-scoped runtime.
6. Validate two independent installations and cross-tenant isolation before production cutover.

## Current milestone
The additive database schema and RLS policies have been applied to the connected Supabase project and recorded in migrations. Existing single-installation tables and Render routes have not been changed by this migration. The current application remains the legacy single-installation client until the auth and multi-installation UI phases are completed.