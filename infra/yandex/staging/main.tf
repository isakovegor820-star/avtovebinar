locals {
  name_prefix = "${var.project_name}-staging"
  labels = {
    environment = "staging"
    managed_by  = "terraform-review-only"
    project     = var.project_name
  }
}

resource "yandex_iam_service_account" "runtime" {
  folder_id   = var.folder_id
  name        = "${local.name_prefix}-runtime-sa"
  description = "ASPB staging runtime identity"
}

resource "yandex_iam_service_account" "media" {
  folder_id   = var.folder_id
  name        = "${local.name_prefix}-media-sa"
  description = "ASPB staging private media identity"
}

resource "yandex_iam_service_account" "speechkit" {
  folder_id   = var.folder_id
  name        = "${local.name_prefix}-speechkit-sa"
  description = "ASPB staging SpeechKit identity"
}

resource "yandex_iam_service_account" "audit" {
  folder_id   = var.folder_id
  name        = "${local.name_prefix}-audit-sa"
  description = "ASPB staging Audit Trails identity"
}

resource "yandex_kms_symmetric_key" "media" {
  folder_id           = var.folder_id
  name                = "${local.name_prefix}-media-kms"
  description         = "ASPB staging private media SSE-KMS key"
  default_algorithm   = "AES_256"
  rotation_period     = "8760h"
  deletion_protection = true

  lifecycle { prevent_destroy = true }
}

resource "yandex_storage_bucket" "media" {
  folder_id               = var.folder_id
  bucket                  = var.media_bucket_name
  force_destroy           = false
  disabled_statickey_auth = true

  # Provider 0.220 defaults the bucket ACL to private. Keep the deprecated
  # inline acl argument absent and make every anonymous capability explicit.
  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  versioning { enabled = true }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        kms_master_key_id = yandex_kms_symmetric_key.media.id
        sse_algorithm     = "aws:kms"
      }
    }
  }

  lifecycle_rule {
    id                                     = "staging-abort-incomplete-multipart"
    prefix                                 = ""
    enabled                                = true
    abort_incomplete_multipart_upload_days = var.incomplete_multipart_days
  }

  dynamic "lifecycle_rule" {
    for_each = var.approved_object_retention_days == null ? [] : [var.approved_object_retention_days]
    content {
      id      = "staging-approved-retention"
      prefix  = ""
      enabled = true
      expiration { days = lifecycle_rule.value }
      noncurrent_version_expiration { days = lifecycle_rule.value }
    }
  }

  cors_rule {
    allowed_headers = ["Content-Type", "Content-MD5", "x-amz-checksum-sha256", "x-amz-date"]
    allowed_methods = ["GET", "HEAD", "PUT", "POST"]
    allowed_origins = [var.allowed_origin]
    expose_headers  = ["ETag"]
    max_age_seconds = 600
  }

  tags = local.labels
  lifecycle { prevent_destroy = true }
}

resource "yandex_storage_bucket_iam_binding" "media_viewers" {
  bucket = yandex_storage_bucket.media.bucket
  role   = "storage.viewer"
  members = [
    "serviceAccount:${yandex_iam_service_account.runtime.id}",
    "serviceAccount:${yandex_iam_service_account.media.id}",
  ]
}

resource "yandex_storage_bucket_iam_binding" "media_uploaders" {
  bucket = yandex_storage_bucket.media.bucket
  role   = "storage.uploader"
  members = [
    "serviceAccount:${yandex_iam_service_account.media.id}",
    "serviceAccount:${yandex_iam_service_account.audit.id}",
  ]
}

resource "yandex_kms_symmetric_key_iam_member" "media_runtime" {
  symmetric_key_id = yandex_kms_symmetric_key.media.id
  role             = "kms.keys.encrypterDecrypter"
  member           = "serviceAccount:${yandex_iam_service_account.runtime.id}"
}

resource "yandex_kms_symmetric_key_iam_member" "media_worker" {
  symmetric_key_id = yandex_kms_symmetric_key.media.id
  role             = "kms.keys.encrypterDecrypter"
  member           = "serviceAccount:${yandex_iam_service_account.media.id}"
}

resource "yandex_kms_symmetric_key_iam_member" "audit_writer" {
  symmetric_key_id = yandex_kms_symmetric_key.media.id
  role             = "kms.keys.encrypter"
  member           = "serviceAccount:${yandex_iam_service_account.audit.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "speechkit_user" {
  folder_id = var.folder_id
  role      = "ai.speechkit-stt.user"
  member    = "serviceAccount:${yandex_iam_service_account.speechkit.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "audit_viewer" {
  folder_id = var.folder_id
  role      = "audit-trails.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.audit.id}"
}

resource "yandex_lockbox_secret" "runtime_metadata" {
  folder_id           = var.folder_id
  name                = "${local.name_prefix}-runtime-secret-metadata"
  description         = "Metadata container only; secret versions and values are managed outside this template"
  kms_key_id          = yandex_kms_symmetric_key.media.id
  deletion_protection = true
  labels              = local.labels

  lifecycle { prevent_destroy = true }
}

resource "yandex_lockbox_secret_iam_member" "runtime_payload_viewer" {
  secret_id = yandex_lockbox_secret.runtime_metadata.id
  role      = "lockbox.payloadViewer"
  member    = "serviceAccount:${yandex_iam_service_account.runtime.id}"
}

resource "yandex_audit_trails_trail" "staging" {
  folder_id          = var.folder_id
  name               = "${local.name_prefix}-audit-trail"
  description        = "ASPB staging management and Object Storage data events"
  service_account_id = yandex_iam_service_account.audit.id
  labels             = local.labels

  storage_destination {
    bucket_name   = yandex_storage_bucket.media.bucket
    object_prefix = "audit-trails/staging/"
  }

  filtering_policy {
    management_events_filter {
      resource_scope {
        resource_id   = var.folder_id
        resource_type = "resource-manager.folder"
      }
    }
    data_events_filter {
      service = "storage"
      resource_scope {
        resource_id   = var.folder_id
        resource_type = "resource-manager.folder"
      }
    }
  }

  depends_on = [
    yandex_storage_bucket_iam_binding.media_uploaders,
    yandex_kms_symmetric_key_iam_member.audit_writer,
  ]
}
