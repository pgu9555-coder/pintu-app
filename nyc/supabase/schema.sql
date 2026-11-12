-- Pintu NYC — Supabase schema.
-- Run once in Supabase: SQL Editor → New query → paste → Run.

create table if not exists public.rooms (
  code        text primary key check (code ~ '^[A-Z0-9]{6}$'),
  name        text not null check (char_length(name) between 1 and 60),
  meet        jsonb,          -- chosen meeting station
  meet_time   jsonb,          -- {date, time} in NYC time; null = leaving now
  bill        jsonb,          -- shared bill for splitting
  created_at  timestamptz not null default now()
);

create table if not exists public.people (
  id          uuid primary key,
  room_code   text not null references public.rooms(code) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  origin      jsonb,          -- {label, lat, lon} or {label, station}
  venmo       text check (venmo is null or char_length(venmo) <= 40),
  created_at  timestamptz not null default now()
);
-- Upgrading an earlier install:
alter table public.rooms add column if not exists meet_time jsonb;

create index if not exists people_room_idx on public.people(room_code);

create table if not exists public.votes (
  room_code   text not null references public.rooms(code) on delete cascade,
  person_id   uuid not null references public.people(id) on delete cascade,
  venue_id    text not null,
  venue       jsonb not null, -- snapshot so everyone sees the same name/details
  vote        smallint not null check (vote in (-1, 1)),
  primary key (person_id, venue_id)
);
create index if not exists votes_room_idx on public.votes(room_code);

-- Rooms work like a shared link: anyone with the 6-character code can read
-- and edit that room, with no sign-in. Rows are only reachable by code.
alter table public.rooms  enable row level security;
alter table public.people enable row level security;
alter table public.votes  enable row level security;

drop policy if exists "rooms open" on public.rooms;
drop policy if exists "people open" on public.people;
drop policy if exists "votes open" on public.votes;
create policy "rooms open"  on public.rooms  for all to anon using (true) with check (true);
create policy "people open" on public.people for all to anon using (true) with check (true);
create policy "votes open"  on public.votes  for all to anon using (true) with check (true);

-- Live updates for everyone in the room.
alter publication supabase_realtime add table public.rooms, public.people, public.votes;
