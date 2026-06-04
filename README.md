# АСПБ Автовебинар

Платформа автовебинара АСПБ: статический frontend в `crisis_premium`, Node.js/TypeScript backend, PostgreSQL/Prisma, CRM-админка, серверный live-тайминг, чат, вопросы, партнерские заявки, email outbox и Telegram-уведомления.

## Архитектура доступа

Доступ в вебинарную комнату cookie-only:

- письмо или Telegram могут содержать одноразовый `exchange-token` в `webinar.html?token=...`;
- frontend сразу вызывает `POST /api/registration/exchange/:token`;
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

## Основные API

Public:

```text
GET  /api/health
GET  /api/webinar/current
GET  /api/webinar/timeline/session/current
GET  /api/webinar/chat/session/current
POST /api/register
POST /api/registration/exchange/:token
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
ADMIN_LOGIN=...
ADMIN_PASSWORD=...
ADMIN_COOKIE_SECRET=...
IP_HASH_SECRET=...
EMAIL_MODE=send
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM=...
WEBINAR_TEST_ROOM_MODE=off
```

Production guard запрещает дефолтные admin-секреты, `EMAIL_MODE=log`, HTTP `PUBLIC_SITE_URL`, wildcard CORS и test-room mode.

Docker production:

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

## Security/CSP

Helmet включает CSP, frame/object restrictions, cookie hardening и rate limits. Inline event handlers убраны; `script-src-attr 'none'`. Inline script/style blocks еще есть в статических страницах, поэтому `unsafe-inline` для script/style elements пока остается как зафиксированный долг до frontend build pipeline.

## QA checklist

- Регистрация создает lead/registration и outbox email job.
- API регистрации успешен при временно недоступном SMTP.
- Success page открывается без token в URL.
- Вход в `webinar.html?token=...` выполняет exchange и очищает URL.
- Повторный exchange того же token возвращает отказ.
- Room state, timeline и chat работают через cookie/session.
- Live-полоска выглядит как live/DVR без серого хвоста до конца видео.
- Во время live можно отмотать назад в уже прошедший буфер; эфир на сервере продолжает идти дальше.
- Кнопка `К эфиру` возвращает зрителя к актуальному live-edge.
- Вопрос отправляется во время live и появляется в CRM/chat.
- После завершения видео показывает “Вебинар окончен”, а чат остается видимым и принимает вопросы.
- Partner application отправляется после доступного состояния и попадает в CRM.
- Admin CRM работает: список регистраций, карточка, статусы, заметки.
- `npm run css:build`, `npm run lint`, `npm run build`, `npm test`, `npm audit --omit=dev` проходят.
- `npm run e2e:install` выполнен хотя бы один раз, затем `npm run e2e` проходит.
