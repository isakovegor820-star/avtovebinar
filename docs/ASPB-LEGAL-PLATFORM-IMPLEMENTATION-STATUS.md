# АСПБ Legal Platform — статус реализации

Дата: 21 августа 2026 года
Текущий этап: этап 3; DEC-05/DEC-06 зафиксировали рекомендуемый Yandex-based provider contour, S3-compatible media/ffmpeg и Yandex SpeechKit/Foundation Models adapters реализованы fail-closed, production activation заблокирован договорным и staging acceptance

## Требования

| Requirement ID | Статус | Доказательство и граница |
| --- | --- | --- |
| TEN-001 | `verified` | `User`, `Organization`, `OrganizationMembership`, enum/unique constraints; multi-organization integration test и non-empty migration fixture |
| TEN-002 (foundation slice) | `verified` | Server-resolved active tenant, обязательный scope `WebinarSession`, scoped read/write и одинаковый safe 404 для foreign/unknown ID |
| TEN-002 (platform-wide rollout) | `in_progress` | Новые author/CRM/media/analytics/bot/job сущности должны применять тот же обязательный scope в своих этапах; legacy Lead/CRM пока не объявлены tenant API |
| TEN-003 | `verified` | `AdminUser` сохранён отдельно; tenant role не даёт `/admin`; одинаковый email допустим в `users`/`admin_users`; полный admin E2E сохранён |
| TEN-004 | `verified` | Passwordless request/delivery/consume: purpose-bound hash-only token, 20 минут, single-use/replay rejection, 7-day hardened HttpOnly cookie, revoke/select organization и non-enumerating response; integration + browser acceptance |
| TEN-005 | `verified` | Owner-only invitation create/list/revoke/accept, 7-day email/role binding, hash-only single-use token, durable retry/dead-letter outbox, membership reactivation, audit и safe cross-tenant 404; integration + browser acceptance |
| TEN-006 | `verified` | Role/membership/invitation lifecycle атомарно пишет actor, organization, before/after и correlation ID; rejected mutation не пишет audit |
| TEN-007 | `verified` | Last available `ACTIVE HUMAN OWNER` защищён advisory lock и HTTP `409 last_organization_owner`; service race tests и authenticated HTTP acceptance проходят |
| TEN-008 | `verified` | Обязательная platform-admin MFA сохранена; owner TOTP enrollment/confirm/verify/disable реализован. Secret AES-GCM encrypted, enrollment 10 минут, другие sessions отзываются, MFA-pending session не видит tenant data и не проходит protected middleware; integration + 320px browser acceptance |
| AUT-001 | `verified` | Tenant-scoped draft, strict partial/full Zod validation, author UI и integration/browser acceptance |
| AUT-002 | `verified` | `DRAFT/PENDING/NEEDS_INFO/VERIFIED/REJECTED/SUSPENDED`, row lock, role-limited state machine и audit; invalid transitions возвращают 409 |
| AUT-003 | `verified` | Реальный `POST /api/v1/creator/webinars/:id/publish` всегда вызывает `assertAuthorCanPublish` до readiness; прямой API для draft/suspended автора возвращает 403 `author_verification_required`, verified/idempotent publish проходит integration |
| AUT-004 | `verified` | Admin/owner UI+API запрашивают уточнение; author API/UI видит public comment, но не internal reason; integration и admin E2E |
| AUT-005 | `verified` | Public projection только для verified active author/membership; evidence bytes в private storage boundary, MIME+magic-byte+5 МиБ checks, `no-store`/`noindex`, safe cross-tenant 404 |
| WEB-001 | `verified` | `Webinar` отделён от `WebinarSession`; composite tenant FK и `@@unique([webinarId, scheduledAt])`; legacy sessions backfilled; integration подтверждает одинаковый start time для разных Webinar и изоляцию edits |
| WEB-002 | `verified` | Раздельные content/media/transcript/scenario/session enums и server state machine; invalid transition даёт 409, а creator UI показывает пять независимых статусов. Integration + 320px browser acceptance |
| WEB-003 | `verified` | Tenant-scoped legal metadata, tree taxonomy, jurisdiction, audience/level, format/duration, freshness/current-as-of, disclaimer и HTTPS sources; publish validator блокирует неполные данные, creator E2E сохраняет полный набор |
| WEB-004 | `verified` | Slug уникален в tenant; organization advisory lock защищает current/alias namespace; rename атомарно сохраняет старый slug, integration проверяет alias |
| WEB-005 | `verified` | Catalog/sitemap допускают только PUBLIC; UNLISTED открывается только по tenant-qualified direct URL с `noindex`; PRIVATE не открывается по URL и требует grant в room/replay/delivery. Negative integration + browser acceptance |
| WEB-006 | `verified` | Отдельный authenticated preview UI показывает metadata/source/session/synthetic-chat без выдачи себя за live room; exact Lead/registration/event/email counts неизменны в integration и creator E2E |
| WEB-007 | `verified` | Tenant-scoped versioned `ChatScenario`/messages; idempotent duplicate создаёт новый draft, копирует whitelist legal/content/taxonomy/source и последнюю scenario как unapproved version 1, не копирует sessions/registrations/analytics/access grants/media/approval/history. Integration и non-empty legacy fixture проходят |
| WEB-008 | `verified` | Tenant-scoped `supersededByWebinarId`; public detail возвращает заметный status и ссылку только на eligible successor, не раскрывая private target. Alias/supersession integration acceptance |
| WEB-009 | `verified` | Publish→archive выполняется state machine, timestamp и audit без delete; archived detail/catalog/sitemap дают безопасное отсутствие, exact registration/event history counts сохранены integration-тестом |
| WEB-010 | `verified` | Owner-only create/list/revoke; HMAC-only email binding, hash-only single-use token, verified User accept, expiry/purpose/Webinar scope, durable outbox и immediate central room/replay/email/Telegram revoke; safe cross-tenant 404 и browser/integration acceptance |
| SES-001 | `verified` | Session хранит mandatory Webinar relation, UTC `scheduledAt`, IANA timezone, duration, room-open/replay policy; creator API возвращает server-computed state, legacy room contract сохранён |
| SES-002 | `verified` | Strict creator API создаёт bounded `ONCE/DAILY/WEEKLY` schedule и независимые session instances; migration сняла global `scheduledAt` uniqueness, integration проверяет одинаковое время разных Webinar |
| SES-003 | `verified` | `SCHEDULED/ROOM_OPEN/LIVE/REPLAY/CLOSED/CANCELLED` считаются общей server policy; boundary unit tests, creator API и room cancellation acceptance проходят. Cancelled session исключена из room exchange/current access, email reminders и Telegram reminder/live/follow-up |
| SES-004 | `verified` | Перенос/отмена с registered participants без `confirmRegisteredChange` и причины даёт 409 без mutation/audit/outbox; confirmed change атомарно increment-ит version, отзывает stale reminders, пишет audit и durable service notices; integration проверяет exact counts/delivery |
| SES-005 | `verified` | UTC persistence + explicit timezone в API/email; Amsterdam DST tests подтверждают сохранение 09:00 при смене offset, reject nonexistent 02:30 и deterministic earlier instant для repeated hour |
| SES-006 | `verified` | `endsOn` и `maxFutureInstances` ограничивают генерацию; API max 90, DB constraints max 366, generator guard 1000; unit/integration проверяют period/max bounds |
| CAT-001 | `verified` | SQL projection и sitemap требуют published PUBLIC, active organization/user/membership и VERIFIED author; unlisted/private/draft/archived/suspended membership отрицательно проверены |
| CAT-002 | `verified` | Карточка текстом показывает title/author/area/jurisdiction/format/freshness/next date/duration; API integration и 320px E2E |
| CAT-003 | `verified` | Area/specialization/jurisdiction/level/format/date/upcoming/recording filters и sort живут в URL; integration проверяет semantics, E2E — reload/back и narrow layout |
| CAT-004 | `verified` | Поиск по title/description/author/tags и только `PUBLISHED` transcript segments; integration проверяет relevance и отсутствие draft/private контента |
| CAT-005 | `verified` | Transcript hit возвращает безопасный snippet и `startMs`; catalog detail сохраняет разрешённый timestamp |
| CAT-006 | `implemented` | RELEVANCE/UPCOMING/NEWEST/UPDATED реализованы и сохраняются в URL; полный per-sort browser acceptance ещё не выполнен |
| CAT-007 | `in_progress` | Public detail показывает author/program/sources/freshness/access; registration CTA честно disabled до tenant-scoped registration vertical, фиктивного success нет |
| MED-001 | `implemented` | Creator API выдаёт временные signed multipart operations через `PrivateMediaStorageAdapter`; S3-compatible adapter реализует private multipart/ListParts/complete/abort/read, Express не проксирует upload bytes и не раскрывает storage key |
| MED-002 | `verified` | Server checkpoints хранят `partNumber`/ETag, resume выдаёт fresh 15-minute operations только для missing parts; E2E рвёт part 2 и подтверждает upload sequence `[1,2,2]` |
| MED-003 | `verified` | UI до выбора файла показывает 4 ГБ/180 минут; Zod/server повторно валидируют MIME/extension/size, worker — duration |
| MED-004 | `implemented` | S3 media worker скачивает private source, проверяет size/checksum/magic bytes, ffprobe duration/container/codecs/dimensions и возвращает safe failure codes; реальный provider acceptance ещё не выполнен |
| MED-005 | `implemented` | ffmpeg worker создаёт HLS, poster JPEG и private OGG/Opus speech rendition, валидирует manifest и сохраняет metadata; staging provider acceptance ещё не выполнен |
| MED-006 | `verified` | Tenant-scoped status API и creator UI показывают стадию, достоверный progress, update time, polling, retry/cancel/activate actions; browser acceptance проходит |
| MED-007 | `verified` | `MediaJob` durable, claim-owned, dedup по asset/version, bounded attempts, backoff/dead-letter и recoverable renewable lease; integration подтверждает repeat complete = один asset/job, восстановление abandoned RUNNING claim и dead-letter ровно после пяти failed attempts |
| MED-008 | `verified` | Новая загрузка получает следующую version; integration подтверждает, что current READY asset не меняется до explicit activate |
| MED-009 | `verified` | Новый READY MediaAsset подключён к cookie-authorized manifest/segment/poster gateway; manifest URL rewrites скрывают storage keys, Range сохраняет 206. Integration проверяет anonymous/cross-session/revoked/expired safe 404 и legacy fallback |
| MED-010 | `verified` | Cancel до transcoding и retry failed доступны в UI/API и пишут audit; integration проверяет cancel, retry и dead-letter. Delete API намеренно отсутствует |
| TRN-001 | `implemented` | `SpeechToTextAdapter` отделён от domain/API; Yandex SpeechKit async adapter submit/poll/result/delete и Yandex Foundation Models structured adapter покрыты 5 contract tests, включая cleanup после poll failure. Credentials/provider activation и DPA acceptance ещё не выполнены |
| TRN-002 | `in_progress` | Versioned segments хранят `startMs`/`endMs`/speaker/text; editor выбирает timestamp, но seek нового MediaAsset в room зависит от MED-009/ROM-003 |
| TRN-003 | `verified` | `DRAFT/REVIEWED/PUBLISHED`, immutable versions, ровно одна published version; catalog видит только published segments |
| TRN-004 | `verified` | Атомарное редактирование segments с optimistic revision; stale concurrent update даёт `409` и не затирает текст |
| TRN-005 | `verified` | Tenant-only dictionary CRUD изолирован в service/API и передаётся STT/AI adapter; negative cross-tenant tests |
| TRN-006 | `verified` | Durable AI job создаёт title/description/chapter/tag/prepared-question suggestions; каждое принимается, редактируется или отклоняется только человеком |
| TRN-007 | `verified` | Provenance хранит task/provider/model/prompt version/time/input entity revisions/review status без secrets и raw signed URLs |
| TRN-008 | `verified` | AI job не меняет freshness, content status и transcript publication; integration проверяет точные состояния до human acceptance |
| TRN-009 | `verified` | PostgreSQL search vector строится только для published segments; catalog возвращает relevance/snippet/timestamp и не индексирует draft/private |
| TRN-010 | `verified` | Tenant-authorized TXT/VTT export берёт только published version; cross-tenant и absent published version неразличимы |

## Ключевые изменения

- Foundation/backfill: `prisma/migrations/20260820120000_tenant_foundation/migration.sql`, deploy preflight/concurrent-index/postflight checks.
- Passwordless User auth: `prisma/migrations/20260820143000_user_passwordless_auth/migration.sql`, `src/lib/tenancy/userAuth.ts`, `src/lib/tenancy/userAuthEmailOutbox.ts`.
- Invitations: `prisma/migrations/20260820160000_organization_invitations/migration.sql`, `src/lib/tenancy/organizationInvitations.ts`, `src/lib/tenancy/organizationInvitationEmailOutbox.ts`.
- Owner MFA: `prisma/migrations/20260820170000_user_owner_mfa/migration.sql`, `src/lib/tenancy/userMfa.ts`; существующий `src/lib/mfa.ts` использован без смены AdminUser encryption contract.
- Author verification: `prisma/migrations/20260820180000_author_verification/migration.sql`, `src/lib/tenancy/authorVerification.ts`, `src/routes/authorPlatform.ts`, platform-admin routes в `src/routes/admin.ts`.
- Webinar domain/backfill: `prisma/migrations/20260820190000_webinar_domain/migration.sql`, preflight/postflight в `prisma/checks/20260820190000_webinar_domain_*`, `src/lib/tenancy/webinarContent.ts`, `src/routes/creatorWebinars.ts`; старый session helper/seed используют стабильный `webinar_aspb_legacy`.
- Sessions/recurrence: `prisma/migrations/20260820193000_webinar_sessions_recurrence/migration.sql`, deploy checks `prisma/checks/20260820193000_webinar_sessions_recurrence_*`, `src/lib/sessionScheduling.ts`, `src/lib/tenancy/webinarSessions.ts`; versioned durable notices и cancellation guards подключены к email/Telegram/room contours.
- Private Webinar access: `prisma/migrations/20260820200000_private_webinar_access/migration.sql`, deploy checks `prisma/checks/20260820200000_private_webinar_access_*`, `src/lib/tenancy/webinarAccess.ts`, `src/lib/tenancy/webinarAccessInvitationEmailOutbox.ts`; duplicate находится в `src/lib/tenancy/webinarContent.ts`.
- Chat scenario/duplicate: `prisma/migrations/20260820203000_chat_scenario/migration.sql`, deploy checks `prisma/checks/20260820203000_chat_scenario_*`, `src/lib/tenancy/chatScenario.ts`, scenario routes в `src/routes/creatorWebinars.ts`.
- Creator UI/preview: `crisis_premium/creator-webinars.html`, `crisis_premium/js/creator-webinars.js`, `crisis_premium/creator-webinar-preview.html`, отдельные responsive styles, upload/status/transcript/dictionary/AI review states и browser acceptance.
- Public catalog: `src/lib/catalog.ts`, `src/routes/catalog.ts`, `crisis_premium/catalog.html`, `crisis_premium/catalog-webinar.html`, `crisis_premium/js/catalog*.js`; `PUBLIC_CATALOG_ENABLED` отделяет read-only projection от legacy landing.
- Media foundation: [migration](../prisma/migrations/20260821090000_media_pipeline_foundation/migration.sql), [postflight](../prisma/checks/20260821090000_media_pipeline_foundation_postflight.sql), [adapter](../src/lib/mediaStorage.ts), [service](../src/lib/tenancy/mediaPipeline.ts), [routes](../src/routes/creatorMedia.ts); server-checkpointed multipart resume не хранит signed URLs в browser storage, production-safe default provider is `unconfigured`, `test_fake` forbidden outside tests.
- Transcript/AI: migrations [foundation](../prisma/migrations/20260821100000_transcript_foundation/migration.sql) и [enrichment](../prisma/migrations/20260821110000_transcript_enrichment/migration.sql), [STT adapter](../src/lib/speechToText.ts), [AI adapter](../src/lib/contentEnrichment.ts), [transcript service](../src/lib/tenancy/transcripts.ts), [enrichment service](../src/lib/tenancy/transcriptEnrichment.ts), [routes](../src/routes/creatorTranscripts.ts); published search подключён в [catalog](../src/lib/catalog.ts), acceptance — [integration](../tests/integration.test.ts) и [E2E](../tests/e2e/webinar-room.spec.ts).
- Provider hardening: решения [DEC-05](DEC-05-MEDIA-STORAGE-CDN-TRANSCODER.md) и [DEC-06](DEC-06-STT-AI-PROVIDERS.md), migrations [integrity metadata](../prisma/migrations/20260821120000_media_provider_hardening/migration.sql), [speech rendition](../prisma/migrations/20260821121000_media_stt_audio/migration.sql) и [recoverable media leases](../prisma/migrations/20260821122000_media_job_leases/migration.sql), соответствующие pre/postflight checks, [S3/ffmpeg adapter](../src/lib/mediaStorageS3.ts), [SpeechKit adapter](../src/lib/speechToTextYandex.ts), [Foundation Models adapter](../src/lib/contentEnrichmentYandex.ts) и [contract tests](../tests/providerAdapters.test.ts). Все production providers остаются `unconfigured` до credentials/DPA/staging acceptance.
- Authenticated API/UI: `src/routes/platformAuth.ts`, `crisis_premium/platform-access.html`, `crisis_premium/js/platform-access.js`, `crisis_premium/platform-access.css`, `openapi.yml`.
- Author/reviewer UI: `crisis_premium/author-profile.html`, `crisis_premium/js/author-profile.js`, `crisis_premium/admin.html`, `crisis_premium/admin.js`, `crisis_premium/admin-verification.css`.
- Monitoring/retention: `src/lib/health.ts`, `src/lib/metrics.ts`, `src/lib/reminders.ts`, `docs/RETENTION-MATRIX-2026-07-30.md`, `docs/production-runbook.md`.
- Verification: `tests/integration.test.ts`, `tests/e2e/webinar-room.spec.ts`, `tests/tenantMigration.test.ts`, `tests/fixtures/tenant-foundation-legacy-migration.sql`, `tests/healthSafety.test.ts`.

## Compatibility layer

- Stable organization `org_aspb` and non-login system owner remain the default scope for legacy `WebinarSession` create/read paths.
- Registration, room, replay, CRM, email, Telegram and `/admin` contracts remain unchanged; `AdminUser` is not copied into `User` and has no implicit tenant membership.
- `PLATFORM_ACCOUNTS_ENABLED=off`, `PLATFORM_TENANCY_ENFORCEMENT=off`, `CREATOR_DASHBOARD_ENABLED=off` и `PUBLIC_CATALOG_ENABLED=off` remain safe defaults. Disabled platform/creator/catalog routes return safe `404`; enabling accounts does not enable tenant enforcement for unmigrated legacy domains.
- Passwordless and invitation email links are generated only in worker memory; database stores SHA-256 hashes. `EMAIL_MODE=log` cancels rather than pretending delivery.
- Invitation and User auth outboxes run through the existing durable reminders worker and are visible in protected health/Prometheus metrics.
- Author verification таблицы пусты после legacy backfill; данные появляются только в новом flow и полностью скрываются флагом `PLATFORM_ACCOUNTS_ENABLED=off`.
- Каждая legacy session получает один Webinar своей организации. Для АСПБ это стабильный `webinar_aspb_legacy`; исходные session/recording/registration/token/CRM/delivery строки не переписываются и не удаляются.
- Legacy sessions не получают искусственное schedule: exact timestamps сохранены, `scheduleVersion=1`, nullable `scheduleId`; existing reminder history только versioned. До creator switch старый flow продолжает работать через stable Webinar.
- Private access management остаётся скрыт теми же platform/creator flags. Existing public compatibility-Webinar не получает grants и продолжает старую воронку. Raw invitation token создаётся только в worker memory; API list не возвращает email/HMAC.
- Для additive deploy без включения flow допустим fallback HMAC на `ADMIN_COOKIE_SECRET`; до создания первого grant обязателен отдельный стабильный `WEBINAR_ACCESS_HASH_SECRET`.
- Новые ChatScenario rows не создаются backfill-ом: legacy JSON scenario остаётся источником старой комнаты. Creator scenario API и duplicate скрыты `CREATOR_DASHBOARD_ENABLED=off`.
- Catalog не меняет legacy `/api/webinar/current`, registration или room. При выключенном `PUBLIC_CATALOG_ENABLED` ссылка каталога скрыта на legacy landing, routes/sitemap дают 404; UNLISTED compatibility-Webinar не попадает в list/sitemap.
- Media/transcript tables additive и не создают rows для legacy video. Новый upload не переключает `currentMediaAssetId` до READY + explicit activate; старый room/replay gateway остаётся источником до MED-009 switch.
- `MEDIA_UPLOAD_CSP_ORIGINS` разрешает только явные HTTPS origins для direct PUT; production validation отклоняет paths, credentials, localhost и HTTP.

## Quality gate

| Проверка | Результат |
| --- | --- |
| `npx prisma validate` | passed |
| `npx prisma generate` | passed: Prisma Client 6.19.3 |
| Last full baseline at `40209db`: fresh `npm test` migration deploy | passed: all 40 migrations through `20260820193000_webinar_sessions_recurrence` |
| Private access fresh migration/reset | passed: all 41 migrations through `20260820200000_private_webinar_access`; later full gate includes this migration in all 45 |
| `DATABASE_URL=... NODE_ENV=test npx vitest run tests/tenantMigration.test.ts` | passed: 1 test; non-empty legacy counts/relations/tokens/CRM/delivery/AdminUser/audit preserved; sessions attached to compatibility Webinar, session timestamps unchanged, reminder history versioned, schedules empty |
| Webinar preflight/postflight + repeated `npx prisma migrate deploy` | passed on local `schema=test`; no orphan, composite unique index valid/ready, second deploy reports no pending migrations |
| Targeted author integration | passed: strict draft/submit, 5 МиБ limit, MIME signature, review transitions, comment separation, safe projection, cross-tenant read/delete and publish policy |
| Targeted Webinar integration | passed: creator CRUD/source/preview, slug alias, strict forged-tenant rejection, same safe 404 for cross-tenant read/write/source/preview/publish, AUT-003, state machine/idempotency and multi-Webinar session uniqueness |
| Targeted session integration | passed: 2 tests; strict forged-tenant rejection, same safe 404 for list/create/update/cancel, bounded DST recurrence, rejection without side effects, confirmed reschedule/cancel audit + exact durable delivery, cancelled room/email/Telegram exclusion |
| Targeted session/safety/migration | passed: 5 files, 85 tests, including 11 timezone/lifecycle cases |
| Session preflight/postflight + repeated `npx prisma migrate deploy` | passed on local `schema=test`; schedule tenant FK/cancellation/version/index invariants valid, second deploy reports no pending migrations |
| Private access preflight/postflight | passed on local `schema=test`; tenant FK/hash/token/terminal invariants and empty legacy backfill confirmed |
| Targeted private/duplicate integration | passed: 2 tests; owner-only lifecycle, forged/cross-tenant read/write, email binding, single-use/expiry/revoke, central room denial, redacted list, retention and idempotent duplicate/no-history |
| ChatScenario/WEB-007 integration | passed: safe cross-tenant GET/PATCH, forged scope rejection, server-forced synthetic marker, atomic save, idempotent publish, audit, scenario copy as new unapproved draft and no history/registrations/analytics |
| ChatScenario non-empty migration fixture | passed: 1 test; legacy counts/relations/session/reminder/private-access data preserved and new scenario tables empty |
| ChatScenario preflight/postflight | passed via exact SQL on local `schema=test`; tenant FK, synthetic/approval/action constraints and zero orphans confirmed. Prisma history scan remains subject to the File Provider blocker below |
| Creator browser acceptance | passed: 1 Chromium test; 320px owner draft→legal metadata→source→synthetic scenario save/publish→schedule→private invite→preview, private email redacted and side-effect counts unchanged |
| Catalog integration acceptance | passed: 1/59 targeted; flag-off 404, public-only list/sitemap, direct unlisted noindex, safe private/draft/archive 404, exact author membership, filters/search/alias/supersession and archive history preservation |
| Catalog browser acceptance | passed: 1 Chromium test; 320px filters survive URL reload/back, closed records absent, detail/source/status visible, disabled registration is honest, side-effect counts unchanged, no overflow |
| Targeted private browser acceptance | passed: 1 Chromium test; token removed from URL, survives passwordless sign-in only in session memory/storage, single-use accept and 320px no overflow |
| Targeted safety tests | passed: `tests/healthSafety.test.ts`, 6 tests |
| Targeted ESLint | passed for every changed TS/JS/test file |
| `npm run build` | passed for current batch |
| `npm run lint` | passed, full configured scope |
| `npm test` | passed: fresh local `schema=test`, all 48 migrations through `20260821122000_media_job_leases`; 25 files, 256/256 tests. `vitest.config.ts` ограничивает discovery штатным `tests/**/*.test.{js,jsx,ts,tsx}`, чтобы macOS File Provider suffix-copies не запускали dependency tests |
| `npm run css:build` | passed; only non-blocking outdated Browserslist metadata warning |
| `npm run e2e` | passed: fresh 48-migration schema, 19/19 Chromium tests. Creator case проходит interrupted multipart resume, READY/activate, transcript edit/review/publish/export, dictionary, human AI acceptance и 320px layout |
| Real provider adapter contract | passed: `tests/mediaStorageS3.test.ts` + `tests/providerAdapters.test.ts`, 9/9; S3 ListParts pagination/NoSuchUpload recovery, idempotent complete/Head и Range/416 mapping; SpeechKit normalized timestamps/speakers + cleanup после success/poll failure; structured YandexGPT suggestions/model provenance и fail-closed malformed output |
| Local media worker smoke | passed: синтетический MP4 H.264/AAC обработан реальными Homebrew ffprobe/ffmpeg 8.1; получены валидные HLS manifest/segment, JPEG poster и OGG/Opus speech rendition, checksum/codec/duration/dimensions совпали. External S3/CDN acceptance ещё не выполнен |
| Media tenant/idempotency integration | passed: forged scope rejected; cross-tenant и same-tenant unrelated AUTHOR read/part/resume/complete дают safe 404; repeat complete и provider-committed/app-transaction-lost recovery создают ровно один asset/job; abandoned worker lease восстанавливается с claim fencing; READY, explicit version switch, cancel/retry audit и dead-letter на пятой ошибке |
| Transcript/AI/catalog integration | passed: STT job, version conflict, review/publish, tenant dictionary, AI provenance/suggestions/human acceptance, TXT/VTT, published-only search snippet/timestamp и negative cross-tenant/draft/private cases |
| Media/transcript/provider postflight + repeated migrate | passed on local `schema=test`: 48 migrations, both repeats `No pending migrations`; invalid READY/state/segment/review/search-vector/checksum/dimensions, missing speech rendition, stale lease и all cross-tenant link counts = 0 |
| Consolidated creator/catalog interface review | passed manually in accessibility/layout/writing/typography/colors/UI; `better-interface` skill в сессии недоступен. Native keyboard controls, labels/live regions, loading/empty/error/permission/processing states, forced colors и 320px runtime/no overflow проверены |
| OpenAPI YAML parse | passed: OpenAPI 3.0.3, 83 paths; multipart checkpoint/resume, protected manifest/segment/poster/Range, transcript, dictionary, AI suggestions и public search contracts present |
| `npm audit --omit=dev` | not run: execution policy rejected disclosure of dependency metadata to the public npm advisory service; no result is claimed |
| `node scripts/assert-ci-deploy-contract.mjs` | passed |
| `git diff --check` | passed |
| `bash scripts/test-infra-safety.sh` | local macOS runner unavailable: required Linux `flock` is absent; GitHub Linux gate remains mandatory |

## Известные риски

- Legacy CRM `Lead` глобален и не опубликован через tenant API. Перенос в tenant-scoped `CRMContact` выполняется на этапе CRM с one-to-one mapping действующей партнёрской воронки.
- Creator/catalog UI реализованы, но rollout flags остаются выключены; catalog registration CTA намеренно disabled до tenant-scoped registration/access batch этапа 4, поэтому public catalog ещё не готов к production switch.
- `MEDIA_STORAGE_PROVIDER=unconfigured`, `STT_PROVIDER=unconfigured` и `AI_ENRICHMENT_PROVIDER=unconfigured` остаются safe production defaults. DEC-05/DEC-06 зафиксировали технически рекомендуемый Yandex contour, но договор/DPA/no-training/retention, бюджет, credentials и provider acceptance остаются внешними блокерами; test fakes production guard запрещает.
- MED-004/MED-005 и TRN-001 нельзя пометить `verified` без реальных object-storage/ffprobe/HLS/poster/STT provider acceptance; MED-009 correctness verified через application gateway, но CDN/load acceptance ещё не выполнен; TRN-002 ждёт room player seek.
- Ротация effective `WEBINAR_ACCESS_HASH_SECRET` делает ранее созданную email-bound grant-проверку недействительной; secret должен быть отдельным, стабильным и одинаковым на API/worker.
- macOS File Provider периодически воссоздаёт suffix-copy `node_modules 2`; Vitest теперь fail-safe ищет тесты только в tracked `tests/**/*.test.{js,jsx,ts,tsx}`. Зависимый дубль был перемещён в recoverable `/private/tmp/aspb-node-modules-2-quarantine-20260821`; остальные suffix-directories не тронуты как возможные user data.
- После первого reschedule/cancel outbox job нельзя откатывать worker на image до migration `20260820193000`: старый dispatcher не знает новые service-notification types. Схема additive, но application rollback должен оставаться на compatible image.
- Полный production observation одного webinar/reminder/replay/CRM цикла не выполнен локально; rollout flags должны включаться по runbook независимо.
- В старой migration history остаётся документированный schema drift manual GIN/token/id-status indexes и default `telegram_broadcast_recipients.updated_at`; новые migrations его не удаляют и не маскируют.
- Реальный SMTP delivery и внешний deploy требуют production credentials/approval. До SMTP verify используется честный degraded `EMAIL_MODE=log`.
- GitHub deployment environments по последней проверке не содержали обязательные `STAGING_*`/`PRODUCTION_*` SSH secrets; fail-closed workflow остановит внешний deploy до настройки.
- Резервные MFA recovery codes не входят в критерий TEN-008 и пока отсутствуют; потеря authenticator требует контролируемой operator remediation с аудитом.
- Сроки хранения author profile/evidence, private access grants и правила публичного профиля не утверждены юристом/DPO; матрица версии `2026-08-21.5` честно запрещает автоудаление до этого решения.

## Deploy verdict

`ready` для controlled additive schema deploy всех 48 migrations с rollout flags и providers `off/unconfigured`; legacy application path не меняется. Creator/catalog/media/transcript flow нельзя включать в production до DEC-05/DEC-06 legal/budget approval и provider acceptance, отдельного `WEBINAR_ACCESS_HASH_SECRET`, SMTP/worker acceptance и tenant-scoped registration. Внешний deploy остаётся `blocked`: GitHub repository и environments `staging`/`production` не содержат обязательных SSH/storage secrets.

## Следующий минимальный batch

1. Внешняя decision point: утвердить либо отклонить рекомендации DEC-05/DEC-06, DPA/no-training/retention, budget/SLA и secret ownership; никаких ресурсов автоматически не покупать.
2. На approved staging credentials пройти media/STT/AI provider acceptance и только после этого повысить MED-004/MED-005/TRN-001 до `verified`; отдельно выполнить CDN/load acceptance для production-scale MED-009.
3. Этап 4: ROM-003/ROM-006/ROM-007 + TRN-002, затем USR-001–USR-005 и tenant-scoped registration/access path для CAT-007 без подмены действующей партнёрской воронки.
4. После stage-4 gate: tenant-scoped CRM-001–CRM-016, затем CHT-001–CHT-010 и BOT-001–BOT-013 с negative tenant tests для каждого read/write/bulk/export/callback.
