import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";

export interface FoundationStackProps extends cdk.StackProps {
  vpcId: string;
  databaseSecurityGroupId: string;
  certificateArn: string;
}

export class FoundationStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly repository: ecr.Repository;
  public readonly cluster: ecs.Cluster;
  public readonly namespace: servicediscovery.PrivateDnsNamespace;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly httpsListener: elbv2.ApplicationListener;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    this.vpc = ec2.Vpc.fromLookup(this, "Vpc", { vpcId: props.vpcId });

    this.repository = new ecr.Repository(this, "Repository", {
      repositoryName: "yy-aws-setting",
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: false,
      lifecycleRules: [{ maxImageCount: 50, description: "Keep the newest 50 images" }],
    });

    this.cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: "yy-aws-setting",
      vpc: this.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    this.namespace = new servicediscovery.PrivateDnsNamespace(this, "Namespace", {
      name: "yy.internal",
      vpc: this.vpc,
      description: "Private service discovery for Go ECS services",
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      vpc: this.vpc,
      description: "Public HTTPS access to the application load balancer",
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP redirect");
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS from Cloudflare/users");

    this.ecsSecurityGroup = new ec2.SecurityGroup(this, "EcsSecurityGroup", {
      vpc: this.vpc,
      description: "Traffic accepted by Go Fargate tasks",
      allowAllOutbound: true,
    });

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, "LambdaSecurityGroup", {
      vpc: this.vpc,
      description: "Lambda calling ECS through Cloud Map private DNS",
      allowAllOutbound: true,
    });

    this.ecsSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(8080), "ALB to Go API");
    this.ecsSecurityGroup.addIngressRule(this.lambdaSecurityGroup, ec2.Port.tcp(8080), "Lambda to Go API");

    const databaseSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "DatabaseSecurityGroup",
      props.databaseSecurityGroupId,
      { mutable: true },
    );
    databaseSecurityGroup.addIngressRule(this.ecsSecurityGroup, ec2.Port.tcp(5432), "Go Fargate to Aurora PostgreSQL");

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      loadBalancerName: "yy-aws-setting",
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const certificate = acm.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn);
    this.httpsListener = this.loadBalancer.addListener("HttpsListener", {
      port: 443,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: "application/json",
        messageBody: '{"error":"unknown host"}',
      }),
    });
    this.loadBalancer.addRedirect({ sourcePort: 80, targetPort: 443 });

    new cdk.CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
    new cdk.CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, "LoadBalancerDnsName", { value: this.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, "CloudMapNamespace", { value: this.namespace.namespaceName });
  }
}
