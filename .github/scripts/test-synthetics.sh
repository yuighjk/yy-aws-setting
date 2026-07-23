#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
CANARY_NAME="${CANARY_NAME:-yy-aws-setting-api}"

aws synthetics get-canary --region "$REGION" --name "$CANARY_NAME" >/dev/null
aws synthetics start-canary --region "$REGION" --name "$CANARY_NAME" >/dev/null
echo "Started $CANARY_NAME"

for _ in {1..18}; do
  STATUS=$(aws synthetics get-canary-runs \
    --region "$REGION" \
    --name "$CANARY_NAME" \
    --max-results 1 \
    --query 'CanaryRuns[0].Status.State' \
    --output text)
  case "$STATUS" in
    PASSED)
      echo "Synthetics patrol passed"
      exit 0
      ;;
    FAILED)
      echo "Synthetics patrol failed; inspect its CloudWatch log and S3 artifacts" >&2
      exit 1
      ;;
    *)
      echo "Current run state: $STATUS"
      sleep 5
      ;;
  esac
done

echo "Canary did not finish in time" >&2
exit 1
