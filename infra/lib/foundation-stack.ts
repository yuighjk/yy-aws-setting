import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
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
  /** 已有 ECS Task Role ARN。 */
  taskRoleArn: string;
  /** 已有 ECS Execution Role ARN。 */
  executionRoleArn: string;
  /** 包含 DATABASE_URL 字段的 Secrets Manager 完整 ARN。 */
  databaseSecretArn: string;
  /** 已有共享 CloudWatch Log Group 名称。 */
  logGroupName: string;
  /** 已有 API Gateway HTTP API ID。 */
  httpApiId: string;
  /** 已有 Lambda BFF ARN。 */
  bffFunctionArn: string;
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
  public readonly taskRole: iam.IRole;
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

    // 复用已有 Task/Execution Role。它们已经具备拉取共享 ECR、读取数据库
    // Secret 和写入共享日志组的权限，不把 CDK Bootstrap Role 当成 ECS Role。
    this.taskRole = iam.Role.fromRoleArn(this, "ExistingTaskRole", props.taskRoleArn, { mutable: false });
    this.executionRole = iam.Role.fromRoleArn(this, "ExistingExecutionRole", props.executionRoleArn, {
      mutable: false,
    });
    this.databaseSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ExistingDatabaseSecret",
      props.databaseSecretArn,
    );
    this.logGroup = logs.LogGroup.fromLogGroupName(this, "ExistingLogGroup", props.logGroupName);

    // 导入现有 API Gateway 与 Lambda BFF。BFF 会把原始路径转发到私有 ALB。
    const httpApi = apigwv2.HttpApi.fromHttpApiAttributes(this, "ExistingHttpApi", {
      httpApiId: props.httpApiId,
      apiEndpoint: `https://${props.httpApiId}.execute-api.${this.region}.${this.urlSuffix}`,
    });
    const bffFunction = lambda.Function.fromFunctionAttributes(this, "ExistingBffFunction", {
      functionArn: props.bffFunctionArn,
      sameEnvironment: true,
    });
    const bffIntegration = new integrations.HttpLambdaIntegration("ExistingBffIntegration", bffFunction, {
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
  }
}
