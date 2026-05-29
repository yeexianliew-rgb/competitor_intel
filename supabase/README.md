# Supabase Migration

This folder contains the first-pass backend migration for the current single-file dashboard.

## Files

- `schema.sql` creates the Supabase tables/views.
- `../scripts/import-index-to-supabase.ps1` extracts the embedded `DATA` and `mktAds` objects from `index.html`, normalizes them into table rows, and uploads them through Supabase REST.

## Execution Flow

1. Open the Supabase SQL editor.
2. Run `supabase/schema.sql`.
3. Create a local `.env.local` file in the repo root:

```text
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_LEGACY_SERVICE_ROLE_JWT
```

4. Dry-run locally:

```powershell
.\scripts\import-index-to-supabase.ps1
```

5. Apply to Supabase:

```powershell
.\scripts\import-index-to-supabase.ps1 -Apply
```

The importer creates one immutable `baseline_import` run and attaches every imported row to that `run_id`.

## Access Needed

For the current script, Codex needs:

- Supabase project URL.
- Supabase legacy `service_role` JWT key, not the newer `sb_secret_...` API key.
- The schema in `schema.sql` already applied in the project.

In Supabase, look for the JWT-style `service_role` key under Project Settings -> API. It is much longer than the newer secret key and usually starts with `eyJ...`.

For fully direct schema creation from Codex instead, provide the Supabase Postgres connection URI (`postgresql://...`) and make sure `psql` or a Postgres client is installed on the machine.

Do not commit `.env.local` or any service keys.
