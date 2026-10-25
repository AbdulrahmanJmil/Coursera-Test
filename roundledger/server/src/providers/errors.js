import { redact } from '../security.js';

export const PROVIDER_ERROR_CODES = [
  'MISSING_CREDENTIALS', 'INVALID_CREDENTIALS', 'PERMISSION_DENIED', 'MODEL_NOT_FOUND', 'RATE_LIMITED',
  'TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_ERROR', 'BAD_RESPONSE', 'BLOCKED',
];

export class ProviderError extends Error {
  constructor(code, message, { status, retryable = false } = {}) {
    super(redact(message));
    this.code = code;
    this.providerStatus = status;
    this.retryable = retryable;
  }
}
