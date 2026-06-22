// Shared Supabase utilities for fetchers — uses plain fetch (no Realtime/WebSocket)
// Works on any Node version. Fetchers only write data; they never subscribe.
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

// Load .env.local if present (local dev only — CI uses GitHub Secrets)
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../../.env.local');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.trim().split('=');
    if (k && v.length && !process.env[k]) process.env[k] = v.join('=').replace(/^['"]|['"]$/g, '');
  });
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}

const BASE = SUPABASE_URL.replace(/\/$/, '');
const HEADERS = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal'
};

async function restPost(path, body) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`POST ${path} failed (${res.status}): ${detail}`);
  }
}

async function restGet(path) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, { headers: HEADERS });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`GET ${path} failed (${res.status}): ${detail}`);
  }
  return res.json();
}

async function rpc(fnName, params) {
  const res = await fetch(`${BASE}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(params)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`RPC ${fnName} failed (${res.status}): ${detail}`);
  }
}

// Create an ingestion run row and return its UUID
export async function createRun(marketSlug, runType, counts = {}) {
  const id = randomUUID();
  await restPost('intel_ingestion_runs', {
    id,
    market_slug: marketSlug,
    run_type: runType,
    source_file: `scripts/fetchers/${runType}.js`,
    captured_at: new Date().toISOString(),
    status: 'completed',
    raw_counts: counts,
    metadata: { runner: process.env.GITHUB_RUN_ID || 'local' }
  });
  return id;
}

// Mark a section's last_refreshed_at
export async function markSectionRefreshed(marketSlug, section) {
  await rpc('mark_section_refreshed', { p_market_slug: marketSlug, p_section: section });
}

// Rebuild the snapshot for a market (triggers Realtime → browser update)
export async function rebuildSnapshot(marketSlug) {
  await rpc('rebuild_market_payload', { p_market_slug: marketSlug });
}

// Log a change entry
export async function logChange(marketSlug, section, changeType, delta, summary, runId) {
  await restPost('intel_change_log', {
    market_slug: marketSlug,
    section,
    change_type: changeType,
    record_count_delta: delta,
    summary,
    run_id: runId
  });
}

// Insert rows in batches of 250 (PostgREST limit)
export async function batchInsert(table, rows) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 250) {
    const batch = rows.slice(i, i + 250);
    await restPost(table, batch);
  }
}

// Fetch existing headlines/URLs for dedup (last N days)
export async function getRecentHeadlines(marketSlug, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const params = new URLSearchParams({
    select: 'headline,source_url',
    market_slug: `eq.${marketSlug}`,
    created_at: `gte.${since}`
  });
  return restGet(`intel_news_items?${params}`);
}
