-- Recorded from the live project (kwlifmjwsasywjoriggn) on 2026-08-13.
-- These changes were applied directly to the cloud database; this file keeps
-- the repo in sync with the backend so they are never lost on a rebuild.
-- Everything here is idempotent (safe to run more than once).

-- ── server_time() RPC ────────────────────────────────────────────────────────
-- The app calls supabase.rpc('server_time') to sync device-independent time
-- (a wrong phone clock must not create future-dated reports — see
-- lib/serverTime.ts). Called before login too, so grant to anon as well.
create or replace function public.server_time()
returns timestamp with time zone
language sql
stable
as $$ SELECT now() $$;

grant execute on function public.server_time() to anon, authenticated;

-- ── push_tokens RLS: device re-claim + upsert visibility ────────────────────
-- 1) UPDATE: a device proves ownership by presenting its token string, so any
--    signed-in user may claim/re-claim a token row (e.g. several accounts on
--    one phone, or the "make this app an administrator app" button).
--    WITH CHECK guarantees the row always ends up owned by the caller (or
--    unowned) — it can never be reassigned to a third party.
drop policy if exists push_tokens_update_claim_or_own on push_tokens;
create policy push_tokens_update_claim_or_own
  on push_tokens
  for update
  to authenticated
  using (true)
  with check ((auth.uid() = user_id) or (user_id is null));

-- 2) SELECT: PostgreSQL's INSERT ... ON CONFLICT DO UPDATE first reads the
--    conflicting row; if it is not SELECT-visible the upsert fails with the
--    misleading error
--      "new row violates row-level security policy (USING expression)"
--    Token rows are already world-readable via the anon role
--    (anon_select_push_tokens), so this adds no new exposure — it unblocks
--    upsert-based token claiming for signed-in users.
drop policy if exists push_tokens_select_authenticated on push_tokens;
create policy push_tokens_select_authenticated
  on push_tokens
  for select
  to authenticated
  using (true);
