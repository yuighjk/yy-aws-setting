#!/usr/bin/env bash
set -euo pipefail

CLUSTER_NAME="${1:?cluster name is required}"
SERVICE_NAME="${2:?service name is required}"

TASK_DEFINITION=$(aws ecs describe-services \
  --cluster "$CLUSTER_NAME" \
  --services "$SERVICE_NAME" \
  --query 'services[0].taskDefinition' \
  --output text)

AWSPVC_CONFIGURATION=$(aws ecs describe-services \
  --cluster "$CLUSTER_NAME" \
  --services "$SERVICE_NAME" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' \
  --output json)

NETWORK_CONFIGURATION=$(jq -cn \
  --argjson awsvpc "$AWSPVC_CONFIGURATION" \
  '{awsvpcConfiguration: $awsvpc}')

OVERRIDES='{"containerOverrides":[{"name":"app","command":["/app/migrate"]}]}'

RUN_RESULT=$(aws ecs run-task \
  --cluster "$CLUSTER_NAME" \
  --task-definition "$TASK_DEFINITION" \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIGURATION" \
  --overrides "$OVERRIDES")

FAILURE_COUNT=$(jq '.failures | length' <<<"$RUN_RESULT")
if [[ "$FAILURE_COUNT" != "0" ]]; then
  jq '.failures' <<<"$RUN_RESULT"
  exit 1
fi

TASK_ARN=$(jq -r '.tasks[0].taskArn' <<<"$RUN_RESULT")
echo "Waiting for migration task: $TASK_ARN"
aws ecs wait tasks-stopped --cluster "$CLUSTER_NAME" --tasks "$TASK_ARN"

TASK_RESULT=$(aws ecs describe-tasks --cluster "$CLUSTER_NAME" --tasks "$TASK_ARN")
EXIT_CODE=$(jq -r '.tasks[0].containers[] | select(.name == "app") | .exitCode' <<<"$TASK_RESULT")
STOPPED_REASON=$(jq -r '.tasks[0].stoppedReason // "unknown"' <<<"$TASK_RESULT")

echo "Migration task stopped: $STOPPED_REASON"
if [[ "$EXIT_CODE" != "0" ]]; then
  echo "Migration failed with exit code $EXIT_CODE"
  exit 1
fi

echo "Migration completed successfully"
