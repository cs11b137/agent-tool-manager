import { AtmError, type AtmErrorCode, type AtmErrorJson } from '@atm/core';

/** Server-only error codes (not part of core's `AtmErrorCode`). */
export type ServerErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'INTERNAL';

export interface ServerErrorJson {
  error: { code: ServerErrorCode; message: string; nextCommand?: string };
}

export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 500;

const STATUS: Partial<Record<AtmErrorCode, HttpStatus>> = {
  NOT_FOUND: 404,
  LOCKED: 409,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  NOT_INITIALIZED: 409,
  INVALID_MANIFEST: 400,
  INVALID_MCP_DEF: 400,
  UNSUPPORTED: 400,
  AMBIGUOUS: 400,
  PLUGIN_NOT_INSTALLED: 400,
};

export function statusFor(code: AtmErrorCode): HttpStatus {
  return STATUS[code] ?? 500;
}

/** Thrown by request validation; serialised as 400 `INVALID_MANIFEST`. */
export class BadRequest extends AtmError {
  constructor(message: string) {
    super('INVALID_MANIFEST', message, { nextCommand: 'check the request body' });
  }
}

export function toErrorResponse(err: unknown): { status: HttpStatus; body: AtmErrorJson | ServerErrorJson } {
  if (err instanceof AtmError) return { status: statusFor(err.code), body: err.toJSON() };
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: 'INTERNAL', message } } };
}
