/** 明文密钥扫描。 */
const VAR_FORMS = [/\$\{[A-Za-z0-9_]+\}/, /\$\{env:[A-Za-z0-9_]+\}/, /\$[A-Za-z_][A-Za-z0-9_]*/];
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION/i;

export interface SecretHit {
  server: string;
  field: string;
  key: string;
}

export function isVarRef(value: string): boolean {
  return VAR_FORMS.some((re) => re.test(value));
}

export function isPlaintextSecret(key: string, value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && SECRET_KEY.test(key) && !isVarRef(value);
}

/** 扫描一个 server 条目（MCP 定义或已生成配置中的 server）的 env / headers / http_headers。 */
export function scanServer(server: string, entry: unknown): SecretHit[] {
  if (!entry || typeof entry !== 'object') return [];
  const hits: SecretHit[] = [];
  for (const field of ['env', 'headers', 'http_headers']) {
    const rec = (entry as Record<string, unknown>)[field];
    if (!rec || typeof rec !== 'object') continue;
    for (const [key, value] of Object.entries(rec)) if (isPlaintextSecret(key, value)) hits.push({ server, field, key });
  }
  return hits;
}

/** 扫描一组 server（`{ name: entry }`）。 */
export function scanServers(servers: unknown): SecretHit[] {
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers).flatMap(([name, entry]) => scanServer(name, entry));
}
