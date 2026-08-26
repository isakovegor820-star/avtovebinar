# План исправления дефектов и вывода автовебинара АСПБ в production

**Основание:** `AUDIT-PRELAUNCH-2026-08-25.md`
**Дата плана:** 25 августа 2026
**Текущий статус реализации (25 августа 2026):** code/local remediation завершён; финальный локальный gate прошёл 3/3 на чистой test schema, локальный backup/restore drill выполнен. Разрешён переход на STAGING, production остаётся `BLOCK` до внешней приёмки, доверенного CI на exact release SHA и репетиции deploy rollback. Подробности: `REMEDIATION-IMPLEMENTATION-REPORT-2026-08-25.md`.
**Целевой статус:** `GO` после выполнения всех обязательных гейтов этого документа

## 1. Управленческое решение

Продукт нельзя выпускать в production в текущем состоянии. До запуска необходимо:

1. Закрыть все пять P1: attribution, аналитические события, reduced-motion/video source, финальный CTA и разделение versioned/legacy session.
2. Сделать официальный release gate воспроизводимым: сборка, lint, unit/integration и Playwright должны проходить без ручных обходов.
3. Закрыть P2, влияющие на регистрацию, просмотр, данные, безопасность, коммуникации и доступность.
4. Провести полный STAGING-проход с реальными CRM, SMTP, Telegram, аналитикой и видеопровайдером.
5. Доказать backup/restore, наблюдаемость и rollback на exact SHA релиза.

Текущий продукт в репозитории реализует бесплатный путь «регистрация → вебинар → партнёрская заявка». Платёжного контура в коде аудита нет. Если оплата находится во внешнем сервисе, production остаётся заблокированным до отдельного теста оплаты, callback/webhook, идемпотентности и выдачи доступа.

## 2. Цель и критерий завершения

Релиз получает `GO`, только если одновременно выполнены условия:

- открытых P0 и P1 нет;
- нет P2, затрагивающих основной funnel, целостность данных, безопасность, приватность или восстановление;
- оставшиеся P3 имеют владельца, срок и письменное принятие риска Product Owner;
- весь критический путь доказан на STAGING: landing → registration → DB → CRM → email/Telegram → room → video → CTA → partner lead;
- официальные команды проходят три раза подряд на чистой тестовой БД;
- внешние панели подтверждают получение данных, а не только отправку запросов приложением;
- проверены реальные целевые браузеры и устройства;
- release, мониторинг и rollback отрепетированы на том же артефакте, который пойдёт в production.

## 3. Принцип выполнения каждого исправления

Ни один тикет нельзя переводить в `Done` только по code review. Для каждого тикета обязателен пакет доказательств:

1. Доказательство дефекта до исправления: failing test, скриншот, Console/Network, лог или DB-запись.
2. Ссылка на audit ID и точную корневую причину.
3. Исправление с review минимум одним инженером, не являющимся автором.
4. Автоматический regression-test на уровень, где возникла ошибка.
5. Ручной runtime-retest затронутого пользовательского сценария.
6. Доказательство после исправления: видео/скриншот, Network, event ID, DB/CRM/outbox record или отчёт теста.
7. Проверка соседних сценариев и отсутствия регрессии.
8. Обновление runbook/контракта, если изменились состояние, API, события или эксплуатация.

Общий шаблон evidence-папки для релиза:

```text
release-evidence/<release-sha>/
  01-ci/
  02-functional/
  03-browser-device/
  04-analytics-attribution/
  05-crm-email-telegram/
  06-video/
  07-security-privacy/
  08-performance/
  09-backup-restore/
  10-deploy-rollback/
```

В доказательствах нельзя сохранять пароли, bearer-токены, полные email/телефоны и иные ПДн. Используются синтетические адреса, masked IDs и correlation IDs.

## 4. Рекомендуемая команда и ответственность

| Роль | Ответственность | Минимальная загрузка на период исправлений |
|---|---|---:|
| Release Manager / Product Owner | scope, приоритет, доступы, content lock, итоговый GO/NO-GO | 30–40% |
| Tech Lead / Backend | session state, API, DB, idempotency, privacy, outbox | 100% |
| Frontend Engineer | landing/room/forms/video/CTA, attribution, UI/a11y | 100% |
| QA Automation | test gate, Playwright, матрицы состояний и устройств, evidence | 100% |
| DevOps/SRE | STAGING parity, CI, metrics, backup/restore, deploy/rollback | 50–70% |
| Analytics/Marketing/CRM | taxonomy, UTM policy, CRM mapping, dashboard acceptance | 30–50% |
| Content/Video Owner | расписание, CTA, HLS/poster/captions, тексты | 20–30% |
| Security/Legal/DPO | unsubscribe, согласия, privacy, retention, активные тесты | по контрольным точкам |

Если работу выполняет один инженер без выделенного QA и DevOps, реалистичная длительность увеличивается с 15 рабочих дней до 5–7 недель.

## 5. Календарный план

Расчёт ниже предполагает старт 26 августа 2026 и параллельную работу frontend, backend, QA и DevOps. Даты являются плановыми до получения внешних доступов.

| Этап | Рабочие дни | Плановые даты | Результат выхода |
|---|---:|---|---|
| 0. Стабилизация и baseline | D1 | 26.08 | Зафиксирован scope, STAGING, доступы, baseline, владельцы |
| 1. Закрытие P1 и восстановление release gate | D2–D5 | 27.08–01.09 | Все P1 исправлены в code/test; официальный gate стабилен |
| 2. Данные, session state, безопасность и интеграции | D6–D10 | 02.09–08.09 | Закрыты блокирующие P2 backend/runtime |
| 3. Интерфейс, доступность, responsive и SEO | D8–D11 | 04.09–09.09 | Закрыты интерфейсные P2; P3 либо исправлены, либо приняты |
| 4. Полная STAGING-валидация | D12–D14 | 10.09–14.09 | Есть доказательства по внешним системам, браузерам, видео, security и performance |
| 5. Go/No-Go | D15 | 15.09 | Подписан release checklist; выбран exact SHA |
| 6. Контролируемый production rollout | D16 | 16.09 | Ограниченный трафик, smoke, мониторинг, rollback readiness |
| 7. Резерв и hypercare | D17–D19 | 17.09–21.09 | 24/72-hour review, устранение release-only проблем |

Если любой внешний доступ появляется позже D5, календарная дата Go/No-Go сдвигается минимум на число потерянных рабочих дней. Непроверенную интеграцию нельзя принять по коду или mock-режиму.

## 6. Очередь работ: тикеты по корневым причинам

Оценка дана в инженерных человеко-днях и включает код, автотест и ручной retest, но не ожидание внешних доступов.

| Ticket | Audit ID | Результат | Владелец | Оценка | Зависимости | Блокирует |
|---|---|---|---|---:|---|---|
| REL-001 | AUD-024 | Детерминированный release test gate | QA + DevOps | 2–3 | STAGING DB | Любой релиз |
| OBS-001 | AUD-001 | Единый attribution context от landing до CRM | Frontend + Backend | 2 | Решение по attribution model | Запуск рекламы |
| OBS-002 | AUD-002, AUD-016, AUD-030 | Полная event taxonomy и надёжная доставка | Frontend + Backend + Analytics | 3–4 | OBS-001, receiver | Любой публичный запуск |
| WEB-001 | AUD-003 | Video source не зависит от reduced-motion | Frontend | 1–2 | Реальный media source | Просмотр |
| WEB-002 | AUD-004 | Финальный CTA и end-state работают до/после reload | Frontend + Product | 1 | Утверждённый CTA | Продажи/лиды |
| WEB-003 | AUD-005, AUD-006, AUD-009 | Авторитетная versioned session state machine | Backend + Frontend | 4–5 | Product rules | Просмотр и расписание |
| WEB-004 | AUD-007, AUD-008 | Корректный lifecycle pause/visibility/rewind/chat | Frontend | 2–3 | WEB-003 | Широкий запуск |
| LEAD-001 | AUD-011 | Общая schema регистрации и исправляемые field errors | Backend + Frontend | 2–3 | Product data rules | Платный трафик |
| LEAD-002 | AUD-010, AUD-012 | Access gate, validation и idempotency partner form | Backend + Frontend | 2–3 | WEB-003 | Лиды/CRM |
| NOTIFY-001 | AUD-014 | Durable manager Telegram outbox | Backend | 2–3 | Telegram staging access | Reliance на Telegram |
| SEC-001 | AUD-013, AUD-015 | Безопасный unsubscribe и обмен room token | Backend + Security | 2–3 | Email templates | Рассылка/доступ |
| PLAT-001 | AUD-023 | Устранён duplicate ID и восстановлен platform E2E | Frontend + QA | 0.5–1 | Нет | Platform rollout |
| OPS-001 | AUD-025, AUD-026 | Default-webinar invariant, readiness и единый env contract | Backend + DevOps | 1–2 | Production env | Production |
| UI-001 | AUD-017 | Header без overflow на tablet и zoom | Frontend | 0.5–1 | Нет | Публичный UI |
| UI-002 | AUD-018, AUD-019, AUD-020, AUD-021, AUD-022, AUD-027, AUD-028, AUD-029 | Общие доступные UI-примитивы и русская терминология | Frontend + QA + Content | 4–6 | UI tokens/content | Публичный UI |
| SEO-001 | AUD-031 | Canonical, robots, sitemap и служебная индексация | Frontend + DevOps | 1–2 | Production domain | Индексируемый запуск |
| EXT-001 | Остаточные риски 1–17 | Реальные внешние и device acceptance tests | QA + владельцы систем | 3–5 | Все доступы, исправления | Финальный GO |

## 7. Технический план и приёмка по направлениям

### 7.1 REL-001 — release gate

Что сделать:

- ограничить `scripts/prepare-test-database.mjs` тестовой схемой и не удалять rollout policies через опасный `CASCADE`;
- исправить cold-start Playwright web server: readiness должен ждать фактический `/health/ready`, а timeout должен соответствовать измеренному cold start;
- устранить `platformOrganizationName` duplicate ID;
- обновить два устаревших E2E: тест обязан открывать disclosure и переходить на нужный шаг wizard так же, как пользователь;
- отделить fixtures от production seed и выдавать каждому worker изолированные IDs;
- добавить единый CI release job: CSS → lint → TypeScript build → unit/integration → Playwright → dependency/security checks → staging smoke;
- не разрешать production workflow для SHA, который не прошёл STAGING тем же артефактом.

Приёмка:

- `npm run css:build`, `npm run lint`, `npm run build`, `npm test`, `npm run e2e` проходят три раза подряд после очистки тестовой схемы;
- E2E стартует официальной командой без заранее прогретого сервера и временных fixture-обходов;
- повторный test preparation не затрагивает данные за пределами явно проверенной test schema;
- CI сохраняет JUnit/Playwright trace/screenshots для падений;
- `npm audit --omit=dev` либо проходит, либо каждое advisory имеет зафиксированное решение Security Owner со сроком.

### 7.2 OBS-001 — attribution без потерь

Что сделать:

- ввести единый `AttributionContext`: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `gclid/yclid` при применимости, исходный landing URL, referrer и campaign/session ID;
- собирать context при первом landing view и передавать через все восемь CTA, registration request, DB registration/lead, CRM и аналитические события;
- хранить отдельно first-touch и session last-touch; прямой повторный заход не должен стирать уже известный first-touch;
- нормализовать длину и допустимые символы, исключить попадание email/телефона в URL и события;
- определить поведение при отказе от необязательных cookies: критичный текущий переход должен сохранять attribution server-side или в URL без ПДн.

Приёмка:

- матрица для всех восьми CTA: query → переход → registration → DB → CRM → analytics;
- refresh, back/forward, повторный визит и новая вкладка не теряют согласованный attribution;
- неизвестные параметры не становятся SQL/HTML и не ломают URL;
- UTM нет в логах вместе с ПДн; аналитика не получает email/телефон;
- 8/8 CTA и все тестовые регистрации имеют ожидаемые first/last-touch значения.

### 7.3 OBS-002 — аналитические события и доставка

Что сделать:

- утвердить версионированный контракт события: `event_id`, `event_name`, `occurred_at`, `session_id`, pseudonymous user/registration ID, webinar/session ID, attribution, page, device и schema version;
- создать одну клиентскую функцию `track()` и один server receiver вместо локальных несовместимых вызовов;
- реализовать обязательные события: `landing_view`, `registration_form_start`, `registration_form_error`, `registration_success`, `room_enter`, `video_start`, `sound_on`, `video_25`, `video_50`, `video_75`, `video_finish`, `cta_appear`, `cta_click`, `partner_submit_success`, `partner_submit_error`, `session_end`, `user_exit`;
- дедуплицировать по `event_id`/business key;
- для `pagehide` применять `sendBeacon` либо `fetch(..., keepalive: true)`; для 429 уважать `Retry-After`; для 5xx использовать bounded retry/backoff;
- ожидаемый anonymous lookup не отправлять как 404 в Console: вернуть допустимое пустое состояние либо не запрашивать без идентификатора;
- добавить delivery metrics: accepted, duplicate, retried, failed, dead-letter и lag.

Приёмка:

- каждое реальное действие создаёт ровно одно ожидаемое событие, без действий события нет;
- 25/50/75 считаются по авторитетной позиции просмотра и не дублируются при rewind/reload;
- 429, 500, offline→online и закрытие страницы не теряют подтверждённую очередь;
- события видны в Network, receiver log и целевой analytics panel с одним `event_id`;
- UTM/session IDs присутствуют, ПДн отсутствуют;
- расхождение receiver vs analytics panel не более 1% на synthetic STAGING run, дубли не более 0.5%.

### 7.4 WEB-001/002 — видео и CTA

Что сделать:

- инициализировать HLS/MP4 source независимо от `prefers-reduced-motion`; preference отключает только необязательное движение и автоматические анимации;
- все JS-анимации, scroll и timers, создающие движение, подключить к общему motion guard;
- добавить явные состояния video: loading, autoplay-blocked, playing-muted, playing-with-sound, stalled, failed, ended и retry;
- финальный CTA привязать к авторитетному timeline event и сохранять в end-state после `ended` и reload;
- сделать CTA доступным с клавиатуры, с конкретным русским названием действия и touch target не менее 44×44 CSS px;
- не показывать ложное «эфир идёт», если media source или playback фактически не стартовали.

Приёмка:

- `reduce` и `no-preference`: источник существует, explicit Play запускает видео;
- autoplay blocked, muted autoplay, sound enable, stall/retry и fatal media error имеют доказанные состояния;
- CTA появляется в заданную секунду ±1 секунда, не исчезает после `ended`, reload и foreground;
- CTA click сохраняет attribution и создаёт одно `cta_click`;
- реальный HLS и fallback MP4 проверены на целевых браузерах.

### 7.5 WEB-003/004 — session state machine

Что сделать:

- определить единственный server-authoritative resolver: registration всегда привязана к точному `webinar_id`, `session_id`, `schedule_version`, timezone и access policy;
- запретить fallback versioned registration в legacy daily session после expiry; вернуть честное `expired/replay/unavailable` состояние;
- возвращать явное состояние `early`, `waiting`, `live`, `late-live`, `ended`, `replay`, `expired`;
- убрать 30-секундное stale waiting на границе: `no-store` около старта либо TTL, ограниченный расстоянием до следующего state transition;
- показывать timezone сессии и локальное время пользователя, не подписывать все показы как МСК;
- хранить различие между явной паузой пользователя и pause из-за background/visibility;
- при seek/rewind полностью пересобирать chat state по текущей timeline position;
- определить multi-tab policy: одна авторитетная position либо предсказуемая независимая сессия без взаимного прыганья.

Приёмка:

- автоматизированная матрица T−60, T−1, T, T+1, +5, +15, +30, +60, ended, replay, next day;
- versioned registration ни при одном переходе не попадает в legacy webinar;
- warm cache на T−1/T/T+1 показывает правильное состояние;
- refresh, browser restart, cookies/localStorage loss, другая вкладка и другое устройство возвращают документированное состояние;
- пользовательская пауза сохраняется после background→foreground;
- rewind удаляет будущие chat messages и повторно показывает их только в нужное время;
- DST проверен минимум на `Europe/Amsterdam` и `Europe/Moscow`, включая даты перехода.

### 7.6 LEAD-001/002 — формы и качество данных

Что сделать:

- использовать общую Zod/schema-валидацию client/server для регистрации и partner lead;
- нормализовать trim, регистр email и phone representation без агрессивного изменения имени;
- проверять пустые, очень длинные, Unicode, plus-alias, длинный домен, разные phone formats, HTML/script payload;
- возвращать field-level error contract: стабильный code, русское исправляемое сообщение и поле;
- связывать ошибки через `aria-invalid` и `aria-describedby`, переводить фокус к summary/первому ошибочному полю;
- отключать повторную отправку во время запроса, но главным барьером сделать server idempotency key и DB uniqueness/business constraint;
- не показывать активную partner form anonymous/expired пользователю: объяснить, как получить доступ или связаться иначе;
- добавить retry-safe CRM enqueue и correlation ID.

Приёмка:

- полный audit validation set пройден через UI и прямой API;
- 400/401/403/404/409/422/429/500 дают различимые, исправляемые состояния;
- Enter, paste, autofill, double click и 30 параллельных одинаковых submit создают ровно одну business-запись;
- после timeout/retry пользователь видит итог и не создаёт дубль;
- DB, CRM и analytics связаны одним correlation/registration ID;
- anonymous/expired не могут отправить партнёрскую заявку, valid participant может отправить её один раз.

### 7.7 NOTIFY-001 — Telegram manager delivery

Что сделать:

- перенести manager notification в durable outbox с idempotency key;
- реализовать bounded retry/backoff, обработку 429 `Retry-After`, permanent failure и dead-letter;
- повторно проверять актуальность адресата/consent непосредственно перед side effect;
- добавить queue depth, oldest age, retry, failed и dead-letter metrics/alerts;
- не логировать chat ID, email, phone, bot token и полные message payload.

Приёмка:

- 429, 500, timeout и restart worker не теряют notification;
- повторная доставка или webhook создаёт одно сообщение;
- permanent error виден оператору в dead-letter с безопасной причиной;
- Product/Manager подтверждает получение сообщения в реальном тестовом чате.

### 7.8 SEC-001 — unsubscribe и room token

Что сделать:

- заменить токен с email на криптографически случайный opaque token; хранить только hash, purpose, expiry, used/revoked timestamps;
- `GET` unsubscribe показывает подтверждение и ничего не меняет; изменение выполняет защищённый `POST`;
- сделать операцию идемпотентной и записывать audit без ПДн;
- убрать legacy bearer из URL path; использовать короткоживущий одноразовый exchange flow, немедленно очищать URL через `history.replaceState` и запрещать referrer leakage;
- старый endpoint после периода совместимости возвращает безопасный `410`, не подтверждая валидность токена;
- обновить email templates и ссылки.

Приёмка:

- token не содержит email/ID, имеет TTL, одноразовость и purpose separation;
- crawler/link-preview GET не отписывает пользователя;
- expired/replayed/revoked/forged token возвращает одинаково безопасную ошибку;
- после exchange адресная строка, browser history, referrer, access log и analytics не содержат token;
- unsubscribe отражён в DB/CRM/provider и предотвращает дальнейшую marketing-отправку.

### 7.9 OPS-001 — invariant и эксплуатационный контракт

Что сделать:

- сделать наличие опубликованного default webinar частью `/health/ready` либо fail-closed состояния формы;
- отсутствие default webinar должно давать управляемую business error, а не Prisma FK 500;
- добавить admin preflight перед публикацией: session, video, CTA, timezone, email и forms;
- привести README и `.env.production.example` к runbook: production public registration требует `EMAIL_MODE=send` и успешный SMTP verify;
- добавить alert на отсутствие default webinar, media source, stale outbox и dead-letter;
- сохранить существующий forward-only migration и backup/restore контракт из `docs/production-runbook.md`.

Приёмка:

- удалить/снять публикацию default webinar на STAGING: readiness становится false либо регистрация закрывается понятным сообщением, 500 отсутствует;
- после восстановления конфигурации система возвращается без ручной правки данных пользователя;
- README, env example, runtime guard и runbook не противоречат друг другу;
- operator может найти причину через protected dependency health и correlation ID.

### 7.10 UI-001/UI-002 — consolidated interface remediation

Исправления выполняются в общих компонентах и токенах, а не локальными хаками страниц.

**Layout и responsive**

- изменить breakpoint/компоновку header так, чтобы 768 px, landscape и 200% zoom не создавали overflow;
- проверить 320/360/390/430/768/1024/1280/1440/1920, safe area, sticky CTA, modal и mobile keyboard;
- использовать логические отступы, устойчивые min/max размеры и перенос длинных русских строк.

**Keyboard и semantics**

- реализовать APG tabs: Tab входит в tablist один раз, Arrow Left/Right меняют tab, Home/End работают, `aria-selected`/`tabindex` синхронны;
- radio group обернуть в `fieldset`/`legend`;
- admin controls дать постоянные видимые либо программные labels;
- добавить skip link на все funnel pages;
- декоративные Material Symbols пометить `aria-hidden="true"`; accessible name интерактивного элемента должен задаваться текстом/label;
- modal: Escape, focus trap и возврат фокуса к trigger.

**Ошибки и live regions**

- countdown не объявлять каждую секунду: визуально обновлять таймер, а `aria-live` использовать только для важных смен состояния/редких отметок;
- form errors сделать конкретными: что произошло и как исправить;
- loading/success/error/empty/expired состояния должны быть различимы без зависимости только от цвета.

**Цвет и типографика**

- заменить один системный muted-text token так, чтобы обычный мелкий текст имел контраст минимум 4.5:1, крупный — минимум 3:1, UI boundaries/focus — минимум 3:1;
- не уменьшать input font ниже 16 px на iOS;
- сохранить читаемую длину строки, переносы, line-height и иерархию заголовков при 200% zoom;
- focus-visible должен быть заметен на светлой и тёмной поверхности.

**Motion и тексты**

- единый reduced-motion guard для CSS и JS; видео и обязательная функциональность не отключаются;
- заменить технический английский в пользовательском интерфейсе согласованной русской терминологией;
- кнопки называют действие: не «ОК/Далее», а «Зарегистрироваться», «Включить звук», «Отправить заявку».

Приёмка:

- нет horizontal scroll на девяти ширинах, landscape и 200% zoom;
- полный funnel проходится только клавиатурой с логичным Tab order и видимым focus;
- VoiceOver/Safari и NVDA/Firefox объявляют labels, group names, errors, tab state и CTA без декоративного мусора;
- axe/аналогичный scanner не имеет critical/serious finding на критическом пути; ручная проверка остаётся обязательной;
- contrast измерен инструментом и приложен к evidence;
- touch targets основных действий не менее 44×44 CSS px.

### 7.11 SEO-001 — индексируемый production contract

Что сделать:

- добавить production canonical на публичные страницы;
- сформировать sitemap только из индексируемых публичных URL;
- закрыть room, registration success, admin, internal/API и token routes через auth/noindex/robots по назначению;
- проверить title, description, Open Graph, favicon, 404/500, mixed content и redirect HTTP→HTTPS;
- не считать `robots.txt` механизмом безопасности.

Приёмка:

- crawler-проверка на production-like domain показывает один canonical на страницу;
- sitemap не содержит служебных, персональных и token URL;
- 404 возвращает реальный 404, 500 — реальный 5xx и безопасный текст;
- social preview использует доступное изображение по HTTPS;
- закрытый контент недоступен без авторизации независимо от индексации.

## 8. Порядок исполнения и зависимости

### Поток A — можно начинать немедленно

1. REL-001: исправить test preparation, cold start и устаревшие E2E.
2. WEB-001 и WEB-002: восстановить видео при reduced-motion и финальный CTA.
3. PLAT-001 и UI-001: duplicate ID и 768 px overflow.
4. Product/Analytics утверждают attribution и event taxonomy.

### Поток B — после утверждения контрактов

1. OBS-001 → OBS-002.
2. WEB-003 → WEB-004.
3. LEAD-001 → LEAD-002 → реальный CRM acceptance.
4. SEC-001 → обновление email templates → реальный SMTP acceptance.
5. NOTIFY-001 → реальный Telegram acceptance.

### Поток C — после функциональной стабилизации

1. UI-002 и SEO-001.
2. Cross-browser/device/media matrix.
3. Security/performance/30-session STAGING run.
4. Backup/restore/deploy/rollback rehearsal.

Phase 4 нельзя начинать на постоянно меняющемся UI/API: за 48 часов до полного regression вводится code/content freeze, кроме исправлений release blockers.

## 9. STAGING, который нужен для доказательного теста

STAGING должен быть production-like, но изолирован от production данных и получателей:

- отдельный HTTPS domain с явным staging marker;
- отдельная PostgreSQL DB/schema и media/object prefix;
- production-equivalent Docker/worker topology;
- test SMTP/domain/inboxes, test Telegram chats/bots, test CRM pipeline и analytics property/stream;
- тот же HLS/MP4 delivery class, CORS, cache и CDN policy;
- synthetic пользователи и безопасные test phone/email;
- доступ к protected health, metrics, logs, queue state и DB read-only evidence;
- возможность управлять временем/сессиями через fixtures или admin, не меняя системные часы сервера;
- отдельное письменное разрешение на 30 parallel registrations и безопасные active security tests.

На production запрещены нагрузочные и активные security-тесты, массовые формы, реальные списания и изменение пользовательских данных без отдельного разрешения.

## 10. Полная программа повторного тестирования

### 10.1 Автоматический regression

- unit: resolver, timeline math, timezone/DST, validation, tokens, retry/backoff;
- integration: registration/partner idempotency, DB/CRM/outbox, analytics receiver, expired/replay state;
- contract: SMTP/Telegram/CRM/analytics adapters с 2xx/4xx/409/422/429/5xx/timeout;
- Playwright: основной funnel, 30 ролей через параметризованные состояния, keyboard и viewports;
- security checks: lint, typecheck, dependency audit, secret scan, Semgrep/эквивалент;
- official release commands без локальных подмен.

### 10.2 Матрица webinar state

Обязательные точки: early, T−1, T, T+1, +5, +15, +30, +60, ended, replay, next day, expired. Для каждой точки: direct link, зарегистрированный вход, refresh, close/reopen, browser restart, second tab, second device, cookies/localStorage loss и изменённые URL parameters.

### 10.3 Браузеры и устройства

Минимум:

- реальный iPhone Safari: актуальная и предыдущая major iOS;
- реальный Android Chrome: актуальный Android;
- desktop Chrome, Firefox и Safari;
- 320/360/390/430/768/1024/1280/1440/1920 px;
- portrait/landscape, 200% zoom, увеличенный системный шрифт, safe area;
- keyboard-only, VoiceOver/Safari и NVDA/Firefox.

Эмуляция Chromium полезна для regression, но не заменяет реальный Safari/iPhone, Android и screen reader.

### 10.4 Видео и сеть

- autoplay muted/unmuted, явный Play, sound enable;
- Slow 3G/4G, offline→online, network switch, segment 404/429/500, fatal HLS error и retry;
- background/foreground, lock screen, rotation, fullscreen;
- PiP/AirPlay там, где браузер показывает эти функции;
- poster, captions/transcript, volume, live-edge/seek policy;
- точная синхронизация CTA, chat и analytics milestones.

### 10.5 Интеграции

Для каждого synthetic пользователя сохранить связку ID:

```text
test_case_id → registration_id → crm_contact/lead_id →
email_outbox_id/provider_message_id → telegram_job_id →
analytics event_ids → partner_application_id
```

Доказать delivery и состояние в целевой панели CRM/email/Telegram/analytics, а не только локальный `200 OK`.

### 10.6 Производительность и устойчивость

Предлагаемые release thresholds, которые Product и SRE должны утвердить до D5:

- LCP ≤ 2.5 с, INP ≤ 200 мс, CLS ≤ 0.1 на mobile p75;
- registration и room bootstrap API p95 ≤ 500 мс без учёта внешней доставки;
- 5xx критичных API < 1% в пятиминутном окне;
- video start success ≥ 98% и start time ≤ 10 с в целевом профиле сети;
- analytics delivery ≥ 99%, duplicate rate ≤ 0.5%;
- email/Telegram queue не имеет stale/dead-letter перед открытием трафика;
- 30 разрешённых параллельных synthetic sessions не создают дублей, 429 storm или неограниченных retries.

Если фактический traffic/устройства не позволяют посчитать p75, используются воспроизводимые synthetic profiles, а RUM включается с первого ограниченного rollout.

### 10.7 Безопасность и приватность

Только на разрешённом STAGING:

- direct URL/auth bypass, IDOR/cross-tenant, token replay/expiry/purpose;
- XSS payloads в form/UTM/chat и безопасное отображение в admin/CRM;
- CSRF для state-changing endpoints;
- CORS, cookie `Secure`/`HttpOnly`/`SameSite`, CSP и security headers;
- rate limiting registration/partner/token endpoints;
- webhook signature/replay, если внешние webhooks используются;
- отсутствие secrets/ПДн в URL, logs, analytics, HTML и error responses;
- consent, unsubscribe и delete/revoke process;
- dependency advisories через разрешённый registry.

## 11. Production GO/NO-GO gate

### Обязательный функциональный gate

- [ ] AUD-001–005 закрыты и повторно проверены.
- [ ] AUD-006–016, 023–026 закрыты либо явно признаны неприменимыми с доказательством.
- [ ] Основной funnel пройден минимум тремя новыми synthetic пользователями подряд без ручной правки БД.
- [ ] Versioned session ни разу не переключается на legacy.
- [ ] Финальный CTA, partner lead и CRM result доказаны end-to-end.

### Quality gate

- [ ] `npm run css:build` — green ×3.
- [ ] `npm run lint` — green ×3.
- [ ] `npm run build` — green ×3.
- [ ] `npm test` — green ×3 на чистой test schema.
- [ ] `npm run e2e` — green ×3 официальной командой.
- [ ] `npm audit --omit=dev` и security pipeline приняты.
- [ ] GitHub Actions для exact SHA полностью green.
- [ ] Нет игнорируемых/skipped critical-path tests без письменного решения QA Lead.

### External gate

- [ ] CRM mapping, deduplication, status и manager visibility доказаны в панели.
- [ ] Реальное письмо получено; personalization, timezone, links и unsubscribe проверены.
- [ ] Telegram participant/manager test получен; retry/dead-letter проверены.
- [ ] Analytics receiver/panel показывает полный funnel без ПДн и дублей.
- [ ] Реальный HLS/MP4 принят на целевых устройствах и сетевых профилях.
- [ ] Если есть внешний payment flow — отдельный payment acceptance полностью green.

### Interface gate

- [ ] Девять ширин, landscape, safe area и 200% zoom без блокирующего overflow.
- [ ] Funnel полностью работает keyboard-only.
- [ ] VoiceOver/Safari и NVDA/Firefox прошли ручной сценарий.
- [ ] Контраст и visible focus подтверждены измерениями.
- [ ] Captions/transcript доступны либо Product письменно запрещает запуск до их готовности.

### Operations gate

- [ ] HTTPS, production env guard и protected health проверены.
- [ ] Fresh verified backup создан; restore выполнен в отдельную recovery DB.
- [ ] Все migration preflight/postflight из runbook выполнены, второй deploy — no-op.
- [ ] Exact-SHA Docker artifact/checksum/attestation проверены.
- [ ] STAGING deploy и rollback того же SHA отрепетированы.
- [ ] Dashboard и alerts активны; on-call и escalation contacts назначены.
- [ ] Content freeze: дата, timezone, видео, CTA, цена/условия и тексты подписаны Product Owner.

Решение принимает Release Manager совместно с Tech Lead, QA Lead, Product Owner и владельцами Analytics/CRM. Один незакрытый обязательный пункт означает `NO-GO`, а не «условный pass».

## 12. Production rollout

### T−7/T−3 дня

- feature freeze для funnel и session contract;
- STAGING на exact candidate SHA;
- backup/restore rehearsal и migration pre/postflight;
- browser/device/media и external acceptance;
- утверждение dashboards, alerts и rollback owners.

### T−1 день

- content/config freeze;
- финальный smoke: registration, email, room, video, CTA, partner lead;
- проверить default webinar, timezone, HLS duration/poster/captions;
- убедиться, что queues пусты, dead-letter = 0, dependencies healthy;
- подписать Go/No-Go evidence index.

### T0

- production workflow только из `main`, exact SHA, после успешного STAGING того же SHA;
- применить forward-only migrations по `docs/production-runbook.md`;
- выполнить `/health/live`, `/health/ready`, protected dependency health и synthetic smoke;
- открыть ограниченный трафик: внутренний cohort/малый рекламный процент; если продукт не поддерживает tenant canary, ограничивать входящий трафик на уровне кампании, не глобальным небезопасным feature flag;
- наблюдать минимум 60 минут до расширения трафика.

### T+1 час / T+24 / T+72

- сравнить landing→registration→room→video→CTA→lead funnel;
- проверить source/UTM completeness, event loss/duplicates, CRM duplicates;
- проверить outbox lag, dead-letter, video errors, 4xx/5xx, browser breakdown;
- на T+24 Product Owner подтверждает качество лидов и коммуникаций;
- на T+72 закрыть hypercare либо продлить его с конкретным incident plan.

## 13. Условия немедленной остановки трафика или rollback

Немедленно закрыть платный трафик и запустить rollback/feature shutdown при любом условии:

- любой P0: недоступность основного пути, потеря заявок, утечка ПДн/токена, подделка доступа или двойное финансовое действие;
- registration/room 5xx > 1% пять минут;
- video start failure > 2% на поддерживаемых устройствах;
- финальный CTA или `cta_appear` отсутствует у достигших контрольной точки;
- attribution completeness падает ниже 99%;
- появляются дубли registration/partner lead из одного idempotency key;
- email/Telegram/analytics очередь растёт без обработки или появляется dead-letter;
- readiness/dependency health красный;
- миграционный postflight имеет ненулевое violation count;
- наблюдается browser-specific блокировка значимой доли пользователей.

Rollback выполняется предыдущим совместимым application image и выключением соответствующих rollout flags. Forward-only schema не откатывается импровизированным down SQL. Очереди и audit history не удаляются.

## 14. Наблюдаемость после запуска

Минимальные dashboards:

1. Funnel: landing, form start/error, registration, room, video start, milestones, CTA, partner lead.
2. Attribution: доля заполненных UTM/referrer, unknown/direct, campaign breakdown.
3. API: RPS, p50/p95/p99, 4xx/5xx, rate limit, DB pool.
4. Media: manifest/segment errors, start time, stalls, fatal HLS, browser/device.
5. Queues: email, Telegram, analytics/CRM — depth, oldest age, retry, dead-letter.
6. Business integrity: duplicate registrations/leads, unmatched CRM records, orphan sessions.
7. Security: auth failures, token replay, CSRF/CORS/rate-limit anomalies без хранения ПДн.

Минимальные synthetic monitors каждые 5 минут: landing 200, registration configuration available, room gate, health/live, health/ready. Полную регистрацию каждые 5 минут запускать только в специальный synthetic segment с автоматической очисткой/маскировкой и согласованной частотой.

## 15. Что нужно получить до начала внешней приёмки

| Доступ/решение | Для чего | Риск без него |
|---|---|---|
| STAGING URL и разрешённый load/security scope | Runtime, 30 sessions, active negative tests | Нельзя доказать устойчивость и безопасность |
| Test/admin accounts для всех ролей | Admin/platform/tenant/manager flows | Права и эксплуатация остаются непроверенными |
| Test CRM и field mapping | Lead delivery, dedup, status | Риск потери/дублей лидов |
| SMTP/provider и test inboxes | Delivery, template, links, unsubscribe | Риск отсутствия писем и доступа |
| Telegram bots/chats | Participant/manager delivery | Риск потери уведомлений |
| Analytics property/receiver | Receipt, taxonomy, dashboards | Нельзя оценивать funnel и рекламу |
| Реальный video origin/CDN | HLS, CORS, autoplay, retry | Риск неработающего эфира |
| Production domain/DNS/CDN | TLS, cache, headers, SEO | Инфраструктурный риск неизвестен |
| Доступ к logs/metrics/DB read-only | Evidence и диагностика | Нельзя доказать путь данных |
| Решение: есть ли внешний payment flow | Отдельный financial audit | Потенциальный непроверенный P0 |
| Attribution policy и event taxonomy sign-off | OBS-001/002 | Переделка данных и отчётов после запуска |
| Legal/DPO sign-off | Consent, unsubscribe, retention | Privacy/compliance риск |
| Реальные iPhone/Android и Safari/Firefox | Device acceptance | Mobile/browser риск остаётся |

## 16. Первые 48 часов работы

### День 1

1. Назначить Release Manager и владельцев всех тикетов.
2. Заморозить новый feature scope до закрытия release blockers.
3. Создать production-like STAGING и evidence index.
4. Получить/запросить все доступы из раздела 15.
5. Зафиксировать exact baseline SHA, текущие test outputs и список P0–P3.
6. Product/Analytics утверждают first/last-touch attribution и event taxonomy.
7. QA начинает REL-001; Frontend — WEB-001/002; Backend — WEB-003 design.

### День 2

1. Получить первые PR по WEB-001, WEB-002, PLAT-001 и UI-001.
2. Воспроизвести official E2E cold start и закрыть root cause, не повышая timeout вслепую.
3. Зафиксировать session state contract и тестовую временную матрицу.
4. Создать schema contracts для registration, partner lead, analytics event и idempotency.
5. Подключить dashboards/логи STAGING и correlation IDs.
6. Провести первый checkpoint: blockers, доступы, отклонение по срокам и решение по production дате.

## 17. Финальный retest checklist

- [ ] Все 8 landing CTA сохраняют attribution до DB/CRM/analytics.
- [ ] Все обязательные аналитические события приходят exactly once с корректными IDs и без ПДн.
- [ ] Reduced-motion не удаляет video source; декоративное движение сокращено.
- [ ] Финальный CTA появляется, сохраняется и работает после reload.
- [ ] Versioned registration не переключается на legacy.
- [ ] Early/T/+1/+5/+15/+30/+60/ended/replay/next-day матрица green.
- [ ] Warm cache не удерживает waiting после старта.
- [ ] Явная pause, background/foreground и rewind/chat работают корректно.
- [ ] Timezone/DST отображаются корректно.
- [ ] Registration/partner validation, errors и idempotency green.
- [ ] Anonymous partner form закрыта; valid participant submit создаётся один раз.
- [ ] Manager Telegram notification durable; retry/dead-letter доказаны.
- [ ] Unsubscribe и room token не раскрывают ПДн/секрет и устойчивы к replay.
- [ ] Default webinar failure управляем и виден readiness/alert.
- [ ] 768 px overflow, tabs, radio name, live region, labels и contrast исправлены.
- [ ] Funnel keyboard/VoiceOver/NVDA и девять viewport widths green.
- [ ] Canonical/robots/sitemap/404/500/HTTPS green.
- [ ] CRM, SMTP, Telegram, analytics и video panel evidence приложены.
- [ ] Performance/security/privacy acceptance завершён на разрешённом STAGING.
- [ ] 30 изолированных sessions и разрешённые parallel submits не создают деградацию/дубли.
- [ ] Официальный CI/test gate green три раза.
- [ ] Backup/restore, deploy/rollback exact SHA доказаны.
- [ ] Все обязательные GO-пункты подписаны владельцами.

## 18. Остаточные риски до получения доказательств

До выполнения плана сохраняется исходный вердикт `BLOCK`. Особенно критичны:

- реальная доставка CRM/email/Telegram/analytics не подтверждена;
- реальные Safari/iPhone/Android/Firefox и assistive technologies не проверены;
- реальный video CDN/HLS и сетевые отказы не проверены;
- dependency advisories не подтверждены разрешённым registry;
- production DNS/TLS/CDN/cache/headers неизвестны;
- payment flow, если существует вне репозитория, полностью непроверен;
- активные security и разрешённые parallel form tests не выполнены;
- текущие официальные unit/E2E gates красные/невоспроизводимые.

Эти пункты нельзя закрыть ссылкой на код, mock, локальный `200 OK` или предположение. Для каждого требуется фактический runtime-тест и evidence из целевой системы.
