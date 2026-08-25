# АСПБ Автовебинар

Платформа автовебинара АСПБ: статический frontend в `crisis_premium`, Node.js/TypeScript backend, PostgreSQL/Prisma, CRM-админка, серверный live-тайминг, чат, вопросы, партнерские заявки, email outbox и Telegram-уведомления.

## Продуктовый режим: единый сервис АСПБ

Проект работает как собственный вебинарный сервис АСПБ, а не как маркетплейс
для сторонних организаций:

- вебинары создаёт и обслуживает только приглашённая команда АСПБ;
- участник после регистрации и подтверждения email попадает в раздел «Мои
  вебинары», а комнату открывает из карточки нужной сессии;
- рабочий кабинет команды и личный кабинет участника используют разные входы и
  разные cookie-сессии;
- публичное самостоятельное создание организаций и переключение между ними
  отключены при `ASPB_SINGLE_ORGANIZATION_MODE=on` (режим включён по умолчанию);
- tenant-таблицы сохранены как внутренний контур безопасности и совместимости,
  но не являются пользовательской функцией для внешних компаний.

## Архитектура доступа

Доступ в вебинарную комнату cookie-only:

- одноразовый `exchange-token` поддерживается только для первичного обмена через `POST /api/registration/exchange` с body `{ "token": "..." }`; legacy `POST /api/registration/exchange/:token` временно поддерживается;
- письмо подтверждения регистрации и ссылка восстановления открывают `access.html?next=account#token=...`; после обмена токена участник попадает в «Мои вебинары»;
- reminder и специальные Telegram-ссылки могут вести прямо в `webinar.html#token=...`; legacy `?token=...` остается рабочим для старых ссылок;
- backend удаляет exchange-token, выпускает session-token и ставит `HttpOnly` cookie `aspb_room_token`;
- URL очищается от `token`;
- дальнейшие запросы комнаты используют только cookie и endpoints `session/current`.

Постоянные endpoints с token в path отключены. Frontend не хранит room token в `localStorage` и не отправляет token в analytics, questions или partner application.

Комната получает главы, материалы и только опубликованный транскрипт одним
`private, no-store` snapshot. WebVTT captions запрашиваются отдельным
cookie-защищённым endpoint, который повторно проверяет server-selected tenant,
WebinarSession, current MediaAsset, private grant и replay expiry; storage key и
постоянный origin URL браузеру не выдаются.

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
tenant-данные и доступ к защищённым endpoints. Рабочие модули управляются
отдельными rollout-флагами, а режим единственного сервиса задаётся независимо:

```text
PLATFORM_ACCOUNTS_ENABLED=off
ASPB_SINGLE_ORGANIZATION_MODE=on
PLATFORM_TENANCY_ENFORCEMENT=off
CREATOR_DASHBOARD_ENABLED=off
PUBLIC_CATALOG_ENABLED=off
TENANT_CRM_ENABLED=off
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
layer. Флаг остаётся `off`, пока базовый кабинет и private access
grants не пройдут свой gate.

Migration `20260820193000_webinar_sessions_recurrence` добавляет
tenant-scoped разовые, ежедневные и еженедельные расписания.
Каждый запуск создаётся как отдельная session с UTC timestamp и явной IANA
timezone; DST wall-clock валидируется сервером, а число будущих
instances ограничено. Перенос или отмена после регистраций
требуют явного подтверждения и причины, атомарно пишут audit,
отзывают устаревшие reminders и ставят service notices в durable email
outbox. Отменённая session не выдаёт room access и не попадает в
email/Telegram reminders.

Migration `20260820200000_private_webinar_access` добавляет owner-only
приглашения на private Webinar. Email нормализуется и сохраняется только как
HMAC в grant; raw одноразовая ссылка существует только в памяти worker, а в БД
остаётся SHA-256 hash токена. Принять приглашение может только вошедший и
подтвердивший email User; grant ограничен организацией, конкретным Webinar,
purpose и сроком. Отзыв немедленно закрывает новые room/replay access, email и
Telegram delivery. Cross-tenant read/write возвращают тот же safe `404`, что и
неизвестный объект. Перед включением creator flow задайте отдельный стабильный
`WEBINAR_ACCESS_HASH_SECRET` длиной не менее 32 символов: compatibility fallback
на `ADMIN_COOKIE_SECRET` оставлен только для безопасного additive deploy с
выключенными флагами.

Creator API также поддерживает идемпотентное дублирование Webinar в новый
`DRAFT`: копируются только разрешённые legal/content/taxonomy/source поля, а
последняя версия `ChatScenario` копируется как новый неподтверждённый draft.
Sessions, registrations, analytics, access grants, media, approval и история
команд не копируются. Сценарий редактируется через tenant-scoped API; клиент не
может снять `isSynthetic`, а публикация требует явной маркировки подготовленных
сообщений.

Кабинет команды АСПБ доступен по `/crisis_premium/creator-webinars.html` только
при включённых platform/creator flags. Он показывает независимые content,
media, transcript, scenario и session статусы, позволяет заполнить юридические
метаданные, HTTPS-источники, подготовленный чат, расписание и private grants.
Отдельный `/crisis_premium/creator-webinar-preview.html` не создаёт Lead,
registration, CRM event или delivery и честно сообщает, если READY media ещё
нет.

Публичный каталог включается независимо через `PUBLIC_CATALOG_ENABLED=on`:
`/crisis_premium/catalog.html` и `/crisis_premium/catalog-webinar.html`.
Server-side projection и `/sitemap.xml` включают только published PUBLIC
Webinar проверенных активных авторов. UNLISTED доступен только по полной прямой
ссылке и получает `noindex`; PRIVATE, draft и archived возвращают тот же 404,
что неизвестный объект. Основная CTA регистрирует на exact WebinarSession через
server-resolved Organization/Webinar graph; client `organizationId` не
принимается. Anonymous/existing-mailbox ответы не раскрывают наличие аккаунта,
повторная отправка идемпотентна, а действующая legacy-регистрация и партнёрская
воронка не подменяются.

CAT-006 поддерживает `RELEVANCE`, `UPCOMING`, `NEWEST` и `UPDATED`; default —
`UPCOMING`. Каждый SQL order имеет стабильный ID tie-break, а sort вместе с
остальными фильтрами всегда остаётся в URL и восстанавливается при reload и
Back/Forward. PostgreSQL integration и Playwright проверяют каждый режим,
keyboard focus и отсутствие horizontal overflow при 320px.

Additive migration `20260821130000_viewer_account_registration` связывает новые
Registration с trusted Organization, Webinar и participant User и добавляет
tenant-scoped favorites, progress, private timestamped notes и notification
preferences. Кабинет доступен по `/crisis_premium/account.html`: показывает
upcoming/recordings/watched/saved, timezone и срок replay. Прогресс пишется
только из foreground, дедуплицируется по event ID и throttled на клиенте и
сервере; favorite никогда не выдаёт private access. Marketing email/Telegram и
service email/Telegram настраиваются отдельно, а marketing revoke не отменяет
personal-data consent или отдельное законное основание обязательного сообщения.

Additive migration `20260821140000_crm_contact_pipeline` вводит первый
tenant-scoped CRM slice без замены действующей партнёрской воронки: `CRMContact`,
default `CRMPipeline`/`CRMStage`, unified contact events и stage transitions.
Старые `Registration.crmStatus`, manager и `nextContactAt` сохраняются; для АСПБ
шесть действующих кодов этапов мигрируются один в один и защищаются от удаления.
Следующая additive integrity migration `20260821141000_crm_stage_integrity_hardening`
закрывает прямой обход immutable stage/protected-state и проверяет совпадение
Registration Organization/Lead с привязанным CRMContact на DB boundary.
Новый API `/api/v1/crm/*` определяет Organization только из User session и
membership, маскирует ПДн для ANALYST/AUDITOR и возвращает одинаковый safe 404
для unknown/cross-tenant contact или stage. Интерфейс доступен по
`/crisis_premium/crm.html` при `PLATFORM_ACCOUNTS_ENABLED=on` и
`TENANT_CRM_ENABLED=on`. CRM расширяется только отдельными законченными batch.
Additive migration `20260821150000_crm_tasks_sla` закрывает task/SLA batch:
задача всегда относится к tenant CRMContact, назначается только активному
OWNER/CRM_MANAGER membership и хранит обязательные due/reminder, priority и
status. Сервер считает очереди «Сегодня», «Просрочено» и «Без задачи» в IANA
timezone воронки, а DB trigger поддерживает `CRMContact.nextContactAt` по
ближайшей открытой задаче. Физического delete API и внешней рассылки reminder
нет: задачу завершают или отменяют с event/audit.
Additive migrations `20260821160000_crm_scoring_tags` и
`20260821161000_crm_scoring_legacy_room_backfill` добавляют отдельный
версионированный scoring-контур и tenant-scoped tags. Балл строится только из
immutable/deduplicated факторов реальных registration, room, 50% progress,
question и CTA событий; новая версия правил пересчитывает проекцию без
умножения факторов. Ручной hot требует причины, actor/idempotency/event/audit и
сохраняет `Registration.isHot` только как compatibility projection. Теги
уникальны по нормализованному имени внутри Organization, допускают одинаковое
имя в разных tenant, а использованные теги архивируются вместо физического
удаления. Внешние сообщения scoring/tag batch не отправляет.

Additive migrations `20260821170000_crm_bulk_export` и
`20260821171000_crm_bulk_integrity_hardening` добавляют durable snapshot для
двухшаговых массовых действий: preview фиксирует точный tenant-scoped набор не
более 1000 контактов на 10 минут, а execute возвращает отдельные successes и
безопасные failure codes. Поддержаны назначение менеджера, создание задачи,
смена этапа и добавление тега; повторное выполнение идемпотентно, результат и
scope защищены DB constraints/triggers и audit. CSV export ограничен 10000
контактами и требует явного permission `permissionsJson.crm.export=true` у
активного membership: ответ `private, no-store` не сохраняется как файл,
формулы экранируются, а ANALYST/AUDITOR получают только маскированные ПДн.
Внешних email/Telegram действий этот batch не создаёт.

Additive migration `20260821180000_crm_consent_delivery` добавляет отдельную
tenant-scoped очередь маркетинговых email/Telegram сообщений. Enqueue всегда
указывает trusted Registration конкретных Webinar/WebinarSession и допускается
только OWNER/CRM_MANAGER при актуальном согласии на выбранный канал. Worker
повторяет проверку consent непосредственно перед provider call под тем же
channel lock, имеет bounded retry/dead-letter и не считает `EMAIL_MODE=log`
успешной отправкой. Recipient email/chatId не сохраняются в job, а API,
timeline, audit, metrics и логи не возвращают message body или provider details.
Повторный enqueue/retry идемпотентен; unknown/cross-tenant объекты дают тот же
safe 404. Реальные сообщения локально не отправляются, а rollout остаётся под
`TENANT_CRM_ENABLED=off` до staging acceptance.

Additive migrations `20260821190000_chat_moderation` и
`20260821191000_chat_synthetic_identity_hardening` закрепляют exact
Organization/Webinar/WebinarSession/Registration scope чата, canonical
message type и per-message approval. Комната выдаёт только approved
messages одной published ChatScenario; synthetic-сообщения имеют
видимую и screen-reader маркировку без выдуманных личностей,
отзывов и online count. Participant question проходит Unicode/markup
sanitization и bounded anti-spam; автоматическая AI-публикация
отключена. OWNER/MODERATOR могут с обязательной причиной скрыть/
восстановить сообщение и закрыть/восстановить чат registration в
`/crisis_premium/moderation.html`; все действия tenant-scoped и пишут audit.
Интерфейс и API скрыты platform/creator flags до staging acceptance.

Additive migrations `20260823085000_ai_suggestion_chat_type`,
`20260823090000_question_moderation_grounding` и
`20260823091000_question_legacy_scope_compatibility` расширяют существующие
`Question`/`AiOperationProvenance`/`AiSuggestion`: очереди
`new`/`repeating`/`priority`, reasoned status/priority history, CRM timeline и
grounded draft. Retrieval читает только latest `PUBLISHED` transcript либо
явный `WebinarSource`; draft/reviewed text и personalized legal advice дают
human handoff. До отдельного HUMAN `PUBLISH` public chat message не создаётся.
Внешний AI provider не вызывается, production default остаётся
`AI_ENRICHMENT_PROVIDER=unconfigured`.

Migration `20260821090000_media_pipeline_foundation` добавляет versioned
`MediaAsset`, resumable `MediaUpload` и durable `MediaJob`. Creator API выдаёт
временные multipart operations и не возвращает storage keys/origin URL. В
выбранном self-hosted режиме bytes идут streaming через tenant/author/CSRF-
защищённый same-origin PUT в private persistent volume; external S3 PUT по-
прежнему обходит application bytes. Без выбранного provider безопасный default
`MEDIA_STORAGE_PROVIDER=unconfigured` отвечает `503`; `test_fake` работает
только при `NODE_ENV=test` и запрещён production guard. Лимиты задаются
`MEDIA_MAX_UPLOAD_BYTES` (4 ГБ), `MEDIA_MAX_DURATION_SECONDS` (180 минут) и
`MEDIA_PART_SIZE_BYTES`. Активация разрешена только для READY asset и не
переключает опубликованную версию раньше явного запроса.
Завершённые parts фиксируются на сервере по `partNumber`/ETag; resume выдаёт fresh
15-minute operations только для недостающих частей. Browser хранит только
upload ID, idempotency key и identity файла, а не signed operations. Local adapter
(`MEDIA_STORAGE_PROVIDER=local_fs`) требует absolute `MEDIA_LOCAL_ROOT` вне web
root; Docker API/worker используют один named volume `/var/lib/aspb/media`.
Parts получают SHA-256 ETag после `fsync`, conflicting retry не перезаписывает
checkpoint, а complete повторно проверяет checksum каждой части. Для external
direct PUT origins нужно явно задать comma-separated HTTPS origins в
`MEDIA_UPLOAD_CSP_ORIGINS`. S3-compatible adapter
(`MEDIA_STORAGE_PROVIDER=s3`) сохранён как optional future path. Оба real
adapter используют общие magic-byte/ffprobe checks и ffmpeg HLS/poster/OGG
pipeline.
Init требует `Idempotency-Key`; повтор с тем же server-owned request hash
возвращает существующий upload, а conflicting request fail closed. Resume/complete
строго сверяют server checkpoint с provider `ListParts` и exact part sizes;
expired abort cleanup имеет bounded backoff и dead-letter.
`MediaJob` использует возобновляемый lease: после падения worker зависший `RUNNING` claim
возвращается в очередь либо попадает в dead-letter на исчерпанном лимите. Manifest,
каждый segment/poster и Range проходят повторную cookie/session/WebinarSession/replay/grant
проверку через application gateway; storage keys и origin URL наружу не выдаются.
Техническая рекомендация и ограничения CDN зафиксированы в
[`docs/DEC-05-MEDIA-STORAGE-CDN-TRANSCODER.md`](docs/DEC-05-MEDIA-STORAGE-CDN-TRANSCODER.md).
Local media не включается до staging backup/restore/capacity/failure/load
acceptance. External S3 требует отдельного legal/budget/provider approval;
полный env-контракт указан в `.env.production.example`.
Важно: local streaming проходит через Express и потому не закрывает буквальный
direct-object-storage критерий MED-001; актуальный статус требования указан в
implementation ledger.

Production-capable `MEDIA_STORAGE_PROVIDER=s3` возвращает browser contract
`transport=direct_object_storage`, `credentials=omit`, `method=PUT`,
`fullFileProxy=false` и короткоживущие signed part operations. Resume сверяет
server checkpoint с provider `ListParts`, повторный complete подтверждает объект
через `HeadObject`, cleanup вызывает Abort. Bucket, storage key и origin URL не
являются API/log contract. Это provider-neutral implementation, а не provider
acceptance: до `verified` нужны выбранные private bucket/IAM, exact CORS с
exposed ETag, lifecycle incomplete multipart, DPA/budget/credentials и staging
smoke; production default остаётся `unconfigured`.

Реальный локальный media gate запускается командой `npm run media:acceptance`.
Он создаёт временные MP4/MOV/WebM fixtures, пропускает их через production
ffprobe/ffmpeg pipeline, проверяет HLS/poster/OGG/Range и ожидаемые безопасные
отказы. CI повторяет gate внутри собранного production image. Команда не заменяет
staging-проверку фактической передачи 4 ГБ, capacity, restart и backup/restore.
При `MEDIA_STORAGE_PROVIDER=local_fs` защищённый `/metrics` также публикует
total/available bytes и inodes без filesystem path; пороги alerts выбираются по
реальному staging volume и load test, а не задаются приложением произвольно.
Отдельный private `MEDIA_WORK_ROOT` измеряет bytes/inodes и fail closed до
download/transcode, если нет запаса `source × multiplier + reserve`; path в metrics
не попадает.

Migrations `20260821100000_transcript_foundation` и
`20260821110000_transcript_enrichment` добавляют versioned transcript segments,
tenant dictionary, durable STT/AI jobs, provenance, suggestions, chapters, tags и prepared
questions. `STT_PROVIDER=unconfigured` и `AI_ENRICHMENT_PROVIDER=unconfigured` fail closed;
`test_fake` допустим только в test. Creator редактирует segments с optimistic
revision, явно review/publish-ит транскрипт и отдельно принимает/отклоняет
каждое AI suggestion. В каталог и TXT/VTT export попадает только опубликованная
версия.
Optional adapters `yandex_speechkit` и `yandex_foundation_models` реализуют
async STT submit/poll/result/delete и structured AI suggestions. Они остаются
`unconfigured` до data-processing/no-training acceptance; decision matrix находится в
[`docs/DEC-06-STT-AI-PROVIDERS.md`](docs/DEC-06-STT-AI-PROVIDERS.md).
STT worker хранит provider job/model/deadline только в private `ContentJob`,
возобновляет polling/cleanup после restart, имеет bounded retry,
timeout, cancel и dead-letter. Result создаёт только `DRAFT`; publication
остаётся human-controlled.

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

Обычные `npm test` и `npm run e2e` не удаляют локальную test-схему: setup
проверяет loopback/test-only `DATABASE_URL` и выполняет additive `prisma migrate
deploy`. Destructive reset возможен только при отдельном явном
`ASPB_ALLOW_TEST_SCHEMA_RESET=on`; не используйте его для общей, staging или
production базы.

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
GET  /api/v1/catalog/webinars
GET  /api/v1/catalog/webinars/:slug?organization=:publicSlug
POST /api/v1/catalog/webinars/:slug/register?organization=:publicSlug
GET  /api/v1/viewer/dashboard
POST /api/v1/viewer/registrations/:registrationId/activate
PUT  /api/v1/viewer/favorites/:webinarId
DELETE /api/v1/viewer/favorites/:webinarId
GET  /api/v1/viewer/progress/:sessionId
PUT  /api/v1/viewer/progress/:sessionId
GET  /api/v1/viewer/notes?sessionId=:sessionId
POST /api/v1/viewer/notes
DELETE /api/v1/viewer/notes/:noteId
GET  /api/v1/viewer/notifications
PATCH /api/v1/viewer/notifications
GET  /api/v1/creator/reference-data
GET  /api/v1/creator/webinars
POST /api/v1/creator/webinars
GET  /api/v1/creator/webinars/:webinarId
PATCH /api/v1/creator/webinars/:webinarId
GET  /api/v1/creator/webinars/:webinarId/sessions
POST /api/v1/creator/webinars/:webinarId/sessions
PATCH /api/v1/creator/sessions/:sessionId
DELETE /api/v1/creator/sessions/:sessionId
POST /api/v1/creator/webinars/:webinarId/sources
DELETE /api/v1/creator/webinars/:webinarId/sources/:sourceId
GET  /api/v1/creator/webinars/:webinarId/preview
POST /api/v1/creator/webinars/:webinarId/submit
POST /api/v1/creator/webinars/:webinarId/publish
POST /api/v1/creator/webinars/:webinarId/archive
```

`POST /api/events` принимает текущий аналитический контракт `schemaVersion: 1`.
Тип события берётся из централизованной таксономии, `source` — только из
allowlist `web`, `room`, `replay`, `registration`, `crm`, `email`, `telegram`,
`worker`, `system`, `admin`. Для каждого нового события обязателен случайный
`dedupKey` длиной 16–128 символов, стабильный только для retry одной логической
операции. Browser/server writers включают event-name namespace в ключ
(`web:<eventName>:…` / `srv:<eventName>:…`). Область уникальности: server-derived
Organization для tenant-события или единая platform scope для глобального
события; ключ нельзя переиспользовать с другим event type или payload. Первый insert отвечает `201`, идентичный retry
— `200` с `replayed: true`, несовместимое повторное использование — безопасным
`409 analytics_idempotency_conflict`.

`occurredAt` всегда назначает PostgreSQL по серверному UTC-времени. Необязательный
`clientOccurredAt` хранится отдельно и допускается только в диагностическом окне
±24 часа. `X-Correlation-ID` принимается лишь в безопасном формате длиной до
128 символов, иначе сервер создаёт новый; значение возвращается в header и
response. Organization/Webinar/WebinarSession/Registration/User никогда не
доверяются из body: клиентские ID используются только как hints и сверяются с
participant cookie и server relations. Metadata типизирована по event type,
ограничена глубиной/размером и не допускает email, телефон, chat ID, токены,
cookie, signed URL, storage key, полный IP, provider secrets или произвольный
request body. Старый unversioned body временно проходит только через явный
legacy adapter и сохраняется как `schemaVersion=0`; новые browser writers
отправляют версию 1 и не сохраняют dedup key или секреты в browser storage.

Таксономия schema 1 фиксирована группами:

```text
acquisition: page_view, registration_click, registration_form_open,
  registration_submit, registration_success, telegram_click, telegram_subscribe
room: webinar_room_open, webinar_room_waiting, viewer_heartbeat, video_start,
  video_progress_25, video_progress_50, video_progress_75, video_finish
replay: recordings_open, recording_open, recording_play,
  recording_progress_25, recording_progress_50, recording_progress_75,
  recording_finish, recording_cta_click
interaction: question_submit, question_submit_attempt, question_submitted,
  question_submit_error, partner_application_submit,
  partner_application_submitted, partner_application_error,
  partner_form_opened, partner_request_click, chapter_open, transcript_search
internal: participant_login_request, admin_manual_telegram_reminder,
  telegram_broadcast, telegram_news_broadcast, telegram_broadcast_completed,
  telegram_repeat_start, telegram_start_without_registration,
  telegram_participant_command, telegram_consultant_start,
  telegram_consultant_contact_request, telegram_consultant_message
```

Авторитетный runtime registry находится в `src/lib/analyticsEvents.ts`, а
публичный enum — в `openapi.yml`. Тип не переименовывается и не подменяется
другим смыслом. Добавление optional safe attribute к существующему типу может
оставаться в текущей версии только вместе с registry/OpenAPI/tests; удаление,
переименование, смена типа/обязательности или семантики требует новой
`schemaVersion`, отдельной Zod schema, additive DB compatibility и явного
adapter. Неизвестная версия или type всегда отклоняется и никогда не считается
конверсией.

Analytics dashboard `/crisis_premium/analytics.html` строится только поверх
schema 1 и trusted Registration/Question/PartnerApplication data. Tenant берётся
из User session/membership; `organizationId` не выбирает tenant. Overview,
LIVE/REPLAY retention, active-viewer window и published-transcript content
aggregates документируют UTC period, identity/dedup/background policy и
privacy threshold 3 в [`docs/ANALYTICS-FORMULAS.md`](docs/ANALYTICS-FORMULAS.md).
Filters Webinar/Session/source/period живут только в URL. Platform-wide
projection отделена в MFA AdminUser route и не возвращает raw chat, notes,
email, phone или Telegram IDs.

Migration `20260823120000_analytics_moderation_platform` добавляет публичные
CONTENT/AUTHOR/RIGHTS reports, exact moderation case state machine, immutable
events/evidence, reversible Webinar/Author actions, versioned correction
requests и owner-only Organization/taxonomy/feature-flag governance. Публичный
контакт сохраняется только как HMAC; private/unknown target неразличимы.
Platform action/config mutation требует reason, confirmation и optimistic
revision. Author correction остаётся private до human review. Интерфейсы:
`/crisis_premium/report.html`, `/crisis_premium/platform-moderation.html` и
`/crisis_premium/creator-corrections.html`. Их consolidated full manual review
зафиксирован в
[`docs/INTERFACE-REVIEW-2026-08-23.md`](docs/INTERFACE-REVIEW-2026-08-23.md).
Managed flags seeded fail-closed и
их изменение само по себе не отправляет сообщения и не запускает provider job.
Platform-wide tenant inventory находится в
[`docs/TEN-002-ENTRYPOINT-INVENTORY.md`](docs/TEN-002-ENTRYPOINT-INVENTORY.md).

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
GET   /api/admin/analytics/organizations
GET   /api/admin/moderation/reports
PATCH /api/admin/moderation/reports/:id/status
POST  /api/admin/moderation/reports/:id/actions
POST  /api/admin/moderation/reports/:id/correction-requests
POST  /api/admin/moderation/corrections/:id/review
GET   /api/admin/platform/feature-flags
PATCH /api/admin/platform/feature-flags/:key
PATCH /api/admin/platform/organizations/:id
PATCH /api/admin/platform/taxonomy/:kind/:id
POST  /api/admin/platform/changes/:id/rollback
GET   /api/v1/platform/author-verifications
GET   /api/v1/platform/author-verifications/:id
PATCH /api/v1/platform/author-verifications/:id
GET   /api/v1/platform/author-verifications/evidence/:evidenceId
```

Tenant analytics and public/moderation additions:

```text
GET  /api/v1/analytics/overview
GET  /api/v1/analytics/retention
GET  /api/v1/analytics/live
GET  /api/v1/analytics/content
POST /api/v1/reports
GET  /api/v1/moderation/corrections
POST /api/v1/moderation/corrections/:requestId/submissions
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
TELEGRAM_OPERATIONAL_CHAT_ID=... # отдельный PII-free infrastructure chat, не admin/manager chat
TELEGRAM_PARTICIPANT_BOT_TOKEN=...
TELEGRAM_PARTICIPANT_BOT_USERNAME=...
TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME=... # должен совпадать с username фактического participant bot
TELEGRAM_CALLBACK_SECRET=... # HMAC tenant manager callbacks; хранить только в secret/env
TENANT_TELEGRAM_BOTS_ENABLED=off # глобальный flag; до изолированного staging acceptance не включать
WEBINAR_VIDEO_HLS_URL=https://cdn.example.com/webinar/master.m3u8 # optional but preferred
WEBINAR_VIDEO_URL=https://private-cdn.example.com/webinar/webinar.mp4 # private origin, not a public playback URL
WEBINAR_POSTER_URL=https://cdn.example.com/webinar/poster.jpg
WEBINAR_MEDIA_ORIGIN_TOKEN=... # обязателен для внешнего origin; не нужен для same-origin файла из read-only mount
WEBINAR_VIDEO_DURATION_SECONDS=3860
WEBINAR_TEST_ROOM_MODE=off
```

Production guard запрещает дефолтные admin-секреты, пустой `METRICS_TOKEN`, HTTP `PUBLIC_SITE_URL`, wildcard CORS, test-room mode и localhost video URLs. `EMAIL_MODE=log` разрешён как явно degraded-режим без обещания доставки; при `send` обязательны SMTP-реквизиты и предварительный verify. Telegram send mode требует отдельный `TELEGRAM_OPERATIONAL_CHAT_ID`, отличный от legacy admin chat; tenant bot flow дополнительно требует accounts/CRM flags, platform bot identities и `TELEGRAM_CALLBACK_SECRET`. Организациям bot token не выдаётся. Видео выдаётся только через cookie-защищённые `/api/media/*`: внешний private CDN/origin требует Bearer token, а same-origin файл может читаться приложением из read-only mount без сетевого origin. `DATABASE_URL` должен включать pooling параметры, например `connection_limit=10&pool_timeout=20`. `TRUST_PROXY` включайте только за доверенным reverse proxy. `/health/dependencies` без токена показывает только `checks.smtp`, `checks.telegram` и `checks.emailOutbox` со значениями `ok/degraded` — без ошибок провайдера, username, адресов, heartbeat timestamps и размеров очереди. Полные детали, включая SLA очереди и per-subsystem worker deadlines, доступны по `/health/dependencies/details` с metrics token.

Docker production:

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

Production compose запускает два deployment units из одного image:

- `api` с `WORKER_ROLE=api`: Express, public/admin API, static frontend, `/health/*`, `/metrics`.
- `webinar-worker` с `WORKER_ROLE=webinar`: reminders, email outbox consumer, Telegram polling/news и legacy/tenant broadcast worker. Tenant path остаётся fail-closed при `TENANT_TELEGRAM_BOTS_ENABLED=off`.

Без `WORKER_ROLE` старый запуск остается совместимым и стартует роль `all`.

## Security/CSP

Helmet включает CSP, frame/object restrictions, COEP/CORP, cookie hardening и rate limits. `script-src` разрешает только self-hosted JS, inline scripts вынесены в отдельные файлы, `script-src-attr 'none'`. Оставшиеся статические inline style blocks/attributes разрешены точечными CSP sha256 hashes без `unsafe-inline`. Cookie-based mutation endpoints защищены double-submit CSRF cookie `aspb_csrf_token` и header `x-csrf-token`. В production admin cookie выставляется как `HttpOnly`, `Secure`, `SameSite=Strict`, `Partitioned`.

Публичные файлы `/.well-known/security.txt` и `/robots.txt` отдаются из static frontend root.

Observability: каждый request получает `x-correlation-id`, pino logs включают `correlation_id`, `userId`/`adminId` где доступны. `/health/ready` проверяет готовность ядра API и БД, `/health/dependencies` публично показывает только категорию неисправного контура (`smtp`, `telegram`, `emailOutbox`) и состояние `ok/degraded`. Подробные checks доступны по `/health/dependencies/details`; он и `/metrics` в production требуют `Authorization: Bearer <METRICS_TOKEN>`.

## Gap-closure package (24.08.2026)

Additive migrations `20260824090000`–`20260824110000` add self-service organizations, manual chapters, private webinar materials, freshness review tasks, shadow chat provenance, tenant rollout policies and legal holds. Their read-only preflight/postflight checks are in `prisma/checks/`. Application rollback is flag/policy rollback over the additive schema; destructive down-migrations are not provided.

New user interfaces:

- `/crisis_premium/platform-access.html` — verified-user onboarding;
- `/crisis_premium/organization.html` — owner-only team/settings;
- `/crisis_premium/catalog-author.html?author=<public-slug>` — safe public author projection;
- `/crisis_premium/creator-webinars.html` — persisted eight-step wizard, chapters and private participant materials.

Tenant rollout is a second, DB-backed gate behind existing master kill switches. Policies are `DISABLED`, `ALLOWLIST` or `ENABLED`; missing rows fail closed. Authentication may bootstrap non-enumerating login in allowlist mode, but every tenant endpoint/job/callback/send boundary checks the server-resolved organization again. Provider policies and managed provider flags remain disabled by migration/default.

Retention inventory is dry-run only. `RETENTION_APPLY_ENABLED=off` is the required default and is not sufficient to enable deletion: the release also contains a compile-time unapproved-policy guard. Do not change either guard until Legal/DPO approves terms, legal-hold behavior and a separate reviewed implementation change.

Reviewable infrastructure and acceptance assets live under `infra/monitoring/`, `infra/yandex/staging/` and `scripts/staging/`. Staging tools are offline/dry-run by default; network mode requires `ASPB_ALLOW_STAGING_ACCEPTANCE=on`, an exact HTTPS `ASPB_STAGING_ALLOWED_HOST`, and tool-specific load/provider/budget approval. No IaC apply is part of repository verification.

See `docs/ASPB-TZ-TRACEABILITY-MATRIX.md` for exact status/evidence and external blockers.

## QA checklist

- Регистрация создает lead/registration и outbox email job.
- Catalog CTA создаёт trusted tenant/Webinar/Session/User scope, не доверяет `organizationId` и повторяется без дублей.
- Кабинет восстанавливает replay progress, не пишет из background tab и не выдаёт private access через favorite.
- Личные заметки недоступны другому User/tenant; marketing и service preferences сохраняются раздельно.
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
