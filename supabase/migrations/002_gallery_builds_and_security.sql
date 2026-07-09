-- Run in Supabase SQL Editor (Pro project: atlantictireking / gqapwytzpwpvwahfdeom)
-- Gallery builds for customer truck installs + storage policies

create table if not exists public.gallery_builds (
  id text primary key,
  store_id text not null default 'moncton',
  image_url text not null,
  image_urls jsonb not null default '[]'::jsonb,
  vehicle_year text default '',
  vehicle_make text default '',
  vehicle_model text default '',
  vehicle_trim text default '',
  wheel_label text default '',
  tire_size text default '',
  lift_kit_brand text default '',
  lift_height text default '',
  caption text default '',
  added_by text default 'Shop team',
  status text not null default 'published' check (status in ('pending', 'published', 'archived')),
  created_at timestamptz not null default now()
);

create index if not exists gallery_builds_store_id_idx on public.gallery_builds (store_id);
create index if not exists gallery_builds_created_at_idx on public.gallery_builds (created_at desc);

alter table public.gallery_builds enable row level security;

drop policy if exists "gallery_public_read" on public.gallery_builds;
create policy "gallery_public_read"
  on public.gallery_builds for select
  using (status = 'published');

drop policy if exists "gallery_anon_insert" on public.gallery_builds;
create policy "gallery_anon_insert"
  on public.gallery_builds for insert to anon
  with check (true);

drop policy if exists "gallery_anon_update" on public.gallery_builds;
create policy "gallery_anon_update"
  on public.gallery_builds for update to anon
  using (true);

-- Optional winter flag for tires (if not already added)
alter table public.tires_catalog
  add column if not exists winter_approved boolean not null default false;

-- Storage buckets (create in Dashboard > Storage if SQL insert fails)
-- product-images (public) — catalog photos
-- gallery-builds (public) — customer build gallery

insert into storage.buckets (id, name, public)
values ('gallery-builds', 'gallery-builds', true)
on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

-- Public read for gallery + product images; writes go through service role API
drop policy if exists "public_read_gallery_builds" on storage.objects;
create policy "public_read_gallery_builds"
  on storage.objects for select
  using (bucket_id in ('gallery-builds', 'product-images'));
