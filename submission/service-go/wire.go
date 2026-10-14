package main

import (
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// explicitZero makes a zero-valued proto3 scalar visible on the wire.
//
// contracts/rounds.proto declares e.g. Round.choice without `optional`, so
// protobuf-go never encodes a 0 there, and the supplied Node loader
// (defaults:false) then drops the key: a round for beacon 0 would arrive with no
// `choice`. protobuf-go marshals unknown fields verbatim, so the field is
// appended there as tag + varint 0. Decoders read it as an ordinary field.
//
// Only call it when the field's value is 0: decoders keep the last occurrence
// of a scalar, so a stray 0 after a real value would overwrite it.
func explicitZero(m proto.Message, field protowire.Number) {
	r := m.ProtoReflect()
	b := protowire.AppendTag(r.GetUnknown(), field, protowire.VarintType)
	r.SetUnknown(protowire.AppendVarint(b, 0))
}
