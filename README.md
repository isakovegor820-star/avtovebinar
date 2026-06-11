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

Регистрация не зависит от успешной SMTP-отправки. После сохранения lead/registration backend создает запись в `email_outbox_jobs` и сразу возвращает успех пользователю.

Outbox job хранит:

- `type`, `status`;
- `attempts`, `lastError`, `nextAttemptAt`, `sentAt`;
- registration/session references;
- адресата, дату эфира и персональную exchange-ссылку.

Scheduler раз в минуту отправляет `pending/failed` письма. При ошибке SMTP задача остается в БД со статусом `failed` и будет повторена позже. В `EMAIL_MODE=log` письмо считается обработанным, но персональные ссылки маскируются в логе.

Production требует `EMAIL_MODE=send` и валидный SMTP.

## Вебинарная комната

Видео ожидается здесь:

```text
crisis_premium/assets/webinar.mp4
```

Каждый день вебинар стартует в 19:00 по Москве. Live-состояние считается на сервере по `webinar_sessions.scheduled_at`, длительности видео и replay window. Во время live работает DVR-режим: пользователь может отмотать назад только в уже прошедшую часть эфира, будущая часть недоступна, а серверный live-edge продолжает идти дальше. Кнопка `К эфиру` возвращает к актуальному live-моменту. После завершения эфир переходит в replay, видео показывает “Вебинар окончен”, а чат остается открытым для вопросов.

Чат server-backed: сообщения и вопросы хранятся в БД, scripted chat синхронизируется с серверным live offset.

Подготовленные вопросы агентов хранятся в `webinar-data/agent-chat-scenario.json`. Для финальной записи:

1. Обновите `WEBINAR_VIDEO_DURATION_SECONDS` в `.env` / production env по фактической длительности файла или HLS-записи.
2. Разметьте ответы в видео и поставьте `sendAtSeconds` у вопросов за 40-70 секунд до `answerStartSeconds`.
3. Не оставляйте сообщения за пределами `WEBINAR_VIDEO_DURATION_SECONDS`, если это не post-webinar сообщение с `allowAfterVideo: true`.
4. Запустите `npm test` перед публикацией: тесты валидируют сценарий и duration.

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
EMAIL_MODE=send
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
WEBINAR_VIDEO_HLS_URL=https://cdn.example.com/webinar/master.m3u8 # optional but preferred
WEBINAR_VIDEO_URL=https://cdn.example.com/webinar/webinar.mp4 # allowed production MP4 fallback/source
WEBINAR_POSTER_URL=https://cdn.example.com/webinar/poster.jpg
WEBINAR_VIDEO_DURATION_SECONDS=3860
WEBINAR_TEST_ROOM_MODE=off
```

Production guard запрещает дефолтные admin-секреты, пустой `METRICS_TOKEN`, `EMAIL_MODE=log`, HTTP `PUBLIC_SITE_URL`, wildcard CORS, test-room mode и localhost video URLs. `DATABASE_URL` должен включать pooling параметры, например `connection_limit=10&pool_timeout=20`. `TRUST_PROXY` включайте только при запуске за доверенным reverse proxy. `/health/dependencies` сверяет Telegram `getMe.username` с настроенными bot usernames.

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

Observability: каждый request получает `x-correlation-id`, pino logs включают `correlation_id`, `userId`/`adminId` где доступны. `/health/ready` проверяет готовность ядра API и БД, `/health/dependencies` отдельно проверяет SMTP/Telegram. `/metrics` отдает Prometheus text format: request counters/duration, 5xx rate alert state, email outbox depth, Telegram broadcast queue/dead-letter depth; в production endpoint требует `Authorization: Bearer <METRICS_TOKEN>`.

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
