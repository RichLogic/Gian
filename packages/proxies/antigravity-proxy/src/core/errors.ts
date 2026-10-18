import type { DomainCode } from '@gian/proxy-protocol';

/** JSON-safe details. Secrets and MCP headers do not belong here. */
export type AntigravityErrorDetails = Record<string, string | number | boolean | null | string[]>;

/**
 * Domain failure for the Antigravity proxy service.
 * `domainCode` is an existing Gian proxy domain code. `retryable` is false
 * when repeating the same call would resend an uncertain prompt or hide a
 * deterministic rejection.
 */
export class AntigravityProxyError extends Error {
  readonly domainCode: DomainCode;
  readonly retryable: boolean;
  readonly details?: AntigravityErrorDetails;

  constructor(
    domainCode: DomainCode,
    message: string,
    retryable: boolean,
    details?: AntigravityErrorDetails,
  ) {
    super(message);
    this.name = 'AntigravityProxyError';
    this.domainCode = domainCode;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}
