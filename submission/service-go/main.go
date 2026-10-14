// Command beacon-service is the authoritative Beacon Relay RoundService (gRPC).
// It is normally built and supervised by submission/start-go-grpc.mjs.
package main

// Bindings are generated from the frozen contracts/rounds.proto itself; the Go
// package is passed with M flags because the contract has no go_package option.
//go:generate protoc -I ../../contracts --go_out=roundspb --go_opt=paths=source_relative --go_opt=Mrounds.proto=beaconrelay/service/roundspb --go-grpc_out=roundspb --go-grpc_opt=paths=source_relative --go-grpc_opt=Mrounds.proto=beaconrelay/service/roundspb rounds.proto

import (
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"google.golang.org/grpc"

	pb "beaconrelay/service/roundspb"
)

func main() {
	port := env("GRPC_PORT", "4402")
	dataDir := env("DATA_DIR", "./data/service")
	delayMs, err := strconv.Atoi(env("ROUND_DELAY_MS", "1200"))
	if err != nil || delayMs < 0 {
		log.Fatalf("invalid ROUND_DELAY_MS %q", os.Getenv("ROUND_DELAY_MS"))
	}

	// Port first: an instance that can't serve exits before it locks DATA_DIR or
	// arms any completion timers.
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", port))
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	store, err := OpenStore(dataDir, time.Duration(delayMs)*time.Millisecond)
	if err != nil {
		log.Fatalf("opening store in %s: %v", dataDir, err)
	}
	srv := grpc.NewServer()
	pb.RegisterRoundServiceServer(srv, &server{store: store})
	go func() {
		if err := srv.Serve(listener); err != nil {
			log.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	if os.Getenv("BEACON_PARENT_PIPE") == "1" {
		// The launcher holds our stdin open; EOF means it died, so don't linger
		// holding the port and data directory.
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop <- syscall.SIGTERM
		}()
	}
	<-stop

	done := make(chan struct{})
	go func() { srv.GracefulStop(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		srv.Stop()
	}
	if err := store.Close(); err != nil {
		log.Printf("closing store: %v", err)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
