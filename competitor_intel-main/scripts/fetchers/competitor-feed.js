// Competitor Feed Fetcher — Product specs + business stats via Claude web extraction
// Cadence: monthly (GitHub Actions cron 0 6 1 * *)

import fetch from 'node-fetch';
import { extractStructured } from '../lib/claude.js';
import { createRun, markSectionRefreshed, rebuildSnapshot, logChange, batchInsert } from '../lib/supabase.js';
import { createHash } from 'crypto';

// ── Competitor product page config ───────────────────────────────────────────

const COMPETITORS = {
  mx: [
    { slug: 'nu',    name: 'Nu Mexico',     url: 'https://nu.com.mx/tarjeta-de-credito/' },
    { slug: 'mp',    name: 'Mercado Pago',  url: 'https://www.mercadopago.com.mx/credits' },
    { slug: 'kueski', name: 'Kueski Pay',   url: 'https://kueskipay.com/' },
    { slug: 'plata', name: 'Plata',         url: 'https://www.plata.com.mx/' },
    { slug: 'klar',  name: 'Klar',          url: 'https://www.klar.mx/' },
    { slug: 'stori', name: 'Stori',         url: 'https://www.storicard.com/' },
  ],
  br: [
    { slug: 'nubank_br',    name: 'Nubank Brazil',      url: 'https://nubank.com.br/cartao-de-credito/' },
    { slug: 'creditas_br',  name: 'Creditas',           url: 'https://www.creditas.com/emprestimo-pessoal/' },
    { slug: 'picpay_br',    name: 'PicPay',             url: 'https://picpay.com/site/para-voce/credito' },
  ],
  ph: [
    { slug: 'gcash_ph',   name: 'GCash',   url: 'https://www.gcash.com/gloans/' },
    { slug: 'maya_ph',    name: 'Maya',    url: 'https://www.maya.ph/maya-credit' },
    { slug: 'billease_ph', name: 'BillEase', url: 'https://billease.ph/' },
  ],
  id: [
    { slug: 'kredivo_id', name: 'Kredivo',  url: 'https://kredivo.com/' },
    { slug: 'akulaku_id', name: 'Akulaku',  url: 'https://www.akulaku.com/' },
    { slug: 'gopay_id',   name: 'GoPay',    url: 'https://www.gojek.com/gopay/' },
  ]
};

const SYSTEM_PROMPT = `You are a fintech product analyst. Extract product specifications from competitor landing pages.
Be precise and factual. Use "N/A" for unavailable fields. Respond only with valid JSON.`;

function buildProductPrompt(competitor, pageText) {
  return `Competitor: ${competitor.name}
Source URL: ${competitor.url}

Extract the product specification from this page content. Focus on credit/lending products.

Return JSON:
{
  "productName": "string",
  "productType": "credit_card|bnpl|personal_loan|savings|other",
  "aprCat": "interest rate or APR range",
  "creditLimit": "credit limit range",
  "tenure": "loan tenure / repayment period",
  "approvalSpeed": "approval time",
  "kycRequirements": "ID requirements",
  "repaymentOptions": "repayment methods",
  "fees": "fees summary",
  "rewards": "rewards or cashback",
  "distribution": "online|app|agent|retail",
  "promise": "main value proposition (one sentence)"
}

Page content (first 3000 chars):
${pageText.slice(0, 3000)}`;
}

async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompetitorIntelBot/1.0)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Strip HTML tags for cleaner Claude input
    return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
               .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
               .replace(/<[^>]+>/g, ' ')
               .replace(/\s{3,}/g, '\n')
               .trim();
  } catch (e) {
    console.warn(`  [fetch] ${url}: ${e.message}`);
    return '';
  }
}

async function getLatestProductSpec(marketSlug, companySlug) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const params = new URLSearchParams({
    select: 'fees,apr_cat,credit_limit,product_name',
    market_slug: `eq.${marketSlug}`,
    company_slug: `eq.${companySlug}`,
    order: 'created_at.desc',
    limit: '1'
  });
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/intel_product_specs?${params}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0] || null;
}

function hasChanged(prev, next) {
  if (!prev) return true;
  return prev.fees !== next.fees ||
         prev.apr_cat !== next.aprCat ||
         prev.credit_limit !== next.creditLimit ||
         prev.product_name !== next.productName;
}

async function processMarket(marketSlug) {
  const competitors = COMPETITORS[marketSlug] || [];
  console.log(`\n=== Competitor Feed: ${marketSlug.toUpperCase()} (${competitors.length} competitors) ===`);

  const runId = await createRun(marketSlug, 'monthly_competitor_feed', {});
  let inserted = 0;
  let changed = 0;

  for (const comp of competitors) {
    console.log(`  Fetching ${comp.name}...`);
    const pageText = await fetchPageText(comp.url);
    if (!pageText) continue;

    let spec;
    try {
      spec = await extractStructured(SYSTEM_PROMPT, buildProductPrompt(comp, pageText));
    } catch (e) {
      console.warn(`  Claude failed for ${comp.name}: ${e.message}`);
      continue;
    }

    const prev = await getLatestProductSpec(marketSlug, comp.slug);
    const isChanged = hasChanged(prev, spec);

    const productId = createHash('sha256').update(`${runId}|${comp.slug}`).digest('hex').slice(0, 32);
    await batchInsert('intel_product_specs', [{
      run_id: runId,
      market_slug: marketSlug,
      product_id: productId,
      company_slug: comp.slug,
      product_name: spec.productName || comp.name,
      product_type: spec.productType || 'other',
      apr_cat: spec.aprCat || null,
      credit_limit: spec.creditLimit || null,
      tenure: spec.tenure || null,
      approval_speed: spec.approvalSpeed || null,
      kyc_requirements: spec.kycRequirements || null,
      repayment_options: spec.repaymentOptions || null,
      fees: spec.fees || null,
      rewards: spec.rewards || null,
      distribution: spec.distribution || null,
      promise: spec.promise || null,
      notes: null,
      raw_payload: spec
    }]);

    inserted++;
    if (isChanged && prev) {
      changed++;
      await logChange(marketSlug, 'products', 'modified', 1,
        `${comp.name}: product spec updated`, runId);
    }
    console.log(`  ${comp.name}: ${isChanged ? 'CHANGED' : 'no change'}`);
  }

  if (inserted > 0) {
    await markSectionRefreshed(marketSlug, 'products');
    await rebuildSnapshot(marketSlug);
    console.log(`  Snapshot rebuilt — ${inserted} specs, ${changed} changes`);
  }
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
