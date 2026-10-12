/** 明文密钥扫描。 */
const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
/** 恰好一个变量引用：`${VAR}`、`${env:VAR}`、`$VAR` */
const REF = `(?:\\$\\{${IDENT}\\}|\\$\\{env:${IDENT}\\}|\\$${IDENT})`;
const EXACT_REF = new RegExp(`^${REF}$`);
/** 允许的短字面前缀 + 恰好一个引用：`Bearer ${TOKEN}`、`Basic ${CRED}`、`token ${GH}` */
const PREFIXED_REF = new RegExp(`^(?:(?:Bearer|Basic|token) )?${REF}$`);
const SECRET_KEY = /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION/i;

/** 看起来像密钥的字面量（用于 args / url 这类没有 key 名可参考的字段）。 */
const SECRET_LIKE: RegExp[] = [/sk-[A-Za-z0-9_-]{8,}/, /ghp_[A-Za-z0-9]{16,}/, /xox[abp]-[A-Za-z0-9-]{8,}/];
const HEX_RUN = /[0-9a-fA-F]{32,}/;
const B64_RUN = /[A-Za-z0-9+=_-]{32,}/g;

export interface SecretHit {
  server: string;
  field: string;
  key: string;
  /** env / headers 中的明文 → error；args / url 中疑似密钥 → warn */
  level: 'error' | 'warn';
}

/** 值是否「恰好是一个变量引用」。 */
export function isVarRef(value: string): boolean {
  return EXACT_REF.test(value.trim());
}

/** 值是否安全：恰好一个引用，或允许的短前缀（`Bearer ` / `Basic ` / `token `）+ 恰好一个引用。 */
export function isSafeSecretValue(value: string): boolean {
  return PREFIXED_REF.test(value.trim());
}

export function isPlaintextSecret(key: string, value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && SECRET_KEY.test(key) && !isSafeSecretValue(value);
}

/** 自由文本（args / url）里是否有疑似密钥的字面量。变量引用本身不算。 */
export function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.replace(new RegExp(REF, 'g'), ' ');
  if (SECRET_LIKE.some((re) => re.test(text))) return true;
  const hex = HEX_RUN.exec(text);
  if (hex && /[0-9]/.test(hex[0]) && /[a-fA-F]/.test(hex[0])) return true;
  for (const m of text.matchAll(B64_RUN)) {
    const run = m[0];
    // 只有混合了大小写和数字的长串才像随机密钥（排除 `modelcontextprotocol-server-…` 之类的包名）
    if (/[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

/** 扫描一个 server 条目（MCP 定义或已生成配置中的 server）的 env / headers / http_headers，以及 args / url。 */
export function scanServer(server: string, entry: unknown): SecretHit[] {
  if (!entry || typeof entry !== 'object') return [];
  const e = entry as Record<string, unknown>;
  const hits: SecretHit[] = [];
  for (const field of ['env', 'headers', 'http_headers']) {
    const rec = e[field];
    if (!rec || typeof rec !== 'object') continue;
    for (const [key, value] of Object.entries(rec)) if (isPlaintextSecret(key, value)) hits.push({ server, field, key, level: 'error' });
  }
  if (Array.isArray(e.args)) {
    e.args.forEach((a, i) => {
      if (looksLikeSecret(a)) hits.push({ server, field: 'args', key: String(i), level: 'warn' });
    });
  }
  if (looksLikeSecret(e.url)) hits.push({ server, field: 'url', key: 'url', level: 'warn' });
  return hits;
}

/** 扫描一组 server（`{ name: entry }`）。 */
export function scanServers(servers: unknown): SecretHit[] {
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers).flatMap(([name, entry]) => scanServer(name, entry));
}

/** 一组命中的最高级别；没有命中为 null。 */
export function hitLevel(hits: SecretHit[]): 'error' | 'warn' | null {
  if (!hits.length) return null;
  return hits.some((h) => h.level === 'error') ? 'error' : 'warn';
}
