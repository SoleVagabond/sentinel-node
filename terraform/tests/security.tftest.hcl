mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/sentinelnode-test" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-1:123456789012:function:sentinelnode-test" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-1:123456789012:rule/sentinelnode-test" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/sentinelnode-test" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::sentinelnode-test", bucket_regional_domain_name = "sentinelnode-test.s3.us-east-1.amazonaws.com" }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = { arn = "arn:aws:cloudfront::123456789012:distribution/E123456789" }
  }
}
mock_provider "random" {
  mock_resource "random_id" {
    defaults = { hex = "12ab34cd" }
  }
}

run "public_dashboard_private_storage" {
  command = apply

  assert {
    condition = (
      aws_s3_bucket_public_access_block.dashboard.block_public_acls &&
      aws_s3_bucket_public_access_block.dashboard.block_public_policy &&
      aws_s3_bucket_public_access_block.dashboard.ignore_public_acls &&
      aws_s3_bucket_public_access_block.dashboard.restrict_public_buckets
    )
    error_message = "The dashboard bucket must reject direct public access."
  }
  assert {
    condition     = aws_cloudfront_distribution.dashboard.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https"
    error_message = "Dashboard viewers must use HTTPS."
  }
  assert {
    condition     = aws_lambda_function.monitor.reserved_concurrent_executions == 1
    error_message = "The snapshot and history writer must remain serialized."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.monitor.policy).Statement[0].Action == ["s3:GetObject", "s3:PutObject"]
    error_message = "The telemetry writer must not gain bucket-wide administrative permissions."
  }
  assert {
    condition     = aws_lambda_function_event_invoke_config.monitor.maximum_retry_attempts == 0
    error_message = "Failed monitor events must not retry against old observation windows."
  }
}
