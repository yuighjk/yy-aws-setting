# AWS 控制台、CDK 与 GitHub Actions 配置指南

本项目不使用 CodeBuild。构建和部署由 GitHub Actions 完成，AWS CDK 创建基础设施，AWS 控制台主要用于第一次建立信任、证书、数据库密码以及查看部署结果。

本地浏览器 → API Gateway → Lambda BFF → 私有 ALB → ECS → Aurora

> 不要同时用控制台和 CDK 创建同名资源。推荐按本文的“CDK 方式”执行；“控制台手动方式”用于理解每个资源的对应配置。

## 1. 当前环境与目标架构

只读检查确认当前数据库为：

| 项目 | 当前值 |
|---|---|
| AWS 账号 | `978184426686` |
| Region | `ap-northeast-1`（东京） |
| 数据库 | `database-workflow-instance-1` |
| Engine | Aurora PostgreSQL |
| VPC | `vpc-06e535e0d55e64fdd` |
| 数据库安全组 | `sg-0fa1f22a2b4e37550` |
| VPC 类型 | Default VPC，`172.31.0.0/16`；已有两条私有子网和 NAT Gateway |

当前 AWS CLI 使用的是 root 身份。不要把 root Access Key 放入 GitHub，也不建议日常继续使用。先在 IAM Identity Center 或 IAM 中创建管理员身份，确认能登录后删除 root Access Key，只保留 root MFA 和紧急使用方式。

部署后的流量：

```text
Cloudflare
   │ HTTPS
   ▼
AWS ALB
   ├─ host=api.example.com ─────────────► Go ECS Fargate
   ├─ host=<branch>.preview.example.com ► PR Fargate Service
   └─ /lambda/* ────────────────────────► Go Lambda
                                               │
                                               ▼
                                      Cloud Map private DNS
                                               │
                                               ▼
                                           Go ECS API

Go ECS ──TCP 5432/TLS──► Aurora PostgreSQL
```

东京 `ap-northeast-1` 属于标准 AWS 分区，不是 `cn-north-1`/`cn-northwest-1` 中国分区。本项目仍按“不使用 CodeBuild”的要求全部使用 GitHub Actions。

## 2. 首次安全配置

### 2.1 为管理员启用 MFA，就是手机上Anth软件输入6位验证码的

AWS Console → 右上角账号 → Security credentials：

1. 给 root 用户启用 MFA。
2. 创建 IAM Identity Center 管理员用户，或一个仅供初始化 CDK 的 IAM 管理员。
3. 用新管理员登录并验证权限。
4. 删除本机正在使用的 root Access Key。

### 2.2 Bootstrap CDK

用非 root 管理员凭证在本机执行一次：

```bash
cd infra
npm ci
npx cdk bootstrap aws://978184426686/ap-northeast-1
```
cdk-hnb659fds-cfn-exec-role
cdk-hnb659fds-deploy-role
cdk-hnb659fds-file-publishing-role
cdk-hnb659fds-image-publishing-role
cdk-hnb659fds-lookup-role
说明 cdk bootstrap 成功。它们是 CDK 的“施工工具”，不是你的应用资源，也不是 ECS Task Role。

输入命令后，Bootstrap 会自动创建 CDK 部署角色、CloudFormation 执行角色、查询角色、文件/镜像发布角色，以及资产 S3 Bucket 和 ECR 仓库。它们由 CDK CLI 自动使用，不是 ECS Task Role。

官方说明：[Bootstrapping AWS CDK environments](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)

## 3. Secrets Manager 配置数据库密码，数据库在创建时候就配置好了。

AWS Console → Secrets Manager → Store a new secret：

1. Secret type：`Other type of secret`。
2. 添加以下 JSON 字段：

```json
{
  "host": "database-workflow-instance-1.c5240eqqsji3.ap-northeast-1.rds.amazonaws.com",
  "port": "5432",
  "dbname": "postgres",
  "username": "postgres",
  "password": "你的数据库密码"
}
```

3. Secret name：`yy-aws-setting/database`。
4. Encryption key：先使用 `aws/secretsmanager`。
5. Rotation：作业阶段可以暂不开启。

ECS Task Definition 只保存 Secret 引用，不会把密码明文写入 GitHub 或 CDK 文件。

## 4. ACM HTTPS 证书与 Cloudflare

确定真实域名后，AWS Console → Certificate Manager，Region 必须选择东京：

1. Request certificate → Public certificate。
2. 添加：
   - `api.yourdomain.com`
   - `*.preview.yourdomain.com`
3. Validation method：DNS validation。只有非AWS才启动导出。
4. 在 Cloudflare DNS 中添加 ACM 给出的 CNAME 验证记录。
5. 验证 CNAME 设置为 DNS only，等待 ACM 状态变成 Issued。
6. 复制 Certificate ARN，稍后填写 GitHub Variable `ACM_CERTIFICATE_ARN`。

CDK 创建 ALB 后，在 CloudFormation `YyAwsSettingFoundation` Outputs 中复制 `LoadBalancerDnsName`，再到 Cloudflare 添加：

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `api` | ALB DNS | Proxied |
| CNAME | `*.preview` | ALB DNS | Proxied |

Cloudflare SSL/TLS mode 设为 `Full (strict)`。

## 5. GitHub Actions：使用 Access Key 部署

本项目按当前作业配置使用 IAM 用户的长期 Access Key，不配置 GitHub OIDC。请在 GitHub Actions **Secrets**（不是 Variables）中同时创建：

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

两项缺一不可。不要使用 root Access Key；应创建只供本仓库部署的 IAM 用户，并按实际 CDK 资源收敛权限。泄露或作业结束后立即停用并轮换密钥。

## 6. GitHub 网页设置

GitHub Repository → Settings → Environments，创建：

- `preview`
- `production`

可以给 `production` 添加 Required reviewers，避免 main 每次推送未经确认直接上线。

Settings → Secrets and variables → Actions → Variables，添加：

| Variable | Value |
|---|---|
| `AWS_REGION` | `ap-northeast-1` |
| `VPC_ID` | `vpc-06e535e0d55e64fdd` |
| `DB_SECURITY_GROUP_ID` | `sg-0fa1f22a2b4e37550` |
| `DB_SECRET_NAME` | `yy-aws-setting/database` |
| `ACM_CERTIFICATE_ARN` | ACM 证书 ARN |
| `BASE_DOMAIN` | 真实根域名，例如 `example.com` |
| `CORS_ALLOWED_ORIGINS` | Cloudflare Pages 地址，例如 `https://project.pages.dev` |

这些值没有数据库密码，因此使用 Variables 即可。数据库密码只存在 Secrets Manager。

Settings → Branches/Rulesets → main：

1. Require a pull request before merging。
2. Require status checks to pass。
3. 选择 `Jira Guard`、`DB Guard` 和 Go 测试相关检查。
4. Require branches to be up to date。
5. 不允许直接 push main。

## 7. Jira Guard 和 PR 域名

工作流文件：`.github/workflows/deploy-pr-preview.yml`。

允许的分支名：

```text
JUNIGO-928
JUNIGO-928-add-profile-api
ABC-12-fix-timeout
```

拒绝：

```text
feature/test
junigo-928
JUNIGO_928
JUNIGO-abc
```

正则：

```regex
^[A-Z][A-Z0-9]+-[0-9]+(-[a-z0-9]+(-[a-z0-9]+)*)?$
```

分支名必须不超过 40 字符。通过后转为小写域名：

```text
JUNIGO-928-add-profile-api
    ↓
junigo-928-add-profile-api.preview.example.com
```

Cloudflare 使用一个 `*.preview.example.com` 通配符记录，不需要每个 PR 调用 Cloudflare API。

## 8. DB Guard 与迁移,就是把数据库迁到Aurora database上

DB Guard 比较 PR base/head commit。如果修改路径匹配下面任一规则，就输出 `migration_changed=true`：

```text
**/migration/**
**/migrations/**
**/schema/**
**/*.sql（位于 migration/schema 规则或 schema.sql）
```

当前迁移目录：

```text
internal/database/migrations/
```

Go Web 容器在 ECS 中设置 `AUTO_MIGRATE=false`，不会每次启动都擅自改数据库。

检测到迁移时，Actions 会：

1. 构建同时包含 `/app/server` 和 `/app/migrate` 的镜像。
2. 部署/更新 PR ECS Service。
3. 读取该 Service 的 Task Definition 和网络配置。
4. 用相同镜像启动一次性 Fargate Task，命令覆盖为 `/app/migrate`。
5. 等待 Task 停止并检查 exit code。
6. exit code 非 0 时整个 DB Guard/部署失败，PR 不能合并。

这里只做向前迁移，不会在 PR 关闭时自动回滚共享数据库。正式项目的 migration 必须设计为向后兼容。

## 9. Actions 工作流

### PR 创建或更新

```text
Jira Guard ─┐
            ├─► Prepare preview ─► Build/Push ECR ─► CDK Deploy ─► Comment URL
DB Guard ───┘                              │
                                          └─ 有迁移时运行 ECS migration task
```

### PR 关闭

`.github/workflows/cleanup-pr-preview.yml` 删除：

- PR ECS Service
- Task Definition Stack 引用
- PR Target Groups/Listener Rules
- PR Lambda
- PR Cloud Map Service

共享的 ECR、Cluster、ALB、Namespace 和 Aurora 不删除。

### main 生产部署

`.github/workflows/deploy-production.yml`：

1. Go test。
2. CDK Foundation deploy。
3. Docker build/push ECR。
4. 编译 Go Lambda。
5. CDK Production deploy。
6. 本次 main 变更包含 migration 时运行一次性迁移 Task。

## 10. 推荐的 CDK 首次部署

完成 Secrets Manager、ACM、OIDC 和 GitHub Variables 后，可以让 Actions 首次部署，也可以本地先创建 Foundation：

```bash
cd infra
npm ci
npx cdk deploy YyAwsSettingFoundation --require-approval never \
  -c vpcId=vpc-06e535e0d55e64fdd \
  -c databaseSecurityGroupId=sg-0fa1f22a2b4e37550 \
  -c certificateArn=你的ACM证书ARN
```

Foundation 创建应用长期共享资源 完成后会得到：

- ECR：`yy-aws-setting`
- ECS Cluster：`yy-aws-setting`
- ALB：`yy-aws-setting`
- Cloud Map Namespace：`yy.internal`
- ECS、Lambda、ALB 安全组

之后每个 PR 创建独立的 Application Stack：
共享 Foundation
├── production ECS Service
├── PR 123 ECS Service
├── PR 124 ECS Service
└── ...
PR 关闭只删除对应 PR Stack，不删除 ECR、Cluster、ALB。工作流每次执行 Foundation deploy 是幂等操作，没有变化时 CloudFormation 不会重新创建。

## 11. 如果完全在控制台手动创建

推荐 CDK，可以通过lib/stack文件配置，对应的属性是网页版配置可以点击的属性：
  this.repository = new ecr.Repository(this, "ProfileGoRepository", {
			imageScanOnPush: true,
			lifecycleRules: [{ maxImageCount: 50 }],
			removalPolicy: RemovalPolicy.RETAIN,
			repositoryName: "yy-workflow/profile-go",
		});

		this.cluster = new ecs.Cluster(this, "ProfileCluster", {
			clusterName: "yy-workflow-profile",
			containerInsightsV2: ecs.ContainerInsights.ENABLED,
			vpc: this.vpc,
		});
但对应的网页中控制台配置如下。

### 11.1 ECR

ECR → Private repositories → Create：

- Name：`yy-aws-setting`
- Tag mutability：Mutable  映像标签可变性
- Scan on push：开启  /启用推送扫描，以在将每个映像推送到存储库后对其进行自动扫描。如果已禁用，则必须手动开始每个映像的扫描才能获取扫描结果。
- Encryption：AES-256 加密设置
- Lifecycle：保留最新 50 个镜像

### 11.2 ECS Cluster

ECS → Clusters → Create：

- Name：`yy-aws-setting`
- Infrastructure：AWS Fargate
- Container Insights：开启 //CloudWatch Container Insights 是一种适用于容器化应用程序和微服务的监控与故障排除解决方案。

### 11.3 ECS Task Definition

- Launch type：Fargate
- OS/Architecture：Linux/X86_64
- CPU：0.25 vCPU
- Memory：0.5 GB
- Container name：`app`
- Image：ECR 镜像 URL
  IMAGE_TAG 通常使用 Git commit SHA。当前 CDK 会自动组合 Repository 与 Tag，不需要在 ECS 网页中手选。978184426686.dkr.ecr.ap-northeast-1.amazonaws.com/yy-aws-setting:<IMAGE_TAG>
- Port：8080/TCP
- Log driver：awslogs
- Health command：`CMD-SHELL,wget -q -O - http://127.0.0.1:8080/health >/dev/null || exit 1`
  【容器 - 1】 -> 展开 【运行状况检查 - 可选】（Health Check）
- 普通环境变量：`PORT=8080`、`AUTO_MIGRATE=false`、TLS/CORS 配置
  在 【容器 - 1】 区域下，找到 【环境变量 - 可选】（Environment variables）：点击 【单独添加】 或 【添加环境变量】。逐条填入键值对：键（Key）：PORT -> 值（Value）：8080键（Key）：AUTO_MIGRATE -> 值（Value）：false（以及你的 TLS/CORS 相关环境变量，比如 CORS_ORIGIN 等）
- Secrets：把 RDSHOST、DB_PORT、DB_NAME、DB_USER、DB_PASSWORD 映射到 Secrets Manager JSON 字段
  不要选截图中的任何 cdk-hnb659fds-* 角色。
  CDK 会自动创建：
    Execution Role：ECS 拉取 ECR、读取 Secret、写 CloudWatch Logs
    Task Role：Go 容器调用 AWS API 时使用

### 11.4 Cloud Map

Cloud Map → Namespaces → Create namespace：

- Name：`yy.internal`
- Discovery：API calls and DNS queries in VPC
- VPC：`vpc-06e535e0d55e64fdd`

创建完之后，点进去，创建 Service：`api-production`，DNS record 为 A，TTL 10 秒。ECS Service 的 Service discovery 选择它。

### 11.5 ALB 和 ECS Service

EC2 → Target Groups：

- Target type：IP addresses
- Protocol/Port：HTTP/8080
- VPC：数据库所在 VPC
- Health path：`/health`
- Healthy codes：200

EC2 → Load Balancers：

- Type：Application Load Balancer
- Scheme：Internet-facing
- Subnets：默认 VPC 至少两个可用区
- Security Group：只开放 80、443
- HTTPS 443：选择 ACM 证书
- HTTP 80：Redirect HTTPS 443

ECS → Cluster → Create service：

- Compute：Launch type/Fargate
- Desired tasks：1
- Networking：现有两条 Private 子网（带 NAT Gateway）
- Public IP：关闭
- Security Group：8080 只允许 ALB SG 和 Lambda SG
- Load balancer：选择上面的 ALB 和 IP Target Group
- Service discovery：`api-production.yy.internal`

任务没有公网 IP，出站通过现有 NAT Gateway 拉取 ECR 镜像和访问 GitHub；公网只能经过 ALB。后续还应把 Aurora 的 `Publicly accessible` 改为关闭，并评估用 ECR、Logs、Secrets Manager VPC Endpoints 替代部分 NAT 流量。

### 11.6 Go Lambda

本地编译：

```bash
mkdir -p dist/lambda
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o dist/lambda/bootstrap ./cmd/lambda
cd dist/lambda && zip function.zip bootstrap
```

Lambda → Create function：

- Runtime：Amazon Linux 2023 provided runtime
- Architecture：arm64
- Handler/bootstrap：`bootstrap`
- VPC：`vpc-06e535e0d55e64fdd`
- Security Group：Lambda SG
- Environment：`SERVICE_URL=http://api-production.yy.internal:8080`
- Timeout：10 秒
- Memory：128 MB

上传 `function.zip`。创建 Lambda 类型 Target Group，把 ALB `/lambda`、`/lambda/*` 规则指向它。Lambda SG 出站允许 ECS，ECS SG 入站允许 Lambda SG 访问 8080。

CDK 已自动完成上述 Lambda invoke permission、Target Group 和 Listener Rule，使用 CDK 时不要再手动重复创建。

## 12. 部署后的检查

```bash
curl https://api.example.com/health
curl https://api.example.com/api/github
curl https://api.example.com/lambda
```

预期 `/lambda` 返回：

```json
{
  "message": "Lambda reached ECS through Cloud Map",
  "serviceURL": "http://api-production.yy.internal:8080",
  "serviceStatus": 200
}
```

AWS Console 检查顺序：

1. CloudFormation Stack 是否成功。
2. ECS Service Deployment 是否稳定。
3. Target Group 是否 Healthy。
4. CloudWatch Logs 是否有 Go 日志。
5. Lambda 是否能解析 `api-production.yy.internal`。
6. Aurora SG 是否已有来自 ECS SG 的 5432 入站规则。
