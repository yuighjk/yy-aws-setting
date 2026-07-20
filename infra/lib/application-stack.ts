import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";
import { FoundationStack } from "./foundation-stack";

export interface ApplicationStackProps extends cdk.StackProps {
  foundation: FoundationStack;
  environmentName: string;
  hostname: string;
  imageTag: string;
  listenerPriority: number;
  databaseSecretName: string;
  corsOrigins: string;
}

export class ApplicationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    if (!/^[a-z][a-z0-9-]{0,39}$/.test(props.environmentName)) {
      throw new Error(`Invalid environmentName: ${props.environmentName}`);
    }
    if (props.listenerPriority < 1 || props.listenerPriority > 49998) {
      throw new Error(`Invalid ALB listener priority: ${props.listenerPriority}`);
    }

    const discoveryName = `api-${props.environmentName}`;
    const databaseSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "DatabaseSecret",
      props.databaseSecretName,
    );

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDefinition", {
      family: `yy-aws-setting-${props.environmentName}`,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDefinition.addContainer("app", {
      containerName: "app",
      image: ecs.ContainerImage.fromEcrRepository(props.foundation.repository, props.imageTag),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: props.environmentName,
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        PORT: "8080",
        AUTO_MIGRATE: "false",
        GITHUB_USERNAME: "yuighjk",
        DB_SSLMODE: "verify-full",
        DB_SSLROOTCERT: "/app/global-bundle.pem",
        CORS_ALLOWED_ORIGINS: props.corsOrigins,
      },
      secrets: {
        RDSHOST: ecs.Secret.fromSecretsManager(databaseSecret, "host"),
        DB_PORT: ecs.Secret.fromSecretsManager(databaseSecret, "port"),
        DB_NAME: ecs.Secret.fromSecretsManager(databaseSecret, "dbname"),
        DB_USER: ecs.Secret.fromSecretsManager(databaseSecret, "username"),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, "password"),
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

    const service = new ecs.FargateService(this, "Service", {
      serviceName: `yy-aws-setting-${props.environmentName}`,
      cluster: props.foundation.cluster,
      taskDefinition,
      desiredCount: 1,
      // Existing private subnets use a NAT Gateway, so tasks can pull ECR images
      // without receiving public IP addresses.
      assignPublicIp: false,
      securityGroups: [props.foundation.ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      cloudMapOptions: {
        cloudMapNamespace: props.foundation.namespace,
        name: discoveryName,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10),
      },
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

    const lambdaFunction = new lambda.Function(this, "CloudMapLambda", {
      functionName: `yy-cloudmap-${props.environmentName}`,
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: "bootstrap",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../dist/lambda")),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      vpc: props.foundation.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.foundation.lambdaSecurityGroup],
      environment: {
        SERVICE_URL: `http://${discoveryName}.${props.foundation.namespace.namespaceName}:8080`,
      },
      logGroup: new logs.LogGroup(this, "LambdaLogGroup", {
        logGroupName: `/aws/lambda/yy-cloudmap-${props.environmentName}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    const lambdaTargetGroup = new elbv2.ApplicationTargetGroup(this, "LambdaTargetGroup", {
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new targets.LambdaTarget(lambdaFunction)],
    });

    new elbv2.ApplicationListenerRule(this, "LambdaRule", {
      listener: props.foundation.httpsListener,
      priority: props.listenerPriority,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([props.hostname]),
        elbv2.ListenerCondition.pathPatterns(["/lambda", "/lambda/*"]),
      ],
      action: elbv2.ListenerAction.forward([lambdaTargetGroup]),
    });

    new elbv2.ApplicationListenerRule(this, "ApiRule", {
      listener: props.foundation.httpsListener,
      priority: props.listenerPriority + 1,
      conditions: [elbv2.ListenerCondition.hostHeaders([props.hostname])],
      action: elbv2.ListenerAction.forward([apiTargetGroup]),
    });

    new cdk.CfnOutput(this, "PreviewUrl", { value: `https://${props.hostname}` });
    new cdk.CfnOutput(this, "ClusterName", { value: props.foundation.cluster.clusterName });
    new cdk.CfnOutput(this, "ServiceName", { value: service.serviceName });
    new cdk.CfnOutput(this, "TaskDefinitionArn", { value: taskDefinition.taskDefinitionArn });
    new cdk.CfnOutput(this, "CloudMapService", {
      value: `${discoveryName}.${props.foundation.namespace.namespaceName}`,
    });
  }
}
