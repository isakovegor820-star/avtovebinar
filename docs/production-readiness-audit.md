# АСПБ: актуальный production-readiness audit

Дата обновления: 23 августа 2026

Этот документ заменяет исторический аудит от 26 мая 2026. Старые пункты про постоянный `webinar.html?token=...`, production-хранение room token в `localStorage`, отсутствие integration/e2e и прямую зависимость регистрации от SMTP больше не актуальны.

## Текущий статус

Дополнение ANA-001–ANA-007 и MOD-001–MOD-005 от 23 августа 2026: поверх
versioned `events` contract добавлена одна additive migration с tenant/platform
analytics projections, публичными жалобами, moderation state machine,
коррекциями автора, архивированием/приостановкой и audited platform governance.
Tenant scope и Organization→Webinar→WebinarSession→Registration/User связи
выводятся сервером; неизвестные и foreign IDs имеют одинаковый safe 404.
Authoritative время задаёт БД по UTC, повторы дедуплицируются атомарно, а PII,
secrets, signed URLs и storage keys блокируются contract/DB checks. Dashboard
имеет URL-фильтры, формулы, live-window, retention и low-frequency suppression;
platform aggregate структурно не выдаёт chat/notes/contact identifiers. Public
report не раскрывает автора обращения. Коррекции и критические действия требуют
причину, optimistic revision, MFA platform role и audit. Старые writers проходят
наблюдаемый `schemaVersion=0` compatibility adapter. Все 68 migrations повторно
применимы без pending changes; targeted ANA/MOD PostgreSQL acceptance проходит.
Локальные gates: Vitest 319/319, Playwright Chromium 29/29, fresh-schema deploy
68/68, четыре analytics/moderation pre/postflight без нарушений и повторный
deploy без pending migrations. Staging/production migration, provider
acceptance и реальные отправки не выполнялись.

Дополнение от 21 августа 2026: tenant foundation, passwordless User auth,
organization invitations/MFA, author verification, Webinar/session domain,
private grants, creator UI/preview, public catalog, tenant-scoped exact-session
registration, кабинет зрителя, tenant-scoped CRM contact/pipeline/task/scoring/tag/bulk/export/delivery,
chat/moderation CHT-001–CHT-010 и Telegram BOT-001–BOT-013 реализованы
additive и скрыты независимыми rollout-флагами. Полный актуальный requirement
ledger находится в `docs/ASPB-LEGAL-PLATFORM-IMPLEMENTATION-STATUS.md`.
`PUBLIC_CATALOG_ENABLED` остаётся `off` до SMTP и staging acceptance одного
точного catalog registration → room → replay → account flow. Migration
`20260821130000_viewer_account_registration` backfill-ит trusted
Organization/Webinar/User scope через существующую WebinarSession и Lead email,
не создаёт membership и не копирует `AdminUser`. Legacy single-Webinar
registration и партнёрская воронка не подменяются. Полный локальный gate
текущего checkout проходит; внешний выпуск всё равно требует CI и условий
runbook.

Migration `20260821140000_crm_contact_pipeline` additive создаёт CRMContact,
Pipeline/Stage, events/transitions, связывает только scoped Registration и
сохраняет legacy status/manager/nextContact. CRM скрыта
`TENANT_CRM_ENABLED=off`; application rollback выполняется выключением флага и
возвратом к legacy CRM path, без down-migration.
Additive hardening `20260821141000_crm_stage_integrity_hardening` закрепляет
immutable stage/protected-state и Registration Organization/Lead→CRMContact
scope также на DB boundary.
Migration `20260821150000_crm_tasks_sla` additive добавляет реальные CRMTask,
обязательный active tenant assignee, due/reminder/priority/status, task events и
audit. `nextContactAt` становится DB-проекцией ближайшей открытой задачи после
первой task mutation; legacy nextContact без tenant membership сохраняется без
выдуманной задачи. Очереди Today/Overdue/Without task считаются сервером в IANA
timezone default pipeline. Внешнее reminder-сообщение этот batch не отправляет.
Migrations `20260821160000_crm_scoring_tags` и
`20260821161000_crm_scoring_legacy_room_backfill` additive добавляют
версионированные правила, immutable/deduplicated score factors, reasoned manual
hot и tenant tags. Legacy `isHot` сохраняется как projection, а legacy room
factor создаётся только при наличии реального `room_entered`/`webinar_room_open`
evidence. Выдуманные теги или scoring-события не создаются; внешний send-flow
не запускается.
Migrations `20260821170000_crm_bulk_export` и
`20260821171000_crm_bulk_integrity_hardening` additive добавляют точный
10-минутный bulk preview до 1000 контактов, идемпотентные partial results и
DB-проверки snapshot/result/task linkage. CSV до 10000 контактов требует
отдельного membership permission, маскируется для ANALYST/AUDITOR, экранирует
spreadsheet formulas и не сохраняется как серверный файл. Preview/execute и
export audit не отправляют email/Telegram.
Migration `20260821180000_crm_consent_delivery` additive добавляет durable
tenant queue для маркетинговых email/Telegram. Enqueue и provider send отдельно
проверяют актуальное channel consent, exact Registration/Webinar/Session и
active requester membership; revoke до send блокирует job. Bounded retry,
dead-letter, safe status projection, aggregate metrics и ручной idempotent retry
реализованы без хранения recipient email/chatId в job и без provider details в
API/audit/logs. `EMAIL_MODE=log` честно даёт `CANCELLED`, поэтому локальные тесты
не заявляют реальную доставку.

Migrations `20260821190000_chat_moderation` и
`20260821191000_chat_synthetic_identity_hardening` additive закрепляют
exact Organization/Webinar/WebinarSession scope, canonical message type,
synthetic/type consistency, per-message approval, reasoned hide/restore и
registration chat block/restore. Вторая migration нормализует
synthetic identity в честные метки «Подготовленный вопрос»,
«AI-модератор» и «Система АСПБ», не создавая сообщений
или участников. Public room выдаёт только approved messages
одной published ChatScenario; реальные вопросы проходят
sanitization и bounded anti-spam. OWNER/MODERATOR действуют только
в active tenant и с обязательной причиной; foreign/unknown target
возвращает тот же safe 404. Legacy JSON сохранён как compatibility
fallback, но fake flood rows не видны. Rollout остаётся выключенным
до exact-SHA staging acceptance.

Migrations `20260823085000_ai_suggestion_chat_type`,
`20260823090000_question_moderation_grounding` и
`20260823091000_question_legacy_scope_compatibility` additive расширяют
существующие provenance/suggestion модели и `Question`: exact tenant scope от
WebinarSession, durable status/priority/revision/history, CRM event и очереди
`new`/`repeating`/`priority`. Local policy читает только latest `PUBLISHED`
transcript search vector или explicit `WebinarSource`; draft/reviewed content и
personalized legal advice не попадают в ответ. Suggestion не создаёт public
message до human review, а accepted message имеет synthetic `AI-модератор` и
safe timestamp/HTTPS grounding. External AI provider не вызывается и остаётся
`unconfigured`.

Provider-neutral media foundation, self-hosted private filesystem adapter,
S3-compatible adapter и общий real ffmpeg pipeline добавлены additive.
Production остаётся fail-closed с `MEDIA_STORAGE_PROVIDER=unconfigured`; test
fake запрещён production guard. Для текущего односерверного deployment в
[DEC-05](./DEC-05-MEDIA-STORAGE-CDN-TRANSCODER.md) выбран persistent Docker
volume + self-hosted ffmpeg + application authorization gateway как local
compatibility contour. S3 direct multipart contour реализован provider-neutral
для MED-001, но ни provider, ни bucket/CORS/IAM/lifecycle не выбраны и не приняты
на staging. В
[DEC-06](./DEC-06-STT-AI-PROVIDERS.md) — Yandex SpeechKit/Foundation Models.
Это не является production deploy: media switch блокируют staging
backup/restore, capacity/load и failure acceptance; STT/AI по-прежнему требуют
юридическое/финансовое утверждение внешнего provider. Room/replay теперь
дополнительно использует cookie-защищённый consistent content snapshot и WebVTT
endpoint для exact current published transcript. Draft/reviewed версии не
выдаются; captions повторно проверяют WebinarSession, private grant и replay
expiry. Это не меняет production provider state.

Платформа перешла на cookie-only доступ в вебинарную комнату:

- ежедневный webinar slot стартует в 19:30 по Москве;
- во время live включен DVR-режим: можно отмотать назад в уже прошедший эфир, но нельзя смотреть будущую часть;
- одноразовый exchange-token может прийти в URL только для первичного обмена;
- `POST /api/registration/exchange/:token` удаляет exchange-token и ставит `HttpOnly` cookie `aspb_room_token`;
- frontend очищает URL после exchange;
- room state, timeline, chat, questions, events и partner application работают через cookie/session endpoints;
- catalog registration принимает exact session показанного Webinar, не принимает client `organizationId` и не раскрывает существование email;
- кабинет выдаёт только same-User/same-tenant sections, progress, favorites, notes и notification preferences; favorites не создают access;
- legacy routes `/api/registration/:token`, `/api/webinar/timeline/:token`, `/api/webinar/chat/:token` отключены.

Email-доставка переведена на outbox:

- регистрация сохраняет lead/registration/tokens/email job в одной транзакции;
- API регистрации не падает при временной SMTP-ошибке;
- `email_outbox_jobs` хранит `status`, `attempts`, `lastError`, `nextAttemptAt`, `sentAt`;
- scheduler отправляет `pending/failed` jobs и повторяет ошибки;
- повторная регистрация заменяет старые `pending/failed` `registration_confirmation` jobs и сохраняет уже `sent` историю.

Тесты усилены:

- Vitest покрывает cookie-only API, one-time exchange, tenant/session registration scope, analytics formulas/retention/live/published-content, role matrix, public report/state machine/corrections/actions/governance, idempotency, viewer isolation, progress throttling/dedup, note privacy, consent separation, questions, exact chat types/approval/sanitization/rate limit, tenant moderation/audit, partner application, admin flow, object-storage contract и email outbox retry/replace;
- Playwright e2e покрывает регистрацию, success, все CAT-006 sort modes, analytics URL reload/back/keyboard/320px, platform moderation confirmation/revision/320px, catalog exact-session flow, room через cookie/session, очистку token из URL, live/DVR/replay position, private notes, viewer account states/settings, chapters/published transcript/search/captions, keyboard player controls, safe media states, honest synthetic chat labels, keyboard moderation hide/block/restore, question, partner application и ended-chat state;
- CI устанавливает Chromium через `npx playwright install --with-deps chromium` и запускает e2e.

## Оценка готовности

| Направление | Оценка | Комментарий |
| --- | ---: | --- |
| Frontend | 8.3/10 | Основной user flow работает; крупные inline scripts вынесены, оставшиеся static styles закрыты CSP hashes. |
| Backend API | 9/10 | Cookie-only room access, strict env, health/readiness, metrics и worker split закрывают главные production риски. |
| Analytics foundation | 9/10 | ANA-001–ANA-007 и MOD-001–MOD-005 реализованы: tenant/platform aggregates, URL filters, retention/live/content privacy, public reports, corrections/actions/governance и negative tests; exact-SHA staging observation остаётся отдельно. |
| Admin/CRM/Telegram | 9/10 | CRM-001–CRM-016, CHT-001–CHT-010 и BOT-001–BOT-013 закрыты локальным tenant/consent/moderation/bot negative-test контуром; provider и canary acceptance ещё должны пройти на staging. |
| Email | 8.5/10 | Outbox/retry есть; `/metrics` показывает queue depth и failed jobs. |
| Автовебинар | 8.5/10 | Server-backed live/chat flow покрыт e2e. |
| Безопасность | 8.2/10 | Legacy token routes убраны, CSP без `unsafe-inline`; добавлены CSRF, COEP/CORP и hardened admin cookie. |
| Тесты | 8/10 | Есть unit/integration/browser coverage критического пути. |
| Production readiness | 8.8/10 | Docker API/worker split, readiness, metrics, CI security scans и staging deploy добавлены. |

## Закрытые прежние риски

- Replay window приведен к 7 дням.
- Production guard запрещает `EMAIL_MODE=log`, test-room mode и слабые secrets.
- Room token не хранится в frontend `localStorage`; старый `crisisPremiumToken` только очищается.
- Registration/reminder tokens получают `expiresAt`.
- Email log маскирует персональные ссылки.
- Критический путь покрыт integration и browser e2e.
- README и runbook описывают текущую cookie-only архитектуру.
- `/health/ready` проверяет БД и write-доступ к local media volume, когда он выбран; SMTP/Telegram/queues проверяются dependency health, `/metrics` отдаёт Prometheus format.
- Telegram broadcast вынесен в durable worker с dead-letter queue.
- CI включает dependency-review, Semgrep, secretlint, dotenv-linter и staging deploy через secrets.

## Оставшиеся риски

### P0. Analytics/moderation staging acceptance

Analytics/moderation implementation и concurrency/negative tests закрыты
локально, но production rollout не выполнялся. До deploy нужно сохранить оба
analytics/moderation preflight на восстановленной staging-копии, применить
additive migrations, получить нулевой postflight и повторный migrate без pending
changes. На exact SHA отдельно проверить часы/refresh dashboard, role matrix,
create/retry/conflict/cross-tenant parity, public report rate limit,
correction/unpublish/suspend/restore и отсутствие ПДн/secrets в events, API и
logs. Application rollback — предыдущий совместимый image и выключенные flags;
schema, audit и legacy history не откатываются.

### P1. CSP hash list требует регенерации при изменении inline styles

Inline scripts вынесены в отдельные JS-файлы, `script-src-attr 'none'` включен, CSP больше не содержит `unsafe-inline`. Статические inline style blocks/attributes разрешены sha256 hashes в `src/lib/cspInlineHashes.ts`.

Следующий шаг: при изменении HTML/JS с inline styles регенерировать hashes или постепенно вынести эти стили в CSS-файлы.

### P1. Автоматическая доставка алертов

Alert states есть в `/metrics`, но отправка в PagerDuty/Telegram/Sentry пока должна быть настроена внешним мониторингом.

Следующий шаг: подключить Prometheus/Grafana Alertmanager или managed uptime/metrics provider.

### P2. Frontend без сборки

Статические HTML/JS ускорили MVP, но мешают строгому CSP, компонентной структуре и asset fingerprinting.

Следующий шаг: легкий build pipeline или последовательный вынос inline blocks.

### P0. Tenant CRM staging acceptance

Tenant-scoped contacts, filters, masked analyst view, timeline, pipeline/stage
action-flow, task/reminder/timezone queues, explainable versioned scoring,
reasoned manual hot, tenant tags, exact bulk preview/partial results и
permissioned audited CSV, consent-aware email/Telegram delivery,
retry/dead-letter и delivery timeline реализованы локально. До rollout нужны
preflight/postflight на восстановленной staging-копии, provider smoke только на
тестовых адресатах, revoke-before-send/cross-tenant acceptance и observation
одной тестовой организации того же SHA. `TENANT_CRM_ENABLED` остаётся `off` до
этой приёмки; реальные сообщения и production migration без отдельного
разрешения запрещены.

### P0. Chat/moderation staging acceptance

CHT-001–CHT-010 закрыты локально: exact message/question types/scope,
approved-only scenario, видимая и accessibility synthetic-маркировка,
запрет выдуманных личностей/fake audience, sanitization/anti-spam и
reasoned audited hide/block/restore, grounded published-only suggestion,
legal-advice handoff, human publication и CRM/history question queues. До rollout нужны preflight/postflight
на восстановленной staging-копии, exact-SHA keyboard/320px room +
moderation acceptance и observation одной тестовой организации.
Application rollback — флагами `CREATOR_DASHBOARD_ENABLED=off` или
`PLATFORM_ACCOUNTS_ENABLED=off`, без down-migration. External AI activation
не является частью локально закрытого batch и требует отдельного DEC-06/DPA,
credentials и staging acceptance.

### P0. Tenant Telegram staging acceptance

Migrations `20260823100000_telegram_manager_callback_foundation` —
`20260823103000_tenant_telegram_broadcast` additive и локально проходят
preflight/postflight. Platform-owned bot identities сохранены: tenant не
получает token. Participant commands и exact-session reminder dedup, hash-only
one-time manager claim с OWNER confirm/revoke, signed expiring callbacks,
navigation-only consultant handoff/classification/correction и broadcast
template → preview → separate confirm → durable recipient queue реализованы.
Consent/access перепроверяются непосредственно перед send; retry/dead-letter,
pause/cancel/progress, immutable bot events, correlation/provider ID и отдельный
PII-free operational chat покрыты unit/integration tests. Локальный runtime был
только в `TELEGRAM_NOTIFY_MODE=log`, реальные сообщения не отправлялись.

До production switch обязательны exact-SHA staging smoke на тестовых chats,
проверка bot username/token ownership, polling/restart, Telegram provider
message IDs/retry-after, cross-tenant/replay/expiry callbacks, revoke-before-send
и отсутствие token/signed URL/PII в logs/events. `TENANT_TELEGRAM_BOTS_ENABLED`
остаётся `off`; текущий глобальный flag не разрешает production canary одной
Organization без отдельного tenant allowlist. Rollback — только application
flag/polling off, без down-migration и удаления audit/history.

### P0. Catalog registration и viewer-account staging acceptance

Локально закрыты CAT-007, ROM-005 и USR-001–USR-005: exact-session scope,
safe foreign/unknown ответы, idempotency, replay progress, private notes,
favorite без access и разделённые notification settings проходят integration и
320px browser acceptance. До switch всё ещё нужны SMTP `send` smoke test,
preflight/postflight migration на восстановленной staging-копии, cross-tenant и
expired/revoked проверки на том же SHA и observation одной тестовой
организации. Rollback выполняется только `PUBLIC_CATALOG_ENABLED=off`; migration
и созданные viewer rows не удаляются.

### P0. Self-hosted media и внешний STT/AI acceptance

Self-hosted multipart/write/checkpoint/resume/complete/abort/private read,
streaming source validation, ffprobe/ffmpeg HLS/poster/audio, recoverable
leases, protected manifest/segment/poster/Range gateway, а также optional S3 и
Yandex STT/AI adapters реализованы. Local filesystem adapter покрыт restart,
checksum conflict/corruption, traversal/symlink, CSRF/tenant/author/MIME/size,
idempotent complete и Range tests. Автоматизированный real media gate принимает
MP4/MOV/WebM, создаёт HLS/JPEG/OGG, проверяет Range и fail-closed сценарии
signature/MIME/duration/malformed ffprobe/timeout; CI запускает его внутри
production image. Production providers намеренно остаются `unconfigured`, пока
не завершён staging switch.

Не подтверждены для self-hosted: volume backup/restore с согласованным DB
snapshot, фактическая передача максимального 4 ГБ файла, capacity/inode alerts,
порог которых должен быть выбран по измеряемым
`aspb_media_storage_bytes`/`aspb_media_storage_inodes`, staging container restart
и Node gateway load profile. Двухпроцессный checkpoint/resume на общем volume
автоматизирован в CI, но не заменяет restart реального staging container.
Transcoder timeout корректно
fail-closed подтверждён локально, но recovery worker на staging ещё проверяется.
Для STT/AI не подтверждены
договор/DPA/no-training/retention, corpus quality и provider acceptance.
MED-004/MED-005/TRN-001 поэтому остаются `implemented`, не `verified` на
staging; MED-009 correctness остаётся verified локально, load acceptance открыт.

MED-001 отдельно остаётся `implemented`: S3 path выполняет direct signed part
PUT без full-file Express proxy, server checkpoint/ListParts reconciliation,
idempotent HeadObject-backed complete, abort/cleanup и safe audit/errors. До
`verified` обязательны provider/legal/budget decision, private IAM/origin,
production-origin CORS с exposed ETag, incomplete multipart lifecycle,
credentials в approved secret store и exact-SHA staging smoke. Local adapter не
может заменить эту acceptance.

Следующий шаг: на staging того же SHA смонтировать private persistent volume,
выполнить backup/restore и failure/load matrix, затем включить local media для
одной тестовой организации. Отдельно получить legal/budget approval DEC-06 и
staging credentials до любого STT/AI switch. `MEDIA_UPLOAD_CSP_ORIGINS` для
local same-origin upload остаётся пустым; он нужен только будущему external S3.

## Проверки перед production deploy

```bash
npm run css:build
npm run lint
npm run build
npm test
npm audit --omit=dev
npm run e2e:install
npm run e2e
```

Production deploy дополнительно требует:

- `NODE_ENV=production`;
- `PUBLIC_SITE_URL=https://...`;
- `CORS_ORIGIN=https://...`;
- `EMAIL_MODE=send` и рабочий SMTP;
- `WEBINAR_TEST_ROOM_MODE=off`;
- `PUBLIC_CATALOG_ENABLED=off` до same-SHA staging registration/account acceptance;
- managed flags `analytics_dashboard`, `public_reporting`, `moderation_actions`, `provider_jobs` остаются false до отдельной same-SHA acceptance и owner confirmation;
- `MEDIA_STORAGE_PROVIDER=unconfigured` до выбранного provider и MED-001 либо отдельно утверждённого local compatibility switch;
- миграции через `npm run prisma:deploy`;
- preflight/postflight `20260823110000` и `20260823120000` с нулевыми violation counts и повторный migrate без pending migrations;
- viewer-registration preflight/postflight с нулевыми violation counts и повторный migrate без pending migrations;
- согласованный backup/restore PostgreSQL и отдельного media volume;
- мониторинг healthcheck, logs и email outbox.
