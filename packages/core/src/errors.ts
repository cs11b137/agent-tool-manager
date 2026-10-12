import type { AtmErrorCode, AtmErrorJson } from './types.js';

export interface AtmErrorOptions {
  nextCommand?: string;
  candidates?: string[];
  cause?: unknown;
}

const DEFAULT_NEXT: Record<AtmErrorCode, string> = {
  NOT_INITIALIZED: 'atm init',
  ALREADY_EXISTS: 'atm list',
  NOT_FOUND: 'atm search <name>',
  AMBIGUOUS: 'atm list',
  CONFLICT: 'atm doctor',
  INVALID_MANIFEST: 'atm doctor',
  INVALID_MCP_DEF: 'atm doctor',
  PLUGIN_NOT_INSTALLED: '/plugin install <name>',
  LOCKED: 'retry after the other atm process finishes',
  GIT_FAILED: 'atm doctor',
  REV_MISMATCH: 'atm sync',
  UNSUPPORTED: 'atm doctor',
};

export class AtmError extends Error {
  readonly code: AtmErrorCode;
  readonly nextCommand: string;
  readonly candidates?: string[];

  constructor(code: AtmErrorCode, message: string, opts: AtmErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AtmError';
    this.code = code;
    this.nextCommand = opts.nextCommand ?? DEFAULT_NEXT[code];
    if (opts.candidates) this.candidates = opts.candidates;
  }

  toJSON(): AtmErrorJson {
    const error: AtmErrorJson['error'] = { code: this.code, message: this.message, nextCommand: this.nextCommand };
    if (this.candidates) error.candidates = this.candidates;
    return { error };
  }
}

export function isAtmError(e: unknown, code?: AtmErrorCode): e is AtmError {
  return e instanceof AtmError && (code === undefined || e.code === code);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
