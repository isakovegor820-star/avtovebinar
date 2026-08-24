# Yandex Cloud staging template — review only

This directory is a staging-only Terraform/OpenTofu template. It has not been planned or applied against an account. Provider `yandex-cloud/yandex` is constrained to `~> 0.220.0`, the latest reviewed release on 2026-08-24. Resource contracts were checked against the official Yandex Cloud references for Object Storage, Lockbox, KMS, and Audit Trails.

Safety boundaries:

- only `environment=staging` passes validation; names/origins/IDs reject production-like values;
- no cloud/folder IDs, credentials, static access keys, secret versions, real recipients, or remote backend are committed;
- the bucket is private, has all anonymous flags off, `force_destroy=false`, versioning, SSE-KMS, exact-origin CORS with exposed `ETag`, incomplete multipart cleanup, and `prevent_destroy`;
- object expiration is absent by default; set `approved_object_retention_days` only after a versioned legal/DPO decision;
- runtime, media, SpeechKit, and Audit Trails use separate service accounts and service-scoped roles; this template creates no service-account keys;
- Lockbox contains metadata only. Values/versions belong to an approved secret-delivery process outside Terraform state;
- Audit Trails writes to the isolated `audit-trails/staging/` prefix. Production should use a separately reviewed destination bucket;
- budget notifications and Yandex Monitoring bindings remain manual placeholders because recipient, cap, billing account, and escalation policy are not approved. `monthly_budget_cap_rub=0` means no billing activation.

Offline review sequence:

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

`init` may require network access to download the pinned provider. A review-only plan is allowed only after supplying synthetic staging IDs through an untracked tfvars file and obtaining the separate staging-network approval:

```bash
terraform plan -refresh=false -var-file=staging.private.tfvars -out=staging.review.tfplan
```

Never run `terraform apply`/`tofu apply` from this workflow. No `yc ... create/update/delete` command is permitted. Before any future activation, approve DPA/subprocessors, object retention, budget/cap, restore drill, IAM review, alert recipients, exact CORS origin, and dedicated credentials.

Official references: <https://yandex.cloud/en/docs/terraform/resources/storage_bucket>, <https://yandex.cloud/en/docs/terraform/resources/lockbox_secret>, <https://yandex.cloud/en/docs/terraform/resources/audit_trails_trail>, <https://yandex.cloud/en/docs/terraform/resources/kms_symmetric_key>.
