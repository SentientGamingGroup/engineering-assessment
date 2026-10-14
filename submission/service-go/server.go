package main

// gRPC adapter: validates wire input, maps store errors to the contract's
// status codes/details and converts snapshots to protobuf.

import (
	"context"
	"errors"
	"log"

	pb "beaconrelay/service/roundspb"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const pageLimit = 100

type server struct {
	pb.UnimplementedRoundServiceServer
	store *Store
}

func (s *server) Health(context.Context, *pb.Empty) (*pb.HealthReply, error) {
	return &pb.HealthReply{Ok: true}, nil
}

func (s *server) StartRound(_ context.Context, req *pb.StartRoundRequest) (*pb.Round, error) {
	// An omitted choice is proto3's default 0, which is a valid choice.
	round, err := s.store.StartRound(req.GetRequestId(), req.GetPlayerId(), req.GetChoice())
	if err != nil {
		return nil, toStatus(err)
	}
	return toPB(round), nil
}

func (s *server) GetRound(_ context.Context, req *pb.GetRoundRequest) (*pb.Round, error) {
	round, err := s.store.GetRound(req.GetRoundId())
	if err != nil {
		return nil, toStatus(err)
	}
	return toPB(round), nil
}

func (s *server) ListEvents(_ context.Context, req *pb.ListEventsRequest) (*pb.EventPage, error) {
	limit := req.GetLimit()
	if limit == 0 {
		limit = pageLimit // omitted on the wire
	}
	if limit > pageLimit {
		return nil, status.Error(codes.InvalidArgument, "INVALID_CURSOR")
	}
	events, next := s.store.ListEvents(req.GetAfter(), limit)
	page := &pb.EventPage{Events: make([]*pb.Event, len(events)), NextCursor: next}
	if next == 0 {
		explicitZero(page, 2) // next_cursor
	}
	for i, ev := range events {
		page.Events[i] = &pb.Event{Sequence: ev.Sequence, Type: ev.Type, Round: toPB(ev.Round)}
	}
	return page, nil
}

func toStatus(err error) error {
	switch {
	case errors.Is(err, ErrInvalidRequest):
		return status.Error(codes.InvalidArgument, err.Error())
	case errors.Is(err, ErrNotFound):
		return status.Error(codes.NotFound, err.Error())
	case errors.Is(err, ErrConflict):
		return status.Error(codes.AlreadyExists, err.Error())
	case errors.Is(err, ErrInProgress):
		return status.Error(codes.FailedPrecondition, err.Error())
	}
	log.Printf("internal error: %v", err)
	return status.Error(codes.Internal, "INTERNAL_ERROR")
}

// toPB never exposes a result for pending rounds: optional fields stay unset.
// A zero choice is forced onto the wire (see explicitZero).
func toPB(r Round) *pb.Round {
	out := &pb.Round{
		RoundId: r.RoundID, RequestId: r.RequestID, PlayerId: r.PlayerID,
		Choice: r.Choice, Status: r.Status, CreatedAt: r.CreatedAt,
	}
	if r.Choice == 0 {
		explicitZero(out, 4) // choice
	}
	if r.Status == "completed" {
		out.Target = new(*r.Target)
		out.Score = new(*r.Score)
		out.CompletedAt = new(r.CompletedAt)
	}
	return out
}
