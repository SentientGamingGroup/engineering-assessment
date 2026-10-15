// Contract constants from docs/API.md, shared by the service and the gateway.

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const ROUND_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const CHOICES = 3; // beacons 0, 1, 2
export const MAX_CURSOR = 0xffffffff; // uint32
export const MAX_PAGE_SIZE = 100;
export const MAX_BODY_BYTES = 8192;

export const ROUND_STATUS = Object.freeze({ ACCEPTED: 'accepted', COMPLETED: 'completed' });
export const EVENT_TYPE = Object.freeze({ ACCEPTED: 'round.accepted', COMPLETED: 'round.completed' });

export const ERROR_CODE = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_CURSOR: 'INVALID_CURSOR',
  ROUND_NOT_FOUND: 'ROUND_NOT_FOUND',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  ROUND_IN_PROGRESS: 'ROUND_IN_PROGRESS',
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});
