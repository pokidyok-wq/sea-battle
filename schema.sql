-- Run this once in the Supabase dashboard → SQL Editor → New query → Run.
-- It creates the single table the game uses and opens it up for the anon
-- key (minimal-effort: no auth, permissive RLS).

create table if not exists public.games (
  code        text primary key,
  state       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- Row-Level Security on, with permissive policies so the public anon key
-- can create/join/play. (No accounts in this minimal version.)
alter table public.games enable row level security;

drop policy if exists "anon read games"   on public.games;
drop policy if exists "anon insert games" on public.games;
drop policy if exists "anon update games" on public.games;

create policy "anon read games"   on public.games for select using (true);
create policy "anon insert games" on public.games for insert with check (true);
create policy "anon update games" on public.games for update using (true) with check (true);

-- Enable Realtime so both players get live updates on the row.
alter publication supabase_realtime add table public.games;
