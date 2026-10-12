/** Tiny hand-rolled argv parser: positionals, `--flag`, `--key value`, `--key=value`, `-h`. */

export type FlagType = 'bool' | 'string';
export type FlagSpec = Record<string, FlagType>;

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export class UsageError extends Error {
  constructor(
    message: string,
    /** Command whose usage should be printed (undefined = global usage). */
    readonly command?: string,
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

const SHORT: Record<string, string> = { h: 'help' };

export function parseArgs(argv: readonly string[], spec: FlagSpec, command?: string): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const type = spec[key];
      if (!type) throw new UsageError(`unknown option --${key}`, command);
      if (type === 'bool') {
        if (eq !== -1) throw new UsageError(`option --${key} does not take a value`, command);
        flags[key] = true;
        continue;
      }
      let value: string | undefined;
      if (eq !== -1) value = tok.slice(eq + 1);
      else {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) throw new UsageError(`option --${key} requires a value`, command);
        i++;
      }
      if (value === '') throw new UsageError(`option --${key} requires a value`, command);
      flags[key] = value;
      continue;
    }
    if (tok.length > 1 && tok.startsWith('-') && !/^-\d/.test(tok)) {
      const key = SHORT[tok.slice(1)];
      if (!key || !spec[key]) throw new UsageError(`unknown option ${tok}`, command);
      flags[key] = true;
      continue;
    }
    positionals.push(tok);
  }
  return { positionals, flags };
}

/** Find the command word: first token that is not an option (or the value of a global string option). */
export function splitCommand(argv: readonly string[], globalStringFlags: readonly string[]): { command?: string; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') break;
    if (tok.startsWith('-')) {
      if (tok.startsWith('--') && !tok.includes('=') && globalStringFlags.includes(tok.slice(2))) i++;
      continue;
    }
    return { command: tok, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { rest: [...argv] };
}
