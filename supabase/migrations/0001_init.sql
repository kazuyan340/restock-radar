-- restock-radar: initial schema
-- devices doubles as the "user" row for MVP (anonymous auth = 1 device = 1 identity)

create table public.devices (
  id uuid primary key default gen_random_uuid(),  -- == auth.uid() of the anon session
  web_push_subscription jsonb,
  web_push_subscription_updated_at timestamptz,
  is_premium boolean not null default false,
  premium_product_id text,
  premium_transaction_id text,
  premium_purchased_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table public.watched_items (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  url text not null,
  normalized_url text not null,
  site_type text not null check (site_type in
    ('amazon', 'rakuten', 'yahoo_shopping', 'snkrdunk', 'zozotown', 'generic')),
  product_name text,
  product_image_url text,
  status text not null default 'unknown' check (status in ('in_stock', 'sold_out', 'unknown', 'error')),
  previous_status text,
  last_checked_at timestamptz,
  last_notified_at timestamptz,
  consecutive_error_count int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (device_id, normalized_url)
);

create index watched_items_is_active_idx on public.watched_items (is_active);
create index watched_items_device_id_idx on public.watched_items (device_id);

alter table public.devices enable row level security;
alter table public.watched_items enable row level security;

create policy devices_select_own on public.devices
  for select using (id = auth.uid());
create policy devices_update_own on public.devices
  for update using (id = auth.uid());
create policy devices_insert_own on public.devices
  for insert with check (id = auth.uid());

-- Column-level lockdown: RLS above only restricts *which row* a client can
-- touch, not *which columns*. Without this, any signed-in (even anonymous)
-- client could run `update devices set is_premium = true where id =
-- auth.uid()` directly via the anon key REST API/browser console and get
-- premium for free, bypassing Stripe entirely. Only the push-subscription
-- columns are safe for the client to write; is_premium/premium_* must only
-- ever be written by the stripe-webhook Edge Function, which uses the
-- service_role key (bypasses grants and RLS both).
revoke update on public.devices from anon, authenticated;
grant update (web_push_subscription, web_push_subscription_updated_at, last_seen_at)
  on public.devices to anon, authenticated;

create policy watched_items_select_own on public.watched_items
  for select using (device_id = auth.uid());
create policy watched_items_insert_own on public.watched_items
  for insert with check (device_id = auth.uid());
create policy watched_items_update_own on public.watched_items
  for update using (device_id = auth.uid());
create policy watched_items_delete_own on public.watched_items
  for delete using (device_id = auth.uid());

-- Free tier: max 3 active watched_items unless the device is premium.
-- Enforced server-side (not just client-side) so the anon key can't be used
-- to bypass the limit via a raw REST call. Fires on INSERT and whenever
-- is_active is touched: without the UPDATE case, a client could deactivate
-- an item, insert a replacement, then reactivate the first one to end up
-- with more than 3 active items (INSERT-only triggers never see that last
-- reactivation).
create or replace function public.enforce_item_limit()
returns trigger as $$
declare
  v_premium boolean;
  v_count int;
begin
  if tg_op = 'UPDATE' and new.is_active is not true then
    return new; -- deactivating never needs a limit check
  end if;

  select is_premium into v_premium from public.devices where id = new.device_id;

  if coalesce(v_premium, false) = false then
    select count(*) into v_count
      from public.watched_items
      where device_id = new.device_id and is_active = true and id <> new.id;

    if v_count >= 3 then
      raise exception 'FREE_TIER_LIMIT_REACHED';
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer;

create trigger trg_enforce_item_limit
  before insert or update of is_active on public.watched_items
  for each row execute function public.enforce_item_limit();

-- Notification history: one row per push actually sent, so the client can
-- show "past notifications" (the worker keeps this separate from
-- watched_items.last_notified_at, which only tracks the most recent send).
-- product_name/url are snapshotted at send time since the source item can
-- later be edited or deleted.
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  watched_item_id uuid references public.watched_items(id) on delete set null,
  product_name text,
  url text not null,
  sent_at timestamptz not null default now()
);

create index notifications_device_id_sent_at_idx on public.notifications (device_id, sent_at desc);

alter table public.notifications enable row level security;

-- Read-only for clients. No insert/update/delete policy is defined, so RLS
-- denies those operations by default for anon/authenticated; only the
-- worker (service_role, bypasses RLS) writes rows here.
create policy notifications_select_own on public.notifications
  for select using (device_id = auth.uid());
