# АСПБ Legal Platform — статус реализации

Дата: 20 августа 2026 года
Текущий этап: этапы 0–1, deploy hardening tenant foundation vertical

## Требования

| Requirement ID | Статус | Доказательство и граница |
| --- | --- | --- |
| TEN-001 | `verified` | `User`, `Organization`, `OrganizationMembership`, enum/unique constraints; multi-organization integration test и migration fixture |
| TEN-002 (foundation slice) | `verified` | Server-resolved active tenant, обязательный scope `WebinarSession`, scoped read/write и одинаковый safe 404 для foreign/unknown ID |
| TEN-002 (platform-wide rollout) | `in_progress` | Новые CRM/media/analytics/bot/job сущности должны применять тот же обязательный scope в своих этапах; legacy Lead/CRM пока не объявлены tenant API |
| TEN-003 | `verified` | `AdminUser` сохранён отдельно; одинаковый email допустим в `users`/`admin_users`, admin ID не разрешается как tenant principal; действующий admin suite сохранён |
| TEN-004 | `not_started` | Следующий batch: passwordless User auth, hash-only tokens, hardened cookie session |
| TEN-005 | `not_started` | Следующий batch после TEN-004: invite и membership lifecycle |
| TEN-006 (service layer) | `verified` | Role change/removal атомарно пишут actor, organization, before/after и correlation ID в `audit_logs`; rejected mutation не пишет audit |
| TEN-007 (service layer) | `verified` | Доступный owner — только `ACTIVE` membership связанного `ACTIVE HUMAN` User; `SYSTEM`, suspended и deactivated User не считаются. Demotion/removal и три конкурентные комбинации защищены advisory lock |
| TEN-007 (HTTP/API acceptance) | `in_progress` | Публичный tenant endpoint намеренно отсутствует до TEN-004; проверка HTTP `409` будет добавлена вместе с authenticated UserSession middleware |
| TEN-008 | `in_progress` | Platform Admin MFA сохранён; MFA владельца организации ещё не реализован |
| AUT-001–AUT-005 | `not_started` | Начинаются только после TEN-004/005/008 |

## Ключевые изменения

- Schema и expand/backfill: `prisma/schema.prisma`,
  `prisma/migrations/20260820120000_tenant_foundation/migration.sql`.
- Read-only deploy checks: `prisma/checks/20260820120000_tenant_foundation_preflight.sql`,
  `prisma/checks/20260820120000_tenant_foundation_concurrent_indexes.sql`,
  `prisma/checks/20260820120000_tenant_foundation_postflight.sql`.
- Tenant context/policies: `src/lib/tenancy/context.ts`,
  `src/lib/tenancy/webinarSessionRepository.ts`.
- Membership transaction/audit: `src/lib/tenancy/membershipService.ts`.
- Compatibility bootstrap/flags: `prisma/seed.ts`, `src/lib/featureFlags.ts`,
  `.env.example`, `.env.production.example`.
- Verification: `tests/integration.test.ts`, `tests/tenantMigration.test.ts`,
  `tests/fixtures/tenant-foundation-legacy-migration.sql`, `tests/seedSafety.test.ts`.

## Compatibility layer

- Stable organization `org_aspb` and non-login system user
  `user_aspb_system_owner` are created by migration.
- Bootstrap `SYSTEM` owner не считается доступным владельцем-человеком и не
  позволяет удалить/понизить последнего `ACTIVE HUMAN` owner.
- Existing `webinar_sessions` are backfilled atomically; DB/Prisma default scopes
  legacy create paths to `org_aspb`.
- Registration, room, replay, CRM, email and Telegram contracts are unchanged.
- `AdminUser` remains the platform-operator identity and has no implicit tenant
  membership.
- `PLATFORM_ACCOUNTS_ENABLED=off` and
  `PLATFORM_TENANCY_ENFORCEMENT=off` are the current safe defaults. No new public
  tenant endpoint is exposed before TEN-004 provides authenticated User sessions.

## Quality gate

| Проверка | Результат |
| --- | --- |
| Baseline до deploy-hardening | passed: full Vitest 22 files/203 tests; E2E 12/12 |
| `npx prisma validate` | passed |
| `npx prisma generate` | passed: Prisma Client 6.19.3 |
| Full-history `npx prisma migrate deploy` on non-empty legacy test DB | passed: 33 legacy migrations, linked legacy rows, then tenant migration |
| Repeated `npx prisma migrate deploy` | passed: `No pending migrations to apply` |
| Concurrent-index script and idempotent repeat | passed: four indexes valid/ready; repeat skipped existing indexes |
| Expanded linked migration fixture | passed: WebinarSession/Recording, Lead, Registration/tokens, Question/chat, Event, email, Telegram, AdminUser/AuditLog counts, relations and preserved state |
| Targeted Vitest | passed: 3 files, 47 tests |
| `npm run lint` | passed |
| `npm run build` | passed |
| `npm test` | passed: 22 files, 209 tests |
| `npm run e2e` | passed: 12 tests |
| `npm audit --omit=dev` | passed: 0 production vulnerabilities after pinning `deepmerge-ts` 8.0.1 through npm override |
| `node scripts/assert-ci-deploy-contract.mjs` | passed |
| `bash scripts/test-infra-safety.sh` | local macOS runner unavailable: required Linux `flock` command is absent; GitHub Linux gate remains mandatory |
| `git diff --check` | passed |
| `git status --short` | reviewed: only intentional foundation files plus pre-existing user source documents; no suffix-`2` entries |
| Prisma DB/schema diff | exit 2 only for four documented pre-existing index/default differences; no tenant-foundation difference after concurrent-index step |

## Известные риски

- Active organization пока передаётся только как trusted service principal;
  signed UserSession, HTTP middleware и HTTP acceptance TEN-007 относятся к
  TEN-004. Client-supplied `userId`/`organizationId` endpoint отсутствует.
- Legacy CRM `Lead` глобален. Он не опубликован через tenant API; перенос в
  tenant-scoped CRMContact выполняется на этапе CRM с one-to-one status mapping.
- Полный production observation одного webinar/reminder/replay/CRM цикла и
  product-owner acceptance не выполнены локальной итерацией.
- В migration history до этой вертикали есть schema drift: manual GIN/token/id-status
  indexes и default `telegram_broadcast_recipients.updated_at` не полностью
  отражены в Prisma schema. Эта итерация их не удаляет и не маскирует.
- Tenant migration впервые входит в release этой вертикали. Фактическое состояние
  внешней production `_prisma_migrations` из локальной среды недоступно;
  preflight требует остановиться, если migration уже применена с другим checksum.
- Локальный isolated PostgreSQL — 17.9, тогда как repository production/CI image
  — PostgreSQL 16. Использованные DDL guarantees существуют в обеих версиях;
  exact production state всё равно проверяется обязательными preflight/postflight.
- GitHub environments `staging` и `production` созданы, но на дату документа в
  repository/environment scopes отсутствуют обязательные `STAGING_*` и
  `PRODUCTION_*` SSH/deploy secrets. Workflow fail-closed остановит внешний
  deploy до их настройки; значения секретов в repository не добавляются.

## Deploy verdict

`ready` для controlled tenant-foundation deploy при выполнении runbook: свежий
backup, успешный restore в recovery DB, migration отсутствует в production
`_prisma_migrations`, flags остаются `off`, concurrent-index script и postflight
завершаются успешно. Фактический внешний deploy сейчас `blocked` отсутствующей
GitHub deployment-конфигурацией. Это не readiness следующих этапов ТЗ.

## Следующий минимальный batch

1. TEN-004: `UserSession`, passwordless request/consume, purpose/expiry/single-use
   hash token, CSRF и hardened HttpOnly cookie.
2. TEN-005: invite create/revoke/accept и reactivation membership без обхода
   last-owner/audit policy.
3. TEN-008: MFA для organization owner без ослабления действующего Admin MFA.
4. AUT-001–AUT-005 после identity quality gate.
