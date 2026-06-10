# Telegram bots

Проект использует Telegram Bot API через long polling (`getUpdates`). Polling запускается только в worker-части runtime: `WORKER_ROLE=webinar` или `WORKER_ROLE=all`.

## Общая схема

- `src/lib/telegram.ts` - общий слой Telegram API: URL методов, отправка сообщений, health-check `getMe`, форматирование админских уведомлений.
- `src/server.ts` - подключает фоновые задачи: reminders, admin bot, participant bot, consultant bot, news scheduler, broadcast worker.
- `TELEGRAM_NOTIFY_MODE=log` переводит отправку в лог-режим. Это удобно для dev/test.
- `TELEGRAM_NOTIFY_MODE=send` реально отправляет сообщения в Telegram.

## Бот менеджера

Файл: `src/lib/telegramAdminBot.ts`

Назначение:

- получает callback-кнопки из админских Telegram-уведомлений;
- меняет CRM-статус регистрации;
- помечает лида горячим;
- проверяет, что callback пришел из `TELEGRAM_ADMIN_CHAT_ID`.

Env:

- `TELEGRAM_ADMIN_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`
- `TELEGRAM_ADMIN_BOT_POLLING=on`

## Бот участника

Файл: `src/lib/telegramParticipantBot.ts`

Назначение:

- принимает `/start <token>` после клика по Telegram-кнопке на success-странице;
- привязывает `telegramChatId` к `Lead`;
- отправляет персональную ссылку в вебинарную комнату;
- поддерживает `/status`, `/room`, `/help`;
- используется напоминаниями, новостями и ручной админской рассылкой.

Env:

- `TELEGRAM_PARTICIPANT_BOT_TOKEN`
- `TELEGRAM_PARTICIPANT_BOT_USERNAME`
- `TELEGRAM_PARTICIPANT_BOT_POLLING=on`

## Бот-консультант

Файл: `src/lib/telegramConsultantBot.ts`

Назначение:

- первичный бот для пользователей без обязательной регистрации;
- команды `/start`, `/help`, `/webinar`, `/partner`, `/contact`;
- свободный текст сохраняет событие `telegram_consultant_message`;
- входящие запросы пересылаются в админский Telegram-чат через бота менеджера.

Env:

- `TELEGRAM_CONSULTANT_BOT_TOKEN`
- `TELEGRAM_CONSULTANT_BOT_USERNAME`
- `TELEGRAM_CONSULTANT_BOT_POLLING=on`

## Новости и рассылки

- `src/lib/telegramNews.ts` - расписание полезных выпусков по `TELEGRAM_NEWS_TIMES`, выбор RSS/ fallback-темы, отправка всем лидам с `telegramChatId`.
- `src/lib/telegramBroadcastWorker.ts` - очередь ручных рассылок из админки, retry, dead letter.

## Как включить нового бота

1. Создать бота в BotFather и получить token.
2. Заполнить env-переменные нужного бота.
3. Убедиться, что `WORKER_ROLE=webinar` или `WORKER_ROLE=all`.
4. Поставить polling-флаг нужного бота в `on`.
5. Проверить `/health/dependencies`: Telegram health-check делает `getMe` для настроенных токенов.
