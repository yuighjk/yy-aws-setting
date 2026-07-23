#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ApplicationStack } from "../lib/application-stack";
import { FoundationStack } from "../lib/foundation-stack";
import { MessagingStack } from "../lib/messaging-stack";
import { MonitoringStack } from "../lib/monitoring-stack";

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT ?? "978184426686";
const region = process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1";
const env = { account, region };
const publicApiEndpoint = "https://96r1jv57ee.execute-api.ap-northeast-1.amazonaws.com";
const productionApiBaseUrl = `${publicApiEndpoint}/yy-aws-setting`;

/** 读取必须通过 `cdk deploy -c name=value` 提供的 context。 */
function requiredContext(name: string): string {
  const value = app.node.tryGetContext(name);
  if (!value || typeof value !== "string") {
    throw new Error(`Missing CDK context: -c ${name}=...`);
  }
  return value;
}

const messaging = new MessagingStack(app, "YyAwsSettingMessaging", {
  env,
  stackName: "YyAwsSettingMessaging",
});

// 当前教学账号把 Lambda 内存上限限制为 512 MiB，而新建 Synthetics
// Canary 至少需要 960 MiB。保留完整 IaC，通过显式 context 在限制解除后启用。
const enableSynthetics = app.node.tryGetContext("enableSynthetics") === "true";
const monitoring = enableSynthetics
  ? new MonitoringStack(app, "YyAwsSettingMonitoring", {
      env,
      stackName: "YyAwsSettingMonitoring",
      apiBaseUrl: productionApiBaseUrl,
      operationsAlertsTopic: messaging.operationsAlertsTopic,
    })
  : undefined;

// 这些标识来自已经部署完成的 yy-workflow-phase2-shared/service Stack。
// 当前 CDK 只导入并复用它们，不会新建或删除对应的 ALB、ECR、Cluster 和数据库 Secret；
// 当前项目自己的 BFF 则由 Foundation 创建，以便管理 Version/Alias 灰度。
const foundation = new FoundationStack(app, "YyAwsSettingFoundation", {
  env,
  stackName: "YyAwsSettingFoundation",
  vpcId: "vpc-06e535e0d55e64fdd",
  repositoryName: "yy-workflow/profile-go",
  clusterName: "yy-workflow-profile",
  listenerArn:
    "arn:aws:elasticloadbalancing:ap-northeast-1:978184426686:listener/app/yy-workflow-profile-internal/a3dc417cec298526/883c6a4e3c3effa4",
  albSecurityGroupId: "sg-0fc8190bd5b062036",
  ecsSecurityGroupId: "sg-0f57e1fb0873c2973",
  executionRoleArn: "arn:aws:iam::978184426686:role/yy-workflow-profile-ecs-execution",
  databaseSecretArn:
    "arn:aws:secretsmanager:ap-northeast-1:978184426686:secret:yy-workflow-phase2/profile-go/database-RLFvdw",
  logGroupName: "/ecs/yy-workflow/profile-go",
  httpApiId: "96r1jv57ee",
  bffSecurityGroupId: "sg-02f75ca82e714f476",
  internalAlbDnsName: "internal-yy-workflow-profile-internal-496861363.ap-northeast-1.elb.amazonaws.com",
  bffRelease: (app.node.tryGetContext("bffRelease") as string | undefined) ?? "v3",
  rollbackAlarm: monitoring?.availabilityAlarm,
});

// 不带 environment 时只部署 API Gateway 的共享路由；带值时再生成应用环境 Stack。
const targetEnvironment = app.node.tryGetContext("environment") as string | undefined;
if (targetEnvironment) {
  const imageTag = requiredContext("imageTag");
  const corsOrigins = (app.node.tryGetContext("corsOrigins") as string | undefined) ?? "";

  if (targetEnvironment === "production") {
    new ApplicationStack(app, "YyAwsSettingProduction", {
      env,
      stackName: "YyAwsSettingProduction",
      foundation,
      environmentName: "production",
      imageTag,
      listenerPriority: 100,
      pathPrefix: "/yy-aws-setting",
      corsOrigins,
      noteEventsTopic: messaging.noteEventsTopic,
    });
  } else if (targetEnvironment === "preview") {
    const previewName = requiredContext("previewName");
    const prNumber = Number(requiredContext("prNumber"));
    new ApplicationStack(app, `YyAwsSettingPr${prNumber}`, {
      env,
      stackName: `YyAwsSettingPr-${prNumber}`,
      foundation,
      environmentName: previewName,
      imageTag,
      listenerPriority: 1000 + (prNumber % 20000),
      pathPrefix: `/yy-aws-setting-preview/${previewName}`,
      corsOrigins,
      noteEventsTopic: messaging.noteEventsTopic,
    });
  } else {
    throw new Error(`Unsupported environment context: ${targetEnvironment}`);
  }
}

app.synth();
