export const AUTH_PROTOCOL = 'gian.remote.auth/1' as const;
export const RELAY_PROTOCOL = 'gian.relay/1' as const;
export const REMOTE_PROTOCOL = 'gian.remote/1' as const;

export const REMOTE_MAJOR_VERSION = 1 as const;
export const REMOTE_MIN_MINOR_VERSION = 1 as const;
export const REMOTE_MAX_MINOR_VERSION = 1 as const;

export const WIRE_FEATURES = [
  'wire.snapshot_parts',
  'wire.content_resume',
] as const;

export const REMOTE_METHODS = [
  'catalog.read',
  'state.refresh',
  'session.subscribe',
  'session.page',
  'command.status',
  'session.create',
  'session.update',
  'session.send',
  'session.stop',
  'queue.update',
  'queue.remove',
  'queue.clear',
  'queue.send_now',
  'interaction.respond',
  'file.preview',
] as const;

export const BUSINESS_CAPABILITY_IDS = [
  'catalog.read',
  'state.refresh',
  'task.read',
  'session.read',
  'session.create',
  'session.update',
  'session.send',
  'session.stop',
  'queue.read',
  'queue.add',
  'queue.update',
  'queue.remove',
  'queue.clear',
  'queue.send_now',
  'turn.steer',
  'interaction.read',
  'interaction.respond',
  'attachment.upload',
  'attachment.read',
  'file.read',
  'file.download',
] as const;

export const REMOTE_ERROR_CODES = [
  'AUTH_REQUIRED',
  'DEVICE_NOT_PAIRED',
  'DEVICE_REVOKED',
  'HOST_OFFLINE',
  'HOST_RESTARTED',
  'REMOTE_CAPABILITY_DENIED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'PRECONDITION_FAILED',
  'COMMAND_EXPIRED',
  'SNAPSHOT_REQUIRED',
  'INVALID_FRAME',
  'FRAME_TOO_LARGE',
  'RATE_LIMITED',
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_HASH_MISMATCH',
  'UPLOAD_EXPIRED',
  'TRANSFER_CONFLICT',
  'FILE_REFERENCE_EXPIRED',
  'FILE_TOO_LARGE',
  'UNKNOWN_OUTCOME',
] as const;

export const TRANSPORT_DIRECTIONS = [
  'host_to_device',
  'device_to_host',
] as const;

export const FRAME_CLASSES = ['control', 'content'] as const;

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const;

export const MAX_RELAY_FRAME_BYTES = 512 * 1024;
export const MAX_CONTENT_CHUNK_PLAINTEXT_BYTES = 256 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_PREVIEW_BYTES = 1 * 1024 * 1024;
export const CONTROL_OUTBOX_MAX_FRAMES = 2048;
export const CONTROL_OUTBOX_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_DEVICES_PER_HOST = 20;
export const MAX_CONNECTIONS_PER_DEVICE = 2;
export const AUTH_RATE_LIMIT_PER_MINUTE = 10;
export const MAX_CONTROL_FRAMES_PER_SECOND = 100;
/** Host sender burst bucket. A 20-frame capacity with a 60 frames/s refill
 *  keeps every rolling Server second (100-frame hard limit) at ≤ 80 frames. */
export const RELAY_FRAME_BURST_CAPACITY = 20;
export const RELAY_FRAME_REFILL_PER_SECOND = 60;
/** Live assistant deltas sharing one transcript item merge within this window. */
export const TRANSCRIPT_COALESCE_MS = 50;
export const MAX_CIPHERTEXT_BYTES_PER_SECOND = 16 * 1024 * 1024;
/** Sender budget. Strictly below the Server cap so sliding-window skew cannot trip RATE_LIMITED. */
export const CIPHERTEXT_PACE_BYTES_PER_SECOND = 13 * 1024 * 1024;
/** Sender window. Longer than the Server 1000ms window so late receive stamps still overlap. */
export const CIPHERTEXT_PACE_WINDOW_MS = 1_250;
export const MAX_CONCURRENT_TRANSFERS_PER_DEVICE = 4;
export const MAX_INFLIGHT_UPLOAD_BYTES_PER_DEVICE = 64 * 1024 * 1024;
export const CONTENT_WINDOW_CHUNKS = 4;
export const MAX_HELLO_CAPABILITIES = 32;
export const MAX_SNAPSHOT_PARTS = 64;
export const MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024 * 1024;
/** Snapshots above this serialized size ship as state.snapshot.part frames
 *  instead of one oversized command result. */
export const SNAPSHOT_SPLIT_THRESHOLD_BYTES = 384 * 1024;
/** Payload bytes per part; base64url and framing stay inside the 512 KiB
 *  relay frame budget. */
export const SNAPSHOT_PART_BYTES = 256 * 1024;
export const MAX_STRING_CHARS = 16 * 1024;
export const MAX_NAME_CHARS = 256;
export const MAX_ID_CHARS = 64;
export const MAX_ARRAY_ITEMS = 256;
export const MAX_QUEUE_ENTRIES = 64;
export const MAX_SESSION_PAGE_TURNS = 10;
export const MIN_SESSION_PAGE_TURNS = 1;
export const COMMAND_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const COMMAND_TIMESTAMP_SKEW_MS = 1000;
export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const PAIRING_MAX_FAILURES = 5;
export const PAIRING_CODE_LENGTH = 8;
export const REFRESH_SLIDING_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;
export const WS_TICKET_TTL_MS = 60 * 1000;
export const PRESENCE_LEASE_MS = 30 * 1000;
export const PRESENCE_HEARTBEAT_MS = 10 * 1000;
/** After a fresh crypto handshake the Host waits this long for a client-driven
 *  sync (resume.request or state.refresh) before pushing a full resync. */
export const SNAPSHOT_PUSH_GRACE_MS = 2 * 1000;
export const AUTH_SIGNED_AT_SKEW_MS = 5 * 60 * 1000;
export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_KEY_BITS = 256;
export const SHA256_HEX_LENGTH = 64;

export const SNAPSHOT_REQUIRED_REASONS = [
  'crypto_resumed',
  'generation_changed',
  'gap_evicted',
  'revision_mismatch',
  'server_restart',
] as const;

export const COMMAND_STATUS_STATES = [
  'not_seen',
  'accepted',
  'succeeded',
  'failed',
  'unknown_outcome',
  'expired',
] as const;

export const SESSION_STATUSES = [
  'new',
  'running',
  'pending',
  'error',
  'done',
] as const;

export const INTERACTION_KINDS = [
  'approval',
  'question',
  'exit_plan_mode',
  'native_choice',
] as const;

export const ATTENTION_KINDS = [
  'running',
  'interaction',
  'completed',
  'failed',
] as const;

export const CAPABILITY_STATES = [
  'supported',
  'unsupported',
  'offline',
  'denied',
  'version_mismatch',
] as const;

export const DOWNLOAD_KINDS = ['attachment', 'file'] as const;

export const RELAY_NOTICE_TYPES = [
  'host.offline',
  'host.online',
  'device.revoked',
  'device.revoked.ack',
  'pairing.claimed',
  'route.not_bound',
] as const;

export const RELAY_HANDSHAKE_TYPES = [
  'crypto.offer',
  'crypto.accept',
] as const;
