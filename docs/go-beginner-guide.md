# Go 初学者运行与业务开发指南

这份说明按照“Go 怎么安装 → 项目怎么启动 → 请求怎么走 → 业务怎么写 → Docker 怎么运行 Go”的顺序阅读。

## 1. Go 是怎么安装的

当前电脑已经安装：

```text
go version go1.23.11 darwin/arm64
```

- `go1.23.11`：Go 版本。
- `darwin`：操作系统是 macOS。
- `arm64`：电脑是 Apple Silicon 架构。

如果另一台 Mac 没有 Go，可以使用 Homebrew：

```bash
brew install go
go version
```

也可以从 Go 官网下载安装包。安装后最重要的命令是：

```bash
go version       # 查看版本
go env           # 查看 Go 环境
go run ./cmd/server
go test ./...
go build ./cmd/server
```

现代 Go 项目使用 Module 管理依赖，不需要把项目放进旧式的 `GOPATH/src`。

项目根目录的 `go.mod` 相当于 Node 项目的 `package.json`：

```go
module github.com/yuighjk/yy-aws-setting

go 1.23.0

require github.com/jackc/pgx/v5 v5.7.4
```

- `module` 是项目的模块名，也是内部包 import 的前缀。
- `go` 是项目声明兼容的 Go 版本。
- `require` 是第三方依赖。本项目用 `pgx` 连接 PostgreSQL。
- `go.sum` 保存依赖校验值，应该提交到 Git。

安装或整理依赖：

```bash
go mod tidy
```

它会根据源码中的 `import` 自动添加需要的依赖、移除不用的依赖。

## 2. 项目如何运行

### 2.1 准备数据库证书

项目已经包含 AWS 官方的 `global-bundle.pem`。它用于验证连接到的服务器确实是 AWS RDS/Aurora，而不是伪造服务器。

### 2.2 准备环境变量

复制示例文件：

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
PORT=8080
RDSHOST=database-workflow-instance-1.c5240eqqsji3.ap-northeast-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres
DB_PASSWORD=你的真实密码
DB_SSLMODE=verify-full
DB_SSLROOTCERT=./global-bundle.pem
```

`.env` 已加入 `.gitignore`，不能上传到 GitHub。

把文件内容加载成当前终端的环境变量：

```bash
set -a
source .env
set +a
```

### 2.3 启动后端

```bash
go run ./cmd/server
```

`go run` 实际做了两件事：

1. 临时编译项目。
2. 立即运行编译出来的程序。

生产环境一般先编译：

```bash
go build -o bin/server ./cmd/server
./bin/server
```

测试健康检查：

```bash
curl http://localhost:8080/health
```

数据库正常时应该看到：

```json
{"database":"connected","status":"ok"}
```

如果没有设置 `DB_PASSWORD`，程序仍然能启动，但数据库状态是 `disabled`，留言接口会返回 503。

### 2.4 启动前端

另开一个终端：

```bash
make frontend
```

访问：

```text
http://localhost:5500
```

前端和后端是两个独立进程：

```text
浏览器 :5500 ──读取页面──► frontend/
浏览器 :5500 ──HTTP请求──► Go API :8080 ──SQL──► Aurora PostgreSQL
浏览器       ──HTTP请求──► api.github.com/users/yuighjk
```

## 3. Go 程序从哪里开始执行

入口是 `cmd/server/main.go` 中的：

```go
func main() {
    // ...
}
```

启动顺序：

```text
main()
  │
  ├─ config.Load()          读取环境变量
  ├─ database.Open()        建立 PostgreSQL 连接池
  ├─ database.Migrate()     创建 profile_notes 表
  ├─ httpapi.New()          注册路由和中间件
  ├─ ListenAndServe()       监听 :8080
  └─ 等待 Ctrl+C/ECS Stop   优雅关闭 HTTP 和数据库连接
```

`main` 只负责组装，不应该在里面写大量 SQL 或具体业务规则。

## 4. 业务代码是怎么分层的

当前项目分为三层：

| 层 | 文件 | 职责 |
|---|---|---|
| 启动层 | `cmd/server/main.go` | 读取配置、连接各组件、启动服务 |
| 数据库层 | `internal/database/database.go` | 连接池、TLS、数据库迁移 |
| API/业务层 | `internal/httpapi/api.go` | 路由、参数校验、SQL、JSON 响应 |

当前项目不大，所以 SQL 暂时写在 API 层。业务增长后建议再拆成：

```text
handler     处理 HTTP 和参数
service     业务规则
repository  数据库 SQL
```

### 一次新增留言请求的完整流程

浏览器发送：

```http
POST /api/notes
Content-Type: application/json

{"content":"你好"}
```

后端执行：

1. `ServeMux` 根据 `POST /api/notes` 找到 `createNote`。
2. CORS 中间件确认 Cloudflare Pages 域名是否允许访问。
3. `json.Decoder` 把 JSON 解析到 Go 结构体。
4. 检查留言是否为空、是否超过 500 字。
5. 使用 `$1` 参数执行 INSERT，避免 SQL 注入。
6. PostgreSQL 返回自动生成的 id 和时间。
7. `writeJSON` 返回 HTTP 201 和 JSON。
8. logging 中间件记录请求耗时。

## 5. 如何新增一个业务接口

例如增加 `GET /api/hello`。

第一步，在 `New` 中注册路由：

```go
mux.HandleFunc("GET /api/hello", api.hello)
```

第二步，添加处理方法：

```go
func (a *API) hello(w http.ResponseWriter, r *http.Request) {
    writeJSON(w, http.StatusOK, map[string]string{
        "message": "hello, Go",
    })
}
```

这里的三个重要对象：

- `a *API`：可以访问配置、数据库和日志器。
- `w http.ResponseWriter`：用来写状态码、响应头和响应 Body。
- `r *http.Request`：用来读取路径、参数、请求头和请求 Body。

如果业务需要数据库，可以调用：

```go
rows, err := a.db.Query(r.Context(), "SELECT ...")
```

如果是单行查询或 INSERT ... RETURNING：

```go
err := a.db.QueryRow(r.Context(), "SELECT ... WHERE id = $1", id).Scan(&value)
```

始终使用 `$1`、`$2` 参数，不要把用户输入直接拼接进 SQL。

## 6. Go 与 Docker 是什么关系

Go 并不是“连接 Docker”。Docker 的作用是把 Go 程序和运行所需文件包装成一个镜像：

```text
源码 ──Docker build──► 镜像 ──Docker run──► 容器中的 Go 进程
```

本项目 Dockerfile 使用两阶段构建。

第一阶段编译 Go：

```dockerfile
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/server ./cmd/server
```

第二阶段只保留运行文件：

```dockerfile
FROM alpine:3.21
COPY --from=build /out/server /app/server
COPY global-bundle.pem /app/global-bundle.pem
EXPOSE 8080
ENTRYPOINT ["/app/server"]
```

最终镜像不需要包含 Go 编译器和源码，因此更小、更安全。

构建镜像：

```bash
docker build -t yy-go-app:local .
```

运行镜像：

```bash
docker run --rm \
  --env-file .env \
  -p 8080:8080 \
  yy-go-app:local
```

- `--env-file .env`：把数据库配置交给容器中的 Go 程序。
- `-p 8080:8080`：把电脑的 8080 转发到容器的 8080。
- `--rm`：停止后自动删除测试容器。
- `yy-go-app:local`：刚构建的镜像名。

容器访问 Aurora 时直接通过 RDS Endpoint 连接，不需要“经过 Docker”。前提是网络和安全组允许 TCP 5432。

## 7. Docker 到 ECR/ECS 的关系

后续上线时流程是：

```text
Dockerfile
   │ docker build
   ▼
本地镜像
   │ docker push
   ▼
Amazon ECR
   │ ECS 拉取镜像
   ▼
ECS Fargate Task
   │ 监听 8080
   ▼
ALB Target Group
```

ECS Task Definition 中需要配置：

- Image：ECR 镜像 URL。
- Container port：8080。
- Health check 或 ALB health path：`/health`。
- 普通配置：环境变量。
- `DB_PASSWORD`：从 Secrets Manager 注入。
- Log driver：`awslogs`，接收 `slog` 写到标准输出的日志。

Docker 本地 `-p 8080:8080` 只用于开发。在 ECS Fargate 中，由 Task ENI、Security Group、Target Group 和 ALB 完成网络连接。

## 8. 最常用的开发循环

每次修改业务后运行：

```bash
gofmt -w cmd internal
go test ./...
go run ./cmd/server
```

准备部署时再运行：

```bash
docker build -t yy-go-app:local .
docker run --rm -p 8080:8080 yy-go-app:local
```

出现错误时优先按照这个顺序检查：

1. 终端或 CloudWatch 中的 Go 日志。
2. `/health` 返回值。
3. 环境变量是否加载。
4. Aurora 安全组是否允许来源访问 5432。
5. `global-bundle.pem` 路径是否正确。
6. Cloudflare Pages 域名是否加入 `CORS_ALLOWED_ORIGINS`。
