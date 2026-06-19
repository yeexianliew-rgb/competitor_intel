# Implementation Plan — Competitor Intel → Live Prototype on Supabase + GitHub Pages

_Last updated: 2026-06-09_

## Goal

Turn the single-file static dashboard (`index.html`) into a working prototype that:

1. Is reachable by others via a public URL (**GitHub Pages**).
2. Reads its data from **Supabase** instead of hardcoded JavaScript objects, so updates appear without editing the HTML.
3. Lets the team **add / update entries** in Supabase.
4. Reflects a **per-section refresh cadence**:
   | Section | Cadence |
   |---|---|
   | Daily Digest (news) | Daily |
   | Competitor Feed (products) | Weekly |
   | Marketing Feed (ads) | Weekly |
   | Sentiment | Weekly |
   | Macro | Monthly |

---

## Where we are today

- `index.html` (3,887 lines) is fully self-contained. All data lives in JS objects: `DATA` (Mexico), `MARKET_DATA` (mx + br + ph + id), `mktAds`.
- The green "live" dot and "Last updated" text are **cosmetic** — nothing is fetched.
- A Supabase backend is **designed but not connected**: `supabase/schema.sql` (28 tables + views) and `scripts/import-index-to-supabase.ps1` (extracts the embedded data and uploads it). The importer currently handles **Mexico only**.
- Markets BR / PH / ID exist in the HTML with comparable section coverage, but non-MX markets use simpler "generic" product/macro shapes (`renderGenericProducts`, `renderGenericMacro`).

---

## Architecture decision

```
  Browser (GitHub Pages, static index.html)
        │   fetch (anon key, read-only, RLS-protected)
        ▼
  Supabase Postgres  ──  per-market assembled JSON payload
        ▲
        │   service-role writes (Supabase Table Editor / importer)
   Team edits + (later) automated fetchers
```

**Key design choice:** the existing render functions expect each market to be one nested object (the `DATA` shape). Rather than rebuild that shape from 20+ normalized tables in fragile browser JS, the frontend will fetch **one assembled JSON payload per market**. The reshaping happens once on the backend, so the rendering code stays essentially unchanged.

This is delivered in **two phases** so we get a live demo quickly, then layer on editing + cadence.

---

## Phase A — Get it live (data from Supabase, public URL)

**Outcome:** the real dashboard, served at a public URL, loading all 4 markets from Supabase. Fast to demo.

1. **Create the Supabase project** (you do this; free tier). Apply `supabase/schema.sql` in the SQL editor.
2. **Extend the importer to all 4 markets.** Today it parses `const DATA =` (Mexico) only. Update `scripts/import-index-to-supabase.ps1` (or add a wrapper) to walk every market in `MARKET_DATA` (mx/br/ph/id), handling both the rich MX shape and the generic shape, writing one `intel_dashboard_snapshots` row per market.
3. **Add public read access.** Add row-level-security (RLS) policies: anonymous role can `SELECT` the snapshot + current views; no write access. Writes stay with the service-role key (kept secret).
4. **Refactor the frontend to load from Supabase.** Replace the hardcoded `MARKET_DATA` assignment with an async loader that, on page load, fetches the latest snapshot payload per market via the Supabase REST endpoint using the public **anon key**, then renders as today.
   - **Offline fallback:** keep the embedded data as a fallback if Supabase is unreachable, with a visible "cached / offline" indicator so it's never a blank page during a demo.
5. **Deploy to GitHub Pages.** Enable Pages on the repo (serve the folder containing `index.html`); confirm the public URL loads and pulls live data.

**You provide:** a Supabase project URL, the **anon** (public) key for the frontend, and the **service_role** key (kept local, never committed) for the importer.

---

## Phase B — Editing + cadence

**Outcome:** team edits data in Supabase and it flows to the site; each tab shows accurate freshness against its cadence.

6. **Normalized tables become the source of truth.** The schema already has per-section tables (news, products, ads, sentiment, macro, etc.) that are friendly to edit in the Supabase **Table Editor**.
7. **Add a `rebuild_market_payload(market_slug)` SQL function** that reassembles the per-market JSON payload from the normalized rows into the snapshot the frontend reads. Edit a row → run rebuild → site reflects it. (Can later be a trigger or scheduled job.)
8. **Add a `intel_section_refresh` table** (`market_slug`, `section`, `cadence`, `last_refreshed_at`). Drives the UI.
9. **Per-tab freshness UI.** Replace the single hardcoded "Last updated" with a per-section badge: "Updated 2 days ago · refreshes weekly", and color the live dot green / amber / red based on whether the section is within / approaching / past its cadence window.

**You provide:** nothing new; this builds on Phase A.

---

## Phase C — Automation (future, out of scope for now)

Most sources (news sites, product pages, app-store reviews) have **no clean API**, so live auto-pull is deferred. When we get there, scheduled fetchers (a serverless function or scheduled job) write into the same normalized tables on each section's cadence. Candidate semi-automatable sources: central-bank data (macro), Facebook Ads Library API (marketing, needs an approved token), app-store review scraping (sentiment).

---

## Security notes

- **Anon key is safe to ship in the frontend** _only_ behind read-only RLS — it grants exactly the public read access we define. The **service_role key must never** be committed or exposed in the browser; it stays in `.env.local` (already git-ignored) for the importer.
- All data here is competitive intelligence sourced from public pages — no secrets in the data itself.

---

## Open items for your confirmation

- **A1.** OK to create one shared Supabase project for all 4 markets (vs. one per market)? _Recommended: one project._
- **A2.** GitHub Pages will make the dashboard **publicly reachable by anyone with the URL** (no login). Acceptable for this prototype, or do we need access control? _If access control is needed, that changes the hosting choice._
- **A3.** Keep the embedded data as an offline fallback in Phase A? _Recommended: yes, for demo resilience; remove once stable._
