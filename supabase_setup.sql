-- Road Analysis App — Supabase setup
-- Run this once in: Supabase Dashboard → SQL Editor → New Query → Run

-- Stores one row per road segment (key = OSM way id or grid cell id)
create table if not exists segments (
  key  text primary key,
  data jsonb not null
);

-- Stores one row per filed report
create table if not exists reports (
  id   text primary key,
  data jsonb not null
);

-- Allow public read/write via the anon key (the server is the only writer)
-- If you want stricter security, use service_role key instead of anon key.
alter table segments enable row level security;
alter table reports  enable row level security;

create policy "allow all segments" on segments for all using (true) with check (true);
create policy "allow all reports"  on reports  for all using (true) with check (true);
