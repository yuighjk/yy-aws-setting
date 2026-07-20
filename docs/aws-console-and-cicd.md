# AWS 控制台、CDK 与 GitHub Actions 配置指南

本项目不使用 CodeBuild。构建和部署由 GitHub Actions 完成，AWS CDK 创建基础设施，AWS 控制台主要用于第一次建立信任、证书、数据库密码以及查看部署结果。

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

### 2.1 为管理员启用 MFA

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

Bootstrap 会创建 CDK 部署角色、文件发布角色和资产 S3 Bucket。GitHub OIDC Role 之后只需要 Assume 这些 bootstrap roles。

官方说明：[Bootstrapping AWS CDK environments](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)

## 3. Secrets Manager 配置数据库密码

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
   - `api.example.com`
   - `*.preview.example.com`
3. Validation method：DNS validation。
4. 在 Cloudflare DNS 中添加 ACM 给出的 CNAME 验证记录。
5. 验证 CNAME 设置为 DNS only，等待 ACM 状态变成 Issued。
6. 复制 Certificate ARN，稍后填写 GitHub Variable `ACM_CERTIFICATE_ARN`。

CDK 创建 ALB 后，在 CloudFormation `YyAwsSettingFoundation` Outputs 中复制 `LoadBalancerDnsName`，再到 Cloudflare 添加：

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `api` | ALB DNS | Proxied |
| CNAME | `*.preview` | ALB DNS | Proxied |

Cloudflare SSL/TLS mode 设为 `Full (strict)`。

## 5. GitHub OIDC：不用 Access Key 部署

### 5.1 创建 Identity Provider

AWS Console → IAM → Identity providers → Add provider：

- Provider type：OpenID Connect
- Provider URL：`https://token.actions.githubusercontent.com`
- Audience：`sts.amazonaws.com`

官方说明：[GitHub Actions configuring OIDC in AWS](https://docs.github.com/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)

### 5.2 创建 GitHub Actions Role

IAM → Roles → Create role → Web identity：

- Identity provider：`token.actions.githubusercontent.com`
- Audience：`sts.amazonaws.com`
- GitHub organization：`yuighjk`
- Repository：`yy-aws-setting`

角色名建议：`GitHubActionsYyAwsSettingRole`。

创建后编辑 Trust relationships，使用：

```text
infra/policies/github-oidc-trust.json
```

它只允许 `preview` 和 `production` 两个 GitHub Environment 获取 AWS 临时凭证。

添加 Inline policy，内容使用：

```text
infra/policies/github-actions-permissions.json
```

角色 ARN：

```text
arn:aws:iam::978184426686:role/GitHubActionsYyAwsSettingRole
```

这些是短期 OIDC 凭证，不需要在 GitHub 创建 `AWS_ACCESS_KEY_ID` 或 `AWS_SECRET_ACCESS_KEY`。

## 6. GitHub 网页设置

GitHub Repository → Settings → Environments，创建：

- `preview`
- `production`

可以给 `production` 添加 Required reviewers，避免 main 每次推送未经确认直接上线。

Settings → Secrets and variables → Actions → Variables，添加：

| Variable | Value |
|---|---|
| `AWS_ROLE_ARN` | `arn:aws:iam::978184426686:role/GitHubActionsYyAwsSettingRole` |
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

## 8. DB Guard 与迁移

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

Foundation 完成后会得到：

- ECR：`yy-aws-setting`
- ECS Cluster：`yy-aws-setting`
- ALB：`yy-aws-setting`
- Cloud Map Namespace：`yy.internal`
- ECS、Lambda、ALB 安全组

## 11. 如果完全在控制台手动创建

推荐 CDK，但对应的控制台配置如下。

### 11.1 ECR

ECR → Private repositories → Create：

- Name：`yy-aws-setting`
- Tag mutability：Mutable
- Scan on push：开启
- Encryption：AES-256
- Lifecycle：保留最新 50 个镜像

### 11.2 ECS Cluster

ECS → Clusters → Create：

- Name：`yy-aws-setting`
- Infrastructure：AWS Fargate
- Container Insights：开启

### 11.3 ECS Task Definition

- Launch type：Fargate
- OS/Architecture：Linux/X86_64
- CPU：0.25 vCPU
- Memory：0.5 GB
- Container name：`app`
- Image：ECR 镜像 URL
- Port：8080/TCP
- Log driver：awslogs
- Health command：`CMD-SHELL,wget -q -O - http://127.0.0.1:8080/health >/dev/null || exit 1`
- 普通环境变量：`PORT=8080`、`AUTO_MIGRATE=false`、TLS/CORS 配置
- Secrets：把 RDSHOST、DB_PORT、DB_NAME、DB_USER、DB_PASSWORD 映射到 Secrets Manager JSON 字段

### 11.4 Cloud Map

Cloud Map → Namespaces → Create namespace：

- Name：`yy.internal`
- Discovery：API calls and DNS queries in VPC
- VPC：`vpc-06e535e0d55e64fdd`

创建 Service：`api-production`，DNS record 为 A，TTL 10 秒。ECS Service 的 Service discovery 选择它。

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
