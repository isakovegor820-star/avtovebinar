# Тотальный prelaunch-аудит автовебинара АСПБ

Дата: 25 августа 2026
Контур: LOCAL, локальный PostgreSQL, schema=test, http://127.0.0.1:5175
Режим: read-only для исходников и внешних систем; локальная тестовая БД изменялась только штатными тестами и временными audit-fixtures, которые удалены после прогона
Решение об исправлениях: не предоставлено, поэтому продуктовый код не изменялся
Ответственный за итог: Codex, с независимыми проходами backend/integrations, webinar runtime и frontend/accessibility

## 1. Итоговый вердикт

# BLOCK — запускать нельзя

Подтверждённых P0 нет. Подтверждены 5 P1, непосредственно затрагивающих атрибуцию, аналитику, доступность видео, финальный CTA и изоляцию версионных вебинаров. Кроме того, обязательные production-проверки внешних рассылок, CRM, реальных браузеров, видеодоставки и аналитических панелей не выполнены, потому что URL, аккаунты и доступы во входных данных остались шаблонными.

Запуск можно пересмотреть только после исправления AUD-001…AUD-005, восстановления воспроизводимого release-gate AUD-024 и повторного сквозного теста на STAGING с реальными интеграциями.

## 2. Краткое резюме

### Что подтверждённо работает

- TypeScript build: exit 0.
- ESLint: exit 0.
- Prisma schema validation: пройдена; 77 миграций, pending migrations отсутствуют.
- 25 из 30 диагностических Chromium E2E-сценариев прошли после контролируемого восстановления обязательных test-only rollout fixtures.
- Прошли сценарии: anonymous access gate, CRM task/stage transition, private webinar invitation, author verification, public catalog, analytics filters/history, moderation, public report, viewer account, waiting room, cookie decline, analytics retry operation key, participant magic link, clean-context access restore, admin login, registration without marketing consent, unsubscribe consent separation, cookie-only room exchange, published content/captions/player controls, player processing/error states, returning participant CTA suppression, recording availability, moderator chat/question flows.
- 153 viewport-прохода выполнены по 17 поверхностям и 9 ширинам: 320, 360, 390, 430, 768, 1024, 1280, 1440, 1920.
- 30 параллельных изолированных Chromium-контекстов открыли landing, register и anonymous room: 90/90 основных навигаций получили HTTP 200; gate был видим 30/30, поле вопроса disabled 30/30.
- Anonymous direct URL не открывает видео и чат. Неверный token удаляется из URL, посторонние query/hash сохраняются.
- Границы расписания, DST gap/overlap и состояния waiting/pre-live/live/replay проверены модельными тестами.
- Локальные ссылки 28 HTML-страниц проверены статически: отсутствующих локальных href/src не найдено.
- Защитные механизмы найдены и подтверждены focused tests/code review: Helmet/CSP, CSRF, rate limits, HttpOnly/SameSite cookies, tenant scoping, production env guards, hashed access tokens, analytics allowlist, consent evidence, email outbox.
- Статистические утверждения лендинга сверены с официальными источниками: [Банк России](https://cbr.ru/statistics/macro_itm/dkfs/ext_dep_indicator/) и [Федресурс, итоги 2025](https://download.fedresurs.ru/news/%D0%91%D0%B0%D0%BD%D0%BA%D1%80%D0%BE%D1%82%D1%81%D1%82%D0%B2%D0%BE%20%D1%81%D1%82%D0%B0%D1%82%D1%80%D0%B5%D0%BB%D0%B8%D0%B7%202025%20%D0%BD%D0%B0%20%D1%81%D0%B0%D0%B9%D1%82.pdf).

### Что сломано

- Все обычные переходы landing → registration теряют UTM/referrer.
- Большая часть обязательной продуктовой аналитики не эмитится.
- При prefers-reduced-motion видео остаётся без source, а кнопка старта не запускает эфир.
- Финальный CTA скрыт именно на final timeline event.
- Истёкшая registration для версионного вебинара может быть перенаправлена в чужой legacy daily room.
- Официальные npm test и npm run e2e не являются зелёными release-gates.
- Есть системные P2 в таймлайне, чате, формах, privacy-token design, Telegram delivery, responsive/a11y и platform admin.

### Главные риски и места потери денег

1. Невозможность доказать рекламный ROI: UTM теряются до регистрации.
2. Неизмеримый funnel: нет реальных video/CTA/payment-like conversion events.
3. Потеря продаж в конце вебинара: final CTA скрывается.
4. Потеря части аудитории с reduced motion: видео не запускается.
5. Неверный контент/оффер для истёкших версионных регистраций.
6. Дубли и низкое качество заявок из-за слабой validation/idempotency.
7. Ошибочное решение о релизе из-за красного и нестабильного test pipeline.

### Что обязательно исправить до запуска

- AUD-001…AUD-005.
- AUD-011 и AUD-012 для качества заявок и защиты от дублей.
- AUD-024, затем полный зелёный повтор unit/integration/E2E без audit workarounds.
- Сквозной staging-тест Form → DB → CRM → email/SMS/bot → room → CTA → lead status.
- Реальные Safari/iPhone, Android Chrome, Firefox и видеосеть.

## 3. Покрытие

| Область | Статус | Фактические доказательства | Ограничение |
|---|---|---|---|
| Карта продукта | Проверено локально | 28 HTML-страниц, API/ops routes, static-link checker | Production redirects и внешние DNS не проверены |
| Landing и переходы | Проверено | In-app Chromium, UTM click runtime, 9 ширин | Нет production CDN/caching |
| Регистрация | Частично | DOM/native validation, schema/API code, focused tests | Не отправлялась реальная форма в production; SMTP/CRM недоступны |
| Email verification/access | Частично | E2E magic-link/cookie scenarios | Реальный SMTP и доставляемость не проверены |
| Расписание/таймзоны | Частично | boundary/DST tests, code-path simulations | Нет authenticated browser fixture для всех late-entry минут |
| Вебинарная комната | Частично | anonymous gate, waiting state, 25 E2E pass | Реальный participant media playback и multi-tab auth не проверены |
| Видео/звук | Частично | player state E2E, deterministic media clock, source analysis | Нет физических устройств, HLS/CDN, autoplay/audio hardware |
| CTA/оффер | Частично | timeline predicate simulation, UTM runtime | Нет реального завершённого просмотра |
| Платёж | Не применимо к текущему коду | Payment routes/models/webhooks не найдены; продукт бесплатный, финал — partner lead | Если оплата существует вне репозитория, доступы не предоставлены |
| Аналитика | Частично | registry, emitters, retry code, analytics E2E | Нет GA4/Метрики и панели приёмника |
| CRM | Частично | internal tenant CRM E2E прошёл | Внешняя CRM не указана |
| Рассылки/Telegram | Частично | outbox focused tests, log mode | SMTP/Telegram API и реальные аккаунты отсутствуют |
| UX/тексты | Проверено локально | full interface review, 17 поверхностей | Авторизованные production-данные отсутствуют |
| Responsive | Проверено в Chromium | 153 viewport-прохода | Реальные Safari/Firefox/устройства отсутствуют |
| Доступность | Частично | keyboard/runtime/static semantics/contrast | VoiceOver/NVDA и 200% zoom не выполнены |
| Производительность | Частично | размеры ассетов, cold-start, console/network, parallel opens | Lighthouse/CWV/RUM/memory profile не выполнены |
| Безопасность/privacy | Частично | code review, focused tests, negative URL/token paths | Нет разрешения на активные атаки и внешний staging |
| SEO | Частично | metadata/robots/sitemap code/static links | Индексация production не проверена |
| Admin/эксплуатация | Частично | admin/CRM/moderation E2E и source review | Нет реальной admin-сессии и runbook drill |
| Dependencies | Не проверено актуально | Локальный lockfile доступен | npm audit потребовал внешний registry; эскалация отклонена |

## 4. Полная карта продукта

### Публичный funnel

- / и /crisis_premium/landing.html → /crisis_premium/index.html
- /crisis_premium/index.html — landing.
- /crisis_premium/register.html — регистрация.
- /crisis_premium/success.html — подтверждение отправки/следующее действие.
- /crisis_premium/access.html — обмен one-time token на HttpOnly cookie.
- /crisis_premium/webinar.html — room: waiting/live/replay/gate.
- /crisis_premium/recordings.html — доступные записи.
- /crisis_premium/account.html — кабинет участника.

### Каталог и публичный контент

- /crisis_premium/catalog.html
- /crisis_premium/catalog-webinar.html
- /crisis_premium/catalog-author.html
- /crisis_premium/report.html

### Legal

- /crisis_premium/privacy.html
- /crisis_premium/terms.html
- /crisis_premium/consent.html
- /crisis_premium/marketing-consent.html
- /crisis_premium/chat-rules.html
- /api/unsubscribe и confirm state

### Platform/admin

- /crisis_premium/platform-access.html
- /crisis_premium/organization.html
- /crisis_premium/author-profile.html
- /crisis_premium/creator-webinars.html
- /crisis_premium/creator-webinar-preview.html
- /crisis_premium/creator-corrections.html
- /crisis_premium/analytics.html
- /crisis_premium/crm.html
- /crisis_premium/moderation.html
- /crisis_premium/platform-moderation.html
- /crisis_premium/admin.html

### Служебные routes

- /api и /api/v1/*
- /admin/*
- /health/live, /health/ready, /health/dependencies, /health/dependencies/details
- /metrics
- /.well-known/security.txt
- /openapi.yml
- /docs
- /sitemap.xml
- /robots.txt
- 404/500 error middleware

### Фактический путь пользователя

Реклама/прямой заход → landing → registration → POST /api/register → lead/registration/email outbox → success → email one-time link → token exchange → HttpOnly room cookie → waiting/live/replay room → synchronized timeline/chat/content → partner application → internal CRM/manager notification.

Отдельные ветви: повторный участник → account/recordings; публичный каталог → webinar registration/viewer account; platform user → passwordless/MFA → creator/CRM/moderation/admin.

Payment-ветка в репозитории отсутствует.

## 5. Покрытие 30 ролей

| № | Роль | Статус | Доказательство/ограничение |
|---:|---|---|---|
| 1 | Новый посетитель | Проверено | Landing runtime и 5-second hierarchy review |
| 2 | Нетехнический пользователь | Частично | UX/copy review; нет интервью/физического пользователя |
| 3 | Быстро сканирует | Проверено | Heading/CTA hierarchy и viewport sweep |
| 4 | Скептик | Проверено | Claims и официальные источники сверены |
| 5 | Из рекламы | Проверено, дефект | UTM click теряет все параметры |
| 6 | iPhone Safari | Частично | 320/390/430 emulation; реальный Safari/iPhone не проверен |
| 7 | Android Chrome | Частично | Mobile Chromium dimensions; физический Android не проверен |
| 8 | Маленький экран | Проверено | 320×760/844 и cookie banner |
| 9 | Планшет | Проверено, дефект | 768 px loaded sweep: overflow 100 px |
| 10 | Desktop Chrome | Проверено | In-app Chromium и Playwright |
| 11 | Desktop Safari | Не проверено | Доступного Safari automation не было |
| 12 | Firefox | Не проверено | Browser binary/runtime не запускался |
| 13 | Медленный интернет | Частично | Recovery/cache code review; фактический throttle не выполнен |
| 14 | Нестабильный интернет | Частично | Error/retry paths; network switching не выполнен |
| 15 | Cookies отключены | Частично | Decline optional cookies E2E прошёл; browser cookies fully disabled не проверены |
| 16 | Ad blocker | Не проверено | Расширение/правила блокировки не предоставлены |
| 17 | Инкогнито | Частично | 30 isolated contexts и clean-context restore |
| 18 | Повторный посетитель | Проверено | Clean-context restore и returning participant CTA E2E |
| 19 | Другой timezone | Частично | DST/model tests; real-device timezone matrix не выполнена |
| 20 | Пришёл раньше | Проверено | Waiting/pre-live boundary и no-media state |
| 21 | Опоздал | Частично | Live/replay boundaries; отдельные 1/5/15/30/60 browser fixtures не выполнены |
| 22 | Refresh во время эфира | Частично | Cookie restore/E2E; реальный HLS refresh не выполнен |
| 23 | Несколько вкладок | Не проверено полно | Anonymous parallel sessions есть; authenticated multi-tab отсутствует |
| 24 | Неверные данные | Частично | Empty/native validation и server schema; вся матрица email/phone не отправлялась |
| 25 | Многократные клики | Частично | Code/idempotency review; browser burst form submit не выполнялся |
| 26 | Только клавиатура | Проверено, дефекты | Tabs fail; moderation/analytics/player controls pass |
| 27 | Скринридер | Частично | Semantics/ARIA review; VoiceOver/NVDA не запускались |
| 28 | Маркетолог | Проверено, дефекты | UTM и event registry/emitters |
| 29 | Менеджер | Частично | Internal CRM/admin E2E; external CRM/payment/email panels отсутствуют |
| 30 | Техспециалист ломает систему | Частично | URL/token/security/code tests; destructive attacks запрещены |

## 6. P0 и P1

P0: не подтверждены.

P1:

- AUD-001 — UTM/referrer теряются до регистрации.
- AUD-002 — обязательный funnel почти не измеряется.
- AUD-003 — reduced-motion пользователь не может запустить видео.
- AUD-004 — финальный CTA никогда не показывается.
- AUD-005 — истёкшая версионная registration может открыть legacy daily webinar.

## 7. Полный реестр дефектов

### AUD-001 · P1 · Landing теряет UTM и referrer на всех обычных CTA

- Роль: пользователь из рекламы, маркетолог.
- Место: landing → register.
- Среда: Chromium, 1280×720; воспроизведено с utm_source=qa, utm_medium=cpc, utm_campaign=launch.
- Предусловия: открыть landing с UTM query.
- Шаги: открыть URL с query; нажать header CTA «Зарегистрироваться».
- Факт: итоговый URL — /crisis_premium/register.html без query.
- Ожидание: UTM/referrer/campaign identifiers сохраняются до регистрации.
- Частота: 100%; все 8 href на register.html заданы без query propagation.
- Влияние на пользователя: нет видимого сбоя.
- Влияние на деньги: регистрации и последующие лиды становятся unattributed; ROI рекламы и оптимизация кампаний искажены.
- Доказательство: runtime navigation assertion и восемь plain href.
- Код: [index.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/index.html:36), также 137, 275, 352, 537, 879, 908, 1018; [utils.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/utils.js:253); [registration.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/registration.js:270).
- Корень: attribution читается только из query текущей registration page; landing links не передают и не сохраняют параметры.
- Исправление: capture attribution на первом pageview в consent-compatible first-party storage/server token и переносить через URL/operation context; добавить allowlist.
- Ретест: все CTA + direct register + refresh + cookie decline; проверить DB/CRM fields и отсутствие PII в analytics.

### AUD-002 · P1 · Ключевые события автовебинара не эмитятся

- Роль: маркетолог, продуктовый аналитик.
- Место: form, room, video, CTA, exit.
- Среда: source/runtime instrumentation audit.
- Предусловия: пройти funnel.
- Шаги: сопоставить event registry с production emitters и UI actions.
- Факт: registry содержит video_start, 25/50/75, video_finish, partner_request_click, но production emitters отсутствуют; нет form_error, sound_on, CTA appearance, exit; registration_form_open отправляется непосредственно перед POST, а не при открытии/начале ввода.
- Ожидание: событие соответствует реальному действию и отправляется один раз с session/user/UTM.
- Частота: 100% для перечисленных действий.
- Влияние на пользователя: невидимо.
- Влияние на деньги: нельзя найти точки оттока, доказать просмотр, CTA conversion и источники продаж.
- Доказательство: registry/emitter search, analytics focused tests подтверждают allowlist, но не наличие UI emitters.
- Код: [analyticsEvents.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/lib/analyticsEvents.ts:122), [video.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/video.js:1), [registration.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/registration.js:269).
- Корень: event taxonomy создана, но instrumentation contract не доведён до UI.
- Исправление: единый event adapter, явная карта trigger → name → params → dedupe key; contract E2E на каждый funnel step.
- Ретест: Network/receiver inspection, event count exactly once, UTM/session continuity, no PII.

### AUD-003 · P1 · prefers-reduced-motion оставляет видео без source

- Роль: пользователь с вестибулярной чувствительностью, пользователь accessibility settings.
- Место: webinar player; дополнительные JS-анимации landing/register/success.
- Среда: deterministic branch test/source execution path.
- Предусловия: prefers-reduced-motion: reduce.
- Шаги: открыть room; активировать явную start button.
- Факт: reduced-motion branch вызывает init(false), показывает кнопку, но не вызывает initializeVideoSource; play вызывается на video без src. Одновременно tilt/magnetic/count-up/parallax/success animations игнорируют preference.
- Ожидание: preference уменьшает motion, но не блокирует media; источник и ручной play остаются рабочими.
- Частота: 100% по ветке reduce.
- Влияние на пользователя: вебинар не запускается для конкретной accessibility-группы.
- Влияние на деньги: потеря просмотра и CTA для этой аудитории.
- Доказательство: branch simulation; normal branch вызывает source init, reduced branch — нет.
- Код: [video.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/video.js:480), [video.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/video.js:511), [video.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/video.js:903), [main.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/main.js:20), [register-parallax.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/register-parallax.js:1).
- Корень: motion preference ошибочно влияет на media initialization, а не только на decorative motion.
- Исправление: всегда инициализировать source; при reduce отключать autoplay/animation и оставлять explicit play. Ввести единый reduceMotion guard для JS motion.
- Ретест: runtime media source/play при reduce, no decorative transforms/rAF, captions/volume/CTA сохранены.

### AUD-004 · P1 · Финальный CTA никогда не показывается

- Роль: досмотревший вебинар пользователь.
- Место: final timeline event 3820–end.
- Среда: timeline predicate simulation.
- Предусловия: активный event type=final с CTA.
- Шаги: промотать model clock до 3820; вычислить CTA visibility.
- Факт: predicate исключает activeEvent.type === final; CTA виден на 2100/2700 и скрыт на финале. ended listener/end card отсутствует.
- Ожидание: финальный оффер остаётся видимым после кульминации и окончания видео.
- Частота: 100% final interval.
- Влияние на пользователя: после просмотра нет понятного следующего действия.
- Влияние на деньги: прямая потеря partner applications/продаж.
- Доказательство: deterministic simulation по реальному timeline.
- Код: [webinarTimeline.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/lib/webinarTimeline.ts:99), [video.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/video.js:250).
- Корень: CTA predicate разрешает sales события, но отдельно запрещает final.
- Исправление: разрешить CTA для final или ввести persistent end-card state.
- Ретест: 1 sec до final, момент final, ended, refresh после end, повтор; CTA URL/UTM/idempotency.

### AUD-005 · P1 · Истёкшая версионная registration переключается на legacy daily webinar

- Роль: опоздавший/возвращающийся участник versioned webinar.
- Место: session resolution, room/content/chat/partner application.
- Среда: deterministic service-path test.
- Предусловия: registration к non-LEGACY session, session истёк.
- Шаги: запросить current state/timeline после expiry.
- Факт: daily rollover применяется независимо от accessPolicy; state/timeline могут показывать новый legacy webinar, а chat/content/questions продолжают искать exact non-LEGACY session. Partner application может получить неверный session scope.
- Ожидание: versioned registration остаётся в своей replay/expired policy и никогда не перескакивает в чужой webinar.
- Частота: 100% для данной ветки resolution.
- Влияние на пользователя: неверный эфир, broken content/chat, противоречивый статус.
- Влияние на деньги: неверный оффер/CRM attribution и потеря доверия.
- Доказательство: service-path simulation и несовпадающие exact-session queries.
- Код: [helpers.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/helpers.ts:256), [registration.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/registration.ts:1344), [webinar.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/webinar.ts:145), [webinar.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/webinar.ts:442), [partners.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/partners.ts:153).
- Корень: legacy rollover helper используется без guard по accessPolicy/webinar identity.
- Исправление: разделить legacy daily и versioned resolution; хранить immutable webinar/session scope в access token.
- Ретест: expired versioned, replay, next day, new device, exact chat/content/partner scope.

### AUD-006 · P2 · До 30 секунд после старта может сохраняться waiting timeline

- Роль: пользователь, открывший страницу на границе старта.
- Место: GET timeline/current.
- Среда: response/cache contract test; browser boundary требует дополнительного подтверждения.
- Предусловия: waiting payload закэширован непосредственно до start.
- Шаги: пересечь start в той же вкладке и повторить getJson.
- Факт: endpoint отдаёт private,max-age=30; client не cache-bust; waiting payload не содержит video source.
- Ожидание: переход на live не задерживается клиентским cache.
- Частота: гарантированное окно риска до 30 секунд при cache hit.
- Влияние на пользователя: «видео недоступно» после фактического старта.
- Влияние на деньги: ранний уход в первые секунды эфира.
- Доказательство: Cache-Control и client fetch implementation.
- Код: [webinar.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/webinar.ts:180), [utils.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/utils.js:179).
- Корень: time-sensitive state помечен cacheable без next-transition bound.
- Исправление: no-store либо max-age=min(nextTransition-now, small bound), client refresh at boundary.
- Ретест: request at T-1s/T/T+1s с cold/warm cache.

### AUD-007 · P2 · Возврат во вкладку отменяет явную паузу пользователя

- Роль: пользователь, поставивший replay/live-DVR на паузу.
- Место: visibilitychange.
- Среда: event-path test.
- Предусловия: user pause, tab hidden, затем visible.
- Шаги: pause → switch tab → return.
- Факт: handler seekToLive + play не учитывает pausedFromLive/user intent.
- Ожидание: explicit pause сохраняется; auto-resume только после system interruption и с понятной политикой.
- Частота: 100% по ветке visible.
- Влияние на пользователя: потеря места и неожиданное воспроизведение/звук.
- Влияние на деньги: раздражение и выход.
- Доказательство: visibility handler path.
- Код: [video.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/video.js:999), [video.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/video.js:1035).
- Корень: нет отдельного флага userPaused.
- Исправление: различать user/system pause и не seek/play при userPaused.
- Ретест: pause/background/foreground для live, DVR, replay, mobile lock.

### AUD-008 · P2 · После rewind остаются будущие сообщения чата

- Роль: пользователь replay/DVR.
- Место: live chat timeline.
- Среда: state-machine test.
- Предусловия: сообщения до позднего timestamp уже отрисованы.
- Шаги: seek назад.
- Факт: renderedMessages только растёт; seek event не пересобирает chat.
- Ожидание: видимы только сообщения с timestamp ≤ viewer position.
- Частота: 100% после backward seek.
- Влияние на пользователя: спойлеры и рассинхрон «живого» эффекта.
- Влияние на деньги: снижение доверия к автовебинару.
- Доказательство: monotonic set и seek dispatch path.
- Код: [live-chat.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/live-chat.js:15), [live-chat.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/live-chat.js:341), [video.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/video.js:882).
- Корень: chat reducer не поддерживает time reversal.
- Исправление: derive visible messages from current position либо reset/replay on backward seek.
- Ретест: seek назад/вперёд, refresh, return-to-live.

### AUD-009 · P2 · Room принудительно подписывает время как МСК

- Роль: пользователь другого timezone.
- Место: room schedule/status.
- Среда: timezone output contract.
- Предусловия: session timezone не Europe/Moscow.
- Шаги: открыть room для иной timezone.
- Факт: registration API не отдаёт timezone; room formatter всегда Europe/Moscow/МСК.
- Ожидание: явно показывать timezone события и локальное время пользователя без ложной подписи.
- Частота: 100% non-Moscow session.
- Влияние на пользователя: риск прийти не вовремя.
- Влияние на деньги: missed attendance и conversion.
- Доказательство: API payload/formatter comparison; DST helper tests отдельно прошли.
- Код: [registration.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/registration.ts:1444), [room.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/room.js:353), [utils.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/utils.js:202).
- Корень: timezone не является частью room contract.
- Исправление: передавать IANA timezone и format both event/local time.
- Ретест: Europe/Amsterdam DST gap/overlap, UTC, Moscow, device timezone change.

### AUD-010 · P2 · Anonymous room показывает активную partner form, которая всегда получает 401

- Роль: незарегистрированный прямой посетитель room.
- Место: partnerApplicationForm под gated player.
- Среда: Chromium 1280×720.
- Предусловия: открыть room без cookie/token.
- Шаги: прокрутить к partner form.
- Факт: gate видим; formHidden=false, formInert=false, поля и submit enabled; backend требует registration и вернёт 401.
- Ожидание: форма скрыта/disabled/inert до входа либо заменена CTA на регистрацию.
- Частота: 100% anonymous room.
- Влияние на пользователя: неизбежная ошибка после заполнения.
- Влияние на деньги: потеря горячего лида.
- Доказательство: runtime DOM assertions и backend auth guard.
- Код: [webinar.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/webinar.html:1), [partners.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/partners.ts:54).
- Корень: gate охватывает player/chat, но не нижнюю conversion form.
- Исправление: единый access-state reducer для всех restricted controls.
- Ретест: anonymous, valid participant, expired cookie, 401 recovery.

### AUD-011 · P2 · Registration validation не защищает качество данных и не даёт исправляемых field errors

- Роль: пользователь с ошибкой ввода, CRM-менеджер, атакующий input.
- Место: /api/register и register form.
- Среда: schema tests, Chromium empty submit.
- Предусловия: invalid name/phone/server 422.
- Шаги: пустая отправка; затем значения script, abcdef, javascript-like phone; server error.
- Факт: сервер проверяет в основном длину и принимает мусорные name/phone; browser empty submit показывает transient native bubble, aria-invalid/describedby отсутствуют; server details игнорируются и показывается один generic English/form-level alert.
- Ожидание: нормализованные business-valid fields и постоянные inline errors с точным способом исправления.
- Частота: 100% перечисленных inputs/error paths.
- Влияние на пользователя: непонятная ошибка; screen reader теряет контекст.
- Влияние на деньги: мусорные контакты, невозможность дозвона, потеря lead.
- Доказательство: schema calls; runtime empty submit: focus=#reg-name, alerts=[], aria-invalid=null, aria-describedby=null.
- Код: [registration.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/registration.ts:75), [registration.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/registration.js:192), [registration.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/registration.js:308), [http.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/lib/http.ts:46).
- Корень: weak domain validation + form-level error model.
- Исправление: shared normalization/schema; inline error IDs, aria-invalid/describedby, focus first invalid; localized API detail mapping.
- Ретест: вся матрица email/phone/long/HTML/duplicate/400/409/422/429/500/Enter/double click.

### AUD-012 · P2 · Partner API допускает пустые заявки и не имеет idempotency

- Роль: многократно кликающий пользователь, CRM-менеджер.
- Место: POST partner application.
- Среда: route/schema contract test.
- Предусловия: valid participant auth.
- Шаги: отправить пустой body либо два одинаковых POST.
- Факт: все поля optional; каждый POST создаёт новую row; unique/idempotency key отсутствуют.
- Ожидание: минимум actionable contact/message и exactly-once semantic.
- Частота: 100% duplicate requests.
- Влияние на пользователя: непонятные повторы.
- Влияние на деньги: дубли CRM, повторная обработка, ложная conversion.
- Доказательство: schema и create path.
- Код: [partners.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/partners.ts:41), [partners.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/partners.ts:64), [schema.prisma](/Users/egor/Desktop/АВТОВЕБИНАР/prisma/schema.prisma:3214).
- Корень: append-only create без operation key/domain minimums.
- Исправление: required intent/contact rule, Idempotency-Key, unique scope registration+operation.
- Ретест: double click, parallel duplicate, retry after timeout, replayed request.

### AUD-013 · P2 · Unsubscribe token бессрочный, содержит email и меняет состояние через GET

- Роль: подписчик, privacy/security reviewer.
- Место: /api/unsubscribe?token=…&confirm=1.
- Среда: token encode/decode test.
- Предусловия: получить unsubscribe link.
- Шаги: декодировать payload; повторно использовать позже; открыть confirm GET.
- Факт: base64url payload содержит email; HMAC есть, но exp/iat/jti нет; token/email попадает в query, browser history/logs; confirm GET mutates state.
- Ожидание: opaque/expiring/single-purpose token и POST confirmation.
- Частота: 100% links.
- Влияние на пользователя: privacy leak/replay risk.
- Влияние на деньги: compliance risk и ложные unsubscribe.
- Доказательство: token decode на synthetic qa address и route behavior.
- Код: [unsubscribe.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/lib/unsubscribe.ts:10), [registration.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/registration.ts:1593).
- Корень: signed data token используется как долгоживущий bearer URL.
- Исправление: random opaque DB token с TTL/consumedAt; GET render, POST mutate; Referrer-Policy no-referrer.
- Ретест: expiry, replay, logs/referrer/history, CSRF semantics.

### AUD-014 · P2 · Manager Telegram notification недолговечна

- Роль: менеджер.
- Место: manager notification after lead/application.
- Среда: delivery architecture review.
- Предусловия: Telegram недоступен/timeout.
- Шаги: исчерпать три inline retry.
- Факт: final error только логируется; durable outbox/dead letter для данного пути нет.
- Ожидание: заявка остаётся в persistent queue с retry/backoff/alert.
- Частота: 100% после окончательного transient failure.
- Влияние на пользователя: менеджер не реагирует на лид.
- Влияние на деньги: потеря горячей заявки.
- Доказательство: notifySafely и retry loop.
- Код: [helpers.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/helpers.ts:273), [telegram.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/lib/telegram.ts:206).
- Корень: network side effect не оформлен как durable job.
- Исправление: transactional outbox + worker + dead letter + metrics.
- Ретест: Telegram 429/500/timeout/recovery/restart.

### AUD-015 · P2 · Legacy exchange endpoint принимает bearer token в URL path

- Роль: участник, security/privacy reviewer.
- Место: /registration/exchange/:token.
- Среда: route inventory.
- Предусловия: legacy client.
- Шаги: открыть path-token endpoint.
- Факт: token может попасть в access logs/APM/history до one-time exchange.
- Ожидание: token только в fragment/body; URL очищается до third-party requests.
- Частота: 100% legacy calls.
- Влияние на пользователя: риск захвата сессии до consume.
- Влияние на деньги: support/security incident.
- Доказательство: coexistence canonical body endpoint and legacy path endpoint.
- Код: [registration.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/registration.ts:1311), [registration.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/registration.ts:1327).
- Корень: backward compatibility сохраняет unsafe transport.
- Исправление: deprecate/remove path endpoint; redact route params in all logs until removal.
- Ретест: token absent from URL/log/APM/referrer; single-use race.

### AUD-016 · P2 · Analytics delivery теряет события при HTTP errors и закрытии страницы

- Роль: маркетолог.
- Место: browser analytics transport.
- Среда: transport-path test.
- Предусловия: receiver 429/500 либо pagehide.
- Шаги: вызвать track; вернуть HTTP error; закрыть вкладку.
- Факт: один retry только на network exception; 429/500 считаются final; sendBeacon/pagehide flush отсутствует.
- Ожидание: bounded retry/backoff for retryable statuses и unload-safe delivery.
- Частота: 100% соответствующих failures.
- Влияние на пользователя: невидимо.
- Влияние на деньги: недосчёт событий и неверная conversion.
- Доказательство: fetch transport implementation.
- Код: [analytics.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/analytics.js:74).
- Корень: transport не различает retryable HTTP и application reject.
- Исправление: keepalive/sendBeacon, retry policy, dedupe key persistence policy.
- Ретест: offline, 429 Retry-After, 500, close/tab crash, receiver dedupe.

### AUD-017 · P2 · На 768 px header создаёт 100 px горизонтального overflow

- Роль: пользователь планшета.
- Место: landing header.
- Среда: Chromium 768×900 после полной загрузки.
- Предусловия: viewport 768.
- Шаги: открыть landing.
- Факт: innerWidth=768, scrollWidth=868, right edge CTA=868.
- Ожидание: zero global overflow, CTA полностью в viewport.
- Частота: 100% на 768 в sweep; другие восемь widths без global overflow.
- Влияние на пользователя: CTA частично вне экрана.
- Влияние на деньги: снижение регистрации с tablet.
- Доказательство: loaded DOM geometry.
- Код: [index.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/index.html:23).
- Корень: md одновременно показывает brand, full nav и CTA.
- Исправление: desktop nav с lg либо промежуточный tablet layout.
- Ретест: 768, 820, 1024; scrollWidth==innerWidth.

### AUD-018 · P2 · ARIA tabs не поддерживают keyboard pattern

- Роль: keyboard/screen reader user.
- Место: segment и income tabs.
- Среда: Chromium keyboard test.
- Предусловия: focus selected tab.
- Шаги: ArrowRight.
- Факт: aria-selected не меняется; click-only handlers, нет roving tabindex/Home/End/controls relationships.
- Ожидание: WAI-ARIA Tabs pattern.
- Частота: 100%.
- Влияние на пользователя: функциональность недоступна без pointer.
- Влияние на деньги: часть пользователей не видит расчёт/сегментный контент.
- Доказательство: runtime aria-selected assertion.
- Код: [index.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/index.html:267), [index.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/index.html:474), [main.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/main.js:33), [landing-interactions.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/landing-interactions.js:76).
- Корень: visual tabs implemented as buttons with only click state.
- Исправление: complete tab/tablist/tabpanel relationships and keyboard model.
- Ретест: Tab once into group; arrows/Home/End; screen reader names/states.

### AUD-019 · P2 · Radio вопрос не имеет имени группы

- Роль: screen reader user.
- Место: registration, client-count question.
- Среда: accessibility tree/source.
- Предусловия: navigate between radios.
- Шаги: focus each option.
- Факт: question text — unrelated label; radios not inside fieldset/legend.
- Ожидание: common group name announced with each option.
- Частота: 100%.
- Влияние на пользователя: непонятно, на какой вопрос отвечают варианты.
- Влияние на деньги: form abandonment.
- Доказательство: DOM structure.
- Код: [register.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/register.html:131).
- Корень: visual grouping without semantic grouping.
- Исправление: fieldset + legend.
- Ретест: accessibility tree/VoiceOver/NVDA.

### AUD-020 · P2 · Countdown объявляется screen reader каждую секунду

- Роль: screen reader user.
- Место: landing countdown.
- Среда: live-region/source test.
- Предусловия: screen reader follows aria-live=polite.
- Шаги: находиться на странице одну минуту.
- Факт: весь секундный timer находится в live region и обновляется every 1000 ms.
- Ожидание: не прерывать чтение; объявлять только смысловые milestones.
- Частота: каждую секунду.
- Влияние на пользователя: постоянный шум, страница фактически нечитаема.
- Влияние на деньги: уход accessibility users.
- Доказательство: aria-live container + interval.
- Код: [index.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/index.html:117), [room.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/room.js:57).
- Корень: dynamic visual counter целиком сделан live region.
- Исправление: aria-live off на цифрах; отдельный milestone status.
- Ретест: минутный screen reader session.

### AUD-021 · P2 · Admin controls не имеют постоянных labels

- Роль: менеджер, screen reader/autofill user.
- Место: admin create manager, funnel dates, filters/search, broadcast.
- Среда: DOM/accessibility review.
- Предусловия: authenticated admin.
- Шаги: пройти controls по accessibility tree.
- Факт: часть inputs/select/textarea названа только placeholder либо не имеет accessible name.
- Ожидание: visible label for every field/group.
- Частота: 100% перечисленных controls.
- Влияние на пользователя: после ввода назначение поля теряется.
- Влияние на деньги: operational errors в настройке кампании.
- Доказательство: DOM inventory; login fields являются положительным контролем.
- Код: [admin.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/admin.html:147), также 190–192, 212–219, 233.
- Корень: inconsistent form component pattern.
- Исправление: label/for и fieldset/legend; placeholder только как example.
- Ретест: every control non-empty accessible name.

### AUD-022 · P2 · Мелкий secondary text не проходит 4.5:1

- Роль: пользователь со слабым зрением.
- Место: landing team descriptions; registration footnote.
- Среда: computed color contrast.
- Предусловия: default light appearance.
- Шаги: измерить composite foreground/background.
- Факт: team 12px ≈3.97:1; #74777d на white =4.4896:1.
- Ожидание: ≥4.5:1 для normal text без округления.
- Частота: 100% этих tokens.
- Влияние на пользователя: текст трудно читать.
- Влияние на деньги: снижение доверия/понимания.
- Доказательство: numeric contrast calculation.
- Код: [index.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/index.html:657), [register.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/register.html:186), [tailwind.config.cjs](/Users/egor/Desktop/АВТОВЕБИНАР/tailwind.config.cjs:28).
- Корень: opacity applied to already-muted text token.
- Исправление: opaque semantic on-surface-variant token with tested contrast.
- Ретест: actual backgrounds/states, normal/increased contrast.

### AUD-023 · P2 · Duplicate id ломает название организации и platform E2E

- Роль: platform owner/author/MFA user.
- Место: platform-access onboarding input и ready summary.
- Среда: Chromium diagnostic E2E.
- Предусловия: valid platform login/invitation.
- Шаги: consume link; дождаться ready; прочитать organization name.
- Факт: два элемента имеют id=platformOrganizationName. getElementById/setText выбирает onboarding input; ready dd остаётся «—». Три E2E assertions падают strict-mode.
- Ожидание: unique IDs; ready summary содержит имя организации; MFA hidden assertion однозначна.
- Частота: 100% authenticated sessions.
- Влияние на пользователя: не отображается active organization, повышается риск действий не в том tenant.
- Влияние на деньги: admin/CRM operational error.
- Доказательство: [failure screenshot](/Users/egor/Desktop/АВТОВЕБИНАР/test-results/webinar-room-platform-magi-ef48e--removes-the-fragment-token-chromium/test-failed-1.png), 25/30 diagnostic E2E.
- Код: [platform-access.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/platform-access.html:93), [platform-access.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/platform-access.html:174), [platform-access.js](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/js/platform-access.js:194).
- Корень: ID reused between onboarding and ready modes.
- Исправление: distinct platformOrganizationCreateName/platformActiveOrganizationName and update selectors.
- Ретест: owner/author/invite/MFA; DOM duplicate ID checker; E2E strict locators.

### AUD-024 · P2 · Release test gate невоспроизводим и красный

- Роль: технический специалист/release manager.
- Место: npm test, npm run e2e, test fixtures/spec.
- Среда: local schema=test.
- Предусловия: clean official commands.
- Шаги: npm test; npm run e2e; диагностический controlled-server run.
- Факт: npm test: 2 files failed, 45 passed; 1 test failed, 283 passed, 77 skipped. Integration beforeAll >30s, все 77 skipped; analyticsModeration expected 201 got 404, хотя direct live POST дважды дал 201. npm run e2e не запускает тесты: webServer timeout 60s; измеренный cold start >60s. После manual server выяснено: resetDb TRUNCATE admin_users … CASCADE очищает tenant_rollout_policies; official fixture их не восстанавливает. После временного test-only AFTER TRUNCATE seed: 25/30 pass; 3 fail из-за AUD-023; 2 fail потому что spec не открывает create disclosure/не переключает wizard step.
- Ожидание: одна официальная команда создаёт все fixtures и стабильно зелёная.
- Частота: official e2e startup reproduced; fixture wipe 100% each beforeEach.
- Влияние на пользователя: косвенное — регрессии могут попасть в release.
- Влияние на деньги: высокий release risk и ручные задержки.
- Доказательство: command exit codes/output; diagnostic E2E 25 pass / 5 fail in 3.2m.
- Код: [playwright.config.ts](/Users/egor/Desktop/АВТОВЕБИНАР/playwright.config.ts:39), [webinar-room.spec.ts](/Users/egor/Desktop/АВТОВЕБИНАР/tests/e2e/webinar-room.spec.ts:25), [webinar-room.spec.ts](/Users/egor/Desktop/АВТОВЕБИНАР/tests/e2e/webinar-room.spec.ts:321), [integration.test.ts](/Users/egor/Desktop/АВТОВЕБИНАР/tests/integration.test.ts:299), [analyticsModeration.test.ts](/Users/egor/Desktop/АВТОВЕБИНАР/tests/analyticsModeration.test.ts:478).
- Корень: startup threshold ниже cold import; fixture depends on hidden prior DB state and CASCADE side effect; E2E drifted from UI disclosure/wizard.
- Исправление: deterministic seed after each reset; remove hidden state; increase/startup probe timeout based on measured p95; update two flows; isolate analyticsModeration fixture; make integration setup <timeout or explicit.
- Ретест: clean test schema/container; three consecutive npm test + npm run e2e green without manual server/trigger.

### AUD-025 · P2 · Отсутствующий default webinar вызывает unhandled 500

- Роль: anonymous visitor, operator after partial seed failure.
- Место: GET /api/webinar/current.
- Среда: local runtime after test fixture removed default referenced webinar.
- Предусловия: default webinar row missing while daily session resolution runs.
- Шаги: anonymous current-room request.
- Факт: Prisma P2003 webinar_sessions_webinar_scope_fkey в upsert; repeated unhandled API error/500.
- Ожидание: readiness fails before serving либо endpoint returns controlled unavailable state.
- Частота: 100% в нарушенном baseline state.
- Влияние на пользователя: room unavailable.
- Влияние на деньги: потенциальная полная потеря attendance при deploy/seed incident.
- Доказательство: server logs с correlation IDs и stack.
- Код: [webinarSessions.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/lib/webinarSessions.ts:51), [webinar.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/routes/public/webinar.ts:102).
- Корень: runtime upsert assumes referential seed invariant not enforced by readiness/transaction.
- Исправление: atomic default seed, readiness invariant, controlled AppError and alert.
- Ретест: missing/cancelled/default webinar, startup/deploy rollback.

### AUD-026 · P2 · README противоречит production EMAIL_MODE guard

- Роль: operator.
- Место: deployment documentation.
- Среда: docs/env contract.
- Предусловия: deploy по README.
- Шаги: установить production EMAIL_MODE=log как допустимый degraded mode из docs.
- Факт: runtime validation запрещает production mode != send; приложение не стартует. .env.production.example корректно использует send.
- Ожидание: единственный непротиворечивый production contract.
- Частота: 100% при следовании ошибочной инструкции.
- Влияние на пользователя: downtime/no launch.
- Влияние на деньги: задержка запуска и недоставленные письма.
- Доказательство: docs/guard comparison.
- Код: [README.md](/Users/egor/Desktop/АВТОВЕБИНАР/README.md:373), [README.md](/Users/egor/Desktop/АВТОВЕБИНАР/README.md:613), [env.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/lib/env.ts:281).
- Корень: документация не обновлена после ужесточения guard.
- Исправление: удалить degraded recommendation; описать staging-only log mode и SMTP readiness.
- Ретест: docs command in clean production-like environment.

### AUD-027 · P3 · Decorative Material Symbols загрязняют accessible names

- Роль: screen reader user.
- Место: funnel buttons/links.
- Среда: DOM/accessibility names.
- Предусловия: screen reader.
- Шаги: прочитать CTA.
- Факт: 95/104 icon spans без aria-hidden; names включают arrow_forward, send, person.
- Ожидание: decorative glyph скрыт; action name чистый.
- Частота: массово на шести funnel pages.
- Влияние на пользователя: шум и непрофессиональные названия.
- Влияние на деньги: низкое, локальная usability loss.
- Доказательство: static count/runtime accessible names.
- Код: [index.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/index.html:64), [register.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/register.html:64), [success.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/success.html:195), [webinar.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/webinar.html:90).
- Корень: ligature text icon component lacks semantic default.
- Исправление: aria-hidden=true decorative spans; explicit label icon-only controls.
- Ретест: accessible name snapshot.

### AUD-028 · P3 · Не все funnel pages имеют skip link

- Роль: keyboard/screen reader user.
- Место: landing/register/access/success/recordings/admin.
- Среда: first-Tab inventory.
- Предусловия: keyboard only.
- Шаги: открыть page; Tab.
- Факт: main есть, skip link нет.
- Ожидание: первый Tab показывает «К основному содержанию».
- Частота: 100% перечисленных pages.
- Влияние на пользователя: повторный header приходится обходить.
- Влияние на деньги: локальная accessibility friction.
- Доказательство: DOM inventory; webinar/catalog/account/platform pages — positive control.
- Код: [index.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/index.html:58), [register.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/register.html:58), [admin.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/admin.html:111).
- Корень: shared header pattern применён не ко всем legacy pages.
- Исправление: распространить platform-skip-link component.
- Ретест: first Tab + Enter focus main.

### AUD-029 · P3 · Русская локализация смешана с техническим английским

- Роль: нетехнический пользователь/менеджер.
- Место: access/account/creator.
- Среда: copy inventory.
- Предусловия: ru locale.
- Шаги: пройти интерфейс.
- Факт: Session cookie, timezone, Replay/replay, private Webinar.
- Ожидание: единый русский словарь.
- Частота: перечисленные strings.
- Влияние на пользователя: непонимание и снижение доверия.
- Влияние на деньги: низкая локальная conversion friction.
- Доказательство: exact text search.
- Код: [access.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/access.html:178), [account.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/account.html:48), [creator-webinars.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/creator-webinars.html:347).
- Корень: отсутствует shared terminology glossary.
- Исправление: UX glossary и copy lint.
- Ретест: string scan + native speaker pass.

### AUD-030 · P3 · Anonymous happy path загрязняет Console ожидаемыми 404

- Роль: operator/technical support.
- Место: landing/register/room session lookup.
- Среда: 30 isolated Chromium contexts.
- Предусловия: anonymous context.
- Шаги: открыть три страницы.
- Факт: 90/90 main responses HTTP 200 и UI assertions pass, но каждый context получает пять 404 /api/registration/session/current и один 404 ?view=room; browser Console показывает шесть errors.
- Ожидание: ожидаемое anonymous состояние не выглядит как runtime failure.
- Частота: 30/30.
- Влияние на пользователя: невидимо.
- Влияние на деньги: замедляет диагностику настоящих ошибок.
- Доказательство: response URL capture.
- Код: session lookup callers и public registration route.
- Корень: expected absence encoded as error HTTP while UI probes repeatedly.
- Исправление: single cached capability lookup; 200 anonymous state или подавление expected probe without duplicate calls.
- Ретест: anonymous Console/Network has no unexpected errors and gate remains secure.

### AUD-031 · P3 · SEO contract неполный

- Роль: поисковый робот/маркетолог.
- Место: landing/legal/robots/sitemap.
- Среда: metadata/source audit.
- Предусловия: crawl public site.
- Шаги: inspect head, robots, generated sitemap.
- Факт: landing имеет description/OG, но canonical отсутствует; privacy/terms без description/canonical; robots не содержит Sitemap directive; generated sitemap охватывает catalog entries, но не основной landing/legal.
- Ожидание: canonical public URLs, complete sitemap/robots contract, service pages noindex.
- Частота: 100% перечисленных pages.
- Влияние на пользователя: нет прямого.
- Влияние на деньги: возможная потеря organic visibility/duplicate signals.
- Доказательство: head/robots/app sitemap route.
- Код: [index.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/index.html:1), [privacy.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/privacy.html:1), [terms.html](/Users/egor/Desktop/АВТОВЕБИНАР/crisis_premium/terms.html:1), [app.ts](/Users/egor/Desktop/АВТОВЕБИНАР/src/app.ts:488).
- Корень: catalog SEO implemented separately from main public funnel.
- Исправление: explicit public URL inventory, canonical/description, sitemap merge, robots Sitemap.
- Ретест: crawler snapshot, canonical/robots/sitemap validators.

## 8. Отдельный список потерь конверсии

| Место | Механизм потери | Дефект |
|---|---|---|
| Реклама → registration | UTM исчезает | AUD-001 |
| Анализ funnel | video/CTA/form events отсутствуют | AUD-002 |
| Accessibility viewer | видео без source | AUD-003 |
| Конец вебинара | final CTA скрыт | AUD-004 |
| Возврат/expiry | неверный webinar scope | AUD-005 |
| Start boundary | stale waiting до 30 секунд | AUD-006 |
| Background/return | неожиданное resume/seek | AUD-007 |
| Replay | future chat spoils timeline | AUD-008 |
| Timezone | пользователь приходит не вовремя | AUD-009 |
| Anonymous hot lead | заполняет форму и получает 401 | AUD-010 |
| Registration | слабые/неисправимые inputs | AUD-011 |
| Partner application | пустые/дублированные leads | AUD-012 |
| Tablet | CTA за viewport | AUD-017 |
| Keyboard/screen reader | tabs/group/countdown barriers | AUD-018…AUD-020 |

## 9. Устройства и браузеры

| Среда | Результат |
|---|---|
| Chromium 320 | Funnel без global overflow; cookie banner 184 px; buttons 143×42; несколько a11y defects |
| Chromium 360/390/430 | Основные поверхности без global overflow |
| Chromium 768 | Landing header overflow 100 px |
| Chromium 1024/1280/1440/1920 | Основные surfaces без global overflow в loaded sweep |
| Desktop Chrome-like Playwright | 25/30 diagnostic E2E pass после fixture workaround |
| Реальный Chrome | Не проверен отдельно от bundled Chromium |
| iPhone Safari | Не проверен физически |
| Desktop Safari | Не проверен |
| Android Chrome | Не проверен физически |
| Firefox | Не проверен |
| VoiceOver/NVDA | Не проверены |
| Landscape/safe area/system font/200% zoom | Частично по CSS, runtime не завершён |

## 10. Аналитика, CRM, письма и платежи

### Аналитика

- P1: UTM continuity и missing emitters.
- P2: transport не переживает 429/500/pagehide.
- Пройден E2E operation-key retry.
- Event allowlist и PII filters имеют focused tests.
- GA4/Метрика/receiver panel не предоставлены: event receipt, duplicates и dashboards не проверены.

### CRM

- Internal tenant CRM E2E: contact filter, task, audited stage transition — pass.
- Partner API допускает empty/duplicate applications.
- Внешняя CRM отсутствует во входных данных. Form → external CRM field mapping, duplicate behavior и manager view не проверены.

### Письма/Telegram

- Email outbox architecture/focused tests пройдены.
- Реальная SMTP отправка, SPF/DKIM/DMARC, inbox/spam, links и timezone reminders не проверены.
- Manager Telegram path недолговечен после final retries.
- Реальные Telegram bots/permissions/API не проверены.

### Платежи

- Payment code/routes/models/webhooks в текущем репозитории не найдены.
- Реальные списания не выполнялись.
- Если коммерческая оплата находится во внешней системе, весь payment блок остаётся не проверен и является blocking unknown.

## 11. Доступность, производительность и безопасность

### Доступность

- Подтверждены AUD-003, AUD-018…AUD-022, AUD-027…AUD-028.
- Положительные контроли: native labels на registration main fields; seek bar имеет 44 px hit area и keyboard handlers; creator dynamic labels корректно связываются JS; organization использует native dialog; часть platform pages уже имеет skip link.
- Не проверено: VoiceOver/NVDA, 200% zoom, real reduced-motion runtime, authenticated modal focus traps.

### Производительность/устойчивость

- Build assets: CSS около 48 KiB; крупнейшие JS creator-webinars около 96 KiB, video около 60 KiB; local webinar.mp4 около 55 MiB; hero PNG fallback около 1.9 MiB, но modern picture предлагает AVIF 32/84 KiB.
- Video preload=metadata и gated source initialization уменьшают исходную загрузку.
- Cold E2E server start превысил 60 секунд; warm measured start 26 секунд.
- 30 concurrent read-only contexts: основные pages 200, access gate consistent.
- Core Web Vitals, Lighthouse, RUM, memory leaks и weak-device CPU не измерены.
- particles-bg создаёт 3150 particles и perpetual desktop rAF; это только кандидат, требует performance profile и не включён как подтверждённый defect.

### Безопасность/privacy

- Положительно: CSP/Helmet, CSRF, rate limiters, HttpOnly/SameSite, tenant boundaries, hashed tokens, production env guards.
- Подтверждены AUD-013 и AUD-015.
- Registration injection input принимается, но confirmed stored XSS не получен; admin uses text nodes в проверенных местах.
- Anonymous room не открывает restricted media/chat.
- Active XSS/SQLi/IDOR/rate-limit attacks не выполнялись: нет явно разрешённого STAGING.
- npm advisory database не проверена: network registry request был отклонён; никаких обходов не делалось.

## 12. Оценки 0–100

| Направление | Балл | Почему сняты баллы |
|---|---:|---|
| Карта продукта | 88 | Production external routes/panels отсутствуют |
| Регистрация | 55 | Weak validation/error model; real CRM/email path не проверен |
| Логика вебинара | 43 | Version rollover P1, cache/resume/chat/timezone P2 |
| Видео/звук | 42 | Reduced-motion P1; no real devices/HLS/network |
| CTA/оффер | 32 | Final CTA P1, UTM P1, no full real playback |
| Аналитика | 24 | Missing core emitters, attribution, delivery gaps |
| CRM/коммуникации | 54 | Internal CRM pass; external systems absent; partner/Telegram defects |
| UX/тексты | 68 | Clear core proposition, but form/error/localization/dead-end issues |
| Responsive | 66 | Broad Chromium coverage; 768 overflow; no Safari/Firefox |
| Доступность | 46 | Video blocker and multiple keyboard/ARIA/contrast defects |
| Производительность | 52 | Static sizing and concurrency only; no CWV; slow cold start |
| Безопасность/privacy | 67 | Strong baseline controls; unsubscribe/path-token and active-test gaps |
| SEO | 64 | OG/description present; canonical/sitemap contract incomplete |
| Admin/эксплуатация | 56 | CRM/admin flows partly pass; labels, duplicate ID, docs/test gate |
| QA/release readiness | 34 | Official unit/integration/E2E commands are not green |
| Итоговая готовность | 47 | Five P1 plus mandatory production unknowns |

## 13. План исправлений

| Порядок | Что сделать | Сложность | Проверка | Блокирует запуск |
|---:|---|---|---|---|
| 1 | Исправить final CTA и reduced-motion source | S–M | Real browser timeline + reduce runtime | Да |
| 2 | Разделить versioned и legacy session resolution | M–L | Expired/replay/next-day integration matrix | Да |
| 3 | Сохранить attribution end-to-end | M | Landing click → DB → CRM → analytics | Да |
| 4 | Реализовать mandatory analytics emitters/transport | M | Receiver Network/event exactly-once suite | Да |
| 5 | Восстановить clean official test gates | M | 3 consecutive clean green runs | Да |
| 6 | Shared registration/partner validation и idempotency | M | Invalid/error/double-click/concurrency suite | Да для paid traffic |
| 7 | Исправить timezone/cache/visibility/chat state | M | Boundary/network/tab/DVR matrix | Да для широкого запуска |
| 8 | Gate partner form для anonymous | S | Anonymous/expired/valid participant | Да |
| 9 | Исправить duplicate ID platform access | S | Strict DOM + owner/author/MFA E2E | До platform rollout |
| 10 | Durable Telegram manager outbox | M | 429/500/restart/dead letter | До reliance on Telegram |
| 11 | Unsubscribe/token transport hardening | M | Privacy/security retest | До production mailing |
| 12 | Responsive/a11y P2 | M | 9 widths + keyboard + screen reader | До public launch |
| 13 | SEO/P3 polish и console noise | S–M | Crawler/Console snapshots | Нет после blockers |
| 14 | STAGING external integration run | M | Evidence from CRM/email/analytics/video panels | Да |

## 14. Финальный чек-лист повторной проверки

- [ ] Все 8 landing CTA сохраняют UTM/referrer/campaign identifiers.
- [ ] registration DB/CRM record содержит правильный source и не создаёт дубль.
- [ ] form_open означает реальное открытие/первый ввод; form_error/registration_success — exactly once.
- [ ] video_start/sound_on/25/50/75/finish/CTA appear/click/exit доходят в receiver.
- [ ] reduced-motion: video source есть, explicit play работает, decorative motion отключён.
- [ ] Final CTA видим от final event через ended/reload.
- [ ] Versioned registration никогда не переключается на legacy room.
- [ ] Early, exact start, +1/+5/+15/+30/+60, replay, next day.
- [ ] Refresh, browser restart, clean context, cookies disabled, multi-tab, other device.
- [ ] Start boundary с warm HTTP cache не держит waiting.
- [ ] User pause сохраняется после background/foreground.
- [ ] Replay chat корректно пересобирается после rewind.
- [ ] Session timezone/локальное время правильны на DST.
- [ ] Anonymous partner form gated; valid participant submits once.
- [ ] Full invalid email/phone/name/long/HTML matrix; 400/401/403/404/409/422/429/500.
- [ ] Double click/parallel submit/idempotency.
- [ ] CRM record, segment, manager task/status and no duplicates.
- [ ] Email/SMS/bot received, personalized, correct timezone, unsubscribe works.
- [ ] Real video on iPhone Safari, Android Chrome, desktop Safari/Chrome/Firefox.
- [ ] Autoplay/sound, full screen, rotate, lock screen, network switch, PiP/AirPlay where applicable.
- [ ] 320/360/390/430/768/1024/1280/1440/1920, landscape, safe area, 200% zoom/system font.
- [ ] Keyboard, VoiceOver/NVDA, focus trap/return, contrast, reduced motion, captions/transcript.
- [ ] Lighthouse/CWV, memory, slow CPU/network, offline/online.
- [ ] CSP/CSRF/CORS/rate limit/IDOR/XSS/webhook/payment-status on authorized staging.
- [ ] Canonical/robots/sitemap/404/500/security.txt/Open Graph.
- [ ] npm audit/advisory review with approved registry access.
- [ ] npm run build, npm run lint, npm test, npm run e2e — green three times on clean test DB.
- [ ] Production readiness/metrics/logs alert on missing default webinar and delivery failures.

## 15. Остаточные риски и непроверенное

1. Production URL не предоставлен. Не проверены DNS, TLS, CDN, cache, redirects, mixed content, real cookies и production headers.
2. STAGING/PRODUCTION выбор не заполнен. Все активные проверки ограничены LOCAL schema=test.
3. Test accounts/admin access не предоставлены. Часть platform UI проверена synthetic E2E fixtures, не реальными ролями.
4. External CRM не указана. Field mapping, queues, duplicate resolution, manager visibility и deletion не проверены.
5. Email service не указан. SMTP delivery, templates, spam, SPF/DKIM/DMARC и inbox links не проверены.
6. Telegram/bot accounts не предоставлены. Только log mode и code architecture.
7. Analytics receiver/panel не указаны. Receipt, dashboards, attribution reports и consent mode не проверены.
8. Payment system отсутствует в коде и входных данных. Если она существует снаружи, остаётся полностью непроверенный financial P0-risk.
9. Real iPhone/Android/Safari/Firefox/VoiceOver/NVDA не запускались.
10. Real video CDN/HLS, autoplay audio policy, background, lock screen, network switching, PiP/AirPlay не проверены.
11. Full cookies-disabled и ad-blocker sessions не выполнены.
12. Authenticated multi-tab/device race не выполнен.
13. Real 1/5/15/30/60-minute late-entry browser sessions не созданы.
14. 30 parallel registrations/form submits не выполнялись: без явно указанного stand/load permission создавались только read-only sessions.
15. Destructive security/load attacks не выполнялись.
16. Current dependency advisories не проверены из-за отклонённого внешнего registry access.
17. Core Web Vitals/Lighthouse/RUM/memory profile отсутствуют.
18. Исправления не вносились, потому что входное поле «разрешено ли исправлять» осталось [ДА/НЕТ].

## 16. Consolidated interface review

Режим: full. Все шесть доменов проверены: accessibility, layout, writing, typography, colors, UI polish. Подтверждённые root causes уже включены в AUD-003, AUD-011, AUD-017…AUD-023, AUD-027…AUD-029.

Рассмотрены и отклонены как false positives:

- 20 px checkbox/radio controls обёрнуты крупным clickable label.
- Seek bar имеет 44 px hit area и keyboard handlers.
- Creator dynamic labels программно связываются JS.
- Organization modal использует native dialog.
- Anonymous gate не раскрывает restricted video/chat.
- Hidden template headings не считались одновременными visible H1 без runtime proof.

## 17. Протокол команд и результатов

- npm run build → exit 0.
- npm run lint → exit 0.
- npx prisma validate → pass.
- Focused analytics tests → 8/8 pass.
- Focused safety/openapi/delivery tests → 20/20 pass.
- frontendUiSafety → 18/18 pass.
- npm test → exit 1; 45 files pass, 2 fail; 283 tests pass, 1 fail, 77 skip.
- npm run e2e → exit 1; webServer timeout 60, tests не стартовали.
- Diagnostic E2E with controlled server and test-only fixture restoration → 25 pass, 5 fail.
- 153 loaded viewport passes across 17 surfaces × 9 widths.
- 30 concurrent isolated read-only sessions → 90/90 main HTTP 200, gate 30/30, question disabled 30/30; expected anonymous lookup 404 console noise 30/30.

Конец отчёта. Вердикт остаётся BLOCK до исправления blockers и подтверждённого staging retest.
