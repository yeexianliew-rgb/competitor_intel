-- SCredito market intelligence schema
-- Run this once in the Supabase SQL editor before executing scripts/import-index-to-supabase.ps1.

create table if not exists public.intel_markets (
  slug text primary key,
  name text not null,
  country_code text,
  currency_code text,
  created_at timestamptz not null default now()
);

create table if not exists public.intel_companies (
  market_slug text not null references public.intel_markets(slug),
  slug text not null,
  name text not null,
  aliases jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (market_slug, slug)
);

create table if not exists public.intel_ingestion_runs (
  id uuid primary key,
  market_slug text not null references public.intel_markets(slug),
  run_type text not null,
  source_file text,
  captured_at timestamptz not null,
  status text not null default 'completed',
  raw_counts jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.intel_dashboard_snapshots (
  run_id uuid primary key references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.intel_source_links (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  link_key text not null,
  url text not null,
  context text,
  source_table text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (run_id, link_key)
);

create table if not exists public.intel_news_items (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  item_id text not null,
  item_date text,
  category text,
  company_slug text,
  headline text not null,
  one_line_summary text,
  source_url text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, item_id)
);

create table if not exists public.intel_upcoming_events (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  event_key text not null,
  event_date text,
  sort_date date,
  title text not null,
  summary text,
  importance text,
  event_type text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, event_key)
);

create table if not exists public.intel_marketing_items_archive (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  item_id text not null,
  company_slug text,
  date_captured text,
  channel text,
  ad_status text,
  source_url text,
  landing_page_url text,
  creative_url text,
  screenshot_url text,
  headline text,
  ad_copy_summary text,
  hook text,
  promo_mechanics text,
  target_segment text,
  cta text,
  notes text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, item_id)
);

create table if not exists public.intel_marketing_funnels (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  company_slug text not null,
  funnel_summary text,
  channel_implication text,
  prm_counter_move text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, company_slug)
);

create table if not exists public.intel_marketing_channels (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  company_slug text not null,
  ordinal integer not null,
  name text,
  channel_type text,
  traffic_est text,
  engagement text,
  ux_flow text,
  spend_level text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, company_slug, ordinal)
);

create table if not exists public.intel_marketing_message_pillars (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  company_slug text not null,
  ordinal integer not null,
  pillar text,
  channels jsonb not null default '[]'::jsonb,
  copy text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, company_slug, ordinal)
);

create table if not exists public.intel_marketing_campaigns (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  company_slug text not null,
  ordinal integer not null,
  name text,
  period text,
  channel text,
  hook text,
  copy text,
  notes text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, company_slug, ordinal)
);

create table if not exists public.intel_marketing_promotions (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  company_slug text not null,
  ordinal integer not null,
  promotion_type text,
  mechanic text,
  segment text,
  status text,
  period text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, company_slug, ordinal)
);

create table if not exists public.intel_marketing_ad_examples (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  ad_key text not null,
  company_slug text not null,
  section text,
  source_index integer,
  ad_id text,
  format text,
  preview_url text,
  headline_es text,
  ad_copy_es text,
  ad_copy_en text,
  cta_es text,
  source_url text,
  date_seen text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, ad_key)
);

create table if not exists public.intel_product_specs (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  product_id text not null,
  company_slug text not null,
  product_name text,
  product_type text,
  apr_cat text,
  credit_limit text,
  tenure text,
  approval_speed text,
  kyc_requirements text,
  repayment_options text,
  fees text,
  rewards text,
  distribution text,
  promise text,
  notes text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, product_id)
);

create table if not exists public.intel_sentiment_items (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  item_id text not null,
  company_slug text,
  score text,
  score_tier text,
  sources jsonb not null default '[]'::jsonb,
  complaints jsonb not null default '[]'::jsonb,
  praises jsonb not null default '[]'::jsonb,
  quotes jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, item_id)
);

create table if not exists public.intel_business_stats (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  item_id text not null,
  company_slug text,
  users text,
  loan_os text,
  revenue text,
  funding text,
  funding_advantage text,
  est_cac text,
  est_promo_burn text,
  npl text,
  monetisation text,
  distribution text,
  ue_quality text,
  ue_confidence text,
  threat_level text,
  threat_why text,
  implication text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, item_id)
);

create table if not exists public.intel_macro_snapshots (
  run_id uuid primary key references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  raw_payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.intel_macro_indicators (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  ordinal integer not null,
  label text,
  value text,
  note text,
  color text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, ordinal)
);

create table if not exists public.intel_macro_series (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  series_group text not null,
  series_name text not null,
  values_json jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, series_group, series_name)
);

create table if not exists public.intel_macro_events (
  run_id uuid not null references public.intel_ingestion_runs(id) on delete cascade,
  market_slug text not null references public.intel_markets(slug),
  event_group text not null,
  ordinal integer not null,
  event_date text,
  period text,
  event text,
  impact text,
  note text,
  raw_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, event_group, ordinal)
);

create index if not exists intel_news_items_market_date_idx on public.intel_news_items(market_slug, item_date);
create index if not exists intel_ad_examples_company_idx on public.intel_marketing_ad_examples(market_slug, company_slug);
create index if not exists intel_product_specs_company_idx on public.intel_product_specs(market_slug, company_slug);
create index if not exists intel_runs_market_captured_idx on public.intel_ingestion_runs(market_slug, captured_at desc);

create or replace view public.intel_latest_completed_runs as
select distinct on (market_slug, run_type)
  *
from public.intel_ingestion_runs
where status = 'completed'
order by market_slug, run_type, captured_at desc;

create or replace view public.intel_current_news_items as
select n.*
from public.intel_news_items n
join public.intel_latest_completed_runs r
  on r.id = n.run_id
where r.run_type in ('baseline_import', 'daily_digest');

create or replace view public.intel_current_marketing_ad_examples as
select a.*
from public.intel_marketing_ad_examples a
join public.intel_latest_completed_runs r
  on r.id = a.run_id
where r.run_type in ('baseline_import', 'marketing_scan');

create or replace view public.intel_current_product_specs as
select p.*
from public.intel_product_specs p
join public.intel_latest_completed_runs r
  on r.id = p.run_id
where r.run_type in ('baseline_import', 'product_scan');
