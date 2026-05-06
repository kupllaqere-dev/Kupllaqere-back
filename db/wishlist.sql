-- Wishlist table
-- Run this in your Supabase SQL editor

create table if not exists wishlist (
  id        uuid default gen_random_uuid() primary key,
  user_id   uuid not null references profiles(id) on delete cascade,
  item_id   text not null references items(id)    on delete cascade,
  added_at  timestamptz default now(),
  unique (user_id, item_id)
);

-- Optional RLS (enable if you use Supabase auth directly)
-- alter table wishlist enable row level security;
-- create policy "Users manage own wishlist" on wishlist
--   for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
