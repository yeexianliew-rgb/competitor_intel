// Macro Feed Fetcher
// Pulls macro indicators from central bank public APIs and press release RSS feeds.
// Cadence: weekly (GitHub Actions cron 0 5 * * 3)

import fetch from 'node-fetch';
import Parser from 'rss-parser';
import { extractStructured } from '../lib/claude.js';
import { createRun, markSectionRefreshed, rebuildSnapshot, logChange, batchInsert } from '../lib/supabase.js';

const rss = new Parser({ timeout: 15000 });

// ── Market macro config ──────────────────────────────────────────────────────

const MARKETS = {
  mx: {
    name: 'Mexico',
    currency: 'MXN',
    indicators: async () => fetchBanxico(),
    pressRss: 'https://news.google.com/rss/search?q=CNBV+OR+Banxico+regulacion+fintech+mexico&hl=es-419&gl=MX&ceid=MX:es-419',
    eventContext: 'Mexico consumer credit market. CNBV regulates fintechs, Banxico sets monetary policy.'
  },
  br: {
    name: 'Brazil',
    currency: 'BRL',
    indicators: async () => fetchBacen(),
    pressRss: 'https://www.bcb.gov.br/api/feed/pt-br/noticias/rss',
    eventContext: 'Brazil consumer credit market. BCB/BACEN regulates open finance, PIX, fintechs.'
  },
  ph: {
    name: 'Philippines',
    currency: 'PHP',
    indicators: async () => fetchBSP(),
    pressRss: 'https://news.google.com/rss/search?q=BSP+bangko+sentral+fintech+philippines&hl=en-PH&gl=PH&ceid=PH:en',
    eventContext: 'Philippines consumer credit market. BSP regulates e-money, digital banks, lending.'
  },
  id: {
    name: 'Indonesia',
    currency: 'IDR',
    indicators: async () => fetchBI(),
    pressRss: 'https://news.google.com/rss/search?q=OJK+bank+indonesia+fintech+kredit&hl=id&gl=ID&ceid=ID:id',
    eventContext: 'Indonesia consumer credit market. OJK regulates P2P lending, e-money. BI sets BI rate.'
  }
};

// ── Central bank API fetchers ────────────────────────────────────────────────

async function fetchBanxico() {
  // Banxico public API — policy rate (SF61745) and CPI (SP68257)
  const indicators = [];
  try {
    const seriesIds = ['SF61745', 'SP30578', 'SP68257']; // rate, credit growth, CPI
    const labels = ['Policy Rate (Banxico)', 'Consumer Credit Growth YoY', 'CPI Inflation YoY'];
    for (let i = 0; i < seriesIds.length; i++) {
      try {
        const url = `https://www.banxico.org.mx/SieAPIRest/service/v1/series/${seriesIds[i]}/datos/oportuno?token=none`;
        const res = await fetch(url, { headers: { 'Bmx-Token': process.env.BANXICO_TOKEN || 'none' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const dato = json?.bmx?.series?.[0]?.datos?.[0];
        if (dato) {
          indicators.push({ label: labels[i], value: dato.dato + '%', note: `As of ${dato.fecha}`, color: 'blue', ordinal: i });
        }
      } catch (e) {
        console.warn(`  [Banxico] ${labels[i]}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`  [Banxico] fetch error: ${e.message}`);
  }

  // Fallback: if API unavailable, return placeholder with note
  if (!indicators.length) {
    indicators.push({ label: 'Policy Rate (Banxico)', value: 'See banxico.org.mx', note: 'API unavailable — check manually', color: 'gray', ordinal: 0 });
  }
  return indicators;
}

async function fetchBacen() {
  const indicators = [];
  try {
    // BACEN public SGS API — Selic (11), IPCA (13522), credit volume (20541)
    const series = [
      { id: 11,    label: 'Selic Rate (%)',       color: 'blue' },
      { id: 13522, label: 'IPCA Inflation YoY (%)', color: 'red' },
      { id: 20541, label: 'Credit/GDP Ratio (%)',   color: 'green' }
    ];
    for (let i = 0; i < series.length; i++) {
      try {
        const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${series[i].id}/dados/ultimos/1?formato=json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const latest = json?.[0];
        if (latest) {
          indicators.push({ label: series[i].label, value: latest.valor + '%', note: `As of ${latest.data}`, color: series[i].color, ordinal: i });
        }
      } catch (e) {
        console.warn(`  [BACEN] ${series[i].label}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`  [BACEN] fetch error: ${e.message}`);
  }
  if (!indicators.length) {
    indicators.push({ label: 'Selic Rate', value: 'See bcb.gov.br', note: 'API unavailable', color: 'gray', ordinal: 0 });
  }
  return indicators;
}

async function fetchBSP() {
  // BSP does not have a machine-readable API — use Google News for now
  return [{ label: 'BSP Policy Rate', value: 'See bsp.gov.ph', note: 'No public API — update manually', color: 'gray', ordinal: 0 }];
}

async function fetchBI() {
  // Bank Indonesia does not have a machine-readable API
  return [{ label: 'BI Rate', value: 'See bi.go.id', note: 'No public API — update manually', color: 'gray', ordinal: 0 }];
}

// ── Claude: extract regulatory events from press releases ───────────────────

const SYSTEM_PROMPT = `You are a fintech competitive intelligence analyst.
Extract regulatory and macroeconomic events that affect consumer credit and digital payments.
Respond only with valid JSON.`;

async function extractRegulatoryEvents(marketConfig, articles) {
  if (!articles.length) return [];
  const prompt = `Market context: ${marketConfig.eventContext}
Today: ${new Date().toISOString().split('T')[0]}

Review these press releases/news items and extract regulatory events relevant to consumer credit, fintech licensing, interest rate changes, open banking, or payment system rules.
Skip general economic news unrelated to fintech/credit.

Return JSON:
{
  "events": [
    {
      "date": "YYYY-MM-DD",
      "event": "short description of the regulatory event",
      "impact": "positive|negative|neutral",
      "note": "one-sentence implication for a fintech credit provider"
    }
  ]
}

Articles:
${articles.slice(0, 20).map((a, i) => `${i + 1}. ${a.title} | ${a.date}`).join('\n')}`;

  try {
    const result = await extractStructured(SYSTEM_PROMPT, prompt);
    return result.events || [];
  } catch (e) {
    console.warn(`  Claude event extraction failed: ${e.message}`);
    return [];
  }
}

// ── Main per-market logic ────────────────────────────────────────────────────

async function processMarket(marketSlug) {
  const market = MARKETS[marketSlug];
  console.log(`\n=== Macro Feed: ${market.name} ===`);

  // 1. Fetch macro indicators from central bank API
  const indicators = await market.indicators();
  console.log(`  Indicators fetched: ${indicators.length}`);

  // 2. Fetch press release RSS for regulatory events
  let articles = [];
  try {
    const parsed = await rss.parseURL(market.pressRss);
    articles = (parsed.items || []).slice(0, 15).map(item => ({
      title: item.title || '',
      url: item.link || '',
      date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
    }));
    console.log(`  Press releases fetched: ${articles.length}`);
  } catch (e) {
    console.warn(`  RSS fetch failed: ${e.message}`);
  }

  // 3. Extract regulatory events via Claude
  const events = await extractRegulatoryEvents(market, articles);
  console.log(`  Regulatory events extracted: ${events.length}`);

  // 4. Create ingestion run
  const runId = await createRun(marketSlug, 'weekly_macro', {
    indicators: indicators.length,
    regulatoryEvents: events.length
  });

  // 5. Insert macro indicators
  if (indicators.length) {
    const indRows = indicators.map((ind, i) => ({
      run_id: runId,
      market_slug: marketSlug,
      ordinal: ind.ordinal ?? i,
      label: ind.label,
      value: ind.value,
      note: ind.note || null,
      color: ind.color || 'blue',
      raw_payload: ind
    }));
    await batchInsert('intel_macro_indicators', indRows);
    console.log(`  Inserted ${indRows.length} macro indicators`);
  }

  // 6. Insert regulatory events
  if (events.length) {
    const evtRows = events.map((evt, i) => ({
      run_id: runId,
      market_slug: marketSlug,
      event_group: 'regulatory',
      ordinal: i,
      event_date: evt.date || null,
      period: null,
      event: evt.event,
      impact: evt.impact || 'neutral',
      note: evt.note || null,
      raw_payload: evt
    }));
    await batchInsert('intel_macro_events', evtRows);
    console.log(`  Inserted ${evtRows.length} regulatory events`);
  }

  // 7. Log change + refresh + rebuild
  await logChange(marketSlug, 'macro', 'modified', indicators.length + events.length,
    `Macro update: ${indicators.length} indicators, ${events.length} regulatory events`, runId);
  await markSectionRefreshed(marketSlug, 'macro');
  await rebuildSnapshot(marketSlug);
  console.log(`  Snapshot rebuilt for ${marketSlug}`);
}

async function main() {
  const markets = process.env.MARKETS ? process.env.MARKETS.split(',') : ['mx', 'br', 'ph', 'id'];
  let failed = 0;
  for (const slug of markets) {
    try {
      await processMarket(slug);
    } catch (e) {
      console.error(`ERROR processing ${slug}: ${e.message}`);
      failed++;
    }
  }
  if (failed) process.exit(1);
}

main();
