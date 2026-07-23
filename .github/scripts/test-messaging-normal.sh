#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
TOPIC_ARN="${NOTE_EVENTS_TOPIC_ARN:-arn:aws:sns:${REGION}:978184426686:yy-aws-setting-note-events}"
LOG_GROUP="/aws/lambda/yy-aws-setting-note-events-consumer"
EVENT_ID="homework-normal-$(date +%s)"

MESSAGE=$(jq -cn \
  --arg eventId "$EVENT_ID" \
  '{eventId: $eventId, eventType: "NoteCreated", noteId: 9001, environment: "integration-test"}')

aws sns publish --region "$REGION" --topic-arn "$TOPIC_ARN" --message "$MESSAGE" >/dev/null
echo "Published $EVENT_ID; waiting for the SQS consumer..."

for _ in {1..12}; do
  MATCH_COUNT=$(aws logs filter-log-events \
    --region "$REGION" \
    --log-group-name "$LOG_GROUP" \
    --filter-pattern "\"$EVENT_ID\"" \
    --no-paginate \
    --query 'length(events)' \
    --output text)
  if (( MATCH_COUNT > 0 )); then
    aws logs filter-log-events \
      --region "$REGION" \
      --log-group-name "$LOG_GROUP" \
      --filter-pattern "\"$EVENT_ID\"" \
      --no-paginate \
      --query 'events[].message' \
      --output text
    echo "SNS -> SQS -> Lambda test passed"
    exit 0
  fi
  sleep 5
done

echo "No consumer log found for $EVENT_ID" >&2
exit 1
