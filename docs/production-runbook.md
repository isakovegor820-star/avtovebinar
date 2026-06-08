# АСПБ production runbook

Цель документа: запустить платформу АСПБ в production без перегруза лишними инструментами. Базовый production-контур строится вокруг Docker, PostgreSQL, HTTPS, SMTP, Telegram, backup и CI.

## Что входит в lean-production

- Dockerfile для приложения.
- `docker-compose.production.yml` для `api`, `webinar-worker` и PostgreSQL.
- GitHub Actions CI: install, Prisma generate, migrate deploy, seed, build, tests, audit, Docker build, dependency-review, Semgrep, secretlint, dotenv-linter и staging deploy.
- Strict production env guard в backend.
- Healthchecks `/health/live`, `/health/ready`; dependency status `/health/dependencies`; Prometheus metrics `/metrics`.
- Cookie-only доступ в вебинарную комнату через `HttpOnly` cookie `aspb_room_token`.
- Одноразовый exchange-token в письмах/Telegram-ссылках; URL очищается после exchange.
- Email outbox: регистрация не падает из-за временной SMTP-ошибки.
- Durable Telegram broadcast worker с retry/backoff и dead-letter queue.
- PostgreSQL backup/restore scripts.
- Production checklist для ручного запуска.

Что сознательно не включено в первую production-итерацию:

- A/B-тесты лендинга.
- AmoCRM/Bitrix24 webhook.
- Guided tour по админке.
- Еженедельные Telegram-отчеты.
- Полная frontend-сборка вместо статических HTML.

Эти задачи полезны, но не должны блокировать первый запуск.

## Production env

1. Скопировать пример:

```bash
cp .env.production.example .env.production
```

2. Заполнить реальные значения:

- `PUBLIC_SITE_URL=https://ваш-домен`
- `CORS_ORIGIN=https://ваш-домен`
- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `ADMIN_LOGIN`
- `ADMIN_PASSWORD`
- `ADMIN_COOKIE_SECRET`
- `IP_HASH_SECRET`
- SMTP-поля
- Telegram bot tokens и usernames
- `WORKER_ROLE=api` для API container, `WORKER_ROLE=webinar` для worker container
- `TRUST_PROXY=1`, если API стоит за Nginx/reverse proxy

3. Проверить, что:

- `NODE_ENV=production`
- `EMAIL_MODE=send`
- `WEBINAR_TEST_ROOM_MODE=off`
- `PUBLIC_SITE_URL` начинается с `https://`
- `.env.production` не добавлен в Git
- `DATABASE_URL` содержит pooling параметры `connection_limit` и `pool_timeout`
- `TRUST_PROXY` включен только за доверенным reverse proxy

## Миграции и seed

Для production deploy используются миграции:

```bash
npm run prisma:deploy
```

Seed нужен только при первичной подготовке demo/default данных:

```bash
npm run seed
```

Не запускайте `prisma migrate dev` на production.

## Локальная проверка production image

```bash
docker build -t aspb-autowebinar:local .
```

## Запуск через Docker Compose

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

API container сам выполнит:

```bash
npx prisma migrate deploy
WORKER_ROLE=api node dist/server.js
```

Worker container запускает `WORKER_ROLE=webinar node dist/server.js` и не открывает HTTP-порт.

Проверка:

```bash
curl https://ваш-домен/health/ready
curl https://ваш-домен/health/dependencies
curl https://ваш-домен/metrics
```

Ожидаемый ответ:

```json
{"service":"aspb-autowebinar","ok":true,"checks":{"database":{"ok":true}}}
```

`/health/dependencies` отдельно показывает состояние внешних SMTP/Telegram и не должен использоваться как основной container readiness.

## SSL

Минимальный вариант для VPS:

1. Поставить Nginx.
2. Настроить reverse proxy на `127.0.0.1:5174`.
3. Выпустить сертификат Let's Encrypt через Certbot.
4. В `.env.production` указать `PUBLIC_SITE_URL=https://ваш-домен`.

## Backup

Создать backup:

```bash
npm run backup:db
```

Или для production compose:

```bash
COMPOSE_FILE=docker-compose.production.yml npm run backup:db
```

Файлы сохраняются в `backups/`.

Восстановить backup:

```bash
npm run restore:db -- backups/aspb-postgres-YYYYMMDDTHHMMSSZ.sql.gz
```

Перед реальным запуском нужно один раз проверить восстановление на тестовой базе.

## CI/CD

CI уже добавлен в `.github/workflows/ci.yml`.

Он проверяет:

- `npm ci`
- `npx prisma generate`
- `npx prisma migrate deploy`
- `npm run seed`
- `npm run build`
- `npm test`
- `npx playwright install --with-deps chromium`
- `npm run e2e`
- `npm audit --omit=dev`
- `docker build`
- dependency review для PR
- Semgrep SAST
- secretlint и dotenv-linter
- staging deploy по push в `main` через SSH secrets

## Проверки перед deploy

```bash
npm run css:build
npm run lint
npm run build
npm test
npm audit --omit=dev
npm run e2e:install
npm run e2e
```

`npm run e2e:install` ставит Playwright Chromium. В CI используется эквивалентная команда `npx playwright install --with-deps chromium`. `npm run e2e` поднимает Playwright browser checks для регистрации, success page, cookie/session входа в комнату, очистки token из URL, live/DVR поведения, чата, вопроса и partner application.

## Ручная product QA

1. Открыть landing/register page.
2. Зарегистрировать нового пользователя.
3. Проверить success page и отсутствие `token` в URL.
4. Перейти в webinar room.
5. Проверить, что room/timeline/chat работают через cookie/session.
6. В live-состоянии проверить DVR: отмотку назад в прошедший буфер, отсутствие доступа к будущему видео и кнопку `К эфиру`.
7. Отправить вопрос и увидеть его в чате/CRM.
8. Дождаться/смоделировать завершение эфира и проверить “Вебинар окончен” на видео и открытый чат.
9. Отправить partner application и увидеть заявку в CRM.
10. Проверить admin CRM: карточка регистрации, статусы, заметки, заявки, вопросы.

## Минимальный production checklist

- [ ] Домен подключен.
- [ ] HTTPS работает.
- [ ] `.env.production` заполнен реальными значениями.
- [ ] `EMAIL_MODE=send`.
- [ ] SMTP протестирован.
- [ ] Telegram participant bot протестирован.
- [ ] Telegram admin bot протестирован.
- [ ] `WEBINAR_TEST_ROOM_MODE=off`.
- [ ] `npm run css:build` проходит.
- [ ] `npm run lint` проходит.
- [ ] `npm run build` проходит.
- [ ] `npm test` проходит.
- [ ] `npm audit --omit=dev` проходит.
- [ ] `npm run e2e:install` выполнен.
- [ ] `npm run e2e` проходит.
- [ ] GitHub Actions CI проходит.
- [ ] Docker image собирается.
- [ ] `docker compose --env-file .env.production -f docker-compose.production.yml up -d --build` запускается.
- [ ] `/api/health` отвечает.
- [ ] Регистрация создает lead/registration.
- [ ] Регистрация создает `email_outbox_jobs` запись.
- [ ] Временная SMTP-ошибка не ломает регистрацию, failed job остается в outbox.
- [ ] Success page открывается.
- [ ] Webinar room открывается по персональной exchange-ссылке, после exchange URL без token.
- [ ] Вопрос попадает в CRM.
- [ ] Заявка на партнерский договор попадает в CRM.
- [ ] Backup создан.
- [ ] Restore проверен на тестовой базе.

## Rollback

Если deploy сломал production:

1. Остановить текущий app container.
2. Вернуть предыдущий Git commit/tag.
3. Пересобрать image.
4. Запустить compose.
5. Проверить `/api/health`.
6. Если миграция уже изменила БД и rollback невозможен кодом, восстановить последнюю проверенную копию backup.

## Следующий уровень после lean-production

После первого запуска можно делать:

- frontend build pipeline вместо CDN/остаточных inline style attributes;
- автоматическая регенерация CSP style hashes в CI;
- Sentry;
- uptime monitoring;
- Prometheus/Grafana или простой лог-агрегатор;
- webhooks в CRM;
- weekly Telegram reports;
- A/B-тесты.
