# АСПБ production runbook

Цель документа: запустить платформу АСПБ в production без перегруза лишними инструментами. Базовый production-контур строится вокруг Docker, PostgreSQL, HTTPS, SMTP, Telegram, backup и CI.

## Что входит в lean-production

- Dockerfile для приложения.
- `docker-compose.production.yml` для app + PostgreSQL.
- GitHub Actions CI: install, Prisma generate, build, tests, audit, Docker build.
- Strict production env guard в backend.
- Healthcheck `/api/health`.
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

3. Проверить, что:

- `NODE_ENV=production`
- `EMAIL_MODE=send`
- `WEBINAR_TEST_ROOM_MODE=off`
- `PUBLIC_SITE_URL` начинается с `https://`
- `.env.production` не добавлен в Git

## Локальная проверка production image

```bash
docker build -t aspb-autowebinar:local .
```

## Запуск через Docker Compose

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

Приложение само выполнит:

```bash
npx prisma migrate deploy
node dist/server.js
```

Проверка:

```bash
curl https://ваш-домен/api/health
```

Ожидаемый ответ:

```json
{"ok":true,"service":"aspb-autowebinar"}
```

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
- `npm run build`
- `npm test`
- `npm audit --omit=dev`
- `docker build`

Для автоматического deploy нужен следующий отдельный шаг: добавить GitHub Actions job, который по push в `main` подключается к серверу по SSH и выполняет `docker compose pull/up` или rebuild.

## Минимальный production checklist

- [ ] Домен подключен.
- [ ] HTTPS работает.
- [ ] `.env.production` заполнен реальными значениями.
- [ ] `EMAIL_MODE=send`.
- [ ] SMTP протестирован.
- [ ] Telegram participant bot протестирован.
- [ ] Telegram admin bot протестирован.
- [ ] `WEBINAR_TEST_ROOM_MODE=off`.
- [ ] `npm run check` проходит локально.
- [ ] GitHub Actions CI проходит.
- [ ] Docker image собирается.
- [ ] `docker compose --env-file .env.production -f docker-compose.production.yml up -d --build` запускается.
- [ ] `/api/health` отвечает.
- [ ] Регистрация создает lead/registration.
- [ ] Success page открывается.
- [ ] Webinar room открывается по персональной ссылке.
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

- frontend build pipeline вместо CDN/inline;
- Sentry;
- uptime monitoring;
- Prometheus/Grafana или простой лог-агрегатор;
- webhooks в CRM;
- weekly Telegram reports;
- A/B-тесты.
