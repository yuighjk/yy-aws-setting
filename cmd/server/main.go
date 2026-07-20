// package main 表示这个包会被编译成一个可以直接运行的程序，而不是供别人调用的库。
package main

// import 区域列出当前文件需要使用的标准库和项目内部包。
import (
	// context 用于设置超时、取消数据库连接和优雅关闭等操作。
	"context"
	// errors 用于判断服务器返回的错误是不是正常关闭错误。
	"errors"
	// slog 是 Go 标准库提供的结构化日志工具。
	"log/slog"
	// http 提供 HTTP Server、Handler 和状态码等功能。
	"net/http"
	// os 提供标准输出、程序退出和操作系统相关能力。
	"os"
	// signal 用来接收 Ctrl+C 或容器停止时发出的系统信号。
	"os/signal"
	// syscall 定义 SIGINT、SIGTERM 等系统信号常量。
	"syscall"
	// time 用来配置数据库连接、HTTP 请求和关机的超时时间。
	"time"

	// config 是本项目读取环境变量的包。
	"github.com/yuighjk/yy-aws-setting/internal/config"
	// database 是本项目连接 Aurora PostgreSQL 和执行建表 SQL 的包。
	"github.com/yuighjk/yy-aws-setting/internal/database"
	// httpapi 是本项目注册路由和编写业务接口的包。
	"github.com/yuighjk/yy-aws-setting/internal/httpapi"
	// 右括号结束 import 区域。
)

// main 是程序的入口；执行 go run ./cmd/server 时，Go 会从这里开始运行。
func main() {
	// 创建 JSON 格式的日志器，并把日志写到标准输出，ECS 会收集这些输出到 CloudWatch。
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	// 读取 PORT、RDSHOST、DB_PASSWORD 等环境变量，返回统一的配置对象。
	cfg, err := config.Load()
	// 如果配置格式不正确，例如 PORT 不是数字，就不能继续启动。
	if err != nil {
		// 记录具体的配置错误，方便在本地终端或 CloudWatch 中排查。
		logger.Error("invalid configuration", "error", err)
		// 使用退出码 1 结束程序，1 表示程序异常退出。
		os.Exit(1)
		// 右花括号结束配置错误判断。
	}

	// 创建一个最多持续 15 秒的上下文，限制连接数据库和建表不能无限等待。
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	// main 函数结束前调用 cancel，释放这个上下文占用的计时器资源。
	defer cancel()

	// 使用配置连接 Aurora PostgreSQL；如果未设置 DB_PASSWORD，db 会是 nil。
	db, err := database.Open(ctx, cfg.Database)
	// 如果设置了密码但数据库连接失败，则认为启动失败。
	if err != nil {
		// 将数据库连接错误写入日志。
		logger.Error("database connection failed", "error", err)
		// 异常退出，让 Docker 或 ECS 知道容器没有成功启动。
		os.Exit(1)
		// 右花括号结束数据库连接错误判断。
	}
	// db 不为 nil 表示已经获得可用的 PostgreSQL 连接池。
	if db != nil {
		// main 退出时关闭连接池，把数据库连接归还给系统。
		defer db.Close()
		// 本地可设置 AUTO_MIGRATE=true；ECS 中保持 false，由 DB Guard 单独执行迁移任务。
		if cfg.AutoMigrate {
			// 执行内嵌 SQL，创建 profile_notes 表；SQL 使用 IF NOT EXISTS，所以可重复执行。
			if err := database.Migrate(ctx, db); err != nil {
				// 记录数据库迁移失败的原因。
				logger.Error("database migration failed", "error", err)
				// 表没有准备好时不能提供留言业务，因此异常退出。
				os.Exit(1)
				// 右花括号结束数据库迁移错误判断。
			}
			// 右花括号结束是否自动迁移的判断。
		}
		// 输出连接成功日志，但不输出密码等敏感信息。
		logger.Info("database connected", "host", cfg.Database.Host, "database", cfg.Database.Name)
		// else 表示没有设置数据库密码，本地可以先只运行健康检查和 GitHub API。
	} else {
		// 提醒开发者数据库功能目前处于关闭状态。
		logger.Warn("database is disabled; set DB_PASSWORD to enable it")
		// 右花括号结束数据库是否启用的判断。
	}

	// 把配置、数据库连接池和日志器交给 API 层，API 层会返回一个总的 HTTP Handler。
	handler := httpapi.New(cfg, db, logger)
	// 创建 HTTP Server；这个对象以后会监听端口并把请求交给 handler。
	server := &http.Server{
		// Addr 指定监听端口，例如 cfg.Port 为 8080 时结果是 :8080。
		Addr: ":" + cfg.Port,
		// Handler 保存 API 层注册的所有路由和中间件。
		Handler: handler,
		// ReadHeaderTimeout 限制读取请求头的时间，降低慢请求攻击风险。
		ReadHeaderTimeout: 5 * time.Second,
		// ReadTimeout 限制读取整个请求的最长时间。
		ReadTimeout: 10 * time.Second,
		// WriteTimeout 限制服务器写响应的最长时间。
		WriteTimeout: 15 * time.Second,
		// IdleTimeout 控制 keep-alive 空闲连接最多保留多久。
		IdleTimeout: 60 * time.Second,
		// 右花括号结束 HTTP Server 配置。
	}

	// 使用 goroutine 在后台启动 HTTP Server，这样 main 还能继续监听停止信号。
	go func() {
		// 打印服务启动地址。
		logger.Info("server started", "address", server.Addr)
		// ListenAndServe 会一直阻塞；正常 Shutdown 也会返回 http.ErrServerClosed。
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// 只有不是正常关闭的错误才记录为异常。
			logger.Error("server stopped unexpectedly", "error", err)
			// HTTP Server 意外停止后用非零退出码结束程序。
			os.Exit(1)
			// 右花括号结束服务器异常判断。
		}
		// 右花括号结束匿名函数，后面的括号立即执行这个 goroutine。
	}()

	// 创建一个只能保存一个系统信号的 channel。
	stop := make(chan os.Signal, 1)
	// 要求操作系统把 Ctrl+C(SIGINT) 和 Docker/ECS Stop(SIGTERM) 发送到 stop。
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	// 从 stop 读取信号；收到信号之前 main 会阻塞在这里，不会直接退出。
	<-stop

	// 收到停止信号后创建一个最多 10 秒的关机上下文。
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	// main 结束前释放关机上下文资源。
	defer shutdownCancel()
	// Shutdown 停止接收新请求，并等待正在处理的请求完成。
	if err := server.Shutdown(shutdownCtx); err != nil {
		// 如果 10 秒内没有正常关闭，就记录错误。
		logger.Error("graceful shutdown failed", "error", err)
		// 右花括号结束关机错误判断。
	}
	// 右花括号结束 main 函数，所有 defer 会按照后进先出的顺序执行。
}
