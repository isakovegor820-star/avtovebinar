# АСПБ: актуальный production-readiness audit

Дата обновления: 3 июня 2026

Этот документ заменяет исторический аудит от 26 мая 2026. Старые пункты про постоянный `webinar.html?token=...`, production-хранение room token в `localStorage`, отсутствие integration/e2e и прямую зависимость регистрации от SMTP больше не актуальны.

## Текущий статус

Платформа перешла на cookie-only доступ в вебинарную комнату:

- ежедневный webinar slot стартует в 19:00 по Москве;
- во время live включен DVR-режим: можно отмотать назад в уже прошедший эфир, но нельзя смотреть будущую часть;
- одноразовый exchange-token может прийти в URL только для первичного обмена;
- `POST /api/registration/exchange/:token` удаляет exchange-token и ставит `HttpOnly` cookie `aspb_room_token`;
- frontend очищает URL после exchange;
- room state, timeline, chat, questions, events и partner application работают через cookie/session endpoints;
- legacy routes `/api/registration/:token`, `/api/webinar/timeline/:token`, `/api/webinar/chat/:token` отключены.

Email-доставка переведена на outbox:

- регистрация сохраняет lead/registration/tokens/email job в одной транзакции;
- API регистрации не падает при временной SMTP-ошибке;
- `email_outbox_jobs` хранит `status`, `attempts`, `lastError`, `nextAttemptAt`, `sentAt`;
- scheduler отправляет `pending/failed` jobs и повторяет ошибки;
- повторная регистрация заменяет старые `pending/failed` `registration_confirmation` jobs и сохраняет уже `sent` историю.

Тесты усилены:

- Vitest покрывает cookie-only API, one-time exchange, questions, partner application, admin flow и email outbox retry/replace;
- Playwright e2e покрывает регистрацию, success, room через cookie/session, очистку token из URL, live/DVR UI, pause/resume, chat, question, partner application и ended-chat state;
- CI устанавливает Chromium через `npx playwright install --with-deps chromium` и запускает e2e.

## Оценка готовности

| Направление | Оценка | Комментарий |
| --- | ---: | --- |
| Frontend | 8/10 | Основной user flow работает, но остаются inline script/style blocks. |
| Backend API | 8.5/10 | Cookie-only room access и outbox закрывают главные P0/P1 риски. |
| Admin/CRM | 7/10 | CRM рабочая, но action-flow и UX можно усилить. |
| Email | 8/10 | Outbox/retry есть; нужны HTML-шаблоны и мониторинг failed jobs. |
| Автовебинар | 8.5/10 | Server-backed live/chat flow покрыт e2e. |
| Безопасность | 7.5/10 | Legacy token routes убраны, CSP сужен; полный отказ от `unsafe-inline` еще впереди. |
| Тесты | 8/10 | Есть unit/integration/browser coverage критического пути. |
| Production readiness | 7.5/10 | Docker/runbook/CI есть; нужны monitoring/alerting и финальный CSP hardening. |

## Закрытые прежние риски

- Replay window приведен к 7 дням.
- Production guard запрещает `EMAIL_MODE=log`, test-room mode и слабые secrets.
- Room token не хранится в frontend `localStorage`; старый `crisisPremiumToken` только очищается.
- Registration/reminder tokens получают `expiresAt`.
- Email log маскирует персональные ссылки.
- Критический путь покрыт integration и browser e2e.
- README и runbook описывают текущую cookie-only архитектуру.

## Оставшиеся риски

### P1. CSP все еще частично зависит от `unsafe-inline`

Inline event handlers убраны, `script-src-attr 'none'` включен. Но статические HTML-страницы все еще содержат inline script/style blocks, поэтому `script-src`/`style-src` пока сохраняют `unsafe-inline`.

Следующий шаг: вынести оставшиеся inline blocks в отдельные JS/CSS файлы или внедрить nonce/hash pipeline.

### P1. Мониторинг email outbox

Outbox durable, но production должен видеть зависшие/исчерпавшие retries jobs.

Следующий шаг: добавить admin/ops view или alert по `email_outbox_jobs.status='failed'`, `attempts`, `nextAttemptAt`.

### P1. Jobs работают внутри backend process

Scheduler запускается внутри backend. Для одного инстанса это нормально, advisory lock снижает риск дублей, но для зрелого production лучше выделить worker/process.

Следующий шаг: отдельный worker service в compose или managed queue.

### P2. Frontend без сборки

Статические HTML/JS ускорили MVP, но мешают строгому CSP, компонентной структуре и asset fingerprinting.

Следующий шаг: легкий build pipeline или последовательный вынос inline blocks.

### P2. Admin UX

CRM полезна, но требует дальнейшего polish: массовые действия, фильтры, SLA/next contact workflow, outbox visibility.

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
- миграции через `npm run prisma:deploy`;
- backup/restore procedure;
- мониторинг healthcheck, logs и email outbox.
