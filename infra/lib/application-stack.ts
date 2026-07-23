import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { FoundationStack } from "./foundation-stack";

/** 每个部署环境（production 或一个 PR Preview）需要的参数。 */
export interface ApplicationStackProps extends cdk.StackProps {
  /** 导入了 yy-workflow-phase2 共享资源的 Foundation。 */
  foundation: FoundationStack;
  /** 资源名后缀，例如 production 或 junigo-928。 */
  environmentName: string;
  /** 当前提交推送到共享 ECR 后使用的镜像 Tag。 */
  imageTag: string;
  /** 当前环境在共享 ALB HTTP Listener 中的规则优先级。 */
  listenerPriority: number;
  /** API Gateway 到当前环境的独立路径前缀。 */
  pathPrefix: string;
  /** 后端仍保留自身 CORS 白名单；现有 API Gateway 也会添加 CORS 响应。 */
  corsOrigins: string;
  /** Shared business event topic; each app task may only publish to this topic. */
  noteEventsTopic: sns.ITopic;
}

/** 创建当前环境独享的 Task Definition、ECS Service、Target Group 和 ALB Rule。 */
export class ApplicationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    if (!/^[a-z][a-z0-9-]{0,39}$/.test(props.environmentName)) {
      throw new Error(`Invalid environmentName: ${props.environmentName}`);
    }
    if (!/^\/[a-z0-9/-]+$/.test(props.pathPrefix)) {
      throw new Error(`Invalid pathPrefix: ${props.pathPrefix}`);
    }
    if (props.listenerPriority < 1 || props.listenerPriority >= 49999) {
      throw new Error(`Invalid ALB listener priority: ${props.listenerPriority}`);
    }

    // The application gets its own least-privilege Task Role. The existing
    // Execution Role is still reused for ECR, Secret and CloudWatch Logs.
    const taskRole = new iam.Role(this, "ApplicationTaskRole", {
      roleName: `yy-aws-setting-${props.environmentName}-task`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `Task permissions for yy-aws-setting ${props.environmentName}`,
    });
    props.noteEventsTopic.grantPublish(taskRole);

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      family: `yy-aws-setting-${props.environmentName}`,
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      executionRole: props.foundation.executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDefinition.addContainer("app", {
      containerName: "app",
      image: ecs.ContainerImage.fromEcrRepository(props.foundation.repository, props.imageTag),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `yy-aws-setting-${props.environmentName}`,
        logGroup: props.foundation.logGroup,
      }),
      environment: {
        PORT: "8080",
        AUTO_MIGRATE: "false",
        GITHUB_USERNAME: "yuighjk",
        ENVIRONMENT_NAME: props.environmentName,
        NOTE_EVENTS_TOPIC_ARN: props.noteEventsTopic.topicArn,
        DB_SSLMODE: "verify-full",
        DB_SSLROOTCERT: "/app/global-bundle.pem",
        CORS_ALLOWED_ORIGINS: props.corsOrigins,
      },
      // 现有 Secret 使用 DATABASE_URL 单字段，本项目直接复用，不复制数据库密码。
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(props.foundation.databaseSecret, "DATABASE_URL"),
      },
      healthCheck: {
        command: ["CMD-SHELL", "wget -q -O - http://127.0.0.1:8080/health >/dev/null || exit 1"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(15),
      },
    });
    container.addPortMappings({ containerPort: 8080, protocol: ecs.Protocol.TCP });

    // Task 和原 profile-go 一样放在两条带 NAT 的私有子网，没有公网 IP。
    const service = new ecs.FargateService(this, "Service", {
      serviceName: `yy-aws-setting-${props.environmentName}`,
      cluster: props.foundation.cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [props.foundation.ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
    });

    const apiTargetGroup = new elbv2.ApplicationTargetGroup(this, "ApiTargetGroup", {
      vpc: props.foundation.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(20),
      healthCheck: {
        path: "/health",
        healthyHttpCodes: "200",
        interval: cdk.Duration.seconds(30),
      },
    });
    apiTargetGroup.addTarget(service);

    // BFF 会把 /yy-aws-setting/... 原样传入 ALB。这个 Rule 先按前缀分流，
    // 再用 URL rewrite 去掉前缀，使 Go 服务仍接收 /api/notes、/health 等原始路由。
    new elbv2.CfnListenerRule(this, "ApiRule", {
      listenerArn: props.foundation.httpListener.listenerArn,
      priority: props.listenerPriority,
      conditions: [
        {
          field: "path-pattern",
          pathPatternConfig: { values: [`${props.pathPrefix}/*`] },
        },
      ],
      transforms: [
        {
          type: "url-rewrite",
          urlRewriteConfig: {
            rewrites: [{ regex: `^${props.pathPrefix}/(.*)$`, replace: "/$1" }],
          },
        },
      ],
      actions: [{ type: "forward", targetGroupArn: apiTargetGroup.targetGroupArn }],
    });

    const publicApiBaseUrl = `${props.foundation.publicApiEndpoint}${props.pathPrefix}`;
    new cdk.CfnOutput(this, "ApiBaseUrl", { value: publicApiBaseUrl });
    new cdk.CfnOutput(this, "ClusterName", { value: props.foundation.cluster.clusterName });
    new cdk.CfnOutput(this, "ServiceName", { value: service.serviceName });
    new cdk.CfnOutput(this, "TaskDefinitionArn", { value: taskDefinition.taskDefinitionArn });
  }
}
