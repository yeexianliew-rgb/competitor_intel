-- New tables for marketing signals, sentiment scores, and business stats fetchers
-- Run in Supabase SQL Editor

-- ── intel_business_stats ──────────────────────────────────────────────────────
create table if not exists public.intel_business_stats (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid references public.intel_ingestion_runs(id) on delete cascade,
  market_slug     text not null,
  company_slug    text not null,
  metric_name     text not null,
  metric_value    text not null,
  metric_period   text,
  source_url      text,
  key_highlight   text,
  confidence      text default 'medium',
  raw_payload     jsonb,
  created_at      timestamptz default now()
);

create index if not exists idx_biz_stats_market_company
  on public.intel_business_stats (market_slug, company_slug, created_at desc);

-- ── intel_marketing_signals ───────────────────────────────────────────────────
create table if not exists public.intel_marketing_signals (
  id                   uuid primary key default gen_random_uuid(),
  run_id               uuid references public.intel_ingestion_runs(id) on delete cascade,
  market_slug          text not null,
  company_slug         text not null,
  value_props          text[] default '{}',
  target_audience      text,
  promotions           text[] default '{}',
  messaging_theme      text,
  channel_observation  text default 'unknown',
  ads_found_count      int default 0,
  confidence           text default 'medium',
  raw_payload          jsonb,
  created_at           timestamptz default now()
);

create index if not exists idx_mktg_signals_market_company
  on public.intel_marketing_signals (market_slug, company_slug, created_at desc);

-- ── intel_sentiment_scores ────────────────────────────────────────────────────
create table if not exists public.intel_sentiment_scores (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid references public.intel_ingestion_runs(id) on delete cascade,
  market_slug           text not null,
  company_slug          text not null,
  overall_sentiment     text default 'mixed',
  sentiment_score       numeric(4,2) default 0,
  top_complaints        text[] default '{}',
  top_praise            text[] default '{}',
  top_pain_category     text default 'other',
  nps_signal            text default 'neutral',
  review_count          int default 0,
  representative_bad    text,
  representative_good   text,
  raw_payload           jsonb,
  created_at            timestamptz default now()
);

create index if not exists idx_sentiment_market_company
  on public.intel_sentiment_scores (market_slug, company_slug, created_at desc);

-- ── RLS: allow anon read for dashboard ───────────────────────────────────────
alter table public.intel_business_stats    enable row level security;
alter table public.intel_marketing_signals enable row level security;
alter table public.intel_sentiment_scores  enable row level security;

create policy "anon_read_business_stats"
  on public.intel_business_stats for select to anon using (true);

create policy "anon_read_marketing_signals"
  on public.intel_marketing_signals for select to anon using (true);

create policy "anon_read_sentiment_scores"
  on public.intel_sentiment_scores for select to anon using (true);
