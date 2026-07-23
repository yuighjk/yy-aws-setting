// package httpapi 负责 HTTP 路由、业务接口、参数校验和中间件。
package httpapi

// import 区域列出 API 层依赖的标准库和项目包。
import (
	// context 用于限制数据库健康检查最多执行多长时间。
	"context"
	// crypto/rand 生成不可预测的事件 ID，供异步消费者幂等处理。
	"crypto/rand"
	// json 用于把 Go 数据转换成 JSON，也用于解析浏览器提交的 JSON。
	"encoding/json"
	// hex 把随机事件 ID编码成可记录的字符串。
	"encoding/hex"
	// fmt 用于把 GitHub 的 HTTP 状态码拼进错误信息。
	"fmt"
	// slog 用于记录请求日志和业务错误。
	"log/slog"
	// http 提供路由、请求、响应、客户端和 HTTP 状态码。
	"net/http"
	// strings 用于清理用户提交的留言内容。
	"strings"
	// time 用于请求超时、日志耗时和留言创建时间。
	"time"

	// pgxpool 是 PostgreSQL 连接池类型，API 通过它执行 SQL。
	"github.com/jackc/pgx/v5/pgxpool"
	// config 提供统一的应用配置类型。
	"github.com/yuighjk/yy-aws-setting/internal/config"
	// messaging 定义 SNS 事件发布接口。
	"github.com/yuighjk/yy-aws-setting/internal/messaging"
	// 右括号结束 import 区域。
)

// API 把每个接口都需要的公共依赖保存到一个结构体中。
type API struct {
	// cfg 包含 GitHub 用户名、Token、CORS 白名单等配置。
	cfg config.Config
	// db 是 PostgreSQL 连接池；未配置密码时它可以是 nil。
	db *pgxpool.Pool
	// logger 用来把错误和访问记录写到终端或 CloudWatch。
	logger *slog.Logger
	// client 是调用 GitHub API 的 HTTP 客户端，它带有超时设置。
	client *http.Client
	// publisher 在数据库写入成功后发布异步 NoteCreated 事件。
	publisher messaging.Publisher
}

// note 对应数据库中的一条 profile_notes 记录，同时也是返回给前端的 JSON 数据。
type note struct {
	// ID 是数据库自动生成的主键，JSON 字段名是 id。
	ID int64 `json:"id"`
	// Content 是留言正文，JSON 字段名是 content。
	Content string `json:"content"`
	// CreatedAt 是 PostgreSQL 生成的创建时间，前端收到的字段名是 createdAt。
	CreatedAt time.Time `json:"createdAt"`
}

// New 是 API 层的构造函数：接收依赖、注册路由、组合中间件并返回总 Handler。
func New(cfg config.Config, db *pgxpool.Pool, logger *slog.Logger, publishers ...messaging.Publisher) http.Handler {
	publisher := messaging.Publisher(messaging.NoopPublisher{})
	if len(publishers) > 0 && publishers[0] != nil {
		publisher = publishers[0]
	}
	// 创建 API 指针，使后面的所有处理函数都能访问相同的配置、数据库和日志器。
	api := &API{
		// 保存 main 传进来的应用配置。
		cfg: cfg,
		// 保存 main 传进来的 PostgreSQL 连接池。
		db: db,
		// 保存 main 传进来的结构化日志器。
		logger: logger,
		// GitHub 请求最多等待 8 秒，避免外部服务异常时一直占用连接。
		client:    &http.Client{Timeout: 8 * time.Second},
		publisher: publisher,
	}

	// 创建 Go 1.22+ 标准库路由器 ServeMux。
	mux := http.NewServeMux()
	// GET /health 交给 health 方法，用于本地、Docker 和 ALB 健康检查。
	mux.HandleFunc("GET /health", api.health)
	// GET /api/github 交给 githubProfile 方法，代理 GitHub 用户资料。
	mux.HandleFunc("GET /api/github", api.githubProfile)
	// GET /api/notes 交给 listNotes 方法，查询留言列表。
	mux.HandleFunc("GET /api/notes", api.listNotes)
	// POST /api/notes 交给 createNote 方法，创建新留言。
	mux.HandleFunc("POST /api/notes", api.createNote)
	// DELETE 路由中的 {id} 是路径参数，例如 /api/notes/12。
	mux.HandleFunc("DELETE /api/notes/{id}", api.deleteNote)

	// 中间件从内到外依次是 CORS、访问日志、panic 恢复，然后作为总 Handler 返回。
	return api.recoverPanic(api.logging(api.cors(mux)))
}

// health 检查 Go 服务和数据库是否可用。
func (a *API) health(w http.ResponseWriter, r *http.Request) {
	// 默认认为 Go 服务状态正常。
	status := "ok"
	// 默认数据库状态为 disabled，因为本地可能没有设置密码。
	databaseStatus := "disabled"
	// 默认返回 HTTP 200。
	statusCode := http.StatusOK
	// 只有连接池不为 nil 时才检查数据库。
	if a.db != nil {
		// 基于当前 HTTP 请求创建一个最多 2 秒的数据库检查上下文。
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		// 方法返回前释放定时器资源。
		defer cancel()
		// Ping 向 Aurora 发送一个轻量请求，检查连接是否仍可用。
		if err := a.db.Ping(ctx); err != nil {
			// 数据库不可用时将服务标为 degraded。
			status = "degraded"
			// 给响应中的 database 字段设置明确状态。
			databaseStatus = "unavailable"
			// 返回 503，让 ALB/ECS 知道这个 Task 当前不健康。
			statusCode = http.StatusServiceUnavailable
			// else 表示数据库 Ping 成功。
		} else {
			// 把数据库状态标为 connected。
			databaseStatus = "connected"
			// 右花括号结束数据库 Ping 结果判断。
		}
		// 右花括号结束数据库是否启用的判断。
	}
	// 返回类似 {"status":"ok","database":"connected"} 的 JSON。
	writeJSON(w, statusCode, map[string]string{"status": status, "database": databaseStatus})
	// 右花括号结束 health 方法。
}

// githubProfile 从 GitHub 官方 API 获取配置中指定用户的公开资料。
func (a *API) githubProfile(w http.ResponseWriter, r *http.Request) {
	// 拼出用户 API 地址，例如 https://api.github.com/users/yuighjk。
	url := "https://api.github.com/users/" + a.cfg.GitHubUsername
	// 创建 GET 请求，并继承浏览器请求的 Context；浏览器取消时 GitHub 请求也会取消。返回request对象
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, url, nil)
	// 创建请求失败通常意味着 URL 配置有问题。
	if err != nil {
		// 向前端返回统一格式的 500 JSON 错误。
		writeError(w, http.StatusInternalServerError, "failed to create GitHub request")
		// 提前结束当前处理函数，防止继续使用无效 req。
		return
	}
	// 告诉 GitHub 希望收到官方 JSON 媒体类型。
	req.Header.Set("Accept", "application/vnd.github+json")
	// GitHub 要求 API 客户端提供 User-Agent。
	req.Header.Set("User-Agent", "yy-aws-settings")
	// 如果配置了 Token，就使用认证请求以获得更高的 API 频率限制。
	if a.cfg.GitHubToken != "" {
		// 使用 Bearer 认证头；Token 不会被返回给浏览器。
		req.Header.Set("Authorization", "Bearer "+a.cfg.GitHubToken)
	}

	// 使用带 8 秒超时的客户端真正请求 GitHub。
	resp, err := a.client.Do(req)
	// DNS、网络、TLS 或超时错误会进入这里。
	if err != nil {
		// 502 表示我们的服务器正常，但上游 GitHub 当前不可用。
		writeError(w, http.StatusBadGateway, "GitHub API is unavailable")
		// 返回，避免访问空的 resp。
		return
	}
	// 当前方法结束时关闭响应 Body，释放底层网络连接。
	defer resp.Body.Close()
	// GitHub 只有返回 200 才视为成功，404 和限流响应都会进入这里。
	if resp.StatusCode != http.StatusOK {
		// 把 GitHub 状态码包装成 502 错误返回给调用方。
		writeError(w, http.StatusBadGateway, fmt.Sprintf("GitHub API returned %d", resp.StatusCode))
		// 提前结束，不再解析失败响应。
		return
		// 右花括号结束 GitHub 状态码判断。
	}

	// map[string]any 可以保存 GitHub 返回的任意 JSON 字段和值。
	var profile map[string]any
	// 从响应 Body 流中解码一份 JSON 到 profile。
	if err := json.NewDecoder(resp.Body).Decode(&profile); err != nil {
		// JSON 无法解析时说明上游响应格式异常。
		writeError(w, http.StatusBadGateway, "GitHub API returned invalid JSON")
		// 返回，防止把不完整数据发送给浏览器。
		return
		// 右花括号结束 GitHub JSON 解析错误判断。
	}
	// 使用公共工具函数把 GitHub 资料以 HTTP 200 JSON 返回。
	writeJSON(w, http.StatusOK, profile)
}

// listNotes 从 Aurora PostgreSQL 查询最近 20 条留言。
func (a *API) listNotes(w http.ResponseWriter, r *http.Request) {
	// requireDatabase 会检查数据库是否已经配置。
	if !a.requireDatabase(w) {
		// 没配置数据库时错误响应已经写好，直接结束。
		return
		// 右花括号结束数据库可用性判断。
	}
	// Query 执行返回多行的 SELECT，并继承 HTTP 请求的 Context。
	rows, err := a.db.Query(r.Context(), `
		SELECT id, content, created_at
		FROM profile_notes
		ORDER BY created_at DESC
		LIMIT 20`)
	// SQL、连接或权限错误会进入这里。
	if err != nil {
		// 服务器日志保存详细错误，但不会把数据库细节泄露给浏览器。
		a.logger.Error("list notes failed", "error", err)
		// 向浏览器返回通用的 500 错误。
		writeError(w, http.StatusInternalServerError, "failed to list notes")
		// 返回，避免继续遍历无效 rows。
		return
		// 右花括号结束查询错误判断。
	}
	// 方法结束时关闭结果集，把连接归还给连接池。
	defer rows.Close()

	// 创建长度为 0 的切片；JSON 会返回 [] 而不是 null。
	notes := make([]note, 0)
	// rows.Next 每次把游标移动到下一条记录，直到没有数据。
	for rows.Next() {
		// 创建变量接收当前这一行数据库记录。
		var item note
		// Scan 按 SELECT 的字段顺序把数据库值写进 Go 字段。
		if err := rows.Scan(&item.ID, &item.Content, &item.CreatedAt); err != nil {
			// 数据类型不匹配等扫描错误返回 500。
			writeError(w, http.StatusInternalServerError, "failed to read notes")
			// 停止读取剩余记录。
			return
			// 右花括号结束扫描错误判断。
		}
		// 把当前留言追加到切片末尾。
		notes = append(notes, item)
		// 右花括号结束结果集循环。
	}
	// 把留言切片编码成 JSON 数组并返回 200。
	writeJSON(w, http.StatusOK, notes)
	// 右花括号结束 listNotes 方法。
}

// createNote 校验浏览器提交的 JSON，并把新留言写入 Aurora。
func (a *API) createNote(w http.ResponseWriter, r *http.Request) {
	// 首先确认数据库连接池存在。
	if !a.requireDatabase(w) {
		// 数据库未配置时结束请求。
		return
		// 右花括号结束数据库可用性判断。
	}
	// 定义只在当前方法使用的匿名输入结构体。
	var input struct {
		// JSON 中只接受 content 字段。
		Content string `json:"content"`
		// 右花括号结束输入结构体定义。
	}
	// 把请求 Body 限制到 2048 字节，防止客户端上传超大 JSON 占用内存。
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	// JSON 中出现 content 之外的未知字段时直接报错，帮助发现前后端字段拼写错误。
	decoder.DisallowUnknownFields()
	// 解码请求 Body，例如 {"content":"你好"}。
	if err := decoder.Decode(&input); err != nil {
		// JSON 语法错误或字段错误时返回 400。
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		// 返回，不执行数据库 INSERT。
		return
		// 右花括号结束 JSON 解码错误判断。
	}
	// 去掉留言前后的空格和换行。
	input.Content = strings.TrimSpace(input.Content)
	// 留言不能为空，并以 rune 数量限制为 500，中文字符不会被按多个字节误算。
	if input.Content == "" || len([]rune(input.Content)) > 500 {
		// 参数不符合业务规则时返回 400。
		writeError(w, http.StatusBadRequest, "content must contain 1 to 500 characters")
		// 返回，不写入数据库。
		return
		// 右花括号结束留言长度判断。
	}

	// created 用于接收 PostgreSQL 刚创建的完整记录。
	var created note
	// QueryRow 执行只返回一行的 INSERT ... RETURNING。
	err := a.db.QueryRow(r.Context(), `
		INSERT INTO profile_notes (content)
		VALUES ($1)
		RETURNING id, content, created_at`, input.Content).
		// Scan 把 RETURNING 的三个字段写入 created；$1 会安全绑定留言，防止 SQL 注入。
		Scan(&created.ID, &created.Content, &created.CreatedAt)
	// PostgreSQL 写入失败时进入这里。
	if err != nil {
		// 在服务器日志中保存详细数据库错误。
		a.logger.Error("create note failed", "error", err)
		// 只向浏览器返回通用错误，避免泄露数据库信息。
		writeError(w, http.StatusInternalServerError, "failed to create note")
		// 结束当前请求。
		return
		// 右花括号结束写入错误判断。
	}
	// 数据库写入成功后再发布事件；发布失败不会撤销已经提交的 INSERT，
	// 否则用户会看到失败但数据库仍可能已经保存留言。
	eventID := make([]byte, 16)
	if _, randomErr := rand.Read(eventID); randomErr != nil {
		a.logger.Error("create note event id failed", "error", randomErr)
	} else {
		publishCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Second)
		defer cancel()
		if publishErr := a.publisher.PublishNoteCreated(publishCtx, messaging.NoteCreatedEvent{
			EventID:     hex.EncodeToString(eventID),
			EventType:   "NoteCreated",
			NoteID:      created.ID,
			Content:     created.Content,
			CreatedAt:   created.CreatedAt,
			Environment: a.cfg.EnvironmentName,
		}); publishErr != nil {
			a.logger.Error("publish note event failed", "error", publishErr, "note_id", created.ID)
		}
	}
	// 返回 201 Created 和数据库生成的留言对象。
	writeJSON(w, http.StatusCreated, created)
	// 右花括号结束 createNote 方法。
}

// deleteNote 根据 URL 路径里的 id 删除一条留言。
func (a *API) deleteNote(w http.ResponseWriter, r *http.Request) {
	// 删除之前确认数据库已经配置。
	if !a.requireDatabase(w) {
		// 数据库未配置时结束请求。
		return
		// 右花括号结束数据库可用性判断。
	}
	// PathValue("id") 读取路由 {id}，并通过 $1 参数安全传给 DELETE SQL。
	result, err := a.db.Exec(r.Context(), "DELETE FROM profile_notes WHERE id = $1", r.PathValue("id"))
	// id 不是数字或数据库执行失败时进入这里。
	if err != nil {
		// 记录详细错误用于排查。
		a.logger.Error("delete note failed", "error", err)
		// 当前主要可能是非法 id，因此返回 400。
		writeError(w, http.StatusBadRequest, "invalid note id")
		// 结束当前请求。
		return
		// 右花括号结束删除错误判断。
	}
	// RowsAffected 为 0 表示 SQL 执行成功，但没有找到这个 id。
	if result.RowsAffected() == 0 {
		// 返回 404 Not Found。
		writeError(w, http.StatusNotFound, "note not found")
		// 结束当前请求。
		return
		// 右花括号结束记录是否存在判断。
	}
	// 删除成功不需要响应 Body，只返回 204 No Content。
	w.WriteHeader(http.StatusNoContent)
	// 右花括号结束 deleteNote 方法。
}

// requireDatabase 是多个留言接口共用的小工具，用于避免重复 nil 判断。
func (a *API) requireDatabase(w http.ResponseWriter) bool {
	// nil 表示 main 没有获得数据库连接池，一般是因为未设置 DB_PASSWORD。
	if a.db == nil {
		// 返回 503，说明服务存在但数据库功能尚不可用。
		writeError(w, http.StatusServiceUnavailable, "database is not configured")
		// false 告诉调用方不要继续执行 SQL。
		return false
		// 右花括号结束连接池为空判断。
	}
	// true 表示调用方可以继续执行数据库操作。
	return true
	// 右花括号结束 requireDatabase 方法。
}

// cors 是一个中间件，允许配置中的 Cloudflare Pages 域名跨域调用 Go API。
func (a *API) cors(next http.Handler) http.Handler {
	// 把允许的域名切片转换成 map，使每次查询接近 O(1)。
	allowed := make(map[string]struct{}, len(a.cfg.CORSAllowedOrigins))
	// 遍历配置中的每一个允许来源。
	for _, origin := range a.cfg.CORSAllowedOrigins {
		// 空结构体不占额外空间，这里只关心 key 是否存在。
		allowed[origin] = struct{}{}
		// 右花括号结束允许来源循环。
	}
	// HandlerFunc 把普通函数转换成 http.Handler。
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Origin 是浏览器自动携带的前端站点来源，例如 https://demo.pages.dev。
		origin := r.Header.Get("Origin")
		// 在 map 中查找来源；ok 为 true 表示它位于白名单。
		if _, ok := allowed[origin]; ok {
			// 允许这个具体来源读取响应，使用具体域名比通配符更安全。
			w.Header().Set("Access-Control-Allow-Origin", origin)
			// 告诉 CDN 和缓存：不同 Origin 需要分别缓存响应。
			w.Header().Set("Vary", "Origin")
			// 允许浏览器发送 JSON 所需的 Content-Type 请求头。
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			// 声明跨域允许使用的 HTTP 方法。
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			// 右花括号结束来源白名单判断。
		}
		// 浏览器在正式 POST/DELETE 前会先发送 OPTIONS 预检请求。
		if r.Method == http.MethodOptions {
			// 204 表示预检成功且没有响应 Body。
			w.WriteHeader(http.StatusNoContent)
			// 预检请求不需要进入真正的业务路由。
			return
			// 右花括号结束 OPTIONS 判断。
		}
		// 非预检请求继续交给里面一层 Handler。
		next.ServeHTTP(w, r)
		// 右花括号结束中间件匿名处理函数。
	})
	// 右花括号结束 cors 中间件。
}

// logging 是访问日志中间件，用于记录每次请求的方法、路径和耗时。
func (a *API) logging(next http.Handler) http.Handler {
	// 返回一个包装了下一层 Handler 的新 Handler。
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 请求进入时记录当前时间。
		started := time.Now()
		// 调用下一层 CORS 和业务路由；这一行执行完成代表响应基本处理完毕。
		next.ServeHTTP(w, r)
		// 当前时间减去 started 得到请求总耗时，并输出结构化日志。
		a.logger.Info("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(started))
		// 右花括号结束访问日志匿名处理函数。
	})
	// 右花括号结束 logging 中间件。
}

// recoverPanic 是最外层中间件，防止单个请求 panic 导致整个 Go 进程退出。
func (a *API) recoverPanic(next http.Handler) http.Handler {
	// 返回带 panic 保护的新 Handler。
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// defer 保证无论业务代码正常结束还是 panic，匿名函数都会执行。
		defer func() {
			// recover 只能在 defer 中捕获 panic；没有 panic 时返回 nil。
			if recovered := recover(); recovered != nil {
				// 把 panic 的内部信息写进服务器日志。
				a.logger.Error("request panic", "error", recovered)
				// 向浏览器返回通用 500，避免泄露内部实现。
				writeError(w, http.StatusInternalServerError, "internal server error")
				// 右花括号结束是否捕获到 panic 的判断。
			}
			// 右花括号结束 defer 匿名函数，并用括号立即注册它。
		}()
		// 正常调用下一层 Handler。
		next.ServeHTTP(w, r)
		// 右花括号结束 panic 恢复匿名处理函数。
	})
	// 右花括号结束 recoverPanic 中间件。
}

// writeJSON 是所有接口共用的 JSON 响应工具函数。
func writeJSON(w http.ResponseWriter, status int, value any) {
	// 在写状态码之前设置 Content-Type，告诉浏览器响应是 UTF-8 JSON。
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// 写入 HTTP 状态码；调用后就不能再修改状态码。
	w.WriteHeader(status)
	// Encoder 把任意 Go 值编码到响应流；下划线表示这里不再处理编码错误。
	_ = json.NewEncoder(w).Encode(value)
	// 右花括号结束 writeJSON 函数。
}

// writeError 统一错误 JSON 格式，避免每个接口重复创建 map。
func writeError(w http.ResponseWriter, status int, message string) {
	// 把错误信息包装成 {"error":"..."} 并交给 writeJSON。
	writeJSON(w, status, map[string]string{"error": message})
	// 右花括号结束 writeError 函数。
}
