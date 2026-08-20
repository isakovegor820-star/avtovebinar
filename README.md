# АСПБ Автовебинар

Платформа автовебинара АСПБ: статический frontend в `crisis_premium`, Node.js/TypeScript backend, PostgreSQL/Prisma, CRM-админка, серверный live-тайминг, чат, вопросы, партнерские заявки, email outbox и Telegram-уведомления.

## Архитектура доступа

Доступ в вебинарную комнату cookie-only:

- одноразовый `exchange-token` поддерживается только для первичного обмена через `POST /api/registration/exchange` с body `{ "token": "..." }`; legacy `POST /api/registration/exchange/:token` временно поддерживается;
- письма, reminder и Telegram-ссылки используют одноразовый `webinar.html#token=...`; legacy `?token=...` остается рабочим для старых ссылок;
- backend удаляет exchange-token, выпускает session-token и ставит `HttpOnly` cookie `aspb_room_token`;
- URL очищается от `token`;
- дальнейшие запросы комнаты используют только cookie и endpoints `session/current`.

Постоянные endpoints с token в path отключены. Frontend не хранит room token в `localStorage` и не отправляет token в analytics, questions или partner application.

## Tenant foundation (этап 1)

`User`, `Organization` и `OrganizationMembership` существуют отдельно от
`AdminUser`: tenant-роли не дают доступ к platform `/admin`. Additive migration
`20260820120000_tenant_foundation` создаёт compatibility-организацию `ASPB` и
системного владельца без login credentials. Все существующие и новые legacy
`WebinarSession` получают обязательный `organizationId=org_aspb`; связанные
регистрации, вопросы, сообщения и события продолжают получать scope через
сессию без изменения старых публичных контрактов.

Новый код обязан получать active organization из доверенного пользовательского
контекста через `src/lib/tenancy/context.ts` и выполнять object read/write через
scoped repository/service. Поле `organizationId` в payload не является
доказательством доступа и отклоняется новыми Zod-контрактами.

TEN-004 добавляет passwordless User auth: durable email outbox с hash-only
одноразовыми токенами, `aspb_user_session` HttpOnly cookie, отзыв
сессий и серверный выбор active organization. UI входа доступен по
`/crisis_premium/platform-access.html`. TEN-005 добавляет owner-only приглашения,
привязанные к email, роли и семидневному сроку, с отзывом, повторной активацией
membership и отдельным durable outbox. TEN-008 сохраняет обязательную MFA
`AdminUser` и добавляет владельцам организаций TOTP MFA: enrollment действует
10 минут, секрет хранится зашифрованным, а непроверенная MFA-сессия не получает
tenant-данные и доступ к защищённым endpoints. До controlled switch оба
rollout-флага остаются выключены:

```text
PLATFORM_ACCOUNTS_ENABLED=off
PLATFORM_TENANCY_ENFORCEMENT=off
CREATOR_DASHBOARD_ENABLED=off
```

Это сохраняет действующие registration/room/replay/CRM/email/Telegram и
platform-admin flow. При `PLATFORM_ACCOUNTS_ENABLED=off` новые routes возвращают
safe `404`; старый participant passwordless flow не изменяется. Состояние требований
и границы compatibility layer описаны
в `docs/ASPB-LEGAL-PLATFORM-IMPLEMENTATION-STATUS.md`.

AUT-001–AUT-005 добавляют tenant-scoped профиль автора и ручную
проверку. Автор сохраняет черновик на
`/crisis_premium/author-profile.html`, загружает до 5 МИБ PDF/JPEG/PNG и
отправляет профиль на проверку. Файлы хранятся приватно, выдаются
только после повторной authorization-проверки с `no-store` и не входят в
публичную projection. Администратор может запросить уточнение,
принять, отклонить или приостановить профиль; внутренняя причина никогда
не возвращается автору. Публичный endpoint видит только `verified`
активного автора с действующим membership. Прямой publish guard уже
централизован в service policy и подключён к tenant-scoped Webinar publish API.

Этап 2 разворачивается отдельным флагом `CREATOR_DASHBOARD_ENABLED`. Additive
migration `20260820190000_webinar_domain` разделяет `Webinar` и
`WebinarSession`, создаёт стабильный compatibility-Webinar для старой воронки
АСПБ, сохраняет прежние сессии и разрешает одинаковое время запуска у разных
вебинаров. Creator API хранит юридические метаданные и HTTPS-источники,
сохраняет прежний slug в алиасах, предоставляет side-effect-free preview и
проверяет tenant, роль, авторскую верификацию и state machine внутри service
layer. Флаг остаётся `off`, пока базовый кабинет, sessions/recurrence и private
access grants не пройдут свой gate.

## Быстрый запуск

```bash
npm install
docker compose up -d
npx prisma migrate dev
npx prisma generate
npm run seed
npm run dev
```

`npm run dev` выполняет preflight: проверяет MP4, собирает CSS, синхронизирует локальную Prisma-схему и затем запускает backend с авто-перезапуском после неожиданных падений. Рабочий URL берется из `.env` (`PORT`/`PUBLIC_SITE_URL`) и печатается в терминале при старте. Если браузер открыт на старом порту, используйте URL из вывода dev-launcher.

Сайт: `http://127.0.0.1:5174/crisis_premium/index.html`

Админка: `http://127.0.0.1:5174/admin`

Dev-логин берется из `ADMIN_LOGIN` и `ADMIN_PASSWORD` в `.env`; пароль должен быть задан явно.

## Скрипты

```bash
npm run css:build      # Tailwind CSS
npm run build          # TypeScript build
npm test               # Vitest unit/integration
npm run e2e:install    # install Playwright Chromium locally/CI
npm run e2e            # Playwright browser tests
npm audit --omit=dev   # Production dependency audit
npm run check          # build + tests + audit
npm run prisma:deploy  # production migrations
npm run seed           # seed webinar/timeline/admin data
```

На чистой машине перед первым `npm run e2e` выполните:

```bash
npm run e2e:install
```

## Email outbox

После сохранения lead/registration backend создаёт `email_outbox_jobs` и
возвращает одинаковый `202` для нового и уже известного email. Участническая
сессия появляется только после перехода по одноразовой ссылке из письма.

Outbox job хранит:

- `type`, `status`;
- `attempts`, `lastError`, `nextAttemptAt`, `sentAt`;
- registration/session references;
- адресата, дату эфира и non-secret marker для ссылки.

Scheduler раз в минуту отправляет `pending/failed` письма. Непосредственно перед
SMTP worker создаёт raw link только в памяти, а в БД сохраняет лишь hash токена.
При неоднозначной ошибке SMTP предыдущий hash остаётся действующим, retry
выпускает новую короткоживущую ссылку. После terminal-результата outbox marker
редактируется. В development/test при `EMAIL_MODE=log` задача получает статус
`cancelled`: письмо не считается доставленным, а персональные ссылки маскируются
в логе.

Production может временно работать в честном degraded-режиме `EMAIL_MODE=log`:
письмо и доступ не обещаются, API возвращает `deliveryStatus=retrying`.
`EMAIL_MODE=send` включается только после SMTP verify.

## Вебинарная комната

Видео хранится в приватном origin/object storage, заданном через `WEBINAR_VIDEO_URL`/`WEBINAR_VIDEO_HLS_URL`.
Прямой URL пользователю не возвращается: API проксирует поток только после проверки participant session.
Локальные видеофайлы исключены из Docker context и не публикуются статическим сервером.

Каждый день вебинар стартует в 19:30 по Москве. Live-состояние считается на сервере по `webinar_sessions.scheduled_at`, длительности видео и replay window. Во время live работает DVR-режим: пользователь может отмотать назад только в уже прошедшую часть эфира, будущая часть недоступна, а серверный live-edge продолжает идти дальше. Кнопка `К эфиру` возвращает к актуальному live-моменту. После завершения эфир переходит в replay, видео показывает “Вебинар окончен”, а чат остается открытым для вопросов.

Чат server-backed: сообщения и вопросы хранятся в БД, scripted chat синхронизируется с серверным live offset.

Подготовленные вопросы агентов хранятся в `webinar-data/agent-chat-scenario.json`. Для финальной записи:

1. Обновите `WEBINAR_VIDEO_DURATION_SECONDS` в `.env` / production env по фактической длительности файла или HLS-записи.
2. Разметьте ответы в видео и поставьте `sendAtSeconds` у вопросов за 40-70 секунд до `answerStartSeconds`.
3. Не оставляйте сообщения за пределами `WEBINAR_VIDEO_DURATION_SECONDS`, если это не post-webinar сообщение с `allowAfterVideo: true`.
4. Запустите `VIDEO_ENV_FILE=.env.production bash scripts/check-video.sh`: проверка читает фактически настроенный HLS/MP4 source и сверяет его длительность (production default — 3860 секунд).
5. Запустите `npm test` перед публикацией: тесты валидируют сценарий и duration.

## Основные API

Public:

```text
GET  /api/health
GET  /health/live
GET  /health/ready
GET  /health/dependencies
GET  /metrics (production: Authorization: Bearer METRICS_TOKEN)
GET  /docs
GET  /openapi.yml
GET  /api/webinar/current
GET  /api/webinar/timeline/session/current
GET  /api/webinar/chat/session/current
POST /api/register
POST /api/registration/exchange
POST /api/registration/exchange/:token (legacy)
GET  /api/registration/session/current
POST /api/events
POST /api/questions
POST /api/telegram-click
POST /api/partner-application
POST /api/v1/auth/passwordless/request
POST /api/v1/auth/passwordless/consume
GET  /api/v1/auth/session
POST /api/v1/auth/active-organization
POST /api/v1/auth/logout
POST /api/v1/auth/sessions/revoke-all
POST /api/v1/auth/mfa/verify
POST /api/v1/auth/mfa/enrollment/start
POST /api/v1/auth/mfa/enrollment/confirm
POST /api/v1/auth/mfa/disable
POST /api/v1/organization/invitations
GET  /api/v1/organization/invitations
POST /api/v1/organization/invitations/accept
DELETE /api/v1/organization/invitations/:invitationId
PATCH /api/v1/organization/memberships/:membershipId/role
DELETE /api/v1/organization/memberships/:membershipId
GET  /api/v1/author-profile
PATCH /api/v1/author-profile
POST /api/v1/author-verification
POST /api/v1/author-verification/evidence
GET  /api/v1/author-verification/evidence/:evidenceId
DELETE /api/v1/author-verification/evidence/:evidenceId
GET  /api/v1/catalog/authors/:slug
GET  /api/v1/creator/reference-data
GET  /api/v1/creator/webinars
POST /api/v1/creator/webinars
GET  /api/v1/creator/webinars/:webinarId
PATCH /api/v1/creator/webinars/:webinarId
POST /api/v1/creator/webinars/:webinarId/sources
DELETE /api/v1/creator/webinars/:webinarId/sources/:sourceId
GET  /api/v1/creator/webinars/:webinarId/preview
POST /api/v1/creator/webinars/:webinarId/submit
POST /api/v1/creator/webinars/:webinarId/publish
POST /api/v1/creator/webinars/:webinarId/archive
```

Admin:

```text
POST  /api/admin/login
POST  /api/admin/logout
GET   /api/admin/registrations
GET   /api/admin/registrations/:id
PATCH /api/admin/registrations/:id/status
PATCH /api/admin/registrations/:id/note
PATCH /api/admin/registrations/:id/manager
GET   /api/admin/questions
PATCH /api/admin/questions/:id
GET   /api/admin/partner-applications
POST  /api/admin/telegram/broadcast
GET   /api/admin/analytics/summary
GET   /api/v1/platform/author-verifications
GET   /api/v1/platform/author-verifications/:id
PATCH /api/v1/platform/author-verifications/:id
GET   /api/v1/platform/author-verifications/evidence/:evidenceId
```

## Production env

Минимально заполнить:

```text
NODE_ENV=production
PUBLIC_SITE_URL=https://ваш-домен
CORS_ORIGIN=https://ваш-домен
DATABASE_URL=postgresql://...
WORKER_ROLE=api|webinar|all
TRUST_PROXY=1 # если API работает за reverse proxy
ADMIN_LOGIN=...
ADMIN_PASSWORD=...
ADMIN_COOKIE_SECRET=...
IP_HASH_SECRET=...
METRICS_TOKEN=...
EMAIL_MODE=log # degraded до SMTP verify; затем переключить на send
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM=...
TELEGRAM_ADMIN_BOT_TOKEN=...
TELEGRAM_ADMIN_BOT_USERNAME=...
TELEGRAM_ADMIN_CHAT_ID=...
TELEGRAM_PARTICIPANT_BOT_TOKEN=...
TELEGRAM_PARTICIPANT_BOT_USERNAME=...
TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME=... # должен совпадать с username фактического participant bot
WEBINAR_VIDEO_HLS_URL=https://cdn.example.com/webinar/master.m3u8 # optional but preferred
WEBINAR_VIDEO_URL=https://private-cdn.example.com/webinar/webinar.mp4 # private origin, not a public playback URL
WEBINAR_POSTER_URL=https://cdn.example.com/webinar/poster.jpg
WEBINAR_MEDIA_ORIGIN_TOKEN=... # обязателен для внешнего origin; не нужен для same-origin файла из read-only mount
WEBINAR_VIDEO_DURATION_SECONDS=3860
WEBINAR_TEST_ROOM_MODE=off
```

Production guard запрещает дефолтные admin-секреты, пустой `METRICS_TOKEN`, HTTP `PUBLIC_SITE_URL`, wildcard CORS, test-room mode и localhost video URLs. `EMAIL_MODE=log` разрешён как явно degraded-режим без обещания доставки; при `send` обязательны SMTP-реквизиты и предварительный verify. Видео выдаётся только через cookie-защищённые `/api/media/*`: внешний private CDN/origin требует Bearer token, а same-origin файл может читаться приложением из read-only mount без сетевого origin. `DATABASE_URL` должен включать pooling параметры, например `connection_limit=10&pool_timeout=20`. `TRUST_PROXY` включайте только за доверенным reverse proxy. `/health/dependencies` без токена показывает только `checks.smtp`, `checks.telegram` и `checks.emailOutbox` со значениями `ok/degraded` — без ошибок провайдера, username, адресов, heartbeat timestamps и размеров очереди. Полные детали, включая SLA очереди и per-subsystem worker deadlines, доступны по `/health/dependencies/details` с metrics token.

Docker production:

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

Production compose запускает два deployment units из одного image:

- `api` с `WORKER_ROLE=api`: Express, public/admin API, static frontend, `/health/*`, `/metrics`.
- `webinar-worker` с `WORKER_ROLE=webinar`: reminders, email outbox consumer, Telegram polling/news/broadcast worker.

Без `WORKER_ROLE` старый запуск остается совместимым и стартует роль `all`.

## Security/CSP

Helmet включает CSP, frame/object restrictions, COEP/CORP, cookie hardening и rate limits. `script-src` разрешает только self-hosted JS, inline scripts вынесены в отдельные файлы, `script-src-attr 'none'`. Оставшиеся статические inline style blocks/attributes разрешены точечными CSP sha256 hashes без `unsafe-inline`. Cookie-based mutation endpoints защищены double-submit CSRF cookie `aspb_csrf_token` и header `x-csrf-token`. В production admin cookie выставляется как `HttpOnly`, `Secure`, `SameSite=Strict`, `Partitioned`.

Публичные файлы `/.well-known/security.txt` и `/robots.txt` отдаются из static frontend root.

Observability: каждый request получает `x-correlation-id`, pino logs включают `correlation_id`, `userId`/`adminId` где доступны. `/health/ready` проверяет готовность ядра API и БД, `/health/dependencies` публично показывает только категорию неисправного контура (`smtp`, `telegram`, `emailOutbox`) и состояние `ok/degraded`. Подробные checks доступны по `/health/dependencies/details`; он и `/metrics` в production требуют `Authorization: Bearer <METRICS_TOKEN>`.

## QA checklist

- Регистрация создает lead/registration и outbox email job.
- API регистрации успешен при временно недоступном SMTP.
- Success page открывается без token в URL.
- Вход из email/Telegram с одноразовым `webinar.html#token=...` выполняет exchange и очищает URL.
- Повторный exchange того же token возвращает отказ.
- Room state, timeline и chat работают через cookie/session.
- Live-полоска выглядит как live/DVR без серого хвоста до конца видео.
- Во время live можно отмотать назад в уже прошедший буфер; эфир на сервере продолжает идти дальше.
- Кнопка `К эфиру` возвращает зрителя к актуальному live-edge.
- Вопрос отправляется во время live и появляется в CRM/chat.
- После завершения видео показывает “Вебинар окончен”, а чат остается видимым и принимает вопросы.
- Partner application отправляется после доступного состояния и попадает в CRM.
- Admin CRM работает: список регистраций, карточка, статусы, заметки.
- Mutation endpoints с cookie-сессиями без `x-csrf-token` возвращают 403.
- `npm run css:build`, `npm run lint`, `npm run build`, `npm test`, `npm audit --omit=dev` проходят.
- `npm run e2e:install` выполнен хотя бы один раз, затем `npm run e2e` проходит.
