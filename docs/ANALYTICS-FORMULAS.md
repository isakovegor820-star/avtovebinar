# Analytics formulas and privacy contract

Версия projection contract: 1, 2026-08-23. Источник событий — только принятый ANA-006 `Event.schemaVersion=1`. Legacy `schemaVersion=0`, неизвестные события и недоказанные задним числом conversions не входят ни в одну формулу.

## Общие определения

- Tenant всегда берётся из authenticated `TenantContext`; query `organizationId` — игнорируемый compatibility hint.
- Период задаётся календарными датами UTC: `from` включительно с `00:00:00.000Z`, `to` включительно до конца дня, в SQL используется exclusive граница следующего дня. По умолчанию — последние 30 UTC-дней до server now.
- Stable identity: `user:<User.id>`, иначе `registration:<Registration.id>`, иначе server-issued privacy-safe `visitor:<visitor_id>`. Email, телефон, Telegram/chat ID и клиентский user ID identity не образуют.
- PostgreSQL-atomic ANA-006 dedup исключает replay одного `dedupKey`; дополнительно heartbeat одного stable identity, Session, source и `intervalNumber` учитывается один раз.
- Anonymous учитывается только при наличии server-issued visitor identity. Event без trusted identity не увеличивает unique audience.
- Background heartbeat (`visibilityState != visible`) и неиграющее состояние (`playbackState != playing`) не дают watch/retention/live audience.

## ANA-001 overview

| Показатель | Numerator / точная формула | Denominator | Retry/anonymous/background |
|---|---|---|---|
| Регистрации | `COUNT Registration` в tenant/scope/UTC period, `status=registered`, `email_verified_at IS NOT NULL` | нет | бизнес-строка, а не client event; повтор event не влияет |
| Уникальные входы | `COUNT DISTINCT stable identity` по `webinar_room_open`, `recording_open`, `recording_play` | нет | один identity один раз; anonymous только с server visitor ID |
| Live views | distinct identity по room `webinar_room_open`, `video_start`, `viewer_heartbeat`, `video_finish` | нет | duplicate tab с той же identity не добавляет audience |
| Replay views | distinct identity по replay `recording_open`, `recording_play`, `viewer_heartbeat`, `recording_finish` | нет | live и replay не смешиваются |
| Среднее время просмотра | сумма одного accepted visible+playing heartbeat interval на identity/Session/source/intervalNumber; каждый interval `min(intervalSeconds,30)` | число identities хотя бы с одним accepted interval | retry, второй tab и seek к уже учтённому interval не добавляют время; background исключён |
| Completion | distinct identities с `video_finish` или `recording_finish` | distinct identities с accepted room/replay viewing event | если denominator 0, rate 0; legacy finish не считается conversion |
| Вопросы | `COUNT Question.created_at` в tenant/scope/UTC period | нет | authoritative business row, не `question_submit_attempt` |
| CTA | `COUNT PartnerApplication.created_at` + deduplicated v1 `recording_cta_click` | нет | приложение считается trusted business row; retry event deduplicated |

В API completion возвращается как `{numerator, denominator, rate}`, чтобы UI не скрывал базу процента. Все числовые показатели имеют текстовое представление; цвет/график не является единственным носителем значения.

### Вычисляемая fixture

`tests/analyticsModeration.test.ts` создаёт три verified Registration/identity в одном WebinarSession: у каждого room open и один foreground heartbeat по 10 секунд; у одного finish и Question. Background heartbeat каждого identity присутствует намеренно. Ожидается: registrations 3, unique entries 3, live views 3, replay 0, average watch 10 seconds, questions 1, completion `1/3 = 0.3333`.

## ANA-002 retention

- Режим обязателен: `LIVE → source=room`, `REPLAY → source=replay`; конфликт source/playback даёт `analytics_filter_conflict`.
- Фактическая duration берётся из trusted WebinarSession `video_duration_seconds`, fallback — validated event `durationSeconds`. Position ограничивается duration. Нулевая/неизвестная duration исключается.
- Для каждого интервала `0,10,…,90%` numerator — `COUNT DISTINCT stable identity`, у которого accepted position достиг границы. Повтор heartbeat, backward seek и второй tab не создают identity.
- Cohort `1..2` возвращается как `{viewers:null,suppressed:true}` при threshold 3; zero не маскируется как реальный человек и может быть `null/suppressed:false` в текущей projection.
- Индивидуальная строка/identity API не возвращается.

Fixture содержит три replay identities на 50%, затем seek назад. На 50% ожидается ровно 3, не 6; LIVE остаётся пустым.

## ANA-003 active viewers

Numerator — distinct stable identities с server-accepted `viewer_heartbeat`, `source=room`, `visibilityState=visible`, `playbackState=playing`, authoritative `occurred_at` внутри `(server now − 45 seconds, server now]`. Истёкшая heartbeat исключается автоматически. Synthetic count отсутствует и API возвращает `syntheticViewersIncluded:false`.

UI показывает алгоритм рядом с числом, server active window 45 секунд и возможную задержку refresh до 10 секунд. Это не «онлайн прямо сейчас» с нулевой задержкой.

## ANA-004 chapters and transcript search

- `chapter_open.chapterId` должен связываться с Chapter того же tenant/Webinar и Transcript со status `PUBLISHED`.
- `transcript_search.query` проходит bounded Zod allowlist: длина, разрешённые символы, запрет email/phone/token/URL-like patterns и PII field names. Unsafe text отвергается до БД и не включается в logs/errors.
- Chapter/query numerator — distinct stable identities. Aggregate появляется только при числе identities >= 3; одиночный пользователь не может раскрыть свой query повторными запросами.
- Draft/REVIEWED transcripts не участвуют. API не возвращает identity или raw event row.

## ANA-005 filters

`webinarId`, `sessionId`, `source`, `from`, `to` комбинируются в одном server query. Session дополнительно проверяется внутри Webinar, если оба фильтра заданы. AUTHOR автоматически ограничен Webinars своего AuthorProfile. Foreign и unknown Webinar/Session дают одинаковый `404 analytics_scope_not_found`.

Browser UI хранит только эти фильтры и retention playback в URL, восстанавливает их при reload и `popstate`, не использует browser storage. Empty/loading/error/permission states сообщаются текстом через stable polite/alert regions.

## ANA-007 platform aggregate

Platform projection доступна только MFA `AdminUser owner/admin`; tenant User session не принимается. Группировка — Organization → Webinar → Session за UTC period. Registrations, active identities, questions и CTA меньше threshold 3 возвращаются как `null`; поле `suppressed` отмечает ненулевое малое значение. Структурно исключены chat/message, notes, email, phone и Telegram identifiers. Raw drill-down и CSV endpoint намеренно отсутствуют, поэтому отдельного PII permission в текущем contract нет. Если такой endpoint появится, он потребует отдельной permission и обязательной audit record на каждое раскрытие.
