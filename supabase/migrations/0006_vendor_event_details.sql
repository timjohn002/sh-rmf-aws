-- Callback log details: which public URL received each callback and what we replied.
-- Run after 0002. Run it before starting a server that includes this change, or
-- logging callbacks fails on the unknown columns.

alter table public.vendor_events
  add column if not exists endpoint        text,    -- e.g. https://host/api/vendors/keenon/webhook (token redacted)
  add column if not exists response_status int,
  add column if not exists response_body   jsonb;
