# АСПБ Автовебинар

Рабочий проект для платформы автовебинара АСПБ — “Антикризисная служба помощи бизнесу”.

Внутри:
- frontend из 4 страниц в `crisis_premium`;
- Node.js + TypeScript backend;
- PostgreSQL + Prisma;
- регистрация с персональным токеном;
- SMTP/email-log и цепочка напоминаний 24 часа / 3 часа / 30 минут;
- вебинарная комната по ссылке `webinar.html?token=...` с MP4-плеером и таймлайном;
- вопросы к эксперту;
- CRM admin-панель с партнерской воронкой, заметками и заявками на договор;
- события аналитики.

## Быстрый запуск

1. Установить зависимости:

```bash
npm install
```

2. Запустить PostgreSQL:

```bash
docker compose up -d
```

3. Применить миграции и сгенерировать Prisma Client:

```bash
npx prisma migrate dev
npx prisma generate
```

4. Запустить проект:

```bash
npm run dev
```

Сайт:

```text
http://127.0.0.1:5174/crisis_premium/index.html
```

Админка:

```text
http://127.0.0.1:5174/admin
```

Логин по умолчанию из `.env`:

```text
admin / admin123
```

## Основные API

```text
GET  /api/health
GET  /api/webinar/current
GET  /api/webinar/timeline/:token
POST /api/register
GET  /api/registration/:token
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
GET   /api/admin/questions
PATCH /api/admin/questions/:id
GET   /api/admin/partner-applications
POST  /api/admin/telegram/broadcast
GET   /api/admin/analytics/summary
```

## Email

По умолчанию включен режим:

```text
EMAIL_MODE=log
```

В этом режиме письмо не отправляется, а ссылка на вебинарную комнату печатается в консоль backend.

Для реальной отправки нужно указать SMTP-параметры и поставить:

```text
EMAIL_MODE=send
```

После регистрации отправляется подтверждение. Scheduler внутри backend раз в минуту проверяет ближайшие эфиры и отправляет напоминания за 24 часа, 3 часа и 30 минут. Для каждого reminder создается новый персональный token, который тоже ведет в комнату.

## Автовебинар

Комната ожидает файл:

```text
crisis_premium/assets/webinar.mp4
```

Если файла пока нет, страница покажет аккуратную заглушку, но token-доступ, таймлайн, вопросы и заявка на договор уже работают.

Таймлайн хранится в `webinar_timeline_events` и засевается из `prisma/seed.ts`. Основные этапы: старт, рынок, проблемные клиенты, АСПБ, модель партнерства, договор, финальный CTA.

Доступ к комнате строгий:

```text
waiting → live → replay → expired
```

До старта участник видит экран ожидания. Во время эфира видео синхронизируется с серверным временем. После завершения запись доступна 7 дней, затем backend закрывает видео и таймлайн даже при наличии старой ссылки.

В dev-режиме token дополнительно хранится в `localStorage` для удобного тестирования. В production после проверки ссылки backend ставит `HttpOnly` cookie `aspb_room_token`, чтобы frontend не держал боевой token в открытом хранилище.

## CRM

Админка доступна по адресу:

```text
http://127.0.0.1:5174/admin
```

CRM-статусы:

```text
new
contacted
consultation
transferred_to_aspb
contract_pending
contract_signed
payout_due
paid
lost
```

В карточке лида видны контакты, источник и UTM, дата регистрации, дата эфира, вход в комнату, Telegram click, вопросы, заявки на партнерский договор, заметки менеджера и история событий.

## Юридические страницы

Добавлены базовые страницы:

```text
privacy.html
terms.html
consent.html
```

Форма регистрации требует явного чекбокса согласия. Тексты являются базовой MVP-редакцией и могут быть заменены финальной юридической версией перед публичным запуском.

## Telegram

Telegram разведен на два бота:

- админский бот для менеджера: новые регистрации, вопросы и заявки;
- участнический бот: `/start` по персональной ссылке, новости и напоминания.

Публичная ссылка на группу/канал остается отдельной переменной:

```text
TELEGRAM_GROUP_URL=https://t.me/example
```

Для уведомлений менеджеру:

```text
TELEGRAM_ADMIN_BOT_TOKEN=
TELEGRAM_ADMIN_CHAT_ID=
TELEGRAM_NOTIFY_MODE=log
```

`TELEGRAM_NOTIFY_MODE=send` включает реальные отправки. Если `TELEGRAM_ADMIN_CHAT_ID` пустой, backend пытается сам найти chat_id через `getUpdates`. Для этого нужно один раз написать любое сообщение боту, затем создать новую регистрацию/вопрос/заявку.

Для участников:

```text
TELEGRAM_PARTICIPANT_BOT_TOKEN=
TELEGRAM_PARTICIPANT_BOT_USERNAME=
TELEGRAM_PARTICIPANT_BOT_POLLING=off
```

`TELEGRAM_PARTICIPANT_BOT_POLLING=on` включает участнического бота через long polling. После регистрации success-страница дает ссылку вида:

```text
https://t.me/<bot_username>?start=<registration_token>
```

После `/start` бот привязывает Telegram chat_id к регистрации и умеет отправлять личные напоминания за 24 часа, 3 часа и 30 минут до эфира. Команды участника:

```text
/status
/room
/help
```

Уведомления отправляются на события:

- новая регистрация;
- новый вопрос в вебинарной комнате;
- новая заявка на партнерский договор.

В admin-панели есть блок “Telegram-новости участникам”: он отправляет ручную новость всем привязанным Telegram-подписчикам.

Legacy-переменные `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_POLLING` оставлены только для совместимости. Для чистого запуска лучше использовать отдельные `TELEGRAM_ADMIN_*` и `TELEGRAM_PARTICIPANT_*`.

## Проверки

```bash
npm run build
npm test
npm audit --omit=dev
```

В production сервер не стартует с дефолтными `admin/admin123` и dev-secret значениями. Перед запуском нужно задать сильные `ADMIN_PASSWORD`, `ADMIN_COOKIE_SECRET`, `IP_HASH_SECRET` и корректный `CORS_ORIGIN`.
