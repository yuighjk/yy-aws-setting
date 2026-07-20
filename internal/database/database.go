// package database 专门负责数据库配置、连接池和数据库迁移。
package database

// import 区域列出数据库层需要使用的包。
import (
	// context 让数据库操作可以被取消或设置超时。
	"context"
	// embed 让编译器把 migrations 目录中的 SQL 文件打进 Go 可执行文件。
	"embed"
	// fmt 用于构造带有上下文信息的错误。
	"fmt"
	// url 用来安全地生成 PostgreSQL 连接 URL，尤其能正确转义密码中的特殊字符。
	"net/url"
	// strings 用于去除密码前后的空格并判断密码是否为空。
	"strings"

	// pgxpool 是 pgx 提供的 PostgreSQL 连接池实现。
	"github.com/jackc/pgx/v5/pgxpool"
	// 右括号结束 import 区域。
)

// go:embed 是编译器指令，把匹配 migrations/*.sql 的文件嵌入下面的变量。
// migrations 是一个只读的嵌入式文件系统，程序运行时不需要再寻找外部 SQL 文件。
//
//go:embed migrations/*.sql
var migrations embed.FS

// Config 保存连接 PostgreSQL 所需的全部参数。
type Config struct {
	// Host 是 Aurora/RDS Endpoint，不包含协议和端口。
	Host string
	// Port 是 PostgreSQL 端口，默认是 5432。
	Port string
	// Name 是要连接的数据库名，本项目默认使用 postgres。
	Name string
	// User 是数据库用户名。
	User string
	// Password 是数据库密码，只从环境变量读取，不能写进 Git。
	Password string
	// SSLMode 决定 TLS 校验方式，生产环境使用 verify-full。
	SSLMode string
	// SSLRootCert 是 AWS RDS CA 证书文件的位置。
	SSLRootCert string
}

// URL 把 Config 转换成 pgx 能理解的 PostgreSQL URL。
func (c Config) URL() string {
	// 创建查询参数集合，最终会变成 URL 问号后面的参数。
	query := url.Values{}
	// 设置 sslmode，例如 verify-full 会同时校验证书和数据库主机名。
	query.Set("sslmode", c.SSLMode)
	// 只有设置了证书路径时才把 sslrootcert 加入 URL。
	if c.SSLRootCert != "" {
		// 设置 AWS RDS CA bundle 文件路径。
		query.Set("sslrootcert", c.SSLRootCert)
	}
	// 使用 url.URL 结构体拼接地址，避免手写字符串时遗漏转义。
	return (&url.URL{
		// Scheme 指定数据库协议是 postgres。
		Scheme: "postgres",
		// UserPassword 会安全编码用户名和密码中的 @、空格等特殊字符。
		User: url.UserPassword(c.User, c.Password),
		// Host 由 RDS Endpoint、冒号和 5432 端口组成。
		Host: c.Host + ":" + c.Port,
		// Path 表示数据库名；url.URL 会自动在前面加斜杠。
		Path: c.Name,
		// Encode 把 sslmode 和 sslrootcert 编码成查询字符串。
		RawQuery: query.Encode(),
		// String 把上面的 URL 对象转成普通字符串并返回。
	}).String()
}

// Open 创建并验证 PostgreSQL 连接池；调用者负责在程序退出时 Close。
func Open(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
	// 去掉密码前后空格后仍为空，表示开发者暂时没有启用数据库。
	if strings.TrimSpace(cfg.Password) == "" {
		// 返回 nil 连接池和 nil 错误，让本地服务仍可启动，但数据库 API 会返回 503。
		return nil, nil
	}
	// 把刚才生成的数据库 URL 解析成 pgxpool 的详细配置。
	poolConfig, err := pgxpool.ParseConfig(cfg.URL())
	// URL 格式或连接参数无效时会进入这里。
	if err != nil {
		// 使用 %w 包装原始错误，保留底层错误信息供日志和 errors.Is 使用。
		return nil, fmt.Errorf("parse database configuration: %w", err)
	}
	// 限制每个 Go 容器最多同时使用 5 个数据库连接，避免大量 Fargate Task 压垮 Aurora。
	poolConfig.MaxConns = 5

	// 根据配置创建连接池；连接池会复用连接，而不是每个 HTTP 请求都重新登录数据库。
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	// 创建连接池失败时返回带说明的错误。
	if err != nil {
		// 把底层错误包装后交给 main 记录。
		return nil, fmt.Errorf("create database pool: %w", err)
	}
	// Ping 真正向数据库发起一次请求，确认 DNS、网络、安全组、密码和 TLS 都正确。
	if err := pool.Ping(ctx); err != nil {
		// Ping 失败时立即关闭已经创建的连接池，防止资源泄漏。
		pool.Close()
		// 返回具体错误，让 main 以异常状态停止启动。
		return nil, fmt.Errorf("ping database: %w", err)
	}
	// 连接测试成功，返回连接池供 API 层查询和写入数据。
	return pool, nil
}

// Migrate 执行项目内嵌的建表 SQL，让数据库结构满足业务代码要求。
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	// 从编译进程序的文件系统读取第一份迁移 SQL。
	data, err := migrations.ReadFile("migrations/001_create_notes.sql")
	// 理论上文件在编译时就会校验，但仍然正确处理读取错误。
	if err != nil {
		// 包装错误并返回给 main。
		return fmt.Errorf("read migration: %w", err)
	}
	// 把字节转换为字符串并交给 PostgreSQL 执行；下划线表示不需要使用执行结果。
	if _, err := pool.Exec(ctx, string(data)); err != nil {
		// SQL 执行失败时保留 PostgreSQL 返回的具体原因。
		return fmt.Errorf("run migration: %w", err)
		// 右花括号结束执行 SQL 错误判断。
	}
	// 返回 nil 表示迁移成功。
	return nil
}
