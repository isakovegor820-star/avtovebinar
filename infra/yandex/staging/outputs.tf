output "media_bucket_name" {
  description = "Private staging bucket name; not a credential."
  value       = yandex_storage_bucket.media.bucket
}

output "runtime_secret_metadata_id" {
  description = "Lockbox metadata reference only; no secret values or versions."
  value       = yandex_lockbox_secret.runtime_metadata.id
  sensitive   = true
}

output "service_account_ids" {
  description = "Staging identity references; no keys are created by this module."
  value = {
    runtime   = yandex_iam_service_account.runtime.id
    media     = yandex_iam_service_account.media.id
    speechkit = yandex_iam_service_account.speechkit.id
    audit     = yandex_iam_service_account.audit.id
  }
  sensitive = true
}
