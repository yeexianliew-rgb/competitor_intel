-- ============================================================
-- rebuild_market_payload(market_slug)
-- Reassembles all normalized tables → one JSON snapshot payload
-- matching the shape the frontend render functions expect.
-- Called manually, by trigger, or by the importer.
-- Apply in Supabase SQL Editor.
-- ============================================================

create or replace function public.rebuild_market_payload(p_market_slug text)
returns void
language plpgsql
security definer
as $$
declare
  v_run_id        uuid;
  v_payload       jsonb;

  -- section pieces
  v_news          jsonb;
  v_events        jsonb;
  v_mkt_old       jsonb;
  v_funnels       jsonb;
  v_product_items jsonb;
  v_sentiment     jsonb;
  v_biz_stats     jsonb;
  v_macro_ind     jsonb;
  v_macro_reg     jsonb;
  v_macro_seas    jsonb;
  v_mkt_ads       jsonb;

  -- latest run per section type (so each section uses its own most recent run)
  v_latest_digest_run   uuid;
  v_latest_macro_run    uuid;
  v_latest_product_run  uuid;
  v_latest_mkt_run      uuid;
  v_latest_sentiment_run uuid;
begin

  -- Resolve the most recent run per section type
  select id into v_latest_digest_run
  from public.intel_ingestion_runs
  where market_slug = p_market_slug
    and run_type in ('daily_digest')
    and status = 'completed'
  order by captured_at desc limit 1;

  select id into v_latest_macro_run
  from public.intel_ingestion_runs
  where market_slug = p_market_slug
    and run_type in ('weekly_macro')
    and status = 'completed'
  order by captured_at desc limit 1;

  select id into v_latest_product_run
  from public.intel_ingestion_runs
  where market_slug = p_market_slug
    and run_type in ('monthly_competitor_feed')
    and status = 'completed'
  order by captured_at desc limit 1;

  select id into v_latest_mkt_run
  from public.intel_ingestion_runs
  where market_slug = p_market_slug
    and run_type in ('weekly_marketing')
    and status = 'completed'
  order by captured_at desc limit 1;

  select id into v_latest_sentiment_run
  from public.intel_ingestion_runs
  where market_slug = p_market_slug
    and run_type in ('weekly_sentiment')
    and status = 'completed'
  order by captured_at desc limit 1;

  -- ── 1. newsItems — last 30 days across all digest runs ────
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',             n.item_id,
      'date',           n.item_date,
      'category',       n.category,
      'competitor',     n.company_slug,
      'headline',       n.headline,
      'whatHappened',   n.what_happened,
      'whyItMatters',   n.why_it_matters,
      'oneLineSummary', n.one_line_summary,
      'sourceUrl',      n.source_url
    ) order by n.item_date desc
  ), '[]'::jsonb)
  into v_news
  from public.intel_news_items n
  where n.market_slug = p_market_slug
    and n.item_date::date >= (current_date - interval '30 days');

  -- ── 2. upcomingEvents ─────────────────────────────────────
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'date',       e.event_date,
      'sortDate',   e.sort_date,
      'title',      e.title,
      'summary',    e.summary,
      'importance', e.importance,
      'type',       e.event_type
    ) order by e.sort_date asc
  ), '[]'::jsonb)
  into v_events
  from public.intel_upcoming_events e
  where e.market_slug = p_market_slug
    and (v_latest_digest_run is null or e.run_id = v_latest_digest_run);

  -- ── 3. marketingItems_old ─────────────────────────────────
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',             a.item_id,
      'competitor',     a.company_slug,
      'dateCaptured',   a.date_captured,
      'channel',        a.channel,
      'adStatus',       a.ad_status,
      'sourceUrl',      a.source_url,
      'landingPageUrl', a.landing_page_url,
      'creativeUrl',    a.creative_url,
      'screenshotUrl',  a.screenshot_url,
      'headline',       a.headline,
      'adCopySummary',  a.ad_copy_summary,
      'hook',           a.hook,
      'promoMechanics', a.promo_mechanics,
      'targetSegment',  a.target_segment,
      'cta',            a.cta,
      'notes',          a.notes
    )
  ), '[]'::jsonb)
  into v_mkt_old
  from public.intel_marketing_items_archive a
  where a.market_slug = p_market_slug
    and (v_latest_mkt_run is null or a.run_id = v_latest_mkt_run);

  -- ── 4. mktFunnels ─────────────────────────────────────────
  select coalesce(
    jsonb_object_agg(
      f.company_slug,
      jsonb_build_object(
        'funnelSummary',      f.funnel_summary,
        'channelImplication', f.channel_implication,
        'prmCounterMove',     f.prm_counter_move,
        'channels', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'name',        ch.name,
              'type',        ch.channel_type,
              'trafficEst',  ch.traffic_est,
              'engagement',  ch.engagement,
              'uxFlow',      ch.ux_flow,
              'spendLevel',  ch.spend_level
            ) order by ch.ordinal
          ), '[]'::jsonb)
          from public.intel_marketing_channels ch
          where ch.run_id = f.run_id and ch.company_slug = f.company_slug
        ),
        'messaging', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'pillar',   mp.pillar,
              'channels', mp.channels,
              'copy',     mp.copy
            ) order by mp.ordinal
          ), '[]'::jsonb)
          from public.intel_marketing_message_pillars mp
          where mp.run_id = f.run_id and mp.company_slug = f.company_slug
        ),
        'prm', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'name',    mc.name,
              'period',  mc.period,
              'channel', mc.channel,
              'hook',    mc.hook,
              'copy',    mc.copy,
              'notes',   mc.notes
            ) order by mc.ordinal
          ), '[]'::jsonb)
          from public.intel_marketing_campaigns mc
          where mc.run_id = f.run_id and mc.company_slug = f.company_slug
        )
      )
    ),
    '{}'::jsonb
  )
  into v_funnels
  from public.intel_marketing_funnels f
  where f.market_slug = p_market_slug
    and (v_latest_mkt_run is null or f.run_id = v_latest_mkt_run);

  -- ── 5. productItems ───────────────────────────────────────
  select coalesce(
    (
      select jsonb_object_agg(company_slug, products)
      from (
        select p.company_slug,
               jsonb_agg(
                 jsonb_build_object(
                   'id',               p.product_id,
                   'productName',      p.product_name,
                   'productType',      p.product_type,
                   'aprCat',           p.apr_cat,
                   'creditLimit',      p.credit_limit,
                   'tenure',           p.tenure,
                   'approvalSpeed',    p.approval_speed,
                   'kycRequirements',  p.kyc_requirements,
                   'repaymentOptions', p.repayment_options,
                   'fees',             p.fees,
                   'rewards',          p.rewards,
                   'distribution',     p.distribution,
                   'promise',          p.promise,
                   'notes',            p.notes
                 )
               ) as products
        from public.intel_product_specs p
        where p.market_slug = p_market_slug
          and (v_latest_product_run is null or p.run_id = v_latest_product_run)
        group by p.company_slug
      ) sub
    ),
    '{}'::jsonb
  )
  into v_product_items;

  -- ── 6. sentimentItems ─────────────────────────────────────
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',         s.item_id,
      'competitor', s.company_slug,
      'score',      s.score,
      'scoreTier',  s.score_tier,
      'sources',    s.sources,
      'complaints', s.complaints,
      'praises',    s.praises,
      'quotes',     s.quotes
    )
  ), '[]'::jsonb)
  into v_sentiment
  from public.intel_sentiment_items s
  where s.market_slug = p_market_slug
    and (v_latest_sentiment_run is null or s.run_id = v_latest_sentiment_run);

  -- ── 7. businessStats ──────────────────────────────────────
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',               b.item_id,
      'competitor',       b.company_slug,
      'users',            b.users,
      'loanOS',           b.loan_os,
      'revenue',          b.revenue,
      'funding',          b.funding,
      'fundingAdvantage', b.funding_advantage,
      'estCAC',           b.est_cac,
      'estPromoBurn',     b.est_promo_burn,
      'npl',              b.npl,
      'monetisation',     b.monetisation,
      'distribution',     b.distribution,
      'ueQuality',        b.ue_quality,
      'ueConfidence',     b.ue_confidence,
      'threatLevel',      b.threat_level,
      'threatWhy',        b.threat_why,
      'implication',      b.implication
    )
  ), '[]'::jsonb)
  into v_biz_stats
  from public.intel_business_stats b
  where b.market_slug = p_market_slug;

  -- ── 8. macroData ──────────────────────────────────────────
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'label', mi.label,
      'value', mi.value,
      'note',  mi.note,
      'color', mi.color
    ) order by mi.ordinal
  ), '[]'::jsonb)
  into v_macro_ind
  from public.intel_macro_indicators mi
  where mi.market_slug = p_market_slug
    and (v_latest_macro_run is null or mi.run_id = v_latest_macro_run);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'date',   me.event_date,
      'event',  me.event,
      'impact', me.impact,
      'note',   me.note
    ) order by me.ordinal
  ), '[]'::jsonb)
  into v_macro_reg
  from public.intel_macro_events me
  where me.market_slug = p_market_slug
    and me.event_group = 'regulatory'
    and (v_latest_macro_run is null or me.run_id = v_latest_macro_run);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'period', me.period,
      'event',  me.event,
      'note',   me.note
    ) order by me.ordinal
  ), '[]'::jsonb)
  into v_macro_seas
  from public.intel_macro_events me
  where me.market_slug = p_market_slug
    and me.event_group = 'seasonal'
    and (v_latest_macro_run is null or me.run_id = v_latest_macro_run);

  -- ── 9. mktAds ─────────────────────────────────────────────
  select coalesce(
    (
      select jsonb_object_agg(
        a.ad_key,
        jsonb_build_object(
          'id',         a.ad_id,
          'format',     a.format,
          'previewUrl', a.preview_url,
          'headlineEs', a.headline_es,
          'adCopyEs',   a.ad_copy_es,
          'adCopyEn',   a.ad_copy_en,
          'ctaEs',      a.cta_es,
          'sourceUrl',  a.source_url,
          'dateSeen',   a.date_seen
        )
      )
      from public.intel_marketing_ad_examples a
      where a.market_slug = p_market_slug
        and (v_latest_mkt_run is null or a.run_id = v_latest_mkt_run)
    ),
    '{}'::jsonb
  )
  into v_mkt_ads;

  -- ── 10. Assemble full payload ──────────────────────────────
  v_payload := jsonb_build_object(
    'newsItems',          v_news,
    'upcomingEvents',     v_events,
    'marketingItems_old', v_mkt_old,
    'mktFunnels',         v_funnels,
    'productItems',       v_product_items,
    'sentimentItems',     v_sentiment,
    'businessStats',      v_biz_stats,
    'macroData',          jsonb_build_object(
                            'indicators', v_macro_ind,
                            'regulatory', v_macro_reg,
                            'seasonal',   v_macro_seas
                          ),
    'mktAds',             v_mkt_ads
  );

  -- ── 11. Create a new ingestion run (type = 'snapshot_rebuild') ──
  v_run_id := gen_random_uuid();

  insert into public.intel_ingestion_runs
    (id, market_slug, run_type, source_file, captured_at, status, raw_counts, metadata)
  values
    (v_run_id, p_market_slug, 'snapshot_rebuild', 'rebuild_market_payload()', now(), 'completed',
     '{}'::jsonb,
     jsonb_build_object('trigger', 'rebuild_market_payload', 'rebuilt_at', now()::text));

  -- ── 12. Insert new snapshot (Realtime fires → frontend updates) ──
  insert into public.intel_dashboard_snapshots
    (run_id, market_slug, payload, schema_version)
  values
    (v_run_id, p_market_slug, v_payload, 1);

  -- ── 13. Update section refresh timestamps ─────────────────
  update public.intel_section_refresh
  set last_refreshed_at = now()
  where market_slug = p_market_slug;

end;
$$;


-- ============================================================
-- TRIGGER: auto-rebuild snapshot when normalized tables change
-- ============================================================

create or replace function public._trigger_rebuild_payload()
returns trigger
language plpgsql
security definer
as $$
declare
  v_market text;
begin
  v_market := coalesce(NEW.market_slug, OLD.market_slug);
  if v_market is not null then
    perform public.rebuild_market_payload(v_market);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_rebuild_on_news      on public.intel_news_items;
drop trigger if exists trg_rebuild_on_events    on public.intel_upcoming_events;
drop trigger if exists trg_rebuild_on_mkt_arch  on public.intel_marketing_items_archive;
drop trigger if exists trg_rebuild_on_funnels   on public.intel_marketing_funnels;
drop trigger if exists trg_rebuild_on_channels  on public.intel_marketing_channels;
drop trigger if exists trg_rebuild_on_pillars   on public.intel_marketing_message_pillars;
drop trigger if exists trg_rebuild_on_campaigns on public.intel_marketing_campaigns;
drop trigger if exists trg_rebuild_on_ads       on public.intel_marketing_ad_examples;
drop trigger if exists trg_rebuild_on_products  on public.intel_product_specs;
drop trigger if exists trg_rebuild_on_sentiment on public.intel_sentiment_items;
drop trigger if exists trg_rebuild_on_bizstats  on public.intel_business_stats;
drop trigger if exists trg_rebuild_on_macro_ind on public.intel_macro_indicators;
drop trigger if exists trg_rebuild_on_macro_evt on public.intel_macro_events;

create trigger trg_rebuild_on_news
  after insert or update or delete on public.intel_news_items
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_events
  after insert or update or delete on public.intel_upcoming_events
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_mkt_arch
  after insert or update or delete on public.intel_marketing_items_archive
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_funnels
  after insert or update or delete on public.intel_marketing_funnels
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_channels
  after insert or update or delete on public.intel_marketing_channels
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_pillars
  after insert or update or delete on public.intel_marketing_message_pillars
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_campaigns
  after insert or update or delete on public.intel_marketing_campaigns
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_ads
  after insert or update or delete on public.intel_marketing_ad_examples
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_products
  after insert or update or delete on public.intel_product_specs
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_sentiment
  after insert or update or delete on public.intel_sentiment_items
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_bizstats
  after insert or update or delete on public.intel_business_stats
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_macro_ind
  after insert or update or delete on public.intel_macro_indicators
  for each row execute function public._trigger_rebuild_payload();

create trigger trg_rebuild_on_macro_evt
  after insert or update or delete on public.intel_macro_events
  for each row execute function public._trigger_rebuild_payload();
