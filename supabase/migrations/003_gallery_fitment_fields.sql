-- Gallery fitment knowledge fields for future AI/chatbot use
-- Nullable for backward compatibility with existing published builds

alter table public.gallery_builds
  add column if not exists suspension_setup text,
  add column if not exists suspension_setup_notes text,
  add column if not exists no_rub boolean,
  add column if not exists no_trim boolean,
  add column if not exists minor_rub boolean,
  add column if not exists spacers_required boolean,
  add column if not exists fitment_notes text;

comment on column public.gallery_builds.suspension_setup is
  'Structured suspension: Stock, 2" Level, 3" Lift, Other';
comment on column public.gallery_builds.suspension_setup_notes is
  'Free-text when suspension_setup is Other';
comment on column public.gallery_builds.fitment_notes is
  'Staff notes on clearance, trim, daily driver suitability, etc.';
