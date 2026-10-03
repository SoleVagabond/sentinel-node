variable "aws_region" {
  description = "Region for the monitor and dashboard bucket."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Lowercase resource name prefix."
  type        = string
  default     = "sentinelnode"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.project_name))
    error_message = "Use 3–25 lowercase letters, digits, and hyphens, starting with a letter."
  }
}

variable "lambda_zip_path" {
  description = "Path to a clean package created by scripts/package_lambda.py."
  type        = string
  default     = "../work/lambda.zip"
}

variable "monitor_enabled" {
  description = "Enable the recurring endpoint checks after deployment."
  type        = bool
  default     = true
}
