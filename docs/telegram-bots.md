# Telegram-контур АСПБ

Платформа использует общие bot identities АСПБ. Организация не получает и не загружает собственный bot token. Polling запускается только в worker runtime с `WORKER_ROLE=webinar` или `WORKER_ROLE=all`; локально и в тестах `TELEGRAM_NOTIFY_MODE=log` запрещает реальные отправки.

## Границы безопасности

- Tenant определяется только по активной User session/membership или по уже проверенной participant registration; `organizationId`, Webinar ID, Session ID, contact ID и chat ID из callback не считаются доказательством доступа.
- Новые tenant callbacks — opaque HMAC-signed records с exact Organization/Webinar/WebinarSession/action scope и expiry. Повторное действие идемпотентно.
- Manager chat привязывается одноразовым hash-only token, затем отдельно подтверждается OWNER. Привязку можно отозвать; каждый callback повторно проверяет active HUMAN membership, роль, binding и exact chat.
- Participant `/start` принимает только одноразовый token purpose `telegram_start`; повторная или пересланная ссылка не перепривязывает chat ID.
- Signed room URL создаётся только непосредственно перед допустимой отправкой, не сохраняется в bot event, audit, обычном log или browser storage.
- `telegram_bot_events` хранит server correlation ID, provider message ID, когда он существует, exact scope и безопасные metadata. Token, signed URL, email, телефон и raw chat ID туда не пишутся.
- Operational alerts имеют отдельный `TELEGRAM_OPERATIONAL_CHAT_ID`, принимают только типизированные code/subsystem/severity/correlation ID и не могут содержать произвольный текст или ПДн.

## Бот участника

Реализация: `src/lib/telegramParticipantBot.ts`, напоминания: `src/lib/reminders.ts`.

Поддерживаются `/start`, `/webinars`, `/my`, `/room`, `/materials`, `/help`, `/unsubscribe`; legacy `/status` сохранён. Команды возвращают только активные registrations и доступные сейчас sessions. Cancelled session, истёкший replay, отозванный private grant и чужой/private Webinar не дают ссылку. `/unsubscribe` отзывает только marketing Telegram consent и не отключает service notifications или обработку ПДн.

Reminder/live/follow-up delivery использует CAS lease и server-selected Registration/WebinarSession. Dedup key содержит registration, exact session, тип сообщения и schedule version. Перед room-link delivery повторно проверяются registration и private access; перед marketing follow-up — актуальное Telegram consent. Successful/log-mode delivery атомарно фиксирует sent marker и immutable bot event.

## Бот менеджера

Реализация: `src/lib/telegramAdminBot.ts`, tenant policy: `src/lib/tenancy/telegramBots.ts`, API: `/api/v1/telegram/manager-bindings`.

OWNER создаёт приглашение для active HUMAN OWNER или CRM_MANAGER. API единственный раз возвращает `startUrl`; в БД хранится только SHA-256 token. После `/start mgr_…` binding остаётся `PENDING_OWNER` и не получает tenant callbacks до явного OWNER confirm. Revoke немедленно блокирует следующие действия.

Signed callbacks поддерживают принять контакт, изменить этап, отметить hot и создать задачу. Callback имеет expiry/idempotency key и exact Organization/Webinar/WebinarSession/Registration/CRMContact scope. CRM stage, membership, binding и chat проверяются заново внутри транзакции. Кнопка «Открыть CRM» является только навигацией и не заменяет авторизацию web session.

## Бот-помощник

Реализация: `src/lib/telegramConsultantBot.ts`, классификация: `src/lib/tenancy/telegramConsultant.ts`.

Бот отвечает только по навигации: вебинары, материалы, партнёрство и передача человеку. При персонализированном юридическом вопросе он не формирует совет и явно передаёт обращение человеку. Свободный текст нормализуется, получает topic/intent/urgency и provenance `local_policy/telegram-intent-v1`; исходный текст хранится только в dedicated retention contour. Analytics/CRM event содержит классификацию, но не текст и не raw chat ID. OWNER/CRM_MANAGER может исправить классификацию с причиной; original classification остаётся immutable.

## Tenant-рассылки

Реализация: `src/lib/tenancy/telegramBroadcast.ts`, worker: `src/lib/telegramBroadcastWorker.ts`, API: `/api/v1/telegram/broadcast-*`.

OWNER создаёт и публикует шаблон. Разрешены только `{{participant_name}}`, `{{webinar_title}}`, `{{session_datetime}}`, `{{room_link}}`; публикация без `room_link` блокируется. Published template immutable.

Flow состоит из отдельных preview и confirm. Preview вычисляет exact segment `registered_session`, максимум 2000 получателей, возвращает одноразовый raw token только в `private, no-store` response и хранит hash/snapshot/expiry. До `confirm=true` job и recipient rows не создаются. Confirm повторно вычисляет segment и отклоняет изменившийся snapshot. Worker поддерживает pause/resume/cancel, bounded retry/backoff, dead letter и progress. Consent, active binding, Registration, Session, private grant и requester tenant перепроверяются непосредственно перед каждым send.

Legacy global news/admin broadcast остаётся совместимым, но его recipient rows без Organization не используются как tenant evidence.

## Env-контракт

Секреты хранятся только в deployment secrets/env и не коммитятся:

- `TELEGRAM_ADMIN_BOT_TOKEN`, `TELEGRAM_ADMIN_BOT_USERNAME`, `TELEGRAM_ADMIN_BOT_POLLING`;
- `TELEGRAM_PARTICIPANT_BOT_TOKEN`, `TELEGRAM_PARTICIPANT_BOT_USERNAME`, `TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME`, `TELEGRAM_PARTICIPANT_BOT_POLLING`;
- `TELEGRAM_CONSULTANT_BOT_TOKEN`, `TELEGRAM_CONSULTANT_BOT_USERNAME`, `TELEGRAM_CONSULTANT_BOT_POLLING`;
- `TELEGRAM_ADMIN_CHAT_ID` для legacy platform-admin notifications;
- `TELEGRAM_OPERATIONAL_CHAT_ID` для обезличенных infrastructure alerts; в production send mode он обязателен и должен отличаться от admin chat;
- `TELEGRAM_CALLBACK_SECRET` для tenant callbacks;
- `TENANT_TELEGRAM_BOTS_ENABLED=off|on`; production rollout начинается с `off`;
- `TELEGRAM_NOTIFY_MODE=log|send`; `send` разрешается только после provider smoke test на staging.

`/health/dependencies/details` с metrics Bearer token выполняет `getMe` и сверяет provider username с env. Публичный `/health/dependencies` возвращает только `ok/degraded`.

## Acceptance и rollback

На staging используются только тестовая организация и тестовые адресаты. Проверяются one-time binding/replay, owner confirm/revoke, cross-tenant callback, callback expiry/replay, participant commands, expired replay/revoked grant, consultant handoff/correction, template validation, preview-before-confirm, consent revoke before send, retry/dead-letter, pause/cancel/progress и отсутствие ПДн/token/signed URL в events/logs.

Rollback приложения: вернуть `TENANT_TELEGRAM_BOTS_ENABLED=off` и остановить tenant polling/worker path. Additive tables и history не удаляются; production migration, token rotation и реальные рассылки требуют отдельного разрешения.
