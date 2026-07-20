package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yuighjk/yy-aws-setting/internal/database"
)

type Config struct {
	Port               string
	GitHubUsername     string
	GitHubToken        string
	CORSAllowedOrigins []string
	AutoMigrate        bool
	Database           database.Config
}

func Load() (Config, error) {
	port := env("PORT", "8080")
	if _, err := strconv.Atoi(port); err != nil {
		return Config{}, fmt.Errorf("PORT must be numeric: %w", err)
	}
	autoMigrate, err := strconv.ParseBool(env("AUTO_MIGRATE", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("AUTO_MIGRATE must be true or false: %w", err)
	}

	origins := splitCSV(env("CORS_ALLOWED_ORIGINS", "http://localhost:5500,http://127.0.0.1:5500"))
	sslRootCert := env("DB_SSLROOTCERT", "./global-bundle.pem")
	if sslRootCert != "" {
		sslRootCert = filepath.Clean(sslRootCert)
	}

	return Config{
		Port:               port,
		GitHubUsername:     env("GITHUB_USERNAME", "yuighjk"),
		GitHubToken:        os.Getenv("GITHUB_TOKEN"),
		CORSAllowedOrigins: origins,
		AutoMigrate:        autoMigrate,
		Database: database.Config{
			Host:        env("RDSHOST", "database-workflow-instance-1.c5240eqqsji3.ap-northeast-1.rds.amazonaws.com"),
			Port:        env("DB_PORT", "5432"),
			Name:        env("DB_NAME", "postgres"),
			User:        env("DB_USER", "postgres"),
			Password:    os.Getenv("DB_PASSWORD"),
			SSLMode:     env("DB_SSLMODE", "verify-full"),
			SSLRootCert: sslRootCert,
		},
	}, nil
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func splitCSV(value string) []string {
	items := strings.Split(value, ",")
	result := make([]string, 0, len(items))
	for _, item := range items {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}
