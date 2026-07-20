// Command lambda is invoked by the ALB /lambda/* target group. It proves that
// Lambda can discover the private ECS service through AWS Cloud Map DNS.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
)

var client = &http.Client{Timeout: 5 * time.Second}

func handler(ctx context.Context, _ events.ALBTargetGroupRequest) (events.ALBTargetGroupResponse, error) {
	serviceURL := strings.TrimRight(os.Getenv("SERVICE_URL"), "/")
	if serviceURL == "" {
		return albJSON(http.StatusInternalServerError, map[string]string{"error": "SERVICE_URL is not configured"})
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, serviceURL+"/health", nil)
	if err != nil {
		return albJSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	resp, err := client.Do(req)
	if err != nil {
		return albJSON(http.StatusBadGateway, map[string]string{"error": fmt.Sprintf("Cloud Map service call failed: %v", err)})
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return albJSON(http.StatusBadGateway, map[string]string{"error": "failed to read ECS response"})
	}
	return albJSON(http.StatusOK, map[string]any{
		"message":         "Lambda reached ECS through Cloud Map",
		"serviceURL":      serviceURL,
		"serviceStatus":   resp.StatusCode,
		"serviceResponse": json.RawMessage(body),
	})
}

func albJSON(status int, value any) (events.ALBTargetGroupResponse, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return events.ALBTargetGroupResponse{}, err
	}
	return events.ALBTargetGroupResponse{
		StatusCode:        status,
		StatusDescription: fmt.Sprintf("%d %s", status, http.StatusText(status)),
		Headers:           map[string]string{"Content-Type": "application/json; charset=utf-8"},
		Body:              string(body),
		IsBase64Encoded:   false,
	}, nil
}

func main() {
	lambda.Start(handler)
}
