package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/sns"
)

type fakeSNS struct {
	input *sns.PublishInput
	err   error
}

func (f *fakeSNS) Publish(_ context.Context, input *sns.PublishInput, _ ...func(*sns.Options)) (*sns.PublishOutput, error) {
	f.input = input
	return &sns.PublishOutput{}, f.err
}

func TestSNSPublisherPublishesJSONEvent(t *testing.T) {
	client := &fakeSNS{}
	publisher := &SNSPublisher{client: client, topicARN: "arn:aws:sns:ap-northeast-1:123456789012:notes"}
	event := NoteCreatedEvent{
		EventID:     "event-1",
		EventType:   "NoteCreated",
		NoteID:      42,
		Content:     "hello",
		CreatedAt:   time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC),
		Environment: "test",
	}

	if err := publisher.PublishNoteCreated(context.Background(), event); err != nil {
		t.Fatalf("PublishNoteCreated returned error: %v", err)
	}
	if client.input == nil || client.input.TopicArn == nil || *client.input.TopicArn != publisher.topicARN {
		t.Fatal("SNS publish input did not contain the configured topic ARN")
	}
	var body NoteCreatedEvent
	if err := json.Unmarshal([]byte(*client.input.Message), &body); err != nil {
		t.Fatalf("decode published event: %v", err)
	}
	if body.EventID != event.EventID || body.NoteID != event.NoteID || body.Environment != event.Environment {
		t.Fatalf("published event = %#v, want %#v", body, event)
	}
}

func TestSNSPublisherWrapsClientError(t *testing.T) {
	publisher := &SNSPublisher{client: &fakeSNS{err: errors.New("unavailable")}, topicARN: "topic"}
	err := publisher.PublishNoteCreated(context.Background(), NoteCreatedEvent{EventType: "NoteCreated"})
	if err == nil {
		t.Fatal("expected publish error")
	}
}

func TestNewWithoutTopicUsesNoopPublisher(t *testing.T) {
	publisher, err := New(context.Background(), "")
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	if err := publisher.PublishNoteCreated(context.Background(), NoteCreatedEvent{}); err != nil {
		t.Fatalf("noop publisher returned error: %v", err)
	}
}
