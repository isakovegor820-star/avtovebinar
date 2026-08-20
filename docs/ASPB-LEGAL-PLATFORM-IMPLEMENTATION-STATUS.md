# АСПБ Legal Platform — статус реализации

Дата: 20 августа 2026 года
Текущий этап: этап 1, identity/organizations/author verification; gate пройден, кроме зависящего от реального Webinar publish API критерия AUT-003

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
| AUT-003 | `in_progress` | Единая `assertAuthorCanPublish` policy реализована и service-тестом даёт 403 `author_verification_required`; `verified` будет только после подключения к реальному WEB publish endpoint этапа 2 |
| AUT-004 | `verified` | Admin/owner UI+API запрашивают уточнение; author API/UI видит public comment, но не internal reason; integration и admin E2E |
| AUT-005 | `verified` | Public projection только для verified active author/membership; evidence bytes в private storage boundary, MIME+magic-byte+5 МиБ checks, `no-store`/`noindex`, safe cross-tenant 404 |

## Ключевые изменения

- Foundation/backfill: `prisma/migrations/20260820120000_tenant_foundation/migration.sql`, deploy preflight/concurrent-index/postflight checks.
- Passwordless User auth: `prisma/migrations/20260820143000_user_passwordless_auth/migration.sql`, `src/lib/tenancy/userAuth.ts`, `src/lib/tenancy/userAuthEmailOutbox.ts`.
- Invitations: `prisma/migrations/20260820160000_organization_invitations/migration.sql`, `src/lib/tenancy/organizationInvitations.ts`, `src/lib/tenancy/organizationInvitationEmailOutbox.ts`.
- Owner MFA: `prisma/migrations/20260820170000_user_owner_mfa/migration.sql`, `src/lib/tenancy/userMfa.ts`; существующий `src/lib/mfa.ts` использован без смены AdminUser encryption contract.
- Author verification: `prisma/migrations/20260820180000_author_verification/migration.sql`, `src/lib/tenancy/authorVerification.ts`, `src/routes/authorPlatform.ts`, platform-admin routes в `src/routes/admin.ts`.
- Authenticated API/UI: `src/routes/platformAuth.ts`, `crisis_premium/platform-access.html`, `crisis_premium/js/platform-access.js`, `crisis_premium/platform-access.css`, `openapi.yml`.
- Author/reviewer UI: `crisis_premium/author-profile.html`, `crisis_premium/js/author-profile.js`, `crisis_premium/admin.html`, `crisis_premium/admin.js`, `crisis_premium/admin-verification.css`.
- Monitoring/retention: `src/lib/health.ts`, `src/lib/metrics.ts`, `src/lib/reminders.ts`, `docs/RETENTION-MATRIX-2026-07-30.md`, `docs/production-runbook.md`.
- Verification: `tests/integration.test.ts`, `tests/e2e/webinar-room.spec.ts`, `tests/tenantMigration.test.ts`, `tests/fixtures/tenant-foundation-legacy-migration.sql`, `tests/healthSafety.test.ts`.

## Compatibility layer

- Stable organization `org_aspb` and non-login system owner remain the default scope for legacy `WebinarSession` create/read paths.
- Registration, room, replay, CRM, email, Telegram and `/admin` contracts remain unchanged; `AdminUser` is not copied into `User` and has no implicit tenant membership.
- `PLATFORM_ACCOUNTS_ENABLED=off` and `PLATFORM_TENANCY_ENFORCEMENT=off` remain safe defaults. Disabled platform routes return safe `404`; enabling accounts does not enable tenant enforcement for unmigrated legacy domains.
- Passwordless and invitation email links are generated only in worker memory; database stores SHA-256 hashes. `EMAIL_MODE=log` cancels rather than pretending delivery.
- Invitation and User auth outboxes run through the existing durable reminders worker and are visible in protected health/Prometheus metrics.
- Author verification таблицы пусты после legacy backfill; данные появляются только в новом flow и полностью скрываются флагом `PLATFORM_ACCOUNTS_ENABLED=off`.

## Quality gate

| Проверка | Результат |
| --- | --- |
| `npx prisma validate` | passed |
| `npx prisma generate` | passed: Prisma Client 6.19.3 |
| Fresh `npm test` migration deploy | passed: all migrations through `20260820180000_author_verification` |
| `DATABASE_URL=... NODE_ENV=test npx vitest run tests/tenantMigration.test.ts` | passed: 1 test; non-empty legacy counts/relations/tokens/CRM/delivery/AdminUser/audit preserved; TEN/auth/invitation/author expand tables start empty |
| Targeted author integration | passed: strict draft/submit, 5 МиБ limit, MIME signature, review transitions, comment separation, safe projection, cross-tenant read/delete and publish policy |
| Targeted safety/migration | passed: 3 files, 11 tests |
| `npm run lint` | passed |
| `npm run build` | passed |
| `npm test` | passed: 22 files, 219 tests |
| `npm run e2e` | passed: 16 Chromium tests; author 320px flow and platform-admin MFA/review included |
| Consolidated interface review | passed in six domains: labelled native forms, accessible names asserted, announced errors/status, keyboard/focus handling, reduced-motion, 320px author reflow/no overflow, CSP-safe self-hosted styles, established typography/colors/layout |
| OpenAPI YAML parse | passed: OpenAPI 3.0.3, 41 paths |
| `npm audit --omit=dev` | passed: 0 production vulnerabilities |
| `node scripts/assert-ci-deploy-contract.mjs` | passed |
| `git diff --check` | passed |
| `bash scripts/test-infra-safety.sh` | local macOS runner unavailable: required Linux `flock` is absent; GitHub Linux gate remains mandatory |

## Известные риски

- Legacy CRM `Lead` глобален и не опубликован через tenant API. Перенос в tenant-scoped `CRMContact` выполняется на этапе CRM с one-to-one mapping действующей партнёрской воронки.
- Полный production observation одного webinar/reminder/replay/CRM цикла не выполнен локально; rollout flags должны включаться по runbook независимо.
- В старой migration history остаётся документированный schema drift manual GIN/token/id-status indexes и default `telegram_broadcast_recipients.updated_at`; новые migrations его не удаляют и не маскируют.
- Реальный SMTP delivery и внешний deploy требуют production credentials/approval. До SMTP verify используется честный degraded `EMAIL_MODE=log`.
- GitHub deployment environments по последней проверке не содержали обязательные `STAGING_*`/`PRODUCTION_*` SSH secrets; fail-closed workflow остановит внешний deploy до настройки.
- Резервные MFA recovery codes не входят в критерий TEN-008 и пока отсутствуют; потеря authenticator требует контролируемой operator remediation с аудитом.
- Сроки хранения author profile/evidence и правила публичного профиля не утверждены юристом/DPO; матрица версии `2026-08-20.3` честно запрещает автоудаление до этого решения.

## Deploy verdict

`ready` для controlled additive deploy миграций identity/author verification со всеми rollout flags `off` и условиями runbook. Публичный author onboarding ещё `blocked` юридическим утверждением profile/retention rules. Внешний deploy остаётся `blocked` отсутствующими GitHub deployment secrets; локальная реализация не меняет production state.

## Следующий минимальный batch

1. WEB-001/WEB-003: tenant-scoped `Webinar` content model, required legal metadata, sources/taxonomy boundary и additive legacy-Webinar backfill.
2. WEB-002/AUT-003: content state machine и реальный publish endpoint, который всегда вызывает `assertAuthorCanPublish`; negative direct-API test закроет AUT-003.
3. WEB-004/WEB-005/WEB-008/WEB-009: stable slug aliases, visibility, supersession и non-destructive archive.
4. SES-001–SES-006/WEB-006/WEB-007/WEB-010 — после базового Webinar gate; media worker не добавляется до этапа 3.
