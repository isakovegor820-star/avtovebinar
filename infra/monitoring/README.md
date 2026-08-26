# ASPB monitoring templates

Reviewable Prometheus, Alertmanager, and Grafana examples for staging. They contain no live endpoints, receivers, tokens, tenant labels, or personal data.

1. Replace only `placeholder.invalid` targets through deployment configuration.
2. Mount the metrics bearer token from a secret store at `/run/secrets/aspb_metrics_token`; never commit it.
3. Load `prometheus/aspb.rules.yml`, then run `promtool check rules` and `promtool check config` in the target Linux image.
4. Provision Grafana from `grafana/provisioning/` and import the versioned dashboard JSON.

Rules use low-cardinality service/queue/provider labels. Alert annotations link to exact sections in `docs/production-runbook.md` and must never include request bodies, email, phone, chat IDs, tokens, signed URLs, storage keys, or transcript text. Metrics referenced but not emitted by the application yet (`aspb_db_*`, oldest-age, provider/auth outcome, backup/restore timestamps, rollout counters) are exporter/instrumentation contracts; alerts remain inactive until those series are wired and verified.

`promtool` is not bundled by this repository. Local absence is a reported blocker, not a successful validation. The TypeScript static policy test still parses every YAML/JSON file and checks the safety contract.
