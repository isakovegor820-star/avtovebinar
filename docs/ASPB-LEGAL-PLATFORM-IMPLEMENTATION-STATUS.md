# АСПБ Legal Platform — статус реализации

Дата: 20 августа 2026 года
Текущий этап: этап 2, Webinar domain; backend batch WEB-001–WEB-004 и AUT-003 прошёл gate, кабинет/sessions/private access продолжаются

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
| WEB-002 | `in_progress` | Раздельные content/media/transcript/scenario/session enums и server state machine реализованы; invalid transition даёт 409. Базовый кабинет с раздельным отображением статусов ещё не завершён |
| WEB-003 | `implemented` | Tenant-scoped legal metadata, tree taxonomy, jurisdiction, audience/level, format/duration, freshness/current-as-of, disclaimer и HTTPS sources; publish validator блокирует неполные данные. UI acceptance ожидает кабинет |
| WEB-004 | `verified` | Slug уникален в tenant; organization advisory lock защищает current/alias namespace; rename атомарно сохраняет старый slug, integration проверяет alias |
| WEB-005 | `in_progress` | `public/unlisted/private` сохранены в домене; catalog exclusion и private access-grant enforcement входят в следующие batches |
| WEB-006 | `in_progress` | Authenticated tenant preview API не создаёт Lead/registration/event/email state, что подтверждено counts; room preview UI ещё не завершён |
| WEB-007 | `not_started` | Duplicate draft с разрешёнными данными и сценарием без analytics/registrations — следующий batch |
| WEB-008 | `in_progress` | Tenant-scoped `supersededByWebinarId` и validation реализованы; публичное уведомление/ссылка появятся вместе с catalog page |
| WEB-009 | `implemented` | Publish→archive выполняется state machine, timestamp и audit без delete; acceptance сохранения CRM/analytics будет добавлен с catalog/CRM data path |
| WEB-010 | `not_started` | Private invite/access-grant lifecycle ещё не реализован |
| SES-001 | `in_progress` | Session теперь хранит mandatory Webinar relation, timezone и отдельный lifecycle; legacy room status compatibility сохранён |
| SES-002–SES-006 | `not_started` | Creator session CRUD, bounded recurrence, DST tests и notification-confirmed reschedule/cancel — следующий batch |

## Ключевые изменения

- Foundation/backfill: `prisma/migrations/20260820120000_tenant_foundation/migration.sql`, deploy preflight/concurrent-index/postflight checks.
- Passwordless User auth: `prisma/migrations/20260820143000_user_passwordless_auth/migration.sql`, `src/lib/tenancy/userAuth.ts`, `src/lib/tenancy/userAuthEmailOutbox.ts`.
- Invitations: `prisma/migrations/20260820160000_organization_invitations/migration.sql`, `src/lib/tenancy/organizationInvitations.ts`, `src/lib/tenancy/organizationInvitationEmailOutbox.ts`.
- Owner MFA: `prisma/migrations/20260820170000_user_owner_mfa/migration.sql`, `src/lib/tenancy/userMfa.ts`; существующий `src/lib/mfa.ts` использован без смены AdminUser encryption contract.
- Author verification: `prisma/migrations/20260820180000_author_verification/migration.sql`, `src/lib/tenancy/authorVerification.ts`, `src/routes/authorPlatform.ts`, platform-admin routes в `src/routes/admin.ts`.
- Webinar domain/backfill: `prisma/migrations/20260820190000_webinar_domain/migration.sql`, preflight/postflight в `prisma/checks/20260820190000_webinar_domain_*`, `src/lib/tenancy/webinarContent.ts`, `src/routes/creatorWebinars.ts`; старый session helper/seed используют стабильный `webinar_aspb_legacy`.
- Authenticated API/UI: `src/routes/platformAuth.ts`, `crisis_premium/platform-access.html`, `crisis_premium/js/platform-access.js`, `crisis_premium/platform-access.css`, `openapi.yml`.
- Author/reviewer UI: `crisis_premium/author-profile.html`, `crisis_premium/js/author-profile.js`, `crisis_premium/admin.html`, `crisis_premium/admin.js`, `crisis_premium/admin-verification.css`.
- Monitoring/retention: `src/lib/health.ts`, `src/lib/metrics.ts`, `src/lib/reminders.ts`, `docs/RETENTION-MATRIX-2026-07-30.md`, `docs/production-runbook.md`.
- Verification: `tests/integration.test.ts`, `tests/e2e/webinar-room.spec.ts`, `tests/tenantMigration.test.ts`, `tests/fixtures/tenant-foundation-legacy-migration.sql`, `tests/healthSafety.test.ts`.

## Compatibility layer

- Stable organization `org_aspb` and non-login system owner remain the default scope for legacy `WebinarSession` create/read paths.
- Registration, room, replay, CRM, email, Telegram and `/admin` contracts remain unchanged; `AdminUser` is not copied into `User` and has no implicit tenant membership.
- `PLATFORM_ACCOUNTS_ENABLED=off`, `PLATFORM_TENANCY_ENFORCEMENT=off` and `CREATOR_DASHBOARD_ENABLED=off` remain safe defaults. Disabled platform/creator routes return safe `404`; enabling accounts does not enable tenant enforcement for unmigrated legacy domains.
- Passwordless and invitation email links are generated only in worker memory; database stores SHA-256 hashes. `EMAIL_MODE=log` cancels rather than pretending delivery.
- Invitation and User auth outboxes run through the existing durable reminders worker and are visible in protected health/Prometheus metrics.
- Author verification таблицы пусты после legacy backfill; данные появляются только в новом flow и полностью скрываются флагом `PLATFORM_ACCOUNTS_ENABLED=off`.
- Каждая legacy session получает один Webinar своей организации. Для АСПБ это стабильный `webinar_aspb_legacy`; исходные session/recording/registration/token/CRM/delivery строки не переписываются и не удаляются.

## Quality gate

| Проверка | Результат |
| --- | --- |
| `npx prisma validate` | passed |
| `npx prisma generate` | passed: Prisma Client 6.19.3 |
| Fresh `npm test` migration deploy | passed: all migrations through `20260820190000_webinar_domain` |
| `DATABASE_URL=... NODE_ENV=test npx vitest run tests/tenantMigration.test.ts` | passed: 1 test; non-empty legacy counts/relations/tokens/CRM/delivery/AdminUser/audit preserved; sessions attached to compatibility Webinar without orphans |
| Webinar preflight/postflight + repeated `npx prisma migrate deploy` | passed on local `schema=test`; no orphan, composite unique index valid/ready, second deploy reports no pending migrations |
| Targeted author integration | passed: strict draft/submit, 5 МиБ limit, MIME signature, review transitions, comment separation, safe projection, cross-tenant read/delete and publish policy |
| Targeted Webinar integration | passed: creator CRUD/source/preview, slug alias, strict forged-tenant rejection, same safe 404 for cross-tenant read/write/source/preview/publish, AUT-003, state machine/idempotency and multi-Webinar session uniqueness |
| Targeted safety/migration | passed: 3 files, 11 tests |
| `npm run lint` | passed |
| `npm run build` | passed |
| `npm test` | passed: 22 files, 222 tests |
| `npm run e2e` | passed: 16 Chromium tests; author 320px flow and platform-admin MFA/review included |
| Consolidated interface review | passed in six domains: labelled native forms, accessible names asserted, announced errors/status, keyboard/focus handling, reduced-motion, 320px author reflow/no overflow, CSP-safe self-hosted styles, established typography/colors/layout |
| OpenAPI YAML parse | passed: OpenAPI 3.0.3, 50 paths |
| `npm audit --omit=dev` | passed: 0 production vulnerabilities |
| `node scripts/assert-ci-deploy-contract.mjs` | passed |
| `git diff --check` | passed |
| `bash scripts/test-infra-safety.sh` | local macOS runner unavailable: required Linux `flock` is absent; GitHub Linux gate remains mandatory |

## Известные риски

- Legacy CRM `Lead` глобален и не опубликован через tenant API. Перенос в tenant-scoped `CRMContact` выполняется на этапе CRM с one-to-one mapping действующей партнёрской воронки.
- Creator dashboard остаётся выключен: текущий batch не включает UI, bounded recurrence, real preview-room navigation и private access grants.
- Полный production observation одного webinar/reminder/replay/CRM цикла не выполнен локально; rollout flags должны включаться по runbook независимо.
- В старой migration history остаётся документированный schema drift manual GIN/token/id-status indexes и default `telegram_broadcast_recipients.updated_at`; новые migrations его не удаляют и не маскируют.
- Реальный SMTP delivery и внешний deploy требуют production credentials/approval. До SMTP verify используется честный degraded `EMAIL_MODE=log`.
- GitHub deployment environments по последней проверке не содержали обязательные `STAGING_*`/`PRODUCTION_*` SSH secrets; fail-closed workflow остановит внешний deploy до настройки.
- Резервные MFA recovery codes не входят в критерий TEN-008 и пока отсутствуют; потеря authenticator требует контролируемой operator remediation с аудитом.
- Сроки хранения author profile/evidence и правила публичного профиля не утверждены юристом/DPO; матрица версии `2026-08-20.3` честно запрещает автоудаление до этого решения.

## Deploy verdict

`ready` для controlled additive deploy identity/author/Webinar expand migrations со всеми rollout flags `off` и условиями runbook. Creator dashboard включать ещё нельзя до завершения текущего stage-2 gate. Публичный author onboarding остаётся `blocked` юридическим утверждением profile/retention rules. Внешний deploy остаётся `blocked` отсутствующими GitHub deployment secrets; локальная реализация не меняет production state.

## Следующий минимальный batch

1. SES-001–SES-003/SES-005/SES-006: tenant-scoped session CRUD, bounded one-time/daily/weekly recurrence и DST/date-boundary tests.
2. SES-004: confirmed reschedule/cancel after registrations with audit and durable notification outbox.
3. WEB-007/WEB-010: idempotent duplicate draft, private Webinar invitation/access grants and immediate revoke enforcement.
4. WEB-002/WEB-003/WEB-006: базовый creator UI с полными loading/empty/error/permission/narrow states и side-effect-free room preview; затем stage-2 full gate.
