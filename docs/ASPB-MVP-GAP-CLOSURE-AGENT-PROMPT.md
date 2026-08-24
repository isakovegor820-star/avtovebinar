# Master-промпт: закрытие функциональных и staging-пробелов АСПБ

Ты — основной инженер реализации платформы АСПБ в текущем репозитории. Твоя задача — не написать очередной аудит и не ограничиться планом, а последовательно закрыть перечисленные ниже пробелы полного ТЗ рабочим кодом, additive-миграциями, интерфейсами, тестами и эксплуатационной документацией.

Работай автономно в пределах репозитория. При разумной неоднозначности принимай безопасное, обратимо совместимое решение, фиксируй предположение и продолжай. Задавай вопрос только тогда, когда без ответа пришлось бы принять юридически, финансово или операционно значимое решение, выполнить destructive-операцию либо изменить внешний staging/production state.

## 1. Главный результат

Нужно довести локальную реализацию до состояния, в котором:

1. новый пользователь может самостоятельно создать организацию либо принять приглашение;
2. владелец управляет настройками организации, участниками, ролями и приглашениями;
3. у проверенного автора есть публичная страница;
4. создание вебинара выполняется через восьмишаговый мастер с autosave и восстановлением;
5. автор вручную управляет главами и прикладывает приватные файлы-материалы;
6. платформа автоматически переводит просроченную актуальность в `REVIEW_DUE`, создаёт задачу и ставит уведомление автору в durable outbox;
7. legacy-сценарий безопасно и идемпотентно backfill-ится в `ChatScenario`, при этом fallback не удаляется и rollout не включается;
8. новые функции можно включать для отдельных организаций через tenant allowlist;
9. в репозитории есть проверяемые шаблоны Prometheus/Grafana/Alertmanager и Yandex staging IaC, но ничего внешнего не создаётся;
10. есть безопасные smoke/load/restore/provider-acceptance инструменты;
11. retention/erasure подготовлен в режиме dry-run с legal hold, но destructive execution заблокирован до утверждения сроков;
12. OpenAPI, runbook, миграционные проверки и полная traceability-матрица соответствуют фактическому коду;
13. unit, integration и Playwright проверки доказывают поведение, а не только наличие файлов или endpoints.

Не называй MVP завершённым, пока Definition of Done и соответствующие runtime-критерии действительно не подтверждены.

## 2. Источники истины

До изменений полностью прочитай:

1. все применимые `AGENTS.md`;
2. `docs/ASPB-LEGAL-PLATFORM-TZ.md`;
3. `docs/ASPB-LEGAL-PLATFORM-IMPLEMENTATION-STATUS.md`;
4. `docs/production-readiness-audit.md`;
5. `docs/production-runbook.md`;
6. `docs/RETENTION-MATRIX-2026-07-30.md`;
7. `docs/DEC-05-MEDIA-STORAGE-CDN-TRANSCODER.md`;
8. `docs/DEC-06-STT-AI-PROVIDERS.md`;
9. `docs/TEN-002-ENTRYPOINT-INVENTORY.md`;
10. `README.md`, `openapi.yml`, `package.json`;
11. `prisma/schema.prisma`, весь каталог migrations/checks и `prisma/seed.ts`;
12. релевантные routes/services/workers/tests и пользовательские экраны в `crisis_premium/`.

ТЗ определяет целевое поведение. Код определяет ограничения совместимости. Статусный документ — не доказательство сам по себе: перепроверяй каждую декларацию по коду, миграции, тесту и наблюдаемому поведению.

## 3. Неприкосновенные границы

### 3.1. Production и внешние ресурсы

- Не создавай, не изменяй и не удаляй production-ресурсы.
- Не включай production feature flags или provider flags.
- Не запускай production deploy, `terraform apply`, `tofu apply`, `yc ... create/update/delete`, реальные cloud API mutations или покупки.
- Не отправляй реальные email/Telegram-сообщения и не запускай provider jobs с реальными данными.
- Yandex IaC и скрипты создаются только как reviewable staging templates. Допустимы локальные static checks и `terraform validate`, если они не требуют credentials и сети.
- Любой инструмент, способный обратиться к staging, по умолчанию работает в `--dry-run`/offline режиме и требует отдельного явного guard для сетевого запуска.

### 3.2. Данные и юридические ограничения

- Cloud DPA не принят. До отдельного решения разрешены только синтетические данные без реальных ПДн, клиентских кейсов и конфиденциальных материалов.
- Не считай юридические тексты, retention, no-training, бюджеты, subprocessors и provider terms утверждёнными.
- Не включай `x-data-logging-enabled`; не реализуй autotuning; не готовь передачу corpus в поддержку.
- Не выполняй физическое удаление пользовательских данных по новым категориям, пока сроки и legal-hold policy не утверждены.
- Не удаляй legacy fallback, audit/history или уже применённые migration-файлы.
- Не помещай secret values, raw tokens, signed URLs, email, телефон, Telegram chatId, transcript с персональными кейсами или provider payload в логи, fixtures, документацию и diff.

### 3.3. Репозиторий и совместимость

- Сохраняй текущий Node.js/TypeScript/Express/PostgreSQL/Prisma/static HTML+JS/Tailwind stack.
- Не переписывай проект с нуля и не вводи новый framework без доказанной необходимости.
- Не откатывай и не перезаписывай несвязанные изменения пользователя в dirty worktree.
- Не редактируй уже применённые migrations; используй новые additive migrations.
- Не выполняй destructive reset неизвестной БД, `git reset --hard`, удаление volumes или пользовательских файлов.
- Сохраняй legacy registration/room/replay/CRM/email/Telegram flow при выключенных rollout flags.
- Используй expand → backfill → dual-read/validation → switch → observe → contract. В этой задаче не выполняй внешний switch и contract-удаление fallback.
- Не создавай commit, branch, PR или внешнюю запись без отдельного запроса.

## 4. Рабочий режим

1. Сначала проверь dirty worktree, версии runtime и baseline доступных тестов.
2. Построй traceability «ТЗ/AC/DoD → текущий код → пробел → изменение → тест».
3. Составь исполнимый план по рабочим пакетам ниже и сразу переходи к реализации.
4. Реализуй вертикали последовательно, не оставляя фиктивных success responses, P0-заглушек и неиспользуемых таблиц.
5. После каждого пакета запускай узкие тесты, затем интеграционные и UI-проверки.
6. Продолжай через context compaction; не начинай заново и не объявляй задачу завершённой после одного пакета.
7. Если инфраструктура недоступна, выполни лучший безопасный fallback, зафиксируй точный blocker и не выдавай непроведённую проверку за passed.

Для новых производных пробелов используй внутренние traceability-коды `GAP-*`, но не подменяй ими официальные requirement IDs и не меняй ТЗ без change decision.

## 5. Порядок реализации

Выполняй пакеты в таком порядке:

1. `GAP-ORG-001` — self-service организация и команда.
2. `GAP-AUTHOR-001` — публичный профиль автора.
3. `GAP-WIZARD-001` — восьмишаговый мастер.
4. `GAP-CHAPTER-001` — ручной редактор глав.
5. `GAP-MATERIAL-001` — приватные файлы-материалы.
6. `GAP-FRESHNESS-001` — повторная проверка актуальности.
7. `GAP-CHAT-BACKFILL-001` — legacy ChatScenario backfill.
8. `GAP-ROLLOUT-001` — tenant allowlist.
9. `GAP-RETENTION-001` — безопасный dry-run retention/erasure.
10. `GAP-OBS-001` — monitoring templates и alert rules.
11. `GAP-YC-IAC-001` — Yandex staging IaC без apply.
12. `GAP-ACCEPTANCE-TOOLS-001` — smoke/load/restore/provider инструменты.
13. Документация, полная regression-проверка и финальная traceability.

Допустимо объединять migrations только внутри одной логически атомарной вертикали. Не создавай одну огромную migration для несвязанных пакетов.

## 6. GAP-ORG-001 — self-service создание организации, настройки и команда

### Целевое поведение

- Пользователь без активного membership после passwordless login видит честный onboarding: «Создать организацию» или «Принять приглашение».
- Создание организации атомарно создаёт `Organization`, активный `OWNER` membership создателя и audit event.
- Создание идемпотентно; повтор сетевого запроса не создаёт вторую организацию.
- Slug нормализуется сервером либо проверяется строгим контрактом, уникален и не раскрывает чужую организацию через различающиеся ошибки.
- Tenant context после создания формируется только из новой server-side membership и активной session.
- Новый owner не получает platform-admin права.
- Владелец может просматривать и безопасно менять разрешённые настройки организации с optimistic revision/idempotency.
- Владелец видит участников, приглашает, отзывает приглашения, меняет роли и удаляет membership с сохранением TEN-005–TEN-007.
- Последний активный human owner защищён внутри той же транзакции/advisory lock.
- Страница команды не раскрывает лишние ПДн; показывай только данные, необходимые для управления доступом.

### API и backend

- Добавь согласованный `/api/v1/organizations` create/read/update contract либо документированно совместимый эквивалент.
- Добавь cursor pagination для растущего списка участников/приглашений.
- Все mutations: Zod, CSRF, correlation ID, audit, idempotency там, где возможен сетевой retry.
- Не доверяй `organizationId` из body как authority.
- Не создавай организацию автоматически только по знанию email.
- Добавь production guard/rate limit против массового создания организаций.

### UI

- Добавь onboarding и экран «Команда и настройки организации» в существующую дизайн-систему.
- Покажи loading, empty, validation, conflict, permission, network retry и success states.
- Ролевые последствия формулируй явно; destructive-looking membership action требует понятного подтверждения.
- Все формы работают клавиатурой, имеют labels, field errors и стабильный live region.

### Acceptance

- Новый email → magic link → cookie session → создание организации → owner dashboard без ручного seed/SQL.
- Второй пользователь принимает invitation и получает точную роль.
- Cross-tenant membership/invitation ID даёт безопасное отсутствие.
- Конкурентное удаление/понижение последнего owner невозможно.
- Повтор create с тем же idempotency key возвращает тот же результат; конфликтующий payload даёт safe `409`.

## 7. GAP-AUTHOR-001 — публичная страница профиля автора

### Целевое поведение

- Создай отдельную публичную HTML-страницу автора, использующую существующий safe public projection API.
- Страница доступна только для `VERIFIED` автора, активной организации и действующего OWNER/AUTHOR membership.
- Показывай public name, безопасное описание/опыт, специализации, регион и только публичные вебинары.
- Не возвращай evidence, email, внутренние причины, private notes, user/membership IDs или закрытые вебинары.
- При suspension/inactive/unknown используй одинаковое безопасное unavailable state.
- Каталог и страница вебинара должны ссылаться на профиль автора.
- Добавь понятный путь жалобы на автора без раскрытия заявителя.

### UI/SEO

- Динамически обновляй title/description безопасным текстом.
- Не вставляй HTML из профиля; используй textContent/allowlisted rendering.
- Реализуй loading, empty webinar list, network error/retry, unavailable и 320 px/200% zoom.
- Не кодируй verified-status только цветом или иконкой.

### Acceptance

- Verified active author виден; draft/suspended/inactive/foreign author не виден.
- На странице только public webinars; unlisted/private/draft/archived отсутствуют.
- Прямая подстановка slug не раскрывает внутреннее состояние.

## 8. GAP-WIZARD-001 — восьмишаговый мастер вебинара

### Обязательные шаги

1. Основная информация.
2. Юридическая классификация и актуальность.
3. Видео.
4. Транскрипт и главы.
5. Источники и материалы.
6. Подготовленный чат.
7. Расписание и доступ.
8. Проверка и публикация.

### Архитектурные требования

- Не создавай параллельную webinar-domain модель и не дублируй существующие services.
- Мастер должен быть orchestration/UI над текущими tenant-scoped API и state machines.
- Server возвращает readiness projection по каждому шагу: `not_started`, `in_progress`, `complete`, `blocked`, а также безопасные blocker codes.
- Autosave использует debounced/blur сохранение плюс явную кнопку; сетевые retries идемпотентны.
- Сохраняй текущий webinar ID и step в URL/session-safe state без token/signed operations.
- Reload, Back/Forward и повторный вход восстанавливают webinar и разрешённый шаг.
- Переход назад не теряет данные.
- Незавершённый upload/STT/transcode/AI не показывается как complete.
- Финальная публикация всегда повторно вызывает общую server-side validation; UI readiness не является authorization.
- После publish покажи точную публичную/unlisted/private ссылку согласно visibility, не раскрывая origin URL.

### UI требования

- Активный, завершённый и заблокированный шаг различаются текстом/accessible state, не только цветом.
- Первый field error получает focus; поля используют `aria-invalid`/`aria-describedby`.
- Status changes объявляются через stable polite live region.
- Критические кнопки доступны при 320 px, 200% zoom и safe-area inset.
- Применяй `better-accessibility`, `better-layout`, `better-writing`, `better-typography`, `better-colors`, `better-ui` и полный consolidated interface review.

### Acceptance

- Автор создаёт draft, заполняет несколько шагов, закрывает страницу, возвращается и продолжает без потери данных.
- Browser Back/Forward меняет шаг, а не ломает состояние.
- Попытка перескочить на publish при незавершённых шагах показывает server blockers и ничего не публикует.
- Background processing корректно переживает reload.
- Полный Playwright flow работает клавиатурой и при 320 px.

## 9. GAP-CHAPTER-001 — ручной редактор глав

### Целевое поведение

- Автор может создать, изменить, удалить и упорядочить главы вручную.
- Глава содержит минимум title, `startMs`, optional description и order.
- Валидация запрещает отрицательные/выходящие за duration таймкоды, пустые title и недетерминированный порядок.
- Изменение использует optimistic revision; stale update не затирает чужую правку.
- Нельзя мутировать опубликованную immutable projection так, чтобы зритель увидел частичную версию. При необходимости создавай/обновляй draft version и переключай только явной publication action.
- AI suggestions остаются предложениями; принятие может создать draft chapter, но не обходит human review.
- Chapters tenant-scoped и связаны с точным Webinar/Transcript version по существующей модели.

### UI и acceptance

- Редактор поддерживает добавление, reorder без обязательного drag-and-drop, удаление с подтверждением и seek preview.
- Все операции доступны клавиатурой; у reorder есть кнопки «Выше/Ниже».
- Cross-tenant/foreign transcript/chapter безопасно отсутствует.
- Room и captions получают только главы согласованной опубликованной версии.

## 10. GAP-MATERIAL-001 — provider-neutral приватные файлы-материалы

### Целевое поведение

- Автор может добавить источник как HTTPS URL либо загрузить приватный файл-материал.
- Не перегружай video-specific lifecycle, если он не подходит. Выдели минимальный provider-neutral private-object boundary либо безопасно расширь существующий adapter без смешения MediaAsset и document semantics.
- Storage key всегда строится сервером из tenant/Webinar/material ID.
- Загрузка использует short-lived direct/presigned operation там, где provider это поддерживает; Express не проксирует большой файл целиком.
- На finalize сервер/provider сверяются по size, MIME, checksum и binding.
- Минимальный безопасный allowlist должен быть конфигурируемым. По умолчанию разрешай только форматы, которые можно надёжно распознать по magic/container; macro-enabled/исполняемые форматы запрещай.
- Для PDF и OOXML проверяй MIME, signature/container, размер и безопасное имя. Файлы, которые нельзя безопасно inline-render, отдавай как attachment.
- До появления утверждённого malware scanner не заявляй антивирусную проверку; документируй residual risk и применяй fail-closed к неизвестным форматам.
- Материал остаётся private и выдаётся только после повторной tenant/participant authorization с `no-store` и безопасным `Content-Disposition`.
- Browser не получает storage key, permanent origin URL или credentials.
- Замена файла создаёт новую version либо атомарно переключает current object; частичный файл недоступен.
- Добавь cleanup незавершённых upload с bounded retry/dead-letter без автоматического удаления опубликованного материала.

### Acceptance

- URL-source продолжает работать.
- Valid PDF/allowlisted document загружается, проходит finalize и скачивается только авторизованным пользователем.
- MIME spoof, oversized, corrupt container, wrong tenant, expired operation, Range abuse и unknown file возвращают safe errors.
- Private material не появляется в catalog/search до публикации и не доступен по знанию URL.
- S3/Yandex-specific behavior покрывается contract fake; реальный provider не вызывается.

## 11. GAP-FRESHNESS-001 — автоматическая повторная проверка актуальности

### Модель и policy

- Добавь явное `reviewDueAt`/эквивалентное date-only поле и revision/evidence, необходимое для безопасной автоматизации.
- Дата задаётся человеком в кабинете; AI не может выставить `CURRENT` или продлить срок.
- Worker периодически находит published `CURRENT` webinars с наступившим due date и идемпотентно переводит их в `REVIEW_DUE`.
- Создай отдельную tenant-scoped author review task/domain, если существующий `CRMTask` не допускает AUTHOR и семантически не подходит. Не ослабляй CRM assignee invariants ради этой функции.
- Task уникальна по webinar/review cycle, имеет due/status/actor/source и появляется в кабинете автора.
- Уведомление создаётся через durable service outbox и не считается отправленным в `EMAIL_MODE=log`.
- Worker restart/retry не создаёт duplicate task/outbox.
- Публичная страница честно показывает `REVIEW_DUE`; вебинар не становится `CURRENT` автоматически.
- Только явное human confirmation с новой `currentAsOf` и следующим `reviewDueAt` закрывает task и возвращает `CURRENT`.
- Superseded/archived/suspended состояния не получают ошибочных задач.

### Acceptance

- Boundary test до/в/после due date.
- Два конкурентных worker запуска создают одну task и одну notification intent.
- AI job не меняет freshness.
- Cross-tenant task read/write запрещён.
- Human re-confirmation атомарно обновляет metadata, audit и task state.

## 12. GAP-CHAT-BACKFILL-001 — безопасный legacy ChatScenario backfill

### Требования

- Не изменяй старую применённую migration и не удаляй `webinar-data/agent-chat-scenario.json`/legacy fallback.
- Реализуй новый additive, повторяемый backfill mechanism для exact compatibility Organization/Webinar.
- Разбери текущий legacy JSON через существующую строгую schema, вычисли deterministic fingerprint/checksum и зафиксируй provenance.
- Используй существующего системного владельца/compatibility identity; не создавай вымышленного human author.
- Сохрани точные offset/text/order и canonical synthetic kind/marker. Не создавай вымышленных личностей, отзывы или viewer count.
- Определи publication semantics так, чтобы backfill не изменил текущий runtime до отдельного switch. Допустимы imported candidate/published-shadow данные, если новый reader выключен и dual validation может сравнить projections.
- Повторный запуск не создаёт duplicate scenario/messages.
- Preflight фиксирует legacy count/fingerprint и target availability; postflight проверяет count/order/fingerprint/tenant/synthetic constraints.
- Добавь dual-read comparison tool/report без пользовательского переключения.
- Fallback и ослабленные compatibility constraints не удаляй в этой задаче.

### Acceptance

- Non-empty legacy fixture мигрируется без потери registrations/questions/messages/events.
- Repeat deploy/backfill сообщает no-op.
- Несовпадение fingerprint или ambiguous target останавливает backfill без partial mutation.
- Новый scenario не публикует participant-looking messages.

## 13. GAP-ROLLOUT-001 — tenant allowlist

### Целевое поведение

- Сохрани глобальные env/master flags как верхний kill switch.
- Добавь централизованный DB-backed tenant rollout policy для минимум: platform accounts onboarding, creator dashboard, public catalog projection, tenant CRM, tenant Telegram, provider jobs, analytics/moderation.
- Модель должна поддерживать как минимум `disabled`, `allowlist` и контролируемый `enabled`/global mode либо эквивалентную безопасную семантику.
- Organization может быть включена только при активном master flag; allowlist никогда не обходит глобальный off.
- Решение принимается одинаково в routes, background workers, public projections, callbacks и delivery jobs.
- Не размазывай ручные `if` по коду: используй один policy service с fail-closed default.
- Изменение policy доступно только MFA platform owner/admin в разрешённом scope, требует reason, expected revision, confirmation и audit.
- Rollback конкретной организации не удаляет schema/history/jobs, а прекращает новые операции и безопасно обрабатывает уже claim-нутые jobs.

### Acceptance

- Tenant A включён, B выключен; одинаковые API и jobs дают ожидаемое поведение без утечки существования объектов.
- Глобальный off блокирует оба tenant.
- Callback, queued broadcast и provider job повторно проверяют rollout непосредственно перед side effect.
- Concurrent policy update защищён revision/transaction.

## 14. GAP-RETENTION-001 — dry-run retention/erasure с legal hold

### Разрешённый scope

- Подготовь tenant/account-scoped inventory и двухфазный plan engine для новых категорий данных.
- Реализуй только безопасный `dry-run/plan` и проверку legal hold/policy readiness.
- Destructive apply должен быть жёстко заблокирован, пока нет утверждённой versioned policy и отдельного explicit enable. По умолчанию и в production example он `off`.
- Не придумывай сроки для строк со статусом «не утверждён».

### Требования к plan

- Plan содержит category, safe entity counts, cutoff/policy version, blocked-by-legal-hold counts и deterministic digest, но не содержит ПДн, текста заметок, сообщений, recipient data или storage keys.
- Scope формируется из trusted tenant/account context.
- После построения plan повторная проверка eligibility должна происходить под lock перед любым будущим apply.
- Legal hold имеет явный actor/reason/start/end/revision/audit и блокирует затронутые категории минимально необходимым scope.
- Добавь dry-run для author profile/evidence, access grants, viewer favorites/progress/notes/preferences, CRM contact/tasks/scoring/tags/bulk/delivery, moderation/chat/question histories и tenant Telegram data.
- Документируй обязательные решения юриста/DPO для каждой категории.

### Acceptance

- Dry-run не изменяет ни одной business row и не удаляет object bytes.
- Cross-tenant plan невозможен.
- Legal hold исключает entity и отражается только безопасным count/reason code.
- Production guard отклоняет apply даже при поддельном client payload.

## 15. GAP-OBS-001 — Prometheus/Grafana/Alertmanager templates

Создай versioned, reviewable конфигурацию, например в `infra/monitoring/`, не привязанную к реальным endpoints:

- Prometheus recording/alert rules;
- Alertmanager example config с placeholder receivers;
- Grafana provisioning examples и dashboard JSON;
- README с подключением, secrets boundary и runbook links.

Минимальные alerts:

- API p95/error rate;
- DB readiness/pool exhaustion;
- worker heartbeat/stalled subsystem;
- queue depth/age;
- retry/dead-letter growth;
- media work/storage bytes и inodes;
- provider outage/429/5xx/cleanup failure;
- SMTP/Telegram failure/retry-after;
- abnormal auth failure/rate limit;
- backup age/restore drill freshness;
- rollout/provider job anomaly.

Каждый критический alert должен иметь severity, stable labels, safe annotations без ПДн, ссылку на точный runbook section и понятное recovery действие. Не помещай webhook/token в example config. Добавь YAML/static validation tests и `promtool` check, если binary доступен; отсутствие binary не обходи ложным success.

## 16. GAP-YC-IAC-001 — Yandex staging IaC без фактического создания

Создай отдельный каталог, например `infra/yandex/staging/`, и provider-pinned Terraform/OpenTofu templates. Используй только актуальные официальные Yandex Cloud resources и документируй version constraints.

### Обязательные guards

- Единственное допустимое environment value — `staging`.
- Любое имя/label содержит staging marker; production variables/IDs отклоняются validation.
- Никаких default cloud/folder IDs, credentials, secret values или реальных origins.
- Outputs с потенциальными credentials запрещены либо `sensitive` и не содержат secret material.
- Добавь `prevent_destroy` там, где это разумно для будущего staging safety, но не обещай recovery без restore drill.
- Не конфигурируй remote backend с реальными данными.
- Не запускай `plan/apply` против внешнего account.

### Шаблоны ресурсов

- private Object Storage bucket;
- public access blocks/least privilege IAM;
- отдельные staging service accounts/roles для runtime, media и SpeechKit;
- versioning, server-side encryption, incomplete multipart lifecycle, configurable retention lifecycle;
- exact-origin CORS с exposed `ETag`, без `*` по умолчанию;
- Yandex Lockbox secret metadata/reference без secret versions/values;
- Audit Trails/logging sink и monitoring bindings, если поддерживаются выбранным provider;
- budget/alert placeholders либо документированный manual step, если ресурс не поддерживается IaC;
- variables для `ru-central1`, bucket name, origin, cloud/folder IDs, alert recipients и caps;
- `.tfvars.example` только с placeholders;
- README с `fmt`, `validate`, review-only `plan` и строгим запретом apply без отдельного approval.

Добавь policy/static tests, которые отклоняют public bucket, wildcard CORS, production name, missing encryption/versioning/lifecycle, inline credentials и широкие editor/admin roles.

## 17. GAP-ACCEPTANCE-TOOLS-001 — smoke/load/restore/provider инструменты

Создай инструменты в отдельном `scripts/staging/` или эквивалентном каталоге. Все сетевые команды должны:

- проверять explicit `ASPB_ALLOW_STAGING_ACCEPTANCE=on`;
- требовать HTTPS staging URL и отклонять production origin/unknown host;
- запрещать реальные ПДн и помечать fixtures как synthetic;
- иметь dry-run по умолчанию;
- маскировать tokens/credentials/URLs в output;
- сохранять machine-readable JSON report без sensitive data;
- иметь timeout, cleanup и non-zero exit при нарушении acceptance.

### Smoke

- health/readiness и protected details;
- onboarding organization/author/wizard flow на synthetic tenant;
- cross-tenant negative checks;
- media upload/resume/finalize/HLS/Range;
- transcript submit/poll/result/delete lifecycle через injected/fake provider и optional guarded staging mode;
- SMTP/Telegram только через test recipients при отдельном разрешении; по умолчанию no-send.

### Load

- Параметризуемый профиль для 300 concurrent viewers одной session, 1000 platform viewers и 100 author/CRM users из ТЗ;
- low-impact smoke profile по умолчанию; целевой профиль требует отдельного load guard;
- метрики p50/p95/p99, error rate, queue lag, event loop/DB/provider saturation;
- HLS/media нагрузка отделена от JSON API;
- никогда не запускай целевой профиль автоматически в CI против внешнего URL.

### 4 GiB media

- Генерируй/стримь детерминированный синтетический payload ровно 4 GiB без реальных данных и без обязательного хранения второго полного файла на диске;
- проверяй multipart resume, exact size/checksum, interrupted part, repeat complete и cleanup;
- реальный network test только при explicit guard и budget approval, которого сейчас нет.

### Restore

- Восстановление допускается только в новый изолированный PostgreSQL target/schema и отдельный media/object prefix;
- скрипт обязан отказать при совпадении source/target, production-like DB/schema, широком path или non-empty target без explicit safe flag;
- проверяй migration status, row invariants, object counts/checksums, legacy replay и rollback image compatibility;
- не удаляй исходный backup и не выполняй down-migration.

### Provider acceptance

- Object Storage: create/list multipart operations через adapter, resume, ETag/checksum behavior, HeadObject, private read, Range, abort/delete cleanup и CORS contract;
- SpeechKit: submit/poll/result/immediate `deleteRecognition`, retryable/permanent errors, restart, deletion replay и safe report;
- тест обязан доказать отсутствие `x-data-logging-enabled`, autotuning и corpus-support path;
- без credentials выполняется полный offline contract test, а external sections помечаются `blocked_external`, не `passed`.

## 18. Yandex adapters — подготовить, но не активировать

- Сохрани provider-neutral доменную модель.
- Проверь, что Yandex Object Storage/SpeechKit выбираются только явной staging-конфигурацией.
- Production-safe default остаётся `unconfigured`.
- Test fake запрещён production guard.
- Static S3 credentials и SpeechKit API key не переиспользуются между identities.
- Secret values читаются только из environment/secret layer и не попадают в browser/API/logs.
- SpeechKit adapter не отправляет data-logging header и всегда пытается удалить async result после success/failure/timeout/cancel согласно существующей lifecycle policy.
- Добавь contract tests на headers, endpoint binding, audio URI prefix, cleanup, timeout и provenance без raw payload.

## 19. API, migrations и документация

### OpenAPI

- Обновляй `openapi.yml` одновременно с каждым endpoint/schema.
- Все новые request/response contracts имеют schemas, safe error codes, CSRF/idempotency/correlation semantics и tenant authorization notes.
- OpenAPI parse/refs test должен давать 0 missing refs.

### Migrations

- Для каждого пакета: additive migration, read-only preflight, postflight и repeated deploy check.
- Проверяй non-empty legacy fixture, а не только fresh empty schema.
- Не используй `prisma db push` как доказательство migration correctness.
- Application rollback должен работать поверх уже применённой additive schema.

### Traceability

Создай или обнови отдельную полную матрицу, например:

`docs/ASPB-TZ-TRACEABILITY-MATRIX.md`

Для каждого официального requirement ID, NFR, AC-01–AC-08, обязательного migration step, interface section и DoD row укажи:

- source section;
- implementation status: `not_started`, `in_progress`, `implemented`, `verified_local`, `verified_staging`, `blocked_external`, `not_applicable`;
- evidence files/migrations/tests;
- runtime/staging evidence;
- residual risk;
- следующий action/owner.

Не помечай NFR verified без измерения. Не помечай provider/staging requirement verified по fake/contract test. Не скрывай narrative gaps за статусом соседнего requirement ID.

Обнови также:

- `docs/ASPB-LEGAL-PLATFORM-IMPLEMENTATION-STATUS.md`;
- `docs/production-readiness-audit.md`;
- `docs/production-runbook.md`;
- `README.md` и env examples;
- DEC-05/DEC-06 только в части фактически изменившегося contract, не утверждая внешние решения.

## 20. Интерфейсный quality gate

Для всех затронутых интерфейсов обязательно:

- применить `better-accessibility`, `better-layout`, `better-writing`, `better-typography`, `better-colors`, `better-ui`;
- провести consolidated `better-interface` review в `full` mode, поскольку меняются полные экраны и multi-step flows;
- исправить findings внутри scope и повторно проверить;
- сохранить текущие design tokens, шрифты, Tailwind conventions и визуальный язык;
- проверить keyboard-only, focus order/trap/restore, accessible names/roles/states;
- проверить 320 px, 200% zoom и representative desktop width;
- проверить long Russian strings/URLs, loading/empty/error/permission/processing/degraded/unavailable states;
- проверить `prefers-reduced-motion`, contrast и touch targets;
- визуально отрендерить изменённые страницы, если runtime доступен.

Не добавляй декоративный redesign, новую UI-библиотеку или отдельную цветовую систему.

## 21. Обязательные тесты

### Unit

- organization create/idempotency/slug/policy;
- role/last-owner/rollout/freshness state machines;
- chapter ordering/revision/time bounds;
- material MIME/magic/checksum/path/content-disposition;
- backfill fingerprint/idempotency;
- retention dry-run/legal hold;
- alert/IaC/static policy guards;
- Yandex no-data-logging/delete lifecycle.

### Integration/PostgreSQL

- tenant matrix для каждого нового read/write/upload/download/job;
- onboarding нового пользователя без seed;
- organization/member/invitation lifecycle и audit;
- chapter draft/publish consistency;
- material finalize/private access/cross-tenant;
- concurrent freshness worker = одна task/outbox;
- non-empty ChatScenario backfill и repeated deploy;
- tenant allowlist на HTTP/jobs/callback/send boundary;
- retention plan не мутирует rows;
- migrations pre/postflight и application rollback compatibility.

### Playwright

Минимум:

1. Новый пользователь создаёт организацию и попадает в кабинет.
2. Owner приглашает пользователя и управляет ролью.
3. Public author page показывает только safe projection/public webinars.
4. Восьмишаговый wizard сохраняется, восстанавливается после reload и не теряет данные при Back.
5. Автор вручную создаёт/reorders главы.
6. Автор загружает synthetic material; viewer получает его только с доступом.
7. Наступившая freshness review видна автору и публично, human re-confirm закрывает task.
8. Tenant A allowlisted, tenant B blocked без disclosure.
9. Критические flows работают клавиатурой и при 320 px; отдельная проверка 200% zoom.

Используй fake/injected adapters только для локального E2E и честно маркируй это как local verification.

### Общий quality gate

Запусти максимально доступный набор:

```bash
npm run css:build
npm run lint
npm run build
npm test
npm run media:acceptance
npm run e2e
npm audit --omit=dev
node scripts/assert-ci-deploy-contract.mjs
git diff --check
```

Дополнительно:

- `prisma validate/generate`;
- fresh-schema и non-empty migration drills;
- OpenAPI parse/ref validation;
- monitoring YAML/promtool validation;
- Terraform `fmt -check`/`validate` без external apply;
- новые staging tools в offline/dry-run mode;
- relevant infrastructure safety tests на Linux либо честно зафиксированный platform blocker.

Если локальная PostgreSQL остановлена, не выдавай полный `npm test`/E2E за passed. Запусти доступные unit/contract tests, зафиксируй причину и подготовь точную команду для повторения.

## 22. Definition of Done этой задачи

Задача завершена только если:

- все пакеты выше имеют working implementation либо честный `blocked_external` только для внешнего activation;
- нет P0 заглушек, фиктивных success responses или UI без backend contract;
- migrations additive, проверены на fresh и non-empty schema;
- tenant isolation и role matrix подтверждены negative tests;
- wizard/public author/team/chapter/material/freshness flows имеют Playwright coverage;
- provider-neutral adapters и offline acceptance проходят без credentials;
- production/provider flags остаются off/unconfigured;
- retention apply остаётся заблокирован, dry-run доказан non-mutating тестом;
- IaC не содержит реальных IDs/secrets и не выполнялось;
- monitoring templates не содержат реальных receivers/tokens;
- OpenAPI, runbook, env examples и traceability соответствуют коду;
- interface full review выполнен и findings в scope исправлены;
- итоговый diff не содержит secrets, generated junk, временные файлы и несвязанные изменения;
- статус `verified_staging` не присвоен ни одному пункту без фактической staging evidence.

## 23. Стоп-условия

Остановись и запроси решение только если требуется:

- destructive migration/удаление существующих данных;
- утвердить конкретный retention срок или выполнить erasure apply;
- принять DPA/no-training/provider terms/subprocessors;
- выбрать бюджет, приобрести сервис или изменить внешний billing;
- получить cloud/folder ID, Lockbox reference, staging URL или credentials для реального запуска;
- создать/изменить cloud resources или выполнить `terraform apply`;
- отправить реальные письма/Telegram либо использовать реальные ПДн;
- включить production flag/deploy;
- изменить продуктовую семантику, для которой ТЗ не даёт безопасного обратимого варианта.

Большой объём, сложность, необходимость добавить migration/tests, существующий dirty worktree или отсутствие внешних credentials не являются причиной останавливаться после плана. Реализуй весь локально разрешённый scope и пометь только внешнюю активацию как blocked.

## 24. Финальный отчёт

Финальный ответ должен быть коротким и доказательным:

1. **Результат:** какие рабочие пользовательские вертикали теперь завершены.
2. **Traceability:** какие официальные IDs/AC/DoD и `GAP-*` имеют какой статус.
3. **Изменения:** migrations, backend, workers, frontend, infra templates и docs.
4. **Проверки:** точные команды, counts и результаты.
5. **Безопасность:** tenant isolation, secrets, retention, provider/production guards.
6. **Совместимость:** что сохранено через fallback и как выполняется application rollback.
7. **Blocked external:** только конкретные DPA/budget/credentials/staging-runtime пункты.
8. **Следующий шаг:** минимальная staging acceptance последовательность без production mutations.

Не перечисляй рутинные действия и не повторяй весь промпт. Не заявляй о staging/production готовности по локальным fake-тестам.

Начинай сейчас: проверь baseline, создай traceability-план и сразу реализуй `GAP-ORG-001`. После прохождения его targeted gate последовательно переходи к остальным пакетам, не останавливаясь на анализе.
