import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as synthetics from "aws-cdk-lib/aws-synthetics";
import { Construct } from "constructs";

export interface MonitoringStackProps extends cdk.StackProps {
  apiBaseUrl: string;
  operationsAlertsTopic: sns.ITopic;
}

/** Production API patrol and the alarm consumed by CodeDeploy auto rollback. */
// 每 5 分钟巡检生产 /health 与 /api/notes，Alarm 同时用于告警和灰度回滚。
export class MonitoringStack extends cdk.Stack {
  public readonly availabilityAlarm: cloudwatch.Alarm;
  public readonly apiCanary: synthetics.Canary;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const artifactsBucket = new s3.Bucket(this, "CanaryArtifactsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });
    // canaryScript 是巡检测试内容：发两个 GET、检查 200、database 状态和 notes 类型。
    // 网页创建同样要选择 Blueprint 并填写 URL/脚本；CDK 把请求、超时和断言显式保存。
    const canaryScript = `
const https = require("https");

function getJSON(baseUrl, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    const request = https.get(url, { headers: { "user-agent": "yy-aws-setting-synthetics" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode !== 200) {
          reject(new Error(path + " returned " + response.statusCode + ": " + body));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(path + " returned invalid JSON: " + error.message));
        }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error(path + " timed out")));
    request.on("error", reject);
  });
}

exports.handler = async () => {
  const baseUrl = process.env.API_BASE_URL;
  const health = await getJSON(baseUrl, "health");
  if (health.status !== "ok" || health.database !== "connected") {
    throw new Error("health assertion failed: " + JSON.stringify(health));
  }
  const notes = await getJSON(baseUrl, "api/notes");
  if (!Array.isArray(notes)) {
    throw new Error("notes response is not an array");
  }
  console.log("production patrol passed", { database: health.database, noteCount: notes.length });
};
`;

    this.apiCanary = new synthetics.Canary(this, "ProductionApiCanary", {
      canaryName: "yy-aws-setting-api",
      // AWS now requires at least 960 MiB for new canaries. The browserless
      // syn-nodejs runtimes still cap their backing Lambda at 512 MiB, so use
      // the current Puppeteer runtime even though this patrol only calls APIs.
      runtime: new synthetics.Runtime("syn-nodejs-puppeteer-16.1", synthetics.RuntimeFamily.NODEJS),
      test: synthetics.Test.custom({
        code: synthetics.Code.fromInline(canaryScript),
        handler: "index.handler",
      }),
      environmentVariables: { API_BASE_URL: props.apiBaseUrl },
      schedule: synthetics.Schedule.rate(cdk.Duration.minutes(5)),
      timeout: cdk.Duration.minutes(1),
      memory: cdk.Size.mebibytes(960),
      startAfterCreation: true,
      successRetentionPeriod: cdk.Duration.days(7),
      failureRetentionPeriod: cdk.Duration.days(14),
      artifactsBucketLocation: { bucket: artifactsBucket, prefix: "api-patrol" },
      provisionedResourceCleanup: true,
    });

    this.availabilityAlarm = new cloudwatch.Alarm(this, "ApiAvailabilityAlarm", {
      alarmName: "yy-aws-setting-api-canary-failed",
      alarmDescription: "Production API patrol failed; CodeDeploy must stop or roll back the BFF canary.",
      metric: this.apiCanary.metricSuccessPercent({
        period: cdk.Duration.minutes(5),
        statistic: "Average",
      }),
      threshold: 100,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.availabilityAlarm.addAlarmAction(new actions.SnsAction(props.operationsAlertsTopic));

    new cdk.CfnOutput(this, "CanaryName", { value: this.apiCanary.canaryName });
    new cdk.CfnOutput(this, "AvailabilityAlarmName", { value: this.availabilityAlarm.alarmName });
    new cdk.CfnOutput(this, "CanaryArtifactsBucketName", { value: artifactsBucket.bucketName });
  }
}
