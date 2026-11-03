-- Elevators (lifts) driven through Owlsome Tech's LiftMind D Mode API (MQTT over TLS).
-- One shared LiftMind connection; each lift lists the app floors it serves (with LiftMind's own
-- floor names) and the LiftMind robots allowed to use it. Run after 0006. Safe to run again.

-- ---------------------------------------------------------------------------
-- LiftMind connection (a single row). `password` never leaves the server.
-- ---------------------------------------------------------------------------
create table if not exists public.liftmind_connection (
  id                boolean primary key default true check (id),
  enabled           boolean not null default true,
  mqtt_host         text not null default '',
  mqtt_port         int  not null default 8883 check (mqtt_port between 1 and 65535),
  use_tls           boolean not null default true,
  ca_cert           text,                        -- PEM; the CA that signed the MQTT server's certificate
  client_id_prefix  text not null default '',    -- vendor-specific prefix from Owlsome Tech
  manufacturer_id   text not null default '',
  username          text not null default '',
  password          text not null default '',
  updated_at        timestamptz not null default now()
);

alter table public.liftmind_connection enable row level security;

drop trigger if exists liftmind_connection_set_updated_at on public.liftmind_connection;
create trigger liftmind_connection_set_updated_at
  before update on public.liftmind_connection
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Lifts, the floors they serve and the LiftMind robots allowed to use them
-- ---------------------------------------------------------------------------
create table if not exists public.elevators (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(trim(name)) > 0),
  elevator_uuid  text not null unique,           -- LiftMind elevator id, e.g. lc-…
  lobby_uuid     text,                           -- optional LiftMind lobby id
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.elevators enable row level security;

drop trigger if exists elevators_set_updated_at on public.elevators;
create trigger elevators_set_updated_at
  before update on public.elevators
  for each row execute function public.set_updated_at();

create table if not exists public.elevator_floors (
  elevator_id     uuid not null references public.elevators (id) on delete cascade,
  floor_id        uuid not null references public.floors (id) on delete cascade,
  liftmind_floor  text not null check (length(trim(liftmind_floor)) > 0),   -- e.g. 1F, B1F, G
  primary key (elevator_id, floor_id),
  unique (elevator_id, liftmind_floor)
);

alter table public.elevator_floors enable row level security;

create table if not exists public.elevator_robots (
  elevator_id        uuid not null references public.elevators (id) on delete cascade,
  liftmind_robot_id  text not null,                                         -- e.g. rb-…
  robot_id           uuid references public.robots (id) on delete set null, -- optional app robot
  primary key (elevator_id, liftmind_robot_id)
);

alter table public.elevator_robots enable row level security;
