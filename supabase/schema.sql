-- RipeBy live data: tables and access rules for Supabase.
-- Paste all of this into Supabase > SQL Editor > New query and press Run. Running it again is safe.
-- The UID in the three "sensor write" lines is the RipeBy sensor account's User UID
-- (Authentication > Users). If you make a new sensor account, put its UID there instead.
--
-- Anyone may read pods and readings (the dashboard is public).
-- Only the sensor account may write them. Everything else is closed.

-- One row per pod: what is in it and when it was loaded.
create table if not exists public.pods (
  id          text primary key,                -- 'POD-1'
  fruit       text,                            -- 'banana'
  sensor      text,                            -- 'DGS2' or 'FAKE'
  serial      text,                            -- DGS2 serial number
  load_t      bigint,                          -- epoch ms the produce went in; null = not marked
  started_at  bigint,                          -- epoch ms the bridge started
  bridge      text,
  updated_at  timestamptz not null default now()
);

-- One row per 5-second average sent by the bridge.
create table if not exists public.readings (
  id    bigint generated always as identity primary key,
  pod   text   not null references public.pods (id) on delete cascade,
  t     bigint not null check (t > 1600000000000),   -- epoch ms
  ppb   real   not null,
  temp  real   not null,                             -- deg C
  rh    real,                                        -- % relative humidity
  n     smallint                                     -- readings in the average
);
create index if not exists readings_pod_t on public.readings (pod, t);

-- Access rules (row level security)
alter table public.pods     enable row level security;
alter table public.readings enable row level security;

drop policy if exists "public read"  on public.pods;
drop policy if exists "public read"  on public.readings;
drop policy if exists "sensor write" on public.pods;
drop policy if exists "sensor write" on public.readings;

create policy "public read" on public.pods     for select using (true);
create policy "public read" on public.readings for select using (true);

create policy "sensor write" on public.pods for all to authenticated
  using      (auth.uid() = '0b85acb1-f091-4acd-b2a7-4854121e5a18'::uuid)
  with check (auth.uid() = '0b85acb1-f091-4acd-b2a7-4854121e5a18'::uuid);

create policy "sensor write" on public.readings for insert to authenticated
  with check (auth.uid() = '0b85acb1-f091-4acd-b2a7-4854121e5a18'::uuid);

grant select on public.pods, public.readings to anon, authenticated;
grant insert, update on public.pods to authenticated;
grant insert on public.readings to authenticated;

-- Push new rows to open dashboards as they arrive
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'readings') then
    alter publication supabase_realtime add table public.readings;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'pods') then
    alter publication supabase_realtime add table public.pods;
  end if;
end $$;
