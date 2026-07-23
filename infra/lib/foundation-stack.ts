import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/** 账号中已经由 yy-workflow-phase2 创建的共享资源标识。 */
export interface FoundationStackProps extends cdk.StackProps {
  /** Aurora、私有 ALB、ECS 和 Lambda BFF 所在的 VPC。 */
  vpcId: string;
  /** 已有共享 ECR 仓库名称。 */
  repositoryName: string;
  /** 已有共享 ECS Cluster 名称。 */
  clusterName: string;
  /** 私有 ALB HTTP Listener ARN。 */
  listenerArn: string;
  /** 私有 ALB Security Group ID。 */
  albSecurityGroupId: string;
  /** ECS Task 共用的 Security Group ID。 */
  ecsSecurityGroupId: string;
  /** 已有 ECS Execution Role ARN。 */
  executionRoleArn: string;
  /** 包含 DATABASE_URL 字段的 Secrets Manager 完整 ARN。 */
  databaseSecretArn: string;
  /** 已有共享 CloudWatch Log Group 名称。 */
  logGroupName: string;
  /** 已有 API Gateway HTTP API ID。 */
  httpApiId: string;
  /** Lambda BFF 使用的现有 Security Group ID。 */
  bffSecurityGroupId: string;
  /** Lambda BFF 在 VPC 内调用的 internal ALB DNS。 */
  internalAlbDnsName: string;
  /** 记录在响应头中，并在变化时发布新的 Lambda Version。 */
  bffRelease: string;
  /** Synthetics 失败时 CodeDeploy 停止并回滚 BFF 灰度。 */
  rollbackAlarm?: cloudwatch.IAlarm;
}

/**
 * Foundation 不再创建收费的 ALB、ECR 或 ECS Cluster。
 * 它只导入 yy-workflow-phase2 的资源，并给现有 API Gateway 增加两个路由入口。
 */
export class FoundationStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly repository: ecr.IRepository;
  public readonly cluster: ecs.ICluster;
  public readonly httpListener: elbv2.IApplicationListener;
  public readonly ecsSecurityGroup: ec2.ISecurityGroup;
  public readonly executionRole: iam.IRole;
  public readonly databaseSecret: secretsmanager.ISecret;
  public readonly logGroup: logs.ILogGroup;
  public readonly publicApiEndpoint: string;

  /** 导入现有资源并建立当前项目专用的 API Gateway 路由。 */
  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    // fromLookup/fromXxx 不会创建或接管资源，只生成对既有资源的引用。
    this.vpc = ec2.Vpc.fromLookup(this, "ExistingVpc", { vpcId: props.vpcId });
    this.repository = ecr.Repository.fromRepositoryName(this, "ExistingRepository", props.repositoryName);

    const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ExistingAlbSecurityGroup",
      props.albSecurityGroupId,
      { mutable: false },
    );
    this.ecsSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ExistingEcsSecurityGroup",
      props.ecsSecurityGroupId,
      { mutable: false },
    );

    this.cluster = ecs.Cluster.fromClusterAttributes(this, "ExistingCluster", {
      clusterName: props.clusterName,
      vpc: this.vpc,
      securityGroups: [this.ecsSecurityGroup],
    });
    this.httpListener = elbv2.ApplicationListener.fromApplicationListenerAttributes(
      this,
      "ExistingHttpListener",
      {
        listenerArn: props.listenerArn,
        securityGroup: albSecurityGroup,
        defaultPort: 80,
      },
    );

    // 复用已有 Execution Role。它已经具备拉取共享 ECR、读取数据库
    // Secret 和写入共享日志组的权限，不把 CDK Bootstrap Role 当成 ECS Role。
    this.executionRole = iam.Role.fromRoleArn(this, "ExistingExecutionRole", props.executionRoleArn, {
      mutable: false,
    });
    this.databaseSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ExistingDatabaseSecret",
      props.databaseSecretArn,
    );
    this.logGroup = logs.LogGroup.fromLogGroupName(this, "ExistingLogGroup", props.logGroupName);

    // BFF SG 已经只允许向 internal ALB 的 80 端口出站。
    const bffSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ExistingBffSecurityGroup",
      props.bffSecurityGroupId,
      { mutable: false },
    );

    // 当前项目管理自己的 BFF Function/Version/live Alias。API Gateway 始终
    // 调用 live Alias，CodeDeploy 在新 Version 发布时执行 10%/5分钟灰度。
    // CDK 实现灰度的方式是创建 Deployment Group，指定 live Alias、灰度配置和告警：
    /**
     * 1. live Alias 当前指向旧 Version。
     * 2. 代码或 BFF_RELEASE 变化后发布新 Version。
     * 3. CodeDeploy 先把 10% 请求转给新 Version，观察 5 分钟。
     * 4. 无告警则切到 100%；有告警则回滚旧 Version。
     */
    const bffFunction = new lambda.Function(this, "CanaryBffFunction", {
      functionName: "yy-aws-setting-bff",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda/bff")),
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [bffSecurityGroup],
      environment: {
        PROFILE_GO_BASE_URL: `http://${props.internalAlbDnsName}`,
        BFF_RELEASE: props.bffRelease,
      },
      logGroup: new logs.LogGroup(this, "CanaryBffLogGroup", {
        logGroupName: "/aws/lambda/yy-aws-setting-bff",
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    const bffAlias = new lambda.Alias(this, "CanaryBffLiveAlias", {
      aliasName: "live",
      version: bffFunction.currentVersion,
      description: `Live BFF traffic for release ${props.bffRelease}`,
    });
    const bffErrorAlarm = new cloudwatch.Alarm(this, "CanaryBffErrorAlarm", {
      alarmName: "yy-aws-setting-bff-errors",
      alarmDescription: "The live BFF alias returned one or more Lambda invocation errors.",
      metric: bffAlias.metricErrors({ period: cdk.Duration.minutes(1), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new codedeploy.LambdaDeploymentGroup(this, "CanaryBffDeploymentGroup", {
      deploymentGroupName: "yy-aws-setting-bff-canary",
      alias: bffAlias,
      // 先切 10% 到新 Version，等待 5 分钟，再一次性切完剩余 90%。
      deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [bffErrorAlarm, ...(props.rollbackAlarm ? [props.rollbackAlarm] : [])],
      autoRollback: {
        failedDeployment: true,
        stoppedDeployment: true,
        deploymentInAlarm: true,
      },
    });

    // 导入现有 API Gateway，并把当前项目的 routes 更新为 live Alias。
    const httpApi = apigwv2.HttpApi.fromHttpApiAttributes(this, "ExistingHttpApi", {
      httpApiId: props.httpApiId,
      apiEndpoint: `https://${props.httpApiId}.execute-api.${this.region}.${this.urlSuffix}`,
    });
    const bffIntegration = new integrations.HttpLambdaIntegration("CanaryBffIntegration", bffAlias, {
      // 两条路由共用一个宽度受限于此 API 的 Lambda invoke permission。
      scopePermissionToRoute: false,
    });

    // Production 使用固定前缀；所有 Preview 共享第二条贪婪路由，具体分流由 ALB 完成。
    new apigwv2.HttpRoute(this, "ProductionProxyRoute", {
      httpApi,
      routeKey: apigwv2.HttpRouteKey.with("/yy-aws-setting/{proxy+}", apigwv2.HttpMethod.ANY),
      integration: bffIntegration,
    });
    new apigwv2.HttpRoute(this, "PreviewProxyRoute", {
      httpApi,
      routeKey: apigwv2.HttpRouteKey.with("/yy-aws-setting-preview/{proxy+}", apigwv2.HttpMethod.ANY),
      integration: bffIntegration,
    });

    this.publicApiEndpoint = `https://${props.httpApiId}.execute-api.${this.region}.${this.urlSuffix}`;
    new cdk.CfnOutput(this, "PublicApiEndpoint", { value: this.publicApiEndpoint });
    new cdk.CfnOutput(this, "ReusedRepositoryUri", { value: this.repository.repositoryUri });
    new cdk.CfnOutput(this, "ReusedClusterName", { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, "BffLiveAliasArn", { value: bffAlias.functionArn });
    new cdk.CfnOutput(this, "BffDeploymentConfig", { value: "Canary10Percent5Minutes" });
  }
}
