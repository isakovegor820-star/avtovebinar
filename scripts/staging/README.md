# Staging acceptance tools

All tools are dry-run/offline by default, use the `ASPB_SYNTHETIC_ONLY_v1` fixture marker, write a PII-free JSON report under the OS temporary directory, and return non-zero on a failed safety or acceptance check.

- `node scripts/staging/smoke.mjs`
- `node scripts/staging/load.mjs --profile=low`
- `node scripts/staging/media-4gib.mjs --verify-stream`
- `node scripts/staging/restore.mjs`
- `node scripts/staging/provider-acceptance.mjs`

Network execution requires both `--execute` and `ASPB_ALLOW_STAGING_ACCEPTANCE=on`. The URL must be HTTPS, contain the staging marker, exactly match `ASPB_STAGING_ALLOWED_HOST`, and contain no query/credentials. Target load additionally requires `ASPB_ALLOW_STAGING_LOAD=on`; provider and restore tools have separate guards. Restore execution remains `blocked_external` until an isolated target connector is reviewed. Notification sends are never part of the default smoke command.

The load tool runs bounded per-actor loops for separate session JSON, public catalog, authenticated author/CRM and HLS groups. Target execution requires an approved synthetic CRM session in `ASPB_STAGING_AUTHOR_CRM_COOKIE` and a same-origin unsigned/protected manifest path in `--hls-path=/...`; an optional `ASPB_STAGING_VIEWER_COOKIE` is used for protected room/HLS reads. Cookie values are validated, used only as request headers and never written to reports. Saturation series still require a separately approved metrics capture and therefore keep the overall result partial.

Reports never include tokens, credentials, request bodies, recipient data, raw target hosts, signed URLs, provider payloads, storage keys, or transcript text. External checks without approvals are `blocked_external`, never `passed`.
