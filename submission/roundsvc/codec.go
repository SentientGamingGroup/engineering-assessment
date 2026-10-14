package main

import (
	"fmt"

	"beaconrelay/roundsvc/pb"

	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// explicitCodec is the standard proto codec, except Round and EventPage are
// encoded with their zero-valued scalars written explicitly. proto3 normally
// omits choice=0 and next_cursor=0, and the gateway's loader (defaults:false)
// then reports them as absent. Writing them is valid wire format, every
// decoder accepts it, and gateway clients receive the exact public fields.
type explicitCodec struct{}

func (explicitCodec) Name() string { return "proto" }

func (explicitCodec) Marshal(v any) ([]byte, error) {
	switch m := v.(type) {
	case *pb.Round:
		return appendRound(nil, m), nil
	case *pb.EventPage:
		return appendEventPage(nil, m), nil
	case proto.Message:
		return proto.Marshal(m)
	}
	return nil, fmt.Errorf("explicitCodec: cannot marshal %T", v)
}

func (explicitCodec) Unmarshal(data []byte, v any) error {
	m, ok := v.(proto.Message)
	if !ok {
		return fmt.Errorf("explicitCodec: cannot unmarshal into %T", v)
	}
	return proto.Unmarshal(data, m)
}

func appendString(b []byte, field protowire.Number, s string) []byte {
	if s == "" {
		return b
	}
	b = protowire.AppendTag(b, field, protowire.BytesType)
	return protowire.AppendString(b, s)
}

func appendUint(b []byte, field protowire.Number, n uint32) []byte {
	b = protowire.AppendTag(b, field, protowire.VarintType)
	return protowire.AppendVarint(b, uint64(n))
}

// Field numbers follow contracts/rounds.proto.
func appendRound(b []byte, r *pb.Round) []byte {
	b = appendString(b, 1, r.GetRoundId())
	b = appendString(b, 2, r.GetRequestId())
	b = appendString(b, 3, r.GetPlayerId())
	b = appendUint(b, 4, r.GetChoice()) // always present, including 0
	b = appendString(b, 5, r.GetStatus())
	b = appendString(b, 6, r.GetCreatedAt())
	if r.Target != nil {
		b = appendUint(b, 7, *r.Target)
	}
	if r.Score != nil {
		b = appendUint(b, 8, *r.Score)
	}
	if r.CompletedAt != nil {
		b = protowire.AppendTag(b, 9, protowire.BytesType)
		b = protowire.AppendString(b, *r.CompletedAt)
	}
	return b
}

func appendEventPage(b []byte, page *pb.EventPage) []byte {
	for _, e := range page.GetEvents() {
		var event []byte
		event = appendUint(event, 1, e.GetSequence())
		event = appendString(event, 2, e.GetType())
		event = protowire.AppendTag(event, 3, protowire.BytesType)
		event = protowire.AppendBytes(event, appendRound(nil, e.GetRound()))
		b = protowire.AppendTag(b, 1, protowire.BytesType)
		b = protowire.AppendBytes(b, event)
	}
	return appendUint(b, 2, page.GetNextCursor()) // always present, including 0
}
