.PHONY: run test fmt build frontend download-cert

run:
	go run ./cmd/server

test:
	go test ./...

fmt:
	gofmt -w $$(find cmd internal -name '*.go')

build:
	go build -o bin/server ./cmd/server

frontend:
	python3 -m http.server 5500 --directory frontend

download-cert:
	curl --fail --location --output global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
