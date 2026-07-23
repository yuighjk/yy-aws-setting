#!/usr/bin/env bash
set -euo pipefail

if [[ "${CONFIRM_DLQ_TEST:-}" != "yes" ]]; then
  echo "This test deliberately triggers the DLQ alarm." >&2
  echo "Run again with CONFIRM_DLQ_TEST=yes after confirming the DLQ contains no real messages." >&2
  exit 2
fi

REGION="${AWS_REGION:-ap-northeast-1}"
TOPIC_ARN="${NOTE_EVENTS_TOPIC_ARN:-arn:aws:sns:${REGION}:978184426686:yy-aws-setting-note-events}"
DLQ_URL="${NOTE_EVENTS_DLQ_URL:-https://sqs.${REGION}.amazonaws.com/978184426686/yy-aws-setting-note-events-dlq}"
EVENT_ID="homework-dlq-$(date +%s)"
MESSAGE=$(jq -cn --arg eventId "$EVENT_ID" '{eventId: $eventId, simulateFailure: true}')

aws sns publish --region "$REGION" --topic-arn "$TOPIC_ARN" --message "$MESSAGE" >/dev/null
echo "Published deliberate failure $EVENT_ID"

for _ in {1..15}; do
  COUNT=$(aws sqs get-queue-attributes \
    --region "$REGION" \
    --queue-url "$DLQ_URL" \
    --attribute-names ApproximateNumberOfMessages \
    --query 'Attributes.ApproximateNumberOfMessages' \
    --output text)
  if (( COUNT >= 1 )); then
    echo "DLQ test passed; visible messages: $COUNT"
    echo "After collecting evidence, purge only test data with:"
    echo "aws sqs purge-queue --region $REGION --queue-url $DLQ_URL"
    exit 0
  fi
  sleep 10
done

echo "The deliberate failure did not reach the DLQ in time" >&2
exit 1
