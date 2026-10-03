terraform {
  required_version = ">= 1.7, < 2.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.0" }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = var.project_name, ManagedBy = "Terraform" }
  }
}

resource "random_id" "suffix" { byte_length = 4 }

locals {
  frontend_path = "${path.module}/../frontend"
  frontend_files = {
    "demo-config.json" = "application/json"
    "index.html"       = "text/html; charset=utf-8"
    "style.css"        = "text/css; charset=utf-8"
    "app.js"           = "text/javascript; charset=utf-8"
    "telemetry.js"     = "text/javascript; charset=utf-8"
  }
}

resource "aws_s3_bucket" "dashboard" {
  bucket        = "${var.project_name}-${random_id.suffix.hex}"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "dashboard" {
  bucket                  = aws_s3_bucket.dashboard.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "dashboard" {
  bucket = aws_s3_bucket.dashboard.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_cloudfront_origin_access_control" "dashboard" {
  name                              = "${var.project_name}-${random_id.suffix.hex}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "dashboard" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  origin {
    domain_name              = aws_s3_bucket.dashboard.bucket_regional_domain_name
    origin_id                = "dashboard"
    origin_access_control_id = aws_cloudfront_origin_access_control.dashboard.id
  }
  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "dashboard"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate { cloudfront_default_certificate = true }
  price_class = "PriceClass_100"
}

resource "aws_s3_bucket_policy" "dashboard" {
  bucket = aws_s3_bucket.dashboard.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.dashboard.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.dashboard.arn } }
    }]
  })
}

resource "aws_s3_object" "frontend" {
  for_each      = local.frontend_files
  bucket        = aws_s3_bucket.dashboard.id
  key           = each.key
  source        = "${local.frontend_path}/${each.key}"
  source_hash   = filemd5("${local.frontend_path}/${each.key}")
  content_type  = each.value
  cache_control = "no-cache"
}

resource "aws_iam_role" "monitor" {
  name = "${var.project_name}-${random_id.suffix.hex}"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" }
  }] })
}

resource "aws_cloudwatch_log_group" "monitor" {
  name              = "/aws/lambda/${var.project_name}-${random_id.suffix.hex}"
  retention_in_days = 14
}

resource "aws_iam_role_policy" "monitor" {
  role = aws_iam_role.monitor.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = [
      "${aws_s3_bucket.dashboard.arn}/status_data.json", "${aws_s3_bucket.dashboard.arn}/history.json"
    ] },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.monitor.arn}:*" }
  ] })
}

resource "aws_lambda_function" "monitor" {
  function_name                  = "${var.project_name}-${random_id.suffix.hex}"
  role                           = aws_iam_role.monitor.arn
  handler                        = "monitor.lambda_handler"
  runtime                        = "python3.13"
  filename                       = var.lambda_zip_path
  source_code_hash               = filebase64sha256(var.lambda_zip_path)
  timeout                        = 60
  memory_size                    = 128
  reserved_concurrent_executions = 1
  environment {
    variables = { BUCKET_NAME = aws_s3_bucket.dashboard.id }
  }
  depends_on = [aws_iam_role_policy.monitor]
}

resource "aws_cloudwatch_event_rule" "schedule" {
  name                = "${var.project_name}-${random_id.suffix.hex}"
  schedule_expression = "rate(1 minute)"
  state               = var.monitor_enabled ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "monitor" {
  rule = aws_cloudwatch_event_rule.schedule.name
  arn  = aws_lambda_function.monitor.arn
  retry_policy {
    maximum_event_age_in_seconds = 60
    maximum_retry_attempts       = 0
  }
}

resource "aws_lambda_permission" "schedule" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.monitor.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.schedule.arn
}

resource "aws_lambda_function_event_invoke_config" "monitor" {
  function_name                = aws_lambda_function.monitor.function_name
  maximum_event_age_in_seconds = 60
  maximum_retry_attempts       = 0
}
