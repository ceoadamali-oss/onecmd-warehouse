-- Add winter_approved flag to tires catalog for 3PMSF / Winter Approved filtering on the website.
-- Run once in Supabase SQL editor before Saturday inventory recount.

alter table tires_catalog
  add column if not exists winter_approved boolean not null default false;

create index if not exists tires_catalog_winter_approved_idx
  on tires_catalog (winter_approved)
  where winter_approved = true;

comment on column tires_catalog.winter_approved is
  'True for dedicated winter tires and 3PMSF-rated all-weather / A/T tires (Veteran, Battlefield, Aquishi, etc.)';
