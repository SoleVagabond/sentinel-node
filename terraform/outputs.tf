output "dashboard_url" {
  value = "https://${aws_cloudfront_distribution.dashboard.domain_name}"
}

output "bucket_name" { value = aws_s3_bucket.dashboard.id }
output "lambda_name" { value = aws_lambda_function.monitor.function_name }
output "log_group" { value = aws_cloudwatch_log_group.monitor.name }
