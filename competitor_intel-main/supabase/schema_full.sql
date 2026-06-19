-- ============================================================
-- Competitor Intel — Full Schema
-- Apply once in the Supabase SQL Editor.
-- Includes: all tables, indexes, views, RLS, change log,
--           section refresh tracking, rebuild function.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. CORE TABLES
-- ────────────────────────────────────────────────────────────

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
  schema_version integer not null default 1,
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

-- ────────────────────────────────────────────────────────────
-- 2. CHANGE LOG TABLE
-- Tracks new/modified/removed records per section per market
-- ────────────────────────────────────────────────────────────

create table if not exists public.intel_change_log (
  id uuid primary key default gen_random_uuid(),
  market_slug text not null references public.intel_markets(slug),
  section text not null,        -- digest | marketing | products | sentiment | macro
  change_type text not null,    -- added | modified | removed
  record_count_delta integer not null default 0,
  summary text,                 -- human-readable summary of what changed
  run_id uuid references public.intel_ingestion_runs(id) on delete set null,
  detected_at timestamptz not null default now()
);

create index if not exists intel_change_log_market_idx on public.intel_change_log(market_slug, detected_at desc);

-- ────────────────────────────────────────────────────────────
-- 3. SEED MARKET REGISTRY (must come before section_refresh FK)
-- ────────────────────────────────────────────────────────────

insert into public.intel_markets (slug, name, country_code, currency_code)
values
  ('mx', 'Mexico',      'MX', 'MXN'),
  ('br', 'Brazil',      'BR', 'BRL'),
  ('ph', 'Philippines', 'PH', 'PHP'),
  ('id', 'Indonesia',   'ID', 'IDR')
on conflict (slug) do nothing;

-- ────────────────────────────────────────────────────────────
-- 5. SECTION REFRESH CADENCE TABLE
-- Drives freshness badges in the UI
-- ────────────────────────────────────────────────────────────

create table if not exists public.intel_section_refresh (
  market_slug text not null references public.intel_markets(slug),
  section text not null,        -- digest | marketing | products | sentiment | macro
  cadence text not null,        -- daily | weekly | monthly
  cadence_hours integer not null, -- 24 | 168 | 720
  last_refreshed_at timestamptz,
  primary key (market_slug, section)
);

-- Seed default cadences for all 4 markets
insert into public.intel_section_refresh (market_slug, section, cadence, cadence_hours)
values
  ('mx', 'digest',    'daily',   24),
  ('mx', 'marketing', 'weekly',  168),
  ('mx', 'products',  'monthly', 720),
  ('mx', 'sentiment', 'weekly',  168),
  ('mx', 'macro',     'weekly',  168),
  ('br', 'digest',    'daily',   24),
  ('br', 'marketing', 'weekly',  168),
  ('br', 'products',  'monthly', 720),
  ('br', 'sentiment', 'weekly',  168),
  ('br', 'macro',     'weekly',  168),
  ('ph', 'digest',    'daily',   24),
  ('ph', 'marketing', 'weekly',  168),
  ('ph', 'products',  'monthly', 720),
  ('ph', 'sentiment', 'weekly',  168),
  ('ph', 'macro',     'weekly',  168),
  ('id', 'digest',    'daily',   24),
  ('id', 'marketing', 'weekly',  168),
  ('id', 'products',  'monthly', 720),
  ('id', 'sentiment', 'weekly',  168),
  ('id', 'macro',     'weekly',  168)
on conflict (market_slug, section) do nothing;

-- ────────────────────────────────────────────────────────────
-- 4. INDEXES
-- ────────────────────────────────────────────────────────────

create index if not exists intel_news_items_market_date_idx on public.intel_news_items(market_slug, item_date);
create index if not exists intel_ad_examples_company_idx on public.intel_marketing_ad_examples(market_slug, company_slug);
create index if not exists intel_product_specs_company_idx on public.intel_product_specs(market_slug, company_slug);
create index if not exists intel_runs_market_captured_idx on public.intel_ingestion_runs(market_slug, captured_at desc);
create index if not exists intel_snapshots_market_idx on public.intel_dashboard_snapshots(market_slug, created_at desc);

-- ────────────────────────────────────────────────────────────
-- 5. VIEWS
-- ────────────────────────────────────────────────────────────

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

-- Latest snapshot per market (used by frontend)
create or replace view public.intel_latest_snapshots as
select distinct on (market_slug)
  *
from public.intel_dashboard_snapshots
order by market_slug, created_at desc;

-- Recent change log (last 50 entries per market)
create or replace view public.intel_recent_changes as
select *
from public.intel_change_log
order by detected_at desc
limit 200;

-- ────────────────────────────────────────────────────────────
-- 6. ENABLE ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────

alter table public.intel_markets              enable row level security;
alter table public.intel_companies            enable row level security;
alter table public.intel_ingestion_runs       enable row level security;
alter table public.intel_dashboard_snapshots  enable row level security;
alter table public.intel_news_items           enable row level security;
alter table public.intel_upcoming_events      enable row level security;
alter table public.intel_marketing_items_archive enable row level security;
alter table public.intel_marketing_funnels    enable row level security;
alter table public.intel_marketing_channels   enable row level security;
alter table public.intel_marketing_message_pillars enable row level security;
alter table public.intel_marketing_campaigns  enable row level security;
alter table public.intel_marketing_promotions enable row level security;
alter table public.intel_marketing_ad_examples enable row level security;
alter table public.intel_product_specs        enable row level security;
alter table public.intel_sentiment_items      enable row level security;
alter table public.intel_business_stats       enable row level security;
alter table public.intel_macro_snapshots      enable row level security;
alter table public.intel_macro_indicators     enable row level security;
alter table public.intel_macro_series         enable row level security;
alter table public.intel_macro_events         enable row level security;
alter table public.intel_source_links         enable row level security;
alter table public.intel_change_log           enable row level security;
alter table public.intel_section_refresh      enable row level security;

-- ────────────────────────────────────────────────────────────
-- 7. RLS POLICIES — anonymous read-only access
-- ────────────────────────────────────────────────────────────

-- Markets
create policy "anon read markets" on public.intel_markets
  for select to anon using (true);

-- Companies
create policy "anon read companies" on public.intel_companies
  for select to anon using (true);

-- Ingestion runs (metadata only)
create policy "anon read runs" on public.intel_ingestion_runs
  for select to anon using (true);

-- Dashboard snapshots (primary frontend read)
create policy "anon read snapshots" on public.intel_dashboard_snapshots
  for select to anon using (true);

-- News items
create policy "anon read news" on public.intel_news_items
  for select to anon using (true);

-- Upcoming events
create policy "anon read events" on public.intel_upcoming_events
  for select to anon using (true);

-- Marketing archive
create policy "anon read mkt archive" on public.intel_marketing_items_archive
  for select to anon using (true);

-- Marketing funnels
create policy "anon read mkt funnels" on public.intel_marketing_funnels
  for select to anon using (true);

-- Marketing channels
create policy "anon read mkt channels" on public.intel_marketing_channels
  for select to anon using (true);

-- Marketing message pillars
create policy "anon read mkt pillars" on public.intel_marketing_message_pillars
  for select to anon using (true);

-- Marketing campaigns
create policy "anon read mkt campaigns" on public.intel_marketing_campaigns
  for select to anon using (true);

-- Marketing promotions
create policy "anon read mkt promos" on public.intel_marketing_promotions
  for select to anon using (true);

-- Marketing ad examples
create policy "anon read mkt ads" on public.intel_marketing_ad_examples
  for select to anon using (true);

-- Product specs
create policy "anon read products" on public.intel_product_specs
  for select to anon using (true);

-- Sentiment
create policy "anon read sentiment" on public.intel_sentiment_items
  for select to anon using (true);

-- Business stats
create policy "anon read biz stats" on public.intel_business_stats
  for select to anon using (true);

-- Macro snapshots
create policy "anon read macro snapshots" on public.intel_macro_snapshots
  for select to anon using (true);

-- Macro indicators
create policy "anon read macro indicators" on public.intel_macro_indicators
  for select to anon using (true);

-- Macro series
create policy "anon read macro series" on public.intel_macro_series
  for select to anon using (true);

-- Macro events
create policy "anon read macro events" on public.intel_macro_events
  for select to anon using (true);

-- Source links
create policy "anon read source links" on public.intel_source_links
  for select to anon using (true);

-- Change log (read-only for anon)
create policy "anon read change log" on public.intel_change_log
  for select to anon using (true);

-- Section refresh (read-only for anon)
create policy "anon read section refresh" on public.intel_section_refresh
  for select to anon using (true);

-- ────────────────────────────────────────────────────────────
-- 8. ENABLE REALTIME on key tables
-- ────────────────────────────────────────────────────────────

-- Allow the browser to subscribe to snapshot inserts
alter publication supabase_realtime add table public.intel_dashboard_snapshots;
alter publication supabase_realtime add table public.intel_change_log;

-- ────────────────────────────────────────────────────────────
-- 9. HELPER FUNCTION: update section refresh timestamp
-- Called by the importer after each successful section upload
-- ────────────────────────────────────────────────────────────

create or replace function public.mark_section_refreshed(
  p_market_slug text,
  p_section text
)
returns void
language plpgsql
security definer
as $$
begin
  update public.intel_section_refresh
  set last_refreshed_at = now()
  where market_slug = p_market_slug
    and section = p_section;
end;
$$;

