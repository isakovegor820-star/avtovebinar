# АСПБ production runbook

Цель документа: запустить платформу АСПБ в production без перегруза лишними инструментами. Базовый production-контур строится вокруг Docker, PostgreSQL, HTTPS, SMTP, Telegram, backup и CI.

## Что входит в lean-production

- Dockerfile для приложения.
- `docker-compose.production.yml` для `api`, `webinar-worker` и PostgreSQL.
- GitHub Actions CI: install, Prisma generate, migrate deploy, seed, build, tests, audit, Docker build, dependency-review, Semgrep, secretlint, dotenv-linter и staging deploy.
- Strict production env guard в backend.
- Healthchecks `/health/live`, `/health/ready`; dependency status `/health/dependencies`; Prometheus metrics `/metrics`.
- Cookie-only доступ в вебинарную комнату через `HttpOnly` cookie `aspb_room_token`.
- Одноразовый room exchange-token в письмах и отдельный одноразовый `telegram_start` token для deep-link бота; URL очищается после exchange.
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
chmod 600 .env.production
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
- `METRICS_TOKEN` для `Authorization: Bearer ...` на `/metrics`
- SMTP-поля
- Telegram bot tokens и usernames: `TELEGRAM_ADMIN_BOT_USERNAME`, `TELEGRAM_PARTICIPANT_BOT_USERNAME`, при необходимости `TELEGRAM_EXPECTED_PARTICIPANT_BOT_USERNAME`
- Видео: внешний private origin в `WEBINAR_VIDEO_HLS_URL`/`WEBINAR_VIDEO_URL` и `WEBINAR_MEDIA_ORIGIN_TOKEN` либо same-origin путь к файлу из read-only mount; если заданы оба формата, HLS используется первым
- `WORKER_ROLE=api` для API container, `WORKER_ROLE=webinar` для worker container
- `TRUST_PROXY=1`, если API стоит за Nginx/reverse proxy
- для native PostgreSQL deploy: exact absolute data/storage path в GitHub
  secrets `STAGING_NATIVE_POSTGRES_STORAGE_PATH` и
  `PRODUCTION_NATIVE_POSTGRES_STORAGE_PATH`; это shell/deploy-параметр, а не
  секрет приложения в `.env.production`

3. Проверить, что:

- `NODE_ENV=production`
- `EMAIL_MODE=send` и SMTP verify обязательны для публичной регистрации: новая учётная запись до подтверждения email остаётся `pending_verification`; `EMAIL_MODE=log` не выдаёт ей доступ и допустим только в dev/test либо в maintenance с закрытой формой
- `WEBINAR_TEST_ROOM_MODE=off`
- `PUBLIC_SITE_URL` начинается с `https://`
- `.env.production` не добавлен в Git
- `.env.production` — обычный файл (не symlink) с mode `0600` или read-only `0400`; deploy проверяет это до чтения compose
- `DATABASE_URL` содержит pooling параметры `connection_limit` и `pool_timeout`
- `METRICS_TOKEN` заполнен непубличным значением длиной минимум 16 символов
- `TRUST_PROXY` включен только за доверенным reverse proxy
- защищённый `/health/dependencies/details` проходит и Telegram `getMe.username` совпадает с настроенными bot usernames
- В production нет localhost URL в `WEBINAR_VIDEO_HLS_URL`, `WEBINAR_VIDEO_URL`, `WEBINAR_POSTER_URL`

## Миграции и seed

Для production deploy используются миграции:

```bash
npm run prisma:deploy
```

Tenant expand migration `20260820120000_tenant_foundation` впервые входит в
release tenant foundation. Перед её первым production deploy проверьте вывод
preflight: если строка этой migration уже есть в `_prisma_migrations`, остановите
deploy. Нельзя публиковать изменённый checksum уже применённой migration — для
такой базы нужен отдельный follow-up migration после разбора фактической схемы.

Перед deploy обязательны свежий verified backup и доказанный restore в отдельную
recovery DB (не production):

```bash
PG_DATABASE_URL="$PRODUCTION_DATABASE_URL" npm run backup:db
PG_DATABASE_URL="$RECOVERY_DATABASE_URL" RESTORE_TARGET=recovery \
  bash scripts/restore-postgres.sh backups/aspb-postgres-YYYYMMDDTHHMMSSZ.sql.gz
```

После успешного restore сохраните read-only preflight snapshot legacy-связности:

```bash
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820120000_tenant_foundation_preflight.sql
```

Lock profile для PostgreSQL 16:

- `ADD COLUMN ... DEFAULT 'org_aspb' NOT NULL` использует metadata-only fast
  default, но запрашивает краткий `ACCESS EXCLUSIVE` lock на `webinar_sessions`;
- nullable-колонки `audit_logs` также требуют краткий `ACCESS EXCLUSIVE` lock;
- Prisma migration не строит индексы существующих таблиц: Prisma выполняет SQL
  в transaction, несовместимой с `CREATE INDEX CONCURRENTLY`. Сразу после неё
  обязательный отдельный script строит индексы `CONCURRENTLY`, не блокируя
  обычные записи на время полного scan;
- foreign keys добавляются `NOT VALID`, затем проверяются под
  `SHARE UPDATE EXCLUSIVE`, который допускает обычные read/write;
- `lock_timeout=5s` не позволяет migration долго удерживать очередь writers;
  при timeout/ошибке остановите rollout и проверьте partial/invalid indexes до
  любых `migrate resolve` или повторов.

После `npm run prisma:deploy` выполните postflight:

```bash
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820120000_tenant_foundation_concurrent_indexes.sql
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820120000_tenant_foundation_postflight.sql
npm run prisma:deploy
```

Сравните все legacy counts с сохранённым preflight. Число строк не меняется;
все `webinar_sessions` имеют `organization_id='org_aspb'`; bootstrap
organization/system user/membership существуют ровно по одному; constraints и
indexes valid/ready; повторный deploy сообщает `No pending migrations to apply`.
`admin_users` не копируются в `users` и не получают tenant membership. Миграция
additive/forward-only: rollback application image допустим, пока он не записывает
`webinar_sessions` в обход DB-default; schema rollback или удаление новых таблиц
не выполнять.

Concurrent-index script идемпотентен для уже valid indexes. Если его запуск
оборвался, postflight может показать `indisvalid=false`: не повторяйте script с
`IF NOT EXISTS`, пока оператор не удалит конкретный invalid index через
`DROP INDEX CONCURRENTLY` и не зафиксирует инцидент. Rollout-флаги в этом случае
остаются `off`.

До отдельного controlled switch держите
`PLATFORM_ACCOUNTS_ENABLED=off`, `PLATFORM_TENANCY_ENFORCEMENT=off` и
`CREATOR_DASHBOARD_ENABLED=off`, `PUBLIC_CATALOG_ENABLED=off`. Это
оставляет legacy registration, room, replay, CRM, email, Telegram и `/admin`
на прежнем маршруте, но новые scoped services уже обязаны использовать
server-resolved tenant context.

Passwordless User auth добавлен additive migration
`20260820143000_user_passwordless_auth`. Она создаёт только новые
`user_auth_tokens`, `user_sessions` и `user_auth_email_jobs`; legacy rows не
изменяются. Перед включением `PLATFORM_ACCOUNTS_ENABLED=on`:

1. Убедитесь, что migration применена и worker `reminders` healthy.
2. Проверьте SMTP в `send` mode и protected health для
   `userAuthEmailOutbox`: failed/dead-letter/stale counts равны нулю.
3. Создайте тестового `HUMAN User` с `ACTIVE` membership без
   копирования `AdminUser` и пройдите
   `/crisis_premium/platform-access.html` на тестовом адресе.
4. Включите только `PLATFORM_ACCOUNTS_ENABLED`; tenant enforcement для
   legacy сущностей оставьте `off` до их scoped миграций.
5. Наблюдайте Prometheus queues `user_auth_email_outbox*` и alert
   `user_auth_email_failed_or_dead_letter_jobs`. При деградации верните флаг
   в `off`; миграцию и созданные hash-only данные не удаляйте.

Организационные приглашения и owner MFA добавлены следующими additive
migrations: `20260820160000_organization_invitations` и
`20260820170000_user_owner_mfa`. Первая создаёт только invitation/token/outbox
таблицы; вторая добавляет nullable MFA-поля к `users`/`user_sessions` и не
изменяет `admin_users`. Перед открытием team-management flow:

1. Проверьте protected dependency health
   `organizationInvitationEmailOutbox` и worker `reminders`.
2. В `EMAIL_MODE=send` отправьте invitation на контролируемый тестовый адрес,
   примите его один раз и убедитесь, что replay и отзыв возвращают safe error.
3. Проверьте Prometheus queues `invitation_email_outbox*` и alert
   `invitation_email_failed_or_dead_letter_jobs`; raw invitation URL не должен
   появляться в application log.
4. Владелец включает MFA на странице «Мой доступ»: enrollment действует 10
   минут, после подтверждения прочие User sessions отзываются. Новый вход до
   TOTP показывает только MFA challenge и не возвращает tenant membership data.
5. Отдельно повторите действующий platform-admin login с обязательной MFA:
   tenant migration не меняет его secret, cookie или authorization middleware.

Rollback выполняется флагом `PLATFORM_ACCOUNTS_ENABLED=off`. Не удаляйте новые
таблицы/колонки и не очищайте invitation/session history. После rollback уже
отправленные ссылки остаются недоступны через API до повторного включения флага.

Author verification добавлен additive migration
`20260820180000_author_verification`. Она создаёт только новые
`author_profiles`, `author_verifications` и
`author_verification_evidence`; legacy webinar, registration, CRM, email,
Telegram и `admin_users` не изменяются. До открытия author onboarding:

1. Примените migration при `PLATFORM_ACCOUNTS_ENABLED=off` и убедитесь,
   что новые таблицы пусты, а legacy counts/postflight не изменились.
2. Проверьте owner/author flow на контролируемом tenant: draft,
   загрузка файла до 5 МиБ, submit и отказ в cross-tenant read/write.
3. Пройдите platform-admin review: `PENDING -> NEEDS_INFO -> PENDING ->
   VERIFIED`, затем `VERIFIED -> SUSPENDED`; проверьте audit с
   correlation ID и отсутствие internal reason в author response.
4. Убедитесь, что evidence response имеет `Cache-Control: no-store`,
   `X-Robots-Tag: noindex`, а public profile не содержит email, document ID/bytes
   и internal notes.
5. Правила публичного профиля, SLA и сроки хранения документов
   должны письменно утвердить юрист/DPO/владелец процесса. До этого не
   включайте публичный onboarding и не запускайте destructive cleanup.

Application rollback — `PLATFORM_ACCOUNTS_ENABLED=off`. Миграцию не
откатывайте и не удаляйте профили/документы: это требует отдельного
утверждённого retention/erasure process.

Webinar domain добавлен additive migration
`20260820190000_webinar_domain`. Она создаёт новые справочники и content
таблицы, затем привязывает каждую существующую `webinar_sessions` к одному
deterministic compatibility-Webinar своей организации. Для АСПБ используется
стабильный `webinar_aspb_legacy`; записи session/recording/registration/CRM и
delivery history не удаляются.

Перед migration сохраните вывод read-only проверки рядом со свежим verified
backup:

```bash
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820190000_webinar_domain_preflight.sql
```

Lock profile: создание новых таблиц не блокирует legacy writes; `ADD COLUMN`,
`SET NOT NULL` и замена unique index требуют lock на `webinar_sessions`, а
backfill пишет одну новую ссылку на строку. Штатный deploy перед migrations уже
останавливает API и webinar worker. `lock_timeout=5s` прерывает rollout при
неожиданном внешнем writer; не увеличивайте timeout без отдельного maintenance
решения. На большой таблице оцените размер из preflight и длительность полного
index scan на восстановленной production-копии.

После deploy и до запуска creator-флага выполните:

```bash
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820190000_webinar_domain_postflight.sql
npm run prisma:deploy
```

Postflight обязан подтвердить composite tenant FK, отсутствие session orphan,
valid/ready unique index `(webinar_id, scheduled_at)`, отсутствие прежней
глобальной уникальности `scheduled_at` и неизменные legacy counts. Повторный
deploy должен сообщить `No pending migrations to apply`. Application rollback
выполняется `CREATOR_DASHBOARD_ENABLED=off`; новые таблицы/колонки и backfill не
откатываются. Старый image допустим только пока creator flag ни разу не включался
и новые Webinar/session timestamps не создавались.

Session recurrence добавлена additive migration
`20260820193000_webinar_sessions_recurrence`. Она не создаёт расписания из
legacy data: прежние sessions сохраняют exact timestamps, получают
`schedule_version=1`, а `schedule_id` остаётся `NULL`. Существующие
reminder jobs получают ту же версию; history доставки не меняется.

До migration сохраните read-only snapshot:

```bash
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820193000_webinar_sessions_recurrence_preflight.sql
```

`ALTER TABLE` берёт краткий lock на `webinar_sessions` и
`email_outbox_jobs`; замена reminder uniqueness index сканирует outbox.
Штатный deploy уже останавливает API и worker. `lock_timeout=5s`
останавливает rollout при неожиданном writer; размер outbox и
время index build нужно замерить на restored production backup.

После deploy, но до включения creator-флага:

```bash
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820193000_webinar_sessions_recurrence_postflight.sql
npm run prisma:deploy
```

Postflight обязан подтвердить schedule tenant FK, cancellation
invariants, `schedule_version` и valid/ready versioned reminder index; legacy
counts сверяются с preflight. Повторный deploy не должен иметь
pending migrations. До первого session change schema rollback совместим;
после появления `webinar_session_rescheduled/cancelled` jobs не запускайте
старый worker: он не знает их service-notification contract. Откатывайтесь
только на image с поддержкой этой migration или оставляйте worker
остановленным до forward-fix.

Private Webinar access добавлен additive migration
`20260820200000_private_webinar_access`. Она создаёт только grant/token/outbox
таблицы и связи; существующие Webinar, sessions, registrations, CRM и delivery
history не переписываются. До migration сохраните read-only snapshot:

```bash
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820200000_private_webinar_access_preflight.sql
```

Применяйте migration при `PLATFORM_ACCOUNTS_ENABLED=off` и
`CREATOR_DASHBOARD_ENABLED=off`. Затем выполните:

```bash
npm run prisma:deploy
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820200000_private_webinar_access_postflight.sql
npm run prisma:deploy
```

Postflight обязан подтвердить composite tenant FK, purpose/email/token
constraints, отсутствие orphan и пустые новые таблицы на legacy-базе; повторный
deploy не должен иметь pending migrations. До включения creator/private flow:

1. Задайте отдельный стабильный `WEBINAR_ACCESS_HASH_SECRET` длиной не менее
   32 символов во всех API/worker replicas. Не ротируйте его как обычный cookie
   secret: смена HMAC нарушит email-bound проверку ранее созданных grants.
2. Разверните API и reminders worker одного совместимого image. Старый worker
   не знает `webinar_access_invitation_email_jobs` и не доставит приглашение.
3. Убедитесь, что protected dependency health
   `webinarAccessInvitationEmailOutbox` healthy, а Prometheus queues/failed/
   dead-letter равны ожидаемым значениям.
4. В `EMAIL_MODE=send` отправьте приглашение на контролируемый адрес, войдите
   тем же подтверждённым email, примите ссылку один раз и проверьте replay
   rejection, expiry и немедленный revoke. Raw token/email не должны попадать в
   application log или API list.
5. Только после этих проверок включайте platform/creator flags и наблюдайте
   access-outbox alerts. В `EMAIL_MODE=log` job честно отменяется и письмо не
   считается отправленным.

Application rollback выполняется обоими флагами `off`; schema и grant/audit
history не удаляются. Public legacy Webinar остаётся на compatibility path.
Токены очищаются через 7 дней после expiry, terminal email jobs — через 90
дней; сами grants автоматически не удаляются до юридического утверждения срока.

Tenant-scoped ChatScenario добавлен additive migration
`20260820203000_chat_scenario`. Новые таблицы пусты; legacy file-backed
`webinar-data/agent-chat-scenario.json` и существующие
`webinar_chat_messages` не мигрируются и продолжают обслуживать старую воронку.
Migration расширяет допустимые idempotent Webinar commands значением
`publish_scenario`, не меняя прежние действия.

```bash
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820203000_chat_scenario_preflight.sql
npm run prisma:deploy
node scripts/run-libpq-command.mjs psql \
  -v ON_ERROR_STOP=1 \
  -f prisma/checks/20260820203000_chat_scenario_postflight.sql
npm run prisma:deploy
```

Сравните counts Webinar/session/legacy chat/commands с preflight. Postflight
обязан подтвердить composite tenant FK, version/approval constraints и
`is_synthetic=true` для всех scenario messages. До включения creator flow
проверьте на контролируемом tenant save→publish→duplicate: duplicate получает
новый draft/version 1 без approval/history. Cross-tenant GET/PATCH должны
возвращать тот же safe `404`. Application rollback —
`CREATOR_DASHBOARD_ENABLED=off`; таблицы и audit не удаляются. Старый image не
знает новый scenario API, но legacy scripted chat остаётся совместимым.

Public catalog не требует migration и включается отдельным
`PUBLIC_CATALOG_ENABLED`. До switch держите его `off`: legacy landing скрывает
ссылку, catalog API и `/sitemap.xml` отвечают 404, registration/room не
изменяются. Перед включением:

1. Пройдите full CI и targeted catalog integration/browser acceptance на image,
   который содержит `src/lib/catalog.ts` и `crisis_premium/catalog*.html`.
2. На staging создайте по одному PUBLIC, UNLISTED, PRIVATE, DRAFT и ARCHIVED
   Webinar. List и sitemap обязаны содержать только PUBLIC; direct UNLISTED
   detail должен иметь `X-Robots-Tag: noindex`; остальные закрытые состояния —
   совпадать по safe 404 с неизвестным slug.
3. Приостановите membership автора и его organization по очереди: карточка и
   sitemap entry должны исчезнуть без удаления Webinar, sessions,
   registrations, CRM events или analytics history.
4. Проверьте старый slug alias и SUPERSEDED notice. Ссылка на successor
   разрешена только если successor сам eligible; private successor не должен
   раскрываться.
5. Пока tenant-scoped REG vertical не включена, registration CTA остаётся
   честно disabled. Не перенаправляйте его на legacy single-Webinar форму:
   это свяжет заявку с неправильным Webinar.

Rollback — только `PUBLIC_CATALOG_ENABLED=off`. Ничего не удаляйте и не меняйте
visibility существующих Webinar. При отключении sitemap снова отвечает 404, а
legacy landing продолжает прежнюю воронку.

Media foundation разворачивается со значением
`MEDIA_STORAGE_PROVIDER=unconfigured`. В этом режиме migration и status data
безопасны, но новый upload init fail-closed отвечает `503`; legacy room/replay
media gateway не меняется. `MEDIA_STORAGE_PROVIDER=test_fake` запрещён вне
test. Creator UI при такой конфигурации показывает честную provider error, а legacy flow
продолжает работать. Для provider rollout задайте точный comma-separated allowlist HTTPS
origins в `MEDIA_UPLOAD_CSP_ORIGINS` и отдельно проверьте private multipart origin, server
part checkpoints/resume, CORS, MIME signature,
ffprobe duration, checksum, HLS manifest, poster, retry/dead-letter и
cookie-authorized Range/HLS delivery. Rollback application path — вернуть
provider в `unconfigured`; таблицы, READY versions и audit не удалять, а
`current_media_asset_id` не переключать.
Реальный adapter включается только после acceptance через
`MEDIA_STORAGE_PROVIDER=s3` и полный набор `MEDIA_S3_*`. API/worker image должен
содержать `ffmpeg` и `ffprobe`; paths задаются `MEDIA_FFMPEG_PATH` и
`MEDIA_FFPROBE_PATH`. Перед switch проверьте bucket lifecycle для incomplete multipart,
provider CORS, worker disk space под source + renditions и outbound access к object storage.
Отдельно сымитируйте потерю ответа после provider-side
`CompleteMultipartUpload`: `ListParts` вернёт `NoSuchUpload`, resume должен
вернуть все trusted checkpoints без новых signed parts, а repeat complete —
подтвердить object через `HeadObject` и создать ровно один job.
Техническая рекомендация, сравнительная матрица, цены snapshot и внешняя точка
legal/budget approval находятся в
[`DEC-05-MEDIA-STORAGE-CDN-TRANSCODER.md`](./DEC-05-MEDIA-STORAGE-CDN-TRANSCODER.md).

До migrations `20260821120000`–`20260821122000` сохраните вывод трёх read-only
preflight; после deploy запустите postflight. Все violation counts должны быть
нулевыми, кроме явно информационных `*_before`/`oldest_*` значений:

```bash
for version in \
  20260821120000_media_provider_hardening \
  20260821121000_media_stt_audio \
  20260821122000_media_job_leases
do
  node scripts/run-libpq-command.mjs psql -v ON_ERROR_STOP=1 \
    -f "prisma/checks/${version}_preflight.sql"
done

npm run prisma:deploy

for version in \
  20260821120000_media_provider_hardening \
  20260821121000_media_stt_audio \
  20260821122000_media_job_leases
do
  node scripts/run-libpq-command.mjs psql -v ON_ERROR_STOP=1 \
    -f "prisma/checks/${version}_postflight.sql"
done
```

Media worker продлевает DB lease и reminders progress heartbeat каждые 30 секунд.
После принудительного завершения container дождитесь следующего worker tick:
abandoned `RUNNING` job должен получить audit `media.provider.lease_recovered`,
вернуться в `PENDING` и продолжить с новой попытки; при исчерпанном лимите —
перейти в `DEAD_LETTER`. Не исправляйте status вручную.

Текущая защищённая выдача проверяет participant session, точную регистрацию и
`WebinarSession`, tenant, private grant и replay expiry перед manifest и каждым
resource/Range request. Это correctness-first application gateway. Не включайте
CDN path как production replacement, пока edge-auth/revoke, origin isolation,
HLS/Range и нагрузочный тест не докажут эквивалентную авторизацию и допустимую
нагрузку; rollback CDN — вернуть gateway route, не раскрывая S3 origin.

Transcript/AI migrations можно additive-развернуть с
`STT_PROVIDER=unconfigured` и `AI_ENRICHMENT_PROVIDER=unconfigured`: generation endpoints в этом
режиме fail closed, а уже сохранённые versions/search/export не повреждаются.
До письменного утверждения [`DEC-06-STT-AI-PROVIDERS.md`](./DEC-06-STT-AI-PROVIDERS.md)
не включайте provider. Provider acceptance должен покрыть DPA/регион
обработки, timeout/retry/idempotency, speaker/timestamp quality, tenant dictionary, provider/model
provenance, письменный no-training/retention/delete contract, отсутствие
secrets/signed URLs/PII в логах и явное human review до любой publication.
Rollback — вернуть provider в `unconfigured`; не удалять transcripts,
provenance и review decisions.
После approval активация выполняется через `STT_PROVIDER=yandex_speechkit`
и/или `AI_ENRICHMENT_PROVIDER=yandex_foundation_models` с `STT_YANDEX_*`/`AI_YANDEX_*`.
Не переиспользуйте media S3 credentials как API keys. Audio URI prefix должен
давать SpeechKit доступ только к private speech renditions и иметь отдельный
provider-side retention/delete policy.

Seed нужен только при первичной подготовке demo/default данных:

```bash
npm run seed
```

Seed создаёт первоначального owner только когда таблица администраторов вообще
пуста. После появления любой admin-записи `ADMIN_LOGIN` больше не является
командой создать/повысить owner: повторный запуск не меняет пароль, роль или
`isActive` и не может отменить ручную деактивацию/понижение администратора.

Не запускайте `prisma migrate dev` на production.

Миграция `20260805120000_email_outbox_bearer_redaction` удаляет открытые
bearer-ссылки из legacy outbox и отзывает связанные одноразовые токены целей
`registration`/`participant_login`. Активные outbox-задачи не теряются: новый
worker выпустит fresh hash и сформирует ссылку только в памяти перед SMTP.
Ссылки из ранее сохранённых, но ещё не отправленных писем/backup перестанут
работать; участнику нужно запросить новую ссылку на странице «Мой доступ».

## Локальная проверка production image

```bash
docker build -t aspb-autowebinar:local .
```

Перед публикацией видео проверьте фактически настроенный HLS/MP4 origin и
`WEBINAR_VIDEO_DURATION_SECONDS` (по умолчанию 3860 секунд):

```bash
VIDEO_ENV_FILE=.env.production bash scripts/check-video.sh
```

Проверка предпочитает `WEBINAR_VIDEO_HLS_URL`, как и плеер, и больше не считает
старый локальный `assets/webinar.mp4` источником production. Private-origin
token остаётся внутри проверяющего процесса, не передаётся в argv/process
list и никогда не отправляется по HTTP/через HTTPS→HTTP redirect. MP4 metadata
читается bounded first/last range без `ffprobe`; checker парсит
структурные `ftyp`/`mdat`/`moov`/`mvhd` boxes. HLS manifest
читается streaming с жёстким лимитом 1 MiB; checker у первого/последнего
сегмента требует MPEG-TS PAT+PMT+video PES либо структурные
fMP4 `moof`/`traf`/`tfhd`/`trun`/`mdat`. Authorization отправляется только исходному
origin настроенного URL и пересчитывается при каждом redirect: absolute
cross-origin variant/segment никогда не получает private token.

## Запуск через Docker Compose

Для контура, где PostgreSQL также управляется Docker Compose:

```bash
DEPLOY_IMAGE_TAG=local docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

Если production использует уже установленный нативный PostgreSQL, используйте
отслеживаемый Git-файл без контейнера БД:

```bash
DEPLOY_IMAGE_TAG=local docker compose --env-file .env.production -f docker-compose.native-postgres.yml up -d --build
```

`docker-compose.native-postgres.yml` не поднимает и не заменяет PostgreSQL;
приложение подключается строго по `DATABASE_URL` из `.env.production`. Внутри
контейнера `127.0.0.1` и `localhost` указывают на сам контейнер, а не на VPS.
Для PostgreSQL на Linux-хосте используйте `host.docker.internal` (compose
добавляет `host-gateway`) либо отдельный доступный контейнеру host IP. PostgreSQL
должен слушать этот интерфейс, а `pg_hba.conf`/firewall — разрешать только
необходимую Docker-сеть.

API container сам выполнит:

```bash
npx prisma migrate deploy
WORKER_ROLE=api node dist/src/server.js
```

Worker container запускается через watchdog, не открывает HTTP-порт и после
трёх последовательных ошибок stale-heartbeat завершает процесс с non-zero.
`restart: unless-stopped` перезапускает контейнер; одиночный временный сбой к
restart не приводит. Одна SMTP-попытка ограничена 25 секундами, отправка —
одной попыткой с жёстким общим budget 30 секунд; это ниже 90-секундного порога
watchdog и 10-минутной stale-lease outbox. Retry выполняется как новая
попытка worker после backoff, а не внутри одного heartbeat-window. Между
письмами worker обновляет
heartbeat, поэтому зависший SMTP не удерживает job бесконечно.

Проверка:

```bash
curl https://ваш-домен/health/ready
curl https://ваш-домен/health/dependencies
curl -H "Authorization: Bearer $METRICS_TOKEN" https://ваш-домен/health/dependencies/details
curl -H "Authorization: Bearer $METRICS_TOKEN" https://ваш-домен/metrics
```

Ожидаемый ответ:

```json
{"service":"aspb-autowebinar","ok":true,"checks":{"database":{"ok":true}}}
```

`/health/dependencies` публично возвращает только aggregate
`{"ok":<boolean>,"status":"ok|degraded"}`. Он не раскрывает имена
компонентов, тексты ошибок, username, email, host, credentials или
размеры очередей. Какой именно контур деградировал, видно только
в защищённом `/health/dependencies/details` с `METRICS_TOKEN`; ни один из
этих endpoint не используется как основной container readiness.

## SSL

Минимальный вариант для VPS:

1. Поставить Nginx.
2. Настроить reverse proxy на `127.0.0.1:5174`.
3. Выпустить сертификат Let's Encrypt через Certbot.
4. В `.env.production` указать `PUBLIC_SITE_URL=https://ваш-домен`.

## Backup

Создать backup:

```bash
PG_DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/aspb_autowebinar?sslmode=require' npm run backup:db
```

Или для PostgreSQL внутри compose:

```bash
COMPOSE_FILE=docker-compose.production.yml COMPOSE_ENV_FILE=.env.production npm run backup:db
```

Для нативного PostgreSQL задавайте `PG_DATABASE_URL` или `DATABASE_URL`;
compose-файл с отсутствующим
сервисом `postgres` скрипт отклонит. Backup создаётся во временном файле под
lock, проверяется через `gzip -t` и заголовок `pg_dump`, а затем атомарно
переименовывается в `backups/aspb-postgres-*.sql.gz`. Повреждённый или
неполный dump под финальным именем не публикуется.

Для host `pg_dump`/`psql` можно задать отдельный `PG_DATABASE_URL` только с
libpq-параметрами. Если он отсутствует, helper безопасно разбирает Prisma
`DATABASE_URL`: `connection_limit`, `pool_timeout` и другие Prisma-only
параметры не передаются libpq, `schema` становится `pg_dump --schema` либо
`PGOPTIONS search_path` для restore. Неизвестный query-параметр приводит к
отказу до подключения; URL и пароль в лог не выводятся.

После успешного создания новой копии backup-скрипт удаляет только локальные
`aspb-postgres-*.sql.gz` старше 30 дней. Срок можно изменить через
`BACKUP_RETENTION_DAYS`. Перед включением расписания должна существовать
проверенная внешняя/off-site копия.

Восстановить backup:

```bash
RESTORE_TARGET=recovery \
PG_DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/aspb_autowebinar_recovery?sslmode=require' \
npm run restore:db -- backups/aspb-postgres-YYYYMMDDTHHMMSSZ.sql.gz
```

Restore сначала выполняет `gzip -t` и проверяет PostgreSQL dump header, затем
запускает `psql -v ON_ERROR_STOP=1 --single-transaction`. Recovery database или
schema обязана содержать маркер `recovery`, `restore`, `test` либо `staging`.
Восстановление прямо поверх production по умолчанию запрещено; для аварийной
процедуры нужны одновременно `RESTORE_TARGET=production` и точная фраза
`CONFIRM_PRODUCTION_RESTORE=RESTORE_PRODUCTION_IN_PLACE`.

Для compose recovery укажите явные `COMPOSE_FILE`, `COMPOSE_ENV_FILE` и
`POSTGRES_DB=aspb_autowebinar_recovery`; скрипт валидирует compose и наличие
сервиса `postgres` до подключения.

Docker-логи `api`, `webinar-worker` и `postgres` ротируются: по умолчанию
хранятся три файла максимум по 10 МБ на контейнер. Параметры задаются через
`DOCKER_LOG_MAX_SIZE` и `DOCKER_LOG_MAX_FILES`.

После успешных healthcheck, пока серверный deploy-lock ещё удерживается,
deploy запускает targeted image retention. Он работает только с
`aspb-autowebinar-api` и `aspb-autowebinar-worker`, сохраняет image ID
текущих containers, rollback target и три последних image каждого
репозитория. Images, используемые любым running или stopped
container, не удаляются. Лимит задаётся shell-переменной
`APP_IMAGE_KEEP_RECENT`; автоочистку можно аварийно отключить
`APP_IMAGE_PRUNE=off`.

BuildKit-кэш по умолчанию не чистится: `DOCKER_BUILD_CACHE_PRUNE=off`.
Значение `on` допустимо только на выделенном Docker daemon, потому что
`docker builder prune` затрагивает build-cache всех проектов на daemon.
`DOCKER_BUILD_CACHE_MAX_AGE` задаёт возраст только для этого явного opt-in.

До загрузки image deploy проверяет фактический `DockerRootDir`, который
сообщает активный Docker daemon, а не жёстко заданный каталог.
На Docker filesystem требуется максимум из 3 GiB и оценки распаковки
artifact (`размер × 6 + 1 GiB`), а также не менее 15% свободного
места. Отдельно проверяется filesystem каталога artifact. Для
`docker-compose.native-postgres.yml` абсолютный существующий
`NATIVE_POSTGRES_STORAGE_PATH` обязателен: без него deploy падает, а не
пропускает проверку хранилища нативного PostgreSQL.
Пороги настраиваются через `MIN_DEPLOY_*`, `DEPLOY_ARTIFACT_*` и
`MIN_POSTGRES_MIGRATION_*`. При ошибке release
error-trap удаляет только exact-SHA refs неудачного `api`, `worker` и временного
`aspb-autowebinar-build`; current/rollback image IDs и images любого контейнера
всегда защищены. Переданные tar.gz/checksum удаляются отдельным SSH trap даже
если проверка или migration завершилась ошибкой.

После deploy следует проверить и при необходимости удалить только
неиспользуемые Docker-данные (не применять `docker volume prune` к production):

```bash
docker system df -v
bash scripts/prune-app-images.sh --dry-run
APP_IMAGE_KEEP_RECENT=3 bash scripts/prune-app-images.sh --apply
```

`prune-app-images.sh` не вызывает global `docker image prune`, `system prune`
или `volume prune`. Не подменяйте его на `docker image prune -a`: это
удалит неиспользуемые images других проектов общего VPS.
Ручной dry-run/apply берёт тот же deploy-lock и откажется
работать параллельно с релизом.
Именно SHA-tagged app images, а не BuildKit cache, были причиной
постоянного роста диска после каждого deploy.

На общем VPS `scripts/prune-server-storage.sh` сохраняет активный и пять
последних неактивных релизов `compliance152`. Он принимает только
канонический каталог из exact allowlist, отказывается работать с
широкими корнями и требует exact marker. Перед первым запуском:

```bash
printf 'compliance152-release-root-v1\n' > /opt/compliance152-releases/.compliance152-release-root
chmod 600 /opt/compliance152-releases/.compliance152-release-root
bash scripts/prune-server-storage.sh --dry-run
# Только после проверки списка:
bash scripts/prune-server-storage.sh --apply
```

`COMPLIANCE_CURRENT_LINK` обязан быть symlink на один прямой дочерний
каталог root. При частых деплоях запускайте dry-run/проверенный apply
каждые 15 минут; суточного расписания недостаточно, если за день создаются
десятки полных копий релиза.

Перед реальным запуском нужно один раз проверить восстановление на тестовой базе.

## CI/CD

CI уже добавлен в `.github/workflows/ci.yml`. Integration, browser E2E,
dependency audit и Docker build выполняются отдельными jobs, поэтому падение
одного набора не скрывает verdict остальных. Любой required job блокирует
staging/production deploy.

Container собирается ровно один раз в `container-build` из exact
`github.sha` на закреплённом digest образа Node 22.23.2. CI проверяет OCI
revision/schema labels, экспортирует image в tar.gz, публикует artifact с
SHA-256 checksum и подписывает GitHub/Sigstore build-provenance
attestation. На сервере `gh attestation verify` fail-closed проверяет
exact байты archive, repository, signer workflow, source commit/ref и запрещает
provenance от self-hosted runner. Локальный checksum проверяет целостность
пары файлов, но не заменяет подписанную provenance. На сервере должен
быть установлен GitHub CLI с поддержкой `gh attestation`. Для private
repository нужно до deploy выполнить `gh auth status` под тем же
серверным пользователем; non-interactive deploy получает `GH_TOKEN` с
минимальным read-доступом к repository и attestations. Обычный deploy
ничего не пересобирает.

Он проверяет:

- `npm ci`
- `npx prisma generate`
- `npx prisma migrate deploy`
- `npm run seed`
- `npm run build`
- production command smoke: `test -f dist/src/server.js`
- `npm test`
- `npx playwright install --with-deps chromium`
- `npm run e2e`
- `npm audit --omit=dev`
- `docker build`
- `docker compose config --quiet` для обоих tracked production compose-файлов
- Docker production command smoke: `test -f dist/src/server.js` inside the image
- dependency review для PR
- Semgrep SAST
- secretlint и dotenv-linter
- staging deploy по push в `main` и перед production: отсутствие любого
  `STAGING_*` secret роняет job, checkout exact `github.sha` выполняется
  без `git pull`, с tracked `docker-compose.native-postgres.yml`
- production deploy — только через ручной `workflow_dispatch` с
  `deploy_target=production`, ветки `main`, после успешного staging того же
  `github.sha`, всех required jobs и approval защищённого GitHub environment
  `production`

Каждый workflow run копирует artifact в свой `/tmp/aspb-deploy-*`
каталог. Серверный `flock` берётся до проверки worktree, `git fetch`
и checkout, поэтому два deploy не могут поменять общий worktree или
удалить artifact друг друга.

Штатный deploy запускается workflow. Для ручного повтора уже проверенного CI
artifact скачайте archive/checksum именно этого run в уникальный
`/tmp/aspb-deploy-*` каталог. Внутри имена обязаны точно соответствовать
SHA. Ручной production-repeat допустим только после успешного staging этого
же SHA; это проверяет оператор, а штатный workflow гарантирует сам:

```bash
VERIFIED_BACKUP_FILE=backups/aspb-postgres-YYYYMMDDTHHMMSSZ.sql.gz \
DEPLOY_COMMIT_SHA="$(git rev-parse HEAD)" \
DEPLOY_VERIFIED_CI_SHA="$(git rev-parse HEAD)" \
DEPLOY_VERIFIED_CI_RUN_URL=https://github.com/ORG/REPO/actions/runs/RUN_ID \
DEPLOY_GITHUB_REPOSITORY=ORG/REPO \
DEPLOY_SOURCE_REF=refs/heads/main \
DEPLOY_ENVIRONMENT=production \
NATIVE_POSTGRES_STORAGE_PATH=/absolute/path/to/postgresql/data \
DEPLOY_PREBUILT_IMAGES=on \
DEPLOY_IMAGE_ARCHIVE="/tmp/aspb-deploy-manual-RUN_ID/aspb-image-$(git rev-parse HEAD).tar.gz" \
DEPLOY_IMAGE_CHECKSUM_FILE="/tmp/aspb-deploy-manual-RUN_ID/aspb-image-$(git rev-parse HEAD).tar.gz.sha256" \
COMPOSE_FILE=docker-compose.native-postgres.yml \
COMPOSE_ENV_FILE=.env.production \
bash scripts/deploy-production.sh
```

Сборка прямо на production и unsigned artifact запрещены fail-closed.
`ALLOW_REMOTE_REBUILD` и `ALLOW_DEPLOY_WITHOUT_CI_ATTESTATION` больше не
являются bypass: если CI artifact/attestation недоступны, release
останавливается до восстановления цепочки provenance.

Скрипт валидирует фактический compose через `docker compose config`, не
принимает untracked compose по умолчанию и держит серверный `flock`. Dependency
health обязан вернуть HTTP 200. Только для осознанного аварийного запуска можно
явно передать `ALLOW_DEGRADED_DEPENDENCIES=on`, разрешив 503.

Tag image принудительно равен 40-символьному `DEPLOY_COMMIT_SHA`. Docker image
и запущенные containers обязаны содержать совпадающий OCI label
`org.opencontainers.image.revision`; SHA и image IDs атомарно записываются в
`backups/deploy-state/current-release.env`. Несовпадение блокирует замену либо
запускает rollback. Перед bearer-redaction migration останавливаются и старый
webinar-worker, и старый API, чтобы ни один legacy-процесс не записал новую
открытую ссылку во время миграции. До старта migration прежние сервисы можно
безопасно вернуть. После старта migration автоматический rollback разрешён
только если прежний image имеет schema compatibility `email-links-v2`;
legacy/missing image остаётся остановленным, а восстановление выполняется
только совместимым image.
`DEPLOY_VERIFIED_CI_SHA` должен совпадать с commit, а
`DEPLOY_VERIFIED_CI_RUN_URL` — указывать на GitHub Actions run, из которого
запущен deploy. Эти поля — audit metadata, а не доказательство:
криптографическую привязку archive к repo/workflow/SHA/ref даёт только
успешная GitHub/Sigstore attestation verification.

Перед build проверяются и tracked, и untracked изменения. Любой
untracked файл в `src/`, `prisma/migrations/` или frontend блокирует
deploy, чтобы Docker context не мог отличаться от `DEPLOY_COMMIT_SHA`.
Исключены только runtime-каталоги backup/test reports. Старый
server-local `docker-compose.deploy.yml` нужно удалить или вынести из
deploy-worktree; фактический compose теперь обязан быть tracked.
Ignored review-артефакты `crisis_premium/_diffs_*` и `_full_diffs*`
отдельно исключены из Docker context; CI проверяет это real build probe.

Перед forward-only migrations deploy проверяет `VERIFIED_BACKUP_FILE`: это
должен быть обычный (не symlink и не `.part`) `.sql.gz`, `gzip -t` должен
проходить, внутри нужен заголовок PostgreSQL dump, а возраст по умолчанию не
может превышать 24 часа. Порог задаётся
`VERIFIED_BACKUP_MAX_AGE_SECONDS`. Единственный bypass для документированной
аварийной процедуры — явный `ALLOW_DEPLOY_WITHOUT_VERIFIED_BACKUP=on`; обычный
CI его не устанавливает.

## Ротация секретов после небезопасных прав

Если реальный `.env`/`.env.production` когда-либо имел mode `0644`, считайте
содержащиеся в нём credentials потенциально раскрытыми. Сначала установите
`chmod 600`, проверьте права backup/log-архивов без вывода значений секретов,
затем по очереди выпустите и разверните новые Telegram bot tokens, SMTP
password/API key, `ADMIN_COOKIE_SECRET`, `METRICS_TOKEN`,
`WEBINAR_MEDIA_ORIGIN_TOKEN`, database credentials и остальные ключи из файла.
Старые значения отзываются только после healthy deploy с новыми. Blind-ротация
`ADMIN_COOKIE_SECRET` недопустима: от него сейчас также выводится ключ
шифрования TOTP, поэтому до отзыва старого значения нужен план re-enrollment
или контролируемого re-encryption MFA; иначе можно заблокировать вход всем
администраторам. Смена завершит admin sessions и изменит подписи unsubscribe,
но не отзывает participant room sessions, чьи hash хранятся в БД. Смену
`IP_HASH_SECRET` согласуйте с retention/audit-политикой, так как она разрывает
сопоставимость старых и новых технических hash.

Безопасный fallback, пока отдельного проверенного re-encryption tool нет:

1. Назначить maintenance window, проверить свежий backup и наличие минимум
   двух активных owner с известными сильными паролями; старый secret пока не
   менять.
2. Закрыть внешний доступ и остановить API/worker. В одной аудируемой
   транзакции очистить `mfa_secret_encrypted`/`mfa_enabled_at` только у
   активных администраторов и увеличить им `session_version`, чтобы отозвать
   все admin sessions.
3. Развернуть новый `ADMIN_COOKIE_SECRET`, открыть админку только через
   временный IP/VPN allowlist и немедленно заново включить MFA для каждого
   активного owner/manager. Пока продукт не принуждает enrollment, публичный
   доступ не возвращать.
4. Проверить вход и новый TOTP у двух owners, health/audit logs, после чего
   снять allowlist и окончательно уничтожить старое значение. Если нельзя
   обеспечить это окно, ротацию отложить и сначала реализовать/testировать
   controlled re-encryption на копии production backup.

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
Сам `playwright.config.ts` запускает test-DB guard до импорта spec-файлов,
поэтому прямой `npx playwright test` также не сможет выполнить `TRUNCATE` на
унаследованной внешней или production-like БД.

## Ручная product QA

1. Открыть landing/register page.
2. Зарегистрировать нового пользователя.
3. Проверить success page и отсутствие `token` в URL.
4. Перейти в webinar room.
5. Нажать Telegram-кнопку на success page, выполнить `/start <token>`, повторить ту же ссылку и убедиться, что chatId не перепривязывается.
6. Проверить, что room/timeline/chat работают через cookie/session.
7. В live-состоянии проверить DVR: отмотку назад в прошедший буфер, отсутствие доступа к будущему видео и кнопку `К эфиру`.
8. Проверить видео: HLS играет первым, а браузер во всех режимах получает cookie-защищённый `/api/media/*`, не origin URL. Прямой public media path должен давать 401/403/404; внешний origin без `WEBINAR_MEDIA_ORIGIN_TOKEN` должен отклоняться.
9. Отправить вопрос и увидеть его в чате/CRM.
10. Дождаться/смоделировать завершение эфира и проверить “Вебинар окончен” на видео и открытый чат.
11. Отправить partner application и увидеть заявку в CRM.
12. Проверить admin CRM: карточка регистрации, статусы, заметки, заявки, вопросы.

## Минимальный production checklist

- [ ] Домен подключен.
- [ ] HTTPS работает.
- [ ] `.env.production` заполнен реальными значениями.
- [ ] `.env.production` имеет mode `0600`/`0400`, не является symlink; потенциально раскрытые credentials ротированы.
- [ ] `METRICS_TOKEN` задан и сохранен только в secret/env.
- [ ] `EMAIL_MODE=send` и SMTP verify обязательны перед открытием публичной формы; `EMAIL_MODE=log` не выдаёт pending-пользователю доступ.
- [ ] SMTP протестирован перед переключением в `send`.
- [ ] `WEBINAR_VIDEO_HLS_URL` или `WEBINAR_VIDEO_URL` задан на внешний private origin с token либо на same-origin файл из read-only mount; прямой public media path закрыт; poster доступен по HTTPS.
- [ ] `LEGACY_MEDIA_PATH` указывает на существующий выделенный абсолютный каталог с прежними replay/HLS/poster файлами; оба production compose монтируют его только для чтения в `/app/crisis_premium/assets/media`.
- [ ] `VIDEO_ENV_FILE=.env.production bash scripts/check-video.sh` подтверждает настроенный источник и длительность 3860 секунд.
- [ ] Telegram participant bot протестирован.
- [ ] Telegram admin bot протестирован.
- [ ] Публичный `/health/dependencies` раскрывает только aggregate `ok/status`, без имён компонентов/errors/counts/usernames; полная диагностика доступна только в защищённом `/health/dependencies/details`.
- [ ] Telegram deep-link `/start` token одноразовый и не работает как room exchange token.
- [ ] Telegram news работает через durable broadcast jobs: `slot_key`/idempotency уникальны, временная ошибка получает retry, а consent перепроверяется перед каждой отправкой.
- [ ] `WEBINAR_TEST_ROOM_MODE=off`.
- [ ] `npm run prisma:deploy` проходит.
- [ ] `npm run css:build` проходит.
- [ ] `npm run lint` проходит.
- [ ] `npm run build` проходит.
- [ ] `npm test` проходит.
- [ ] `npm audit --omit=dev` проходит.
- [ ] `npm run e2e:install` выполнен.
- [ ] `npm run e2e` проходит.
- [ ] GitHub Actions CI проходит.
- [ ] Production workflow запущен для exact `github.sha` из `main`; staging того же SHA успешен, approval зафиксирован в GitHub environment.
- [ ] Docker image собран один раз в CI; checksum, OCI revision и GitHub/Sigstore attestation для repository/workflow/SHA/ref проверены до `docker load`.
- [ ] В image существует `dist/src/server.js`.
- [ ] Выбран правильный tracked compose: `docker-compose.production.yml` для Docker PostgreSQL или `docker-compose.native-postgres.yml` для нативного PostgreSQL.
- [ ] Для native compose заданы и проверены абсолютные `STAGING_NATIVE_POSTGRES_STORAGE_PATH` и `PRODUCTION_NATIVE_POSTGRES_STORAGE_PATH`; capacity gate видит filesystem PostgreSQL.
- [ ] Свежий `VERIFIED_BACKUP_FILE` создан и проверен перед migrations.
- [ ] Deploy использует `DEPLOY_PREBUILT_IMAGES=on` и exact-SHA archive/checksum из того же passing CI run.
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

До замены контейнеров deploy сохраняет точные предыдущие image ID и refs в
`backups/deploy-state/rollback-target.env`. Если container/dependency/worker
health-check не проходит, скрипт автоматически возвращает предыдущие images и
ждёт их healthy-состояния.

Для самого первого запуска, когда предыдущих containers ещё нет, deploy по
умолчанию откажется продолжать. Разовый операторский override:

В штатном GitHub Actions workflow для этого предусмотрен boolean input
`allow_first_deploy`. Включайте его только для первого ручного
`workflow_dispatch` на выбранный `deploy_target`; значение проходит через
защищённые `staging`/`production` environments и не используется при обычном
push в `main`. После появления rollback image оставляйте input выключенным.

```bash
ALLOW_DEPLOY_WITHOUT_ROLLBACK=on \
VERIFIED_BACKUP_FILE=backups/aspb-postgres-YYYYMMDDTHHMMSSZ.sql.gz \
DEPLOY_COMMIT_SHA="$(git rev-parse HEAD)" \
DEPLOY_VERIFIED_CI_SHA="$(git rev-parse HEAD)" \
DEPLOY_VERIFIED_CI_RUN_URL=https://github.com/ORG/REPO/actions/runs/RUN_ID \
DEPLOY_GITHUB_REPOSITORY=ORG/REPO \
DEPLOY_SOURCE_REF=refs/heads/main \
DEPLOY_ENVIRONMENT=production \
NATIVE_POSTGRES_STORAGE_PATH=/absolute/path/to/postgresql/data \
DEPLOY_PREBUILT_IMAGES=on \
DEPLOY_IMAGE_ARCHIVE="/tmp/aspb-deploy-manual-RUN_ID/aspb-image-$(git rev-parse HEAD).tar.gz" \
DEPLOY_IMAGE_CHECKSUM_FILE="/tmp/aspb-deploy-manual-RUN_ID/aspb-image-$(git rev-parse HEAD).tar.gz.sha256" \
COMPOSE_FILE=docker-compose.native-postgres.yml \
bash scripts/deploy-production.sh
```

Миграции Prisma являются forward-only и автоматически назад не откатываются.
Поэтому перед миграциями обязателен проверенный backup; при несовместимой
миграции восстановите его в отдельный recovery-контур и следуйте отдельному
плану восстановления данных, не выполняя импровизированный down-migration на
production. После bearer-redaction migration не запускайте legacy image без
label `email-links-v2`: он снова начнёт сохранять bearer-ссылки открытым
текстом. Если deploy остановился в этом состоянии, оставьте старые API/worker
выключенными и повторно запустите exact совместимый CI artifact.

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
