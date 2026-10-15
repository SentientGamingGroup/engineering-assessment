// Domain errors carry the exact gRPC status and details string from docs/API.md.
import { grpc } from '../../../lib/grpc.mjs';
import { ERROR_CODE } from '../common/constants.mjs';

export class DomainError extends Error {
  constructor(grpcCode, details) {
    super(details);
    this.grpcCode = grpcCode;
    this.details = details;
  }
}

export const errors = Object.freeze({
  invalidRequest: () => new DomainError(grpc.status.INVALID_ARGUMENT, ERROR_CODE.INVALID_REQUEST),
  invalidCursor: () => new DomainError(grpc.status.INVALID_ARGUMENT, ERROR_CODE.INVALID_CURSOR),
  roundNotFound: () => new DomainError(grpc.status.NOT_FOUND, ERROR_CODE.ROUND_NOT_FOUND),
  idempotencyConflict: () => new DomainError(grpc.status.ALREADY_EXISTS, ERROR_CODE.IDEMPOTENCY_CONFLICT),
  roundInProgress: () => new DomainError(grpc.status.FAILED_PRECONDITION, ERROR_CODE.ROUND_IN_PROGRESS),
});

export function toGrpcError(error) {
  if (error instanceof DomainError) return { code: error.grpcCode, details: error.details };
  return { code: grpc.status.INTERNAL, details: ERROR_CODE.INTERNAL_ERROR };
}
