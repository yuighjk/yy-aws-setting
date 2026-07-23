// Package messaging publishes durable business events to Amazon SNS.
package messaging

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	snsTypes "github.com/aws/aws-sdk-go-v2/service/sns/types"
)

// NoteCreatedEvent is the stable event contract sent after a note is stored.
type NoteCreatedEvent struct {
	EventID     string    `json:"eventId"`
	EventType   string    `json:"eventType"`
	NoteID      int64     `json:"noteId"`
	Content     string    `json:"content"`
	CreatedAt   time.Time `json:"createdAt"`
	Environment string    `json:"environment"`
}

// Publisher is deliberately small so the HTTP layer can be unit tested without AWS.
type Publisher interface {
	PublishNoteCreated(context.Context, NoteCreatedEvent) error
}

// NoopPublisher keeps local development usable when no SNS topic is configured.
type NoopPublisher struct{}

func (NoopPublisher) PublishNoteCreated(context.Context, NoteCreatedEvent) error { return nil }

// SNSAPI is the subset of the AWS client used by SNSPublisher.
type SNSAPI interface {
	Publish(context.Context, *sns.PublishInput, ...func(*sns.Options)) (*sns.PublishOutput, error)
}

// SNSPublisher serializes events and publishes them to one SNS topic.
type SNSPublisher struct {
	client   SNSAPI
	topicARN string
}

// New creates a publisher from the default AWS credential chain.
func New(ctx context.Context, topicARN string) (Publisher, error) {
	if strings.TrimSpace(topicARN) == "" {
		return NoopPublisher{}, nil
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load AWS config for SNS: %w", err)
	}
	return &SNSPublisher{client: sns.NewFromConfig(cfg), topicARN: topicARN}, nil
}

// PublishNoteCreated sends one JSON message. SNS/SQS delivery is at least once,
// so consumers must use EventID for idempotency when side effects are added.
func (p *SNSPublisher) PublishNoteCreated(ctx context.Context, event NoteCreatedEvent) error {
	body, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal note event: %w", err)
	}
	_, err = p.client.Publish(ctx, &sns.PublishInput{
		TopicArn: aws.String(p.topicARN),
		Message:  aws.String(string(body)),
		MessageAttributes: map[string]snsTypesMessageAttributeValue{
			"eventType": {DataType: aws.String("String"), StringValue: aws.String(event.EventType)},
		},
	})
	if err != nil {
		return fmt.Errorf("publish note event: %w", err)
	}
	return nil
}

// This alias keeps the public method above readable while matching the AWS SDK type.
type snsTypesMessageAttributeValue = snsTypes.MessageAttributeValue
