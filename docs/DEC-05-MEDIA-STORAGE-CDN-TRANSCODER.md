# DEC-05 — object storage, CDN и transcoder

Дата исследования: 21 августа 2026 года

Статус: **техническая рекомендация принята в коде; договор, DPA, бюджет и production switch не утверждены**

## Решение

Рекомендуемый production contour:

1. Yandex Object Storage в регионе Россия, private bucket, отдельный service account с минимальными правами.
2. Реализованный generic S3-compatible adapter для multipart upload/ListParts/complete/abort/private read.
3. Собственный durable worker с `ffprobe`/`ffmpeg`: MP4/MOV/WebM validation, HLS VOD, JPEG poster и private OGG/Opus rendition для STT.
4. На первом rollout — cookie-authorized application gateway для manifest, каждого segment/poster и Range. Bucket/origin остаётся закрытым.
5. Yandex Cloud CDN не включать до нагрузочного теста и утверждения edge-auth схемы. Документированный secure-token механизм подписывает отдельные URL/path+expiry, но не заменяет серверную повторную проверку participant session, tenant, private grant и replay expiry.

Multipart recovery учитывает окно между provider-side `CompleteMultipartUpload` и application transaction: `NoSuchUpload` при повторном `ListParts` не теряет загрузку; server checkpoints позволяют повторить complete, а `HeadObject` подтверждает MIME/размер до создания одного deduplicated job.

Адаптер и worker добавлены, но безопасный default остаётся `MEDIA_STORAGE_PROVIDER=unconfigured`. Никакой provider resource или credential этим решением не создаётся.

## Decision matrix

| Критерий | Yandex Cloud | Selectel | AWS |
| --- | --- | --- | --- |
| Регион/право/DPA | Object Storage для региона Россия; заявлена применимость 152-ФЗ. Договор, поручение обработки, применимое право и DPA должны быть получены и проверены юристом до switch | Доступны российские регионы/пулы. Точный S3 pool, договор и DPA требуют письменного подтверждения | Зрелые EU-регионы, но российской region нет; трансграничную передачу и договорную схему нужно отдельно разрешить юридически |
| Private bucket/origin | Private bucket/IAM и HTTPS; S3 origin не публикуется | Requests private by default, bucket policy поддерживается | Private S3 + Origin Access Control — зрелый вариант |
| Multipart/API | S3-compatible Create/UploadPart/ListParts/Complete/Abort; AWS SDK совместим | S3 multipart, SigV4, CORS и presigned URL поддерживаются | Reference implementation, полный multipart API |
| CORS/signed operations | Bucket CORS и pre-signed operations; TTL ограничивает приложение | CORS и presigned URL; документация указывает 15-минутный срок подписи | Bucket CORS и presigned URLs |
| CDN private auth | Secure token — signed link на path с expiry, optional IP; signed-cookie эквивалент в рассмотренных документах не найден | Secure access доступен, но отдельно проверяется HLS/Range и origin hardening | CloudFront поддерживает signed URL и signed cookies; cookies удобны для набора HLS files |
| Range/HLS | Object reads/Range и CDN нужно подтвердить smoke/load тестом; приложение уже сохраняет `206`/`Content-Range` | Требуется provider acceptance | Зрелая поддержка, но юридический регион остаётся блокером |
| Incomplete multipart | Bucket lifecycle умеет удалять incomplete multipart; дополнительно работает application abort/cleanup через 24 часа | Bucket Lifecycle в compatibility table не поддерживается; документация предупреждает о постановке parts на удаление через 6 месяцев без гарантии срока и возлагает контроль на клиента | Lifecycle `AbortIncompleteMultipartUpload` |
| Стоимость, snapshot | Standard storage: 2,376 ₽/GB-month; первые 1 GB, 10k write/list и 100k read operations бесплатны. Первые 100 GB egress бесплатны; пример official price сверх 100 GB до 1 TB — 1,67994 ₽/GB. Перед закупкой пересчитать текущий прайс | Storage, requests и egress; запросить коммерческий расчёт для source + renditions + multipart residue + CDN | Storage/request/egress/CloudFront/MediaConvert либо Compute; currency/cross-border risk |
| Transcoding | Отдельный managed transcoder не нужен: платятся worker VM/container CPU/RAM/disk по секундам и внутренний трафик; нужен benchmark ₽/час видео | Можно запустить собственный worker в российском pool | Self-hosted ffmpeg или MediaConvert; последний имеет отдельный per-minute tariff |
| SLA/limits/observability | Object Storage заявляет 99,98% SLA и replication по availability zones; Monitoring/Audit Trails/bucket logs доступны. Квоты и alert delivery проверяются на staging | SLA/limits/metrics требуют contract review; S3 migration deadline 15.09.2026 нужно учесть | Самая зрелая observability, но не снимает legal blocker |
| Собственный ffmpeg | Да, Compute/Container worker | Да | Да |

Стоимость приведена только как снимок официальной публичной страницы на дату исследования, с НДС для российского договора. Бюджет считать по фактическим минутам source video, числу renditions, сроку хранения, просмотрам/Range и коэффициенту повторной обработки.

## Почему не прямой CDN switch

HLS — это manifest и множество ресурсов. Требование АСПБ требует перед каждым чтением заново проверять точные `Organization`, `Webinar`, `WebinarSession`, participant registration, private grant и replay policy. Короткая подпись URL уменьшает окно утечки, но не отзывает уже выданную ссылку немедленно. Поэтому текущий correctness contour проксирует private bytes через авторизационный gateway. До CDN switch нужны:

- edge authorization design с немедленным revoke либо явно утверждённым максимальным окном;
- защита origin от обхода CDN;
- HLS manifest rewrite и authorization каждого variant/segment/key;
- Range/seek acceptance и нагрузочный тест, доказывающий, что Node gateway не становится bottleneck;
- CDN request/access logs без query token и ПДн.

## Реализованный env-контракт

См. `.env.production.example`:

- `MEDIA_STORAGE_PROVIDER=unconfigured|s3|test_fake`;
- `MEDIA_S3_ENDPOINT`, `MEDIA_S3_REGION`, `MEDIA_S3_BUCKET`;
- `MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY`;
- `MEDIA_S3_FORCE_PATH_STYLE`, `MEDIA_SIGNED_OPERATION_TTL_SECONDS`;
- `MEDIA_TRANSCODE_TIMEOUT_SECONDS`, `MEDIA_HLS_SEGMENT_SECONDS`;
- `MEDIA_FFMPEG_PATH`, `MEDIA_FFPROBE_PATH`;
- exact HTTPS allowlist `MEDIA_UPLOAD_CSP_ORIGINS`.

`test_fake` разрешён только при `NODE_ENV=test`; production guard требует полный real config и отклоняет HTTP/localhost endpoint. Secrets не входят в репозиторий и не должны использоваться совместно со STT/AI.

## Внешняя точка утверждения

До provider smoke обязательны письменные решения владельца бюджета и юриста/DPO:

- юридическое лицо поставщика, применимое право, DPA/поручение обработки, место всех replicas/backups/logs/support access;
- перечень субпроцессоров и порядок уведомления;
- удаление source/renditions/incomplete parts/backups и доказательство удаления;
- SLA/support, quotas, rate limits, budget alerts и согласованный месячный лимит;
- lifecycle policy и ключи service account/rotation в approved secret store.

## Официальные источники

- [Yandex Object Storage: S3 multipart API](https://yandex.cloud/en/docs/storage/s3/api-ref/multipart)
- [Yandex Object Storage: pre-signed URLs](https://yandex.cloud/en/docs/storage/concepts/pre-signed-urls)
- [Yandex Object Storage: lifecycle](https://yandex.cloud/en/docs/storage/concepts/lifecycles)
- [Yandex Object Storage: pricing](https://yandex.cloud/ru/docs/storage/pricing)
- [Yandex Object Storage: service/SLA summary](https://yandex.cloud/en/services/storage)
- [Yandex Cloud: data privacy](https://yandex.cloud/en/security/data-privacy)
- [Yandex Cloud CDN: secure tokens](https://yandex.cloud/en/docs/cdn/concepts/secure-tokens)
- [Yandex Cloud CDN: pricing](https://yandex.cloud/en/docs/cdn/pricing)
- [Selectel: S3 compatibility](https://docs.selectel.ru/en/api/object-storage-s3/)
- [Selectel: incomplete multipart warning](https://docs.selectel.ru/en/s3/objects/upload-object/)
- [Selectel: infrastructure locations](https://docs.selectel.ru/en/infrastructure/locations/)
- [AWS S3: multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [AWS CloudFront: signed URL vs signed cookies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-choosing-signed-urls-cookies.html)
- [AWS Elemental MediaConvert: pricing](https://aws.amazon.com/mediaconvert/pricing/)
