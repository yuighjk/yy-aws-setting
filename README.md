# yy-aws-settings

一个前后端分离的 Go on AWS 练习项目：静态个人主页从 GitHub API 获取 `yuighjk` 的公开资料，Go API 连接 Amazon Aurora PostgreSQL 保存留言。前端可以直接上传到 Cloudflare Pages，后端随后部署到 ECR + ECS Fargate + ALB。

如果刚开始学习 Go，请先阅读 [`docs/go-beginner-guide.md`](docs/go-beginner-guide.md)。其中说明了 Go 安装、项目启动、业务接口、PostgreSQL、Docker 和 ECS 之间的关系；`main.go`、`database.go`、`api.go` 也已经添加逐行中文注释。

AWS 控制台、CDK、GitHub Actions、Jira Guard、DB Guard、PR Preview 和生产部署请阅读 [`docs/aws-console-and-cicd.md`](docs/aws-console-and-cicd.md)。

当前项目为什么复用 API Gateway、Lambda BFF、私有 ALB、ECS 和 Aurora，以及 migration、PR Preview、production 之间的关系，请阅读 [`docs/aws-architecture-design.md`](docs/aws-architecture-design.md)。

## 目录

```text
cmd/server/                 Go API 入口
internal/config/            环境变量配置
internal/database/          Aurora PostgreSQL 连接与迁移
internal/httpapi/           HTTP API、CORS 与健康检查
frontend/                   Cloudflare Pages 静态站点
Dockerfile                  ECS Fargate 容器镜像
```

## 本地准备

- Go 1.24 或更高版本
- PostgreSQL 命令行工具（仅在需要手动检查数据库时使用）
- Docker（可选）

下载 Amazon RDS CA bundle：

```bash
make download-cert
```

复制本地环境变量文件：

```bash
cp .env.example .env
```

编辑 `.env` 并设置 `DB_PASSWORD`。不要把 `.env` 或密码提交到 Git。

加载环境变量并启动后端：

```bash
set -a
source .env
set +a
go run ./cmd/server
```

不设置 `DB_PASSWORD` 也能启动后端，但 `/api/notes` 会返回 `503`，`/health` 会显示数据库为 `disabled`。

启动前端：

```bash
make frontend
```

访问 <http://localhost:5500>。不要直接双击 `index.html`，浏览器的 `file://` 模式会影响跨域请求。

## 数据库检查

项目默认使用以下 Aurora/RDS 地址，并启用服务端身份验证：

```bash
export RDSHOST="database-workflow-instance-1.c5240eqqsji3.ap-northeast-1.rds.amazonaws.com"
psql "host=$RDSHOST port=5432 dbname=postgres user=postgres sslmode=verify-full sslrootcert=./global-bundle.pem"
```

后端第一次成功连接时会自动执行幂等迁移，创建 `profile_notes` 表。

## HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | ALB/ECS 健康检查 |
| `GET` | `/api/github` | 由后端代理读取 GitHub 公开资料 |
| `GET` | `/api/notes` | 读取最近 20 条留言 |
| `POST` | `/api/notes` | 创建留言，JSON：`{"content":"hello"}` |
| `DELETE` | `/api/notes/{id}` | 删除一条留言 |

个人主页本身直接请求 `https://api.github.com/users/yuighjk`，不依赖后端就能展示 GitHub 资料。

## 测试与构建

```bash
go test ./...
go build ./cmd/server
docker build -t yy-go-app:local .
```

运行容器时使用环境变量注入密码：

```bash
docker run --rm -p 8080:8080 --env-file .env yy-go-app:local
```

## 上传 Cloudflare Pages

1. 确认 GitHub 个人资料能够正常显示。
2. `frontend/config.js` 已指向现有 API Gateway 的 production 路径。
3. 可将最终的 Cloudflare Pages 域名加入 `CORS_ALLOWED_ORIGINS`；现有 API Gateway 当前也会返回通配 CORS。
4. 上传 `frontend` 目录中的文件；这是纯静态站点，不需要构建命令。

如果通过 GitHub 连接 Cloudflare Pages：

- Framework preset：`None`
- Build command：留空
- Build output directory：`frontend`

## 后续 ECS 配置要点

- AWS Region：`ap-northeast-1`
- 容器端口：`8080`
- ALB health check：`/health`
- ECS 环境变量：除密码外使用 `.env.example` 对应的值
- `DATABASE_URL`：从现有 AWS Secrets Manager Secret 注入，不要放在 Task Definition 明文环境变量中
- Aurora 安全组：允许 ECS Task 安全组访问 TCP 5432
- ECS Task 必须能够访问 GitHub API、Aurora 和 CloudWatch Logs

Cloudflare Pages 与 API Gateway 属于不同源；HTTPS 由 API Gateway 自动管理，不需要 ACM。完整复用架构见部署指南。
