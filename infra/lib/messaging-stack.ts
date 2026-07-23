import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as eventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

/** Shared asynchronous messaging resources used by production and previews. */
export class MessagingStack extends cdk.Stack {
  public readonly noteEventsTopic: sns.Topic;
  public readonly operationsAlertsTopic: sns.Topic;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly deadLetterAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.operationsAlertsTopic = new sns.Topic(this, "OperationsAlertsTopic", {
      topicName: "yy-aws-setting-operations-alerts",
      displayName: "yy-aws-setting operational alarms",
    });

    // 死信队列
    this.deadLetterQueue = new sqs.Queue(this, "NoteEventsDeadLetterQueue", {
      queueName: "yy-aws-setting-note-events-dlq",
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    const noteEventsQueue = new sqs.Queue(this, "NoteEventsQueue", {
      queueName: "yy-aws-setting-note-events",
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3, //失败3次后消息进入死信队列
      },
    });

    //SNS → SQS Subscription
    this.noteEventsTopic = new sns.Topic(this, "NoteEventsTopic", {
      topicName: "yy-aws-setting-note-events",
      displayName: "NoteCreated business events",
    });
    this.noteEventsTopic.addSubscription(
      new subscriptions.SqsSubscription(noteEventsQueue, { rawMessageDelivery: true }),
    );

    // SQS → Lambda Event Source Mapping，创建lambda函数消费SQS消息
    const consumer = new lambda.Function(this, "NoteEventsConsumer", {
      functionName: "yy-aws-setting-note-events-consumer",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/note-consumer")),
      // Queue visibility is 30 seconds, six times this Lambda timeout.
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      logGroup: new logs.LogGroup(this, "NoteEventsConsumerLogGroup", {
        logGroupName: "/aws/lambda/yy-aws-setting-note-events-consumer",
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    consumer.addEventSource(
      new eventSources.SqsEventSource(noteEventsQueue, {
        batchSize: 5,
        maxConcurrency: 2,
        reportBatchItemFailures: true,
      }),
    );

    //DLQ 消息数量 CloudWatch Alarm 告警
    this.deadLetterAlarm = new cloudwatch.Alarm(this, "DeadLetterQueueAlarm", {
      alarmName: "yy-aws-setting-dlq-has-messages",
      alarmDescription: "A NoteCreated event failed three consumer attempts and reached the DLQ.",
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: "Maximum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.deadLetterAlarm.addAlarmAction(new actions.SnsAction(this.operationsAlertsTopic));

    new cdk.CfnOutput(this, "NoteEventsTopicArn", { value: this.noteEventsTopic.topicArn });
    new cdk.CfnOutput(this, "NoteEventsQueueUrl", { value: noteEventsQueue.queueUrl });
    new cdk.CfnOutput(this, "DeadLetterQueueUrl", { value: this.deadLetterQueue.queueUrl });
    new cdk.CfnOutput(this, "OperationsAlertsTopicArn", { value: this.operationsAlertsTopic.topicArn });
  }
}
