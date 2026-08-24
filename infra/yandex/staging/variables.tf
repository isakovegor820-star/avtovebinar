variable "environment" {
  type        = string
  description = "Safety marker; this module is staging-only."
  default     = "staging"
  validation {
    condition     = var.environment == "staging"
    error_message = "Only environment=staging is accepted."
  }
}

variable "project_name" {
  type        = string
  description = "Lowercase project marker used in every resource name."
  default     = "aspb"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.project_name)) && !can(regex("prod|production", var.project_name))
    error_message = "project_name must be lowercase and must not be production-like."
  }
}

variable "cloud_id" {
  type        = string
  description = "Staging Yandex Cloud ID supplied out of band."
  validation {
    condition     = length(trimspace(var.cloud_id)) >= 8 && !can(regex("(?i)prod|production", var.cloud_id))
    error_message = "cloud_id must be an explicit non-production staging identifier."
  }
}

variable "folder_id" {
  type        = string
  description = "Dedicated staging folder ID supplied out of band."
  validation {
    condition     = length(trimspace(var.folder_id)) >= 8 && !can(regex("(?i)prod|production", var.folder_id))
    error_message = "folder_id must be an explicit non-production staging identifier."
  }
}

variable "zone" {
  type        = string
  default     = "ru-central1-a"
  description = "Staging availability zone."
  validation {
    condition     = can(regex("^ru-central1-[a-d]$", var.zone))
    error_message = "zone must be in ru-central1."
  }
}

variable "media_bucket_name" {
  type        = string
  description = "Globally unique private bucket name containing the staging marker."
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.media_bucket_name)) && can(regex("staging", var.media_bucket_name)) && !can(regex("prod|production", var.media_bucket_name))
    error_message = "media_bucket_name must be a valid staging-only bucket name."
  }
}

variable "allowed_origin" {
  type        = string
  description = "Exact HTTPS browser origin for multipart requests; wildcard is forbidden."
  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+(?::[0-9]+)?$", var.allowed_origin)) && !strcontains(var.allowed_origin, "*") && !can(regex("(?i)prod|production", var.allowed_origin))
    error_message = "allowed_origin must be one exact non-production HTTPS origin."
  }
}

variable "incomplete_multipart_days" {
  type        = number
  default     = 1
  description = "Cleanup window for incomplete synthetic staging multipart uploads."
  validation {
    condition     = var.incomplete_multipart_days >= 1 && var.incomplete_multipart_days <= 7
    error_message = "incomplete multipart cleanup must be between 1 and 7 days."
  }
}

variable "approved_object_retention_days" {
  type        = number
  default     = null
  nullable    = true
  description = "Optional lifecycle only after legal/DPO approval; null creates no object expiration."
  validation {
    condition     = var.approved_object_retention_days == null || (var.approved_object_retention_days >= 1 && var.approved_object_retention_days <= 3650)
    error_message = "Approved retention must be null or 1..3650 days."
  }
}

variable "monthly_budget_cap_rub" {
  type        = number
  default     = 0
  description = "Documentation-only cap; zero means billing activation is not approved."
  validation {
    condition     = var.monthly_budget_cap_rub >= 0
    error_message = "Budget cap cannot be negative."
  }
}

variable "alert_recipient_placeholder" {
  type        = string
  default     = "replace-after-approval"
  description = "Non-secret placeholder; no notification resource is created."
  validation {
    condition     = !can(regex("@|https?://|[0-9]{6,}", var.alert_recipient_placeholder))
    error_message = "Do not put a real email, URL, phone, or chat ID in Terraform variables."
  }
}
