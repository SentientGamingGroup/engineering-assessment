// roundsvc is the authoritative Beacon Relay RoundService (gRPC).
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"beaconrelay/roundsvc/pb"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func main() {
	if err := serve(); err != nil {
		log.Printf("roundsvc: %v", err)
		os.Exit(1)
	}
}

func serve() error {
	port := envInt("GRPC_PORT", 4402)
	delay := time.Duration(envInt("ROUND_DELAY_MS", 1200)) * time.Millisecond
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data/service"
	}
	service, err := NewService(dataDir, delay)
	if err != nil {
		return fmt.Errorf("recover state: %w", err)
	}
	defer service.Close()
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return err
	}
	server := grpc.NewServer(grpc.ForceServerCodec(explicitCodec{}))
	pb.RegisterRoundServiceServer(server, &rpcServer{service: service})

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		// The Node launcher holds our stdin; EOF means it died, so do not linger
		// as an orphan holding the port and the data directory.
		io.Copy(io.Discard, os.Stdin)
		stop <- syscall.SIGTERM
	}()
	go func() {
		<-stop
		timer := time.AfterFunc(2*time.Second, server.Stop)
		server.GracefulStop()
		timer.Stop()
	}()
	log.Printf("roundsvc listening on 127.0.0.1:%d", port)
	return server.Serve(listener)
}

func envInt(name string, fallback int) int {
	if value, err := strconv.Atoi(os.Getenv(name)); err == nil && value >= 0 {
		return value
	}
	return fallback
}

type rpcServer struct {
	pb.UnimplementedRoundServiceServer
	service *Service
}

func (r *rpcServer) Health(context.Context, *pb.Empty) (*pb.HealthReply, error) {
	return &pb.HealthReply{Ok: true}, nil
}

func (r *rpcServer) StartRound(ctx context.Context, in *pb.StartRoundRequest) (*pb.Round, error) {
	round, err := r.service.StartRound(ctx, in.GetRequestId(), in.GetPlayerId(), in.GetChoice())
	if err != nil {
		return nil, toStatus(err)
	}
	return toPB(round), nil
}

func (r *rpcServer) GetRound(ctx context.Context, in *pb.GetRoundRequest) (*pb.Round, error) {
	round, err := r.service.GetRound(ctx, in.GetRoundId())
	if err != nil {
		return nil, toStatus(err)
	}
	return toPB(round), nil
}

func (r *rpcServer) ListEvents(ctx context.Context, in *pb.ListEventsRequest) (*pb.EventPage, error) {
	events, next, err := r.service.ListEvents(ctx, in.GetAfter(), in.GetLimit())
	if err != nil {
		return nil, toStatus(err)
	}
	page := &pb.EventPage{NextCursor: next}
	for _, event := range events {
		page.Events = append(page.Events, &pb.Event{Sequence: event.Sequence, Type: event.Type, Round: toPB(event.Round)})
	}
	return page, nil
}

func toPB(r Round) *pb.Round {
	out := &pb.Round{
		RoundId: r.RoundID, RequestId: r.RequestID, PlayerId: r.PlayerID,
		Choice: r.Choice, Status: r.Status, CreatedAt: r.CreatedAt,
		Target: r.Target, Score: r.Score,
	}
	if r.CompletedAt != "" {
		out.CompletedAt = &r.CompletedAt
	}
	return out
}

func toStatus(err error) error {
	var app appError
	switch {
	case errors.As(err, &app):
		code := map[appError]codes.Code{
			errInvalidRequest: codes.InvalidArgument, errInvalidCursor: codes.InvalidArgument,
			errNotFound: codes.NotFound, errConflict: codes.AlreadyExists,
			errInProgress: codes.FailedPrecondition,
		}[app]
		return status.Error(code, string(app))
	case errors.Is(err, context.DeadlineExceeded):
		return status.Error(codes.DeadlineExceeded, "DEADLINE_EXCEEDED")
	case errors.Is(err, context.Canceled):
		return status.Error(codes.Canceled, "CANCELED")
	case errors.Is(err, errClosed):
		return status.Error(codes.Unavailable, "SHUTTING_DOWN")
	}
	return status.Error(codes.Internal, "INTERNAL_ERROR")
}
