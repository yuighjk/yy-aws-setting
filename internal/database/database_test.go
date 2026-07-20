package database

import (
	"context"
	"strings"
	"testing"
)

func TestConfigURL(t *testing.T) {
	cfg := Config{
		Host:        "example.rds.amazonaws.com",
		Port:        "5432",
		Name:        "postgres",
		User:        "postgres",
		Password:    "p@ss word",
		SSLMode:     "verify-full",
		SSLRootCert: "./global-bundle.pem",
	}
	got := cfg.URL()
	for _, expected := range []string{"postgres://postgres:p%40ss%20word@", "sslmode=verify-full", "sslrootcert="} {
		if !strings.Contains(got, expected) {
			t.Fatalf("URL %q does not contain %q", got, expected)
		}
	}
}

func TestOpenWithoutPasswordDisablesDatabase(t *testing.T) {
	pool, err := Open(context.Background(), Config{})
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	if pool != nil {
		t.Fatal("expected nil pool without password")
	}
}
