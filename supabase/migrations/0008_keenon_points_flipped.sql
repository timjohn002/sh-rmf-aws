-- Keenon named points upside down: some robots' maps (seen on the S100) report named points with
-- y measured from the top of the map image instead of up from the origin. A per-floor switch,
-- off by default, so nothing changes until an admin turns it on. Run after 0007. Safe to run again.
--
-- Rollback: alter table public.keenon_robot_floors drop column if exists points_flipped;

alter table public.keenon_robot_floors
  add column if not exists points_flipped boolean not null default false;
