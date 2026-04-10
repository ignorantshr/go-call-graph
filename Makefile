VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: build install clean

build:
	go build -ldflags "-X main.version=$(VERSION)" -o go-call-graph ./cmd/main.go

install:
	go install -ldflags "-X main.version=$(VERSION)" ./cmd/main.go

clean:
	rm -f go-call-graph
