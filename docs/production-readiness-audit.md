# АСПБ: аудит готовности к production

Дата аудита: 26 мая 2026

Цель: зафиксировать текущее состояние платформы автовебинара АСПБ, отделить уже готовые части от рисков и определить порядок работ до production-ready уровня.

## Короткий вывод

Проект уже вышел за рамки статического MVP: есть рабочий backend, PostgreSQL/Prisma-модель, регистрация, токены доступа, вебинарная комната, Telegram-связка, email/reminder-логика, CRM-админка, юридические страницы и базовые тесты.

Главный риск сейчас не в том, что система “не работает”, а в том, что она пока не выдерживает требования реального запуска на 10/10: не хватает строгого production-режима, интеграционных/e2e-тестов, полного контроля токенов, точной автовебинарной политики, надежной аналитики и production-деплоя.

Текущая оценка после аудита:

| Направление | Оценка | Комментарий |
| --- | ---: | --- |
| Frontend | 7.5/10 | Воронка собрана, но нужен финальный responsive/CTA/text polish и снижение inline-risk. |
| Backend API | 7/10 | Основные сценарии есть, но routes перегружены, не все ответы/ошибки унифицированы. |
| Admin/CRM | 7/10 | Уже полезная CRM, но нужна более сильная карточка лида, фильтры и action-flow. |
| Telegram | 7/10 | Два бота и binding есть, но нужен production-контроль, очереди/ретраи и управление рассылками. |
| Email | 6.5/10 | SMTP/log mode и reminders есть, но нужны HTML-шаблоны, prod guard и контроль дублей/логов. |
| Автовебинар | 7/10 | Видео, timeline и access-status есть, но политика replay и video analytics не доведены. |
| Безопасность | 6.5/10 | Есть env guard/rate-limit/cookies, но остаются localStorage-token risk, unsafe-inline и log-mode risks. |
| Тесты | 5/10 | Unit-тесты проходят, но почти нет integration/browser покрытия. |
| Production readiness | 4.5/10 | Локально стабильно, но нет полного deploy/monitoring/backup/CI контура. |

## Что уже готово

### Frontend

- Основные страницы лежат в `crisis_premium`: `index.html`, `register.html`, `success.html`, `webinar.html`, `privacy.html`, `terms.html`, `consent.html`.
- Лендинг уже переписан под юристов и АСПБ.
- Регистрация подключена к API через `crisis_premium/aspb-api.js`.
- После регистрации появляется доступ к вебинару через `crisis_premium/flow-tabs.js`.
- В комнате есть MP4-плеер, честные смысловые подсказки вместо фейкового чата, форма вопроса и финальный CTA.

### Backend

- Express + TypeScript сервер: `src/server.ts`.
- Public routes: `src/routes/public.ts`.
- Admin routes: `src/routes/admin.ts`.
- Zod validation уже используется в ключевых endpoint'ах.
- Prisma schema включает лиды, вебинары, регистрации, токены, вопросы, события, заявки на договор, timeline, admin users, audit logs, news posts.

### Security

- `helmet` включен.
- Есть CORS-поведение для dev/prod.
- Есть rate-limit для register, questions, partner application, events, telegram-click, registration/timeline и admin login.
- Production env guard проверяет дефолтный admin и слабые secrets.
- Admin cookie `httpOnly`, в production `secure`, `sameSite=strict`.
- Access tokens хранятся hash-ами.

### Автовебинар

- Есть расчет `waiting / pre_live / live / replay / closed`.
- Есть server-based scheduled time.
- Есть test-room mode для локальной проверки.
- Есть timeline endpoint и seed timeline.
- MP4 ожидается в `crisis_premium/assets/webinar.mp4`.

### Telegram

- Разделены admin bot и participant bot.
- Участник может привязать Telegram к регистрации через `/start <token>`.
- Повторный `/start` узнает участника и выдает ссылку.
- Менеджер получает уведомления о регистрациях, вопросах, заявках и Telegram-подключении.
- Есть новости/полезные материалы через participant bot.

### Email/reminders

- Есть SMTP/log mode.
- Есть подтверждение регистрации.
- Есть reminders за 24 часа, 3 часа, 30 минут.
- Post-webinar follow-up считается после окончания вебинара, а не после старта.

### Tests

- `npm run build` проходит.
- `npm test` проходит.
- `npm audit --omit=dev` показывает 0 vulnerabilities.
- Unit-тесты покрывают time access, token hash, env guard, reminders, analytics allowlist, CRM statuses, news slots.

## P0: блокеры перед реальным production-запуском

### P0.1. Несовпадение политики replay

Требование: запись доступна 7 дней после эфира.

Факт по коду:

- `src/lib/time.ts` задает `WEBINAR_REPLAY_HOURS = 48`.
- `src/routes/public.ts` создает webinar session с `replayAvailableHours: 48`.
- `prisma/schema.prisma` держит default 48.

Риск: пользователь и менеджер ожидают доступ 7 дней, а система закроет запись через 48 часов. Это ломает обещание продукта.

Решение: поднять replay до 168 часов, покрыть unit/integration тестами `live → replay → expired`.

### P0.2. Token все еще может сохраняться в localStorage не только в dev

Факт:

- `crisis_premium/aspb-api.js` хранит token в `localStorage` только для `file:`, `localhost`, `127.0.0.1`.
- Но `crisis_premium/flow-tabs.js` читает и пишет `crisisPremiumToken` в `localStorage` без такой проверки.

Риск: в production боевой token может оказаться в открытом JS-хранилище, хотя целевая архитектура требует `HttpOnly` cookie.

Решение: вынести единый storage helper или запретить запись token в `localStorage` вне dev/local origin.

### P0.3. Email/log mode может остаться в production

Факт:

- `EMAIL_MODE=log` является дефолтом.
- В log mode письмо не отправляется, а в консоль попадают email, тема и персональные ссылки.
- Production env guard не запрещает `EMAIL_MODE=log`.

Риск: на реальном запуске пользователи не получат письма, а персональные ссылки могут попасть в логи.

Решение: в production требовать `EMAIL_MODE=send` и валидный SMTP, либо явно разрешать log mode только через отдельный unsafe-флаг.

### P0.4. Нет integration/e2e-покрытия критического пути

Факт:

- Есть unit-тесты, но нет полноценной проверки `registration → success → room → question → admin`.
- Нет browser/e2e тестов waiting/live/replay/expired.

Риск: отдельные функции проходят тесты, но вся воронка может сломаться незаметно.

Решение: добавить integration-тесты API и browser QA/e2e для основных сценариев.

### P0.5. Нет production deploy-контура

Факт:

- Локальный запуск описан.
- Есть Docker Compose для PostgreSQL.
- Нет полного production-пакета: домен/SSL/process manager/backups/monitoring/CI deploy/rollback.

Риск: проект нельзя считать 10/10 до стабильного запуска на сервере.

Решение: отдельный этап deploy readiness: Dockerfile или PaaS config, secrets, migrations, backups, logs, monitoring, rollback.

## P1: высокие риски и важные улучшения

### P1.1. CSP пока зависит от `unsafe-inline`

Факт:

- `src/server.ts` включает Helmet CSP, но оставляет inline scripts/styles.
- Frontend содержит много inline scripts и Tailwind CDN.

Риск: CSP уже лучше, чем ничего, но для production с PII/admin это недостаточно строго.

Решение: постепенно выносить JS/CSS в файлы, вводить nonce/hash или полноценную frontend-сборку.

### P1.2. В проекте еще есть `innerHTML`-паттерны

Факт:

- Admin UI в основном строит пользовательские данные через `textContent`.
- Но `crisis_premium/aspb-api.js` и `crisis_premium/flow-tabs.js` все еще используют `innerHTML` для крупных шаблонов.

Риск: часть данных сейчас системная/контролируемая, но паттерн опасен и легко может стать XSS при расширении.

Решение: заменить шаблонные вставки пользовательских данных на DOM nodes/textContent или экранирование.

### P1.3. Access token lifecycle неполный

Факт:

- `RegistrationToken.expiresAt` есть в БД.
- Но новые registration/reminder tokens часто создаются без `expiresAt`.
- Проверка `expiresAt` уже реализована, но не используется полноценно.

Риск: старые ссылки живут дольше, чем нужно, если логика replay/room меняется.

Решение: задавать expiresAt для email/telegram/room tokens согласно purpose: registration, reminder, replay.

### P1.4. Legacy admin login path остается в admin route

Факт:

- Production guard запрещает дефолтные admin/admin123.
- Но `/api/admin/login` все еще поддерживает fallback на `ADMIN_LOGIN/ADMIN_PASSWORD`.

Риск: смешанная модель auth усложняет контроль и аудит.

Решение: оставить DB admin users как основной способ, legacy env login ограничить dev-режимом или удалить после миграции.

### P1.5. Логи могут содержать PII или персональные ссылки

Факт:

- Email log mode печатает email и webinar URL.
- Telegram log mode печатает chat/text.
- `src/lib/http.ts` логирует raw unknown error.

Риск: в production лог может стать источником утечки.

Решение: в production маскировать PII, не логировать tokens/URLs, добавить structured logger с redaction.

### P1.6. Public analytics allowlist неполный

Факт:

- Public allowlist сейчас содержит только `page_view`, `registration_click`, `registration_form_open`, `partner_request_click`.
- Требуемые video events и часть funnel events не доступны публичному frontend.

Риск: админка не увидит точную эффективность вебинара.

Решение: добавить allowlist для `video_start`, `video_progress_25/50/75`, `video_finish`, `telegram_subscribe`, `registration_success` там, где это безопасно и нужно.

### P1.7. Routes перегружены бизнес-логикой

Факт:

- `src/routes/public.ts` и `src/routes/admin.ts` содержат много бизнес-логики прямо в route handlers.

Риск: труднее тестировать, выше шанс регрессий.

Решение: вынести registration, access, reminders, telegram binding, admin CRM в service-слои.

## P2: архитектурные долги

### P2.1. Frontend без сборки

Сейчас статические HTML/JS удобны для скорости, но мешают строгому CSP, компонентной структуре, e2e-тестам и масштабированию.

Рекомендация: после стабилизации MVP перейти на легкую сборку или хотя бы вынести inline JS/CSS в отдельные файлы.

### P2.2. Admin UI встроен в backend route

Admin page сейчас генерируется из `src/routes/admin.ts`, что быстро для MVP, но неудобно для сложной CRM.

Рекомендация: выделить admin frontend в отдельные статические файлы или небольшой SPA.

### P2.3. Email-шаблоны пока базовые

Нужно добавить HTML-письма, preheader, нормальные CTA, fallback text, тест отправки и preview.

### P2.4. Telegram/news scheduler без промышленной очереди

Сейчас scheduler работает внутри backend процесса.

Рекомендация: для production вынести jobs в отдельный worker или добавить durable job-механику, ретраи, backoff, lock от дублей.

### P2.5. Нет мониторинга и operational playbook

Нужны health checks, structured logs, error monitoring, backup restore instructions, migration procedure и rollback plan.

## Быстрые улучшения

1. Поменять replay с 48 часов на 168 часов и добавить тесты.
2. Починить `flow-tabs.js`, чтобы token не сохранялся в `localStorage` на production-домене.
3. Расширить analytics allowlist и добавить video progress events.
4. В production запретить `EMAIL_MODE=log` без явного unsafe-флага.
5. Добавить `expiresAt` для новых room/reminder tokens.
6. Маскировать tokens/PII в логах.
7. Добавить Express integration tests для регистрации, token access, вопросов и partner application.
8. Заменить рискованные `innerHTML` с динамическими данными.
9. Обновить README: production env, deploy checklist, security checklist.
10. Добавить browser QA сценарии для desktop/mobile.

## Карта production-рисков

| Зона | Готово | Риск | Приоритет |
| --- | --- | --- | --- |
| Регистрация | Да | Нужно integration-покрытие и duplicate policy polish | P1 |
| Token access | Частично | `flow-tabs.js` localStorage в production | P0 |
| Webinar room | Частично | Replay 48h вместо 7 дней, нет video analytics | P0/P1 |
| Admin auth | Частично | Legacy env login path, нужен финальный auth policy | P1 |
| Admin UI | Частично | Нужны более сильные карточки/фильтры/action-flow | P1 |
| Telegram | Частично | Нужны production guards, ретраи, контроль рассылок | P1 |
| Email | Частично | Log mode и PII в логах могут попасть в production | P0/P1 |
| Analytics | Частично | Нет полной funnel/video картины | P1 |
| Tests | Частично | Нет integration/e2e | P0 |
| Deploy | Нет | Нужен полный production контур | P0 |

## Рекомендованный порядок следующих изменений

1. Security + access hotfix:
   - replay 168h;
   - token storage guard;
   - production email/log guard;
   - token expiresAt;
   - masked logs.
2. Integration tests:
   - registration → success;
   - waiting/live/replay/expired;
   - question submit;
   - partner application;
   - admin auth/rate-limit.
3. Webinar analytics:
   - video_start/progress/finish;
   - admin funnel metrics.
4. Frontend hardening:
   - remove risky innerHTML;
   - CTA/text/mobile polish;
   - legal links and consent QA.
5. Admin CRM upgrade:
   - hot leads;
   - lead card;
   - action buttons;
   - event history.
6. Telegram/email production:
   - robust reminders;
   - safe logs;
   - admin controls;
   - news delivery tracking.
7. Production deploy:
   - domain/SSL;
   - production PostgreSQL;
   - backup/restore;
   - process manager;
   - monitoring;
   - CI/CD.

## Проверка этапа аудита

Команды, которые должны проходить после этапа:

```bash
npm run build
npm test
npm audit --omit=dev
```

Текущий результат аудита:

- build: проходит;
- tests: проходят;
- audit: 0 vulnerabilities.

## Definition of Done для перехода к этапу 2

Этап 1 считается закрытым, если:

- карта рисков сохранена в репозитории;
- P0/P1/P2 понятны команде;
- build/test/audit проходят;
- изменения закоммичены и отправлены в GitHub;
- следующий этап начинается с security + webinar access hotfix, без хаотичных правок.
