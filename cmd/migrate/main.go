// Command migrate runs embedded PostgreSQL migrations as a one-off process.
// GitHub Actions starts this binary as an ECS one-off task only when DB Guard
// detects migration/schema changes in a pull request.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/yuighjk/yy-aws-setting/internal/config"
	"github.com/yuighjk/yy-aws-setting/internal/database"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	db, err := database.Open(ctx, cfg.Database)
	if err != nil {
		logger.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	if db == nil {
		logger.Error("database password is required", "error", fmt.Errorf("DB_PASSWORD is empty"))
		os.Exit(1)
	}
	defer db.Close()

	if err := database.Migrate(ctx, db); err != nil {
		logger.Error("database migration failed", "error", err)
		os.Exit(1)
	}
	logger.Info("database migration completed")
}
