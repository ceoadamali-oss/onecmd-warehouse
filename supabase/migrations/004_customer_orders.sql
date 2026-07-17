-- Migration: Create customer_orders table for Order Dispatch queue
-- Run in Supabase SQL Editor (atlantictireking / gqapwytzpwpvwahfdeom)

create table if not exists public.customer_orders (
  id text primary key,
  order_number text not null,
  source text not null check (source in ('website', 'square_pos')),
  status text not null check (status in ('pending_shipping', 'shipped', 'cancelled', 'ready_for_pickup', 'picked_up')),
  customer_name text not null,
  shipping_address text,
  shipping_method text,
  tracking_number text,
  items jsonb not null,
  location_id text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row Level Security (RLS)
alter table public.customer_orders enable row level security;

-- Policies for public and service role access
drop policy if exists "customer_orders_public_select" on public.customer_orders;
create policy "customer_orders_public_select"
  on public.customer_orders for select
  using (true);

drop policy if exists "customer_orders_public_insert" on public.customer_orders;
create policy "customer_orders_public_insert"
  on public.customer_orders for insert
  with check (true);

drop policy if exists "customer_orders_public_update" on public.customer_orders;
create policy "customer_orders_public_update"
  on public.customer_orders for update
  using (true);

-- Indexes for status queues
create index if not exists customer_orders_location_status_idx
  on public.customer_orders (location_id, status);
