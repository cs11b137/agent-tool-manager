/**
 * 极简 YAML frontmatter 解析：只支持 `key: value`、单/双引号字符串，
 * 以及缩进续行（折叠成一个空格连接的字符串，兼容 `description: >` 写法）。
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const src = text.replace(/^\uFEFF/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return {};
  const out: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const rawLine of m[1]!.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/.exec(rawLine);
    if (kv && !/^\s/.test(rawLine)) {
      lastKey = kv[1]!;
      const v = (kv[2] ?? '').trim();
      out[lastKey] = v === '>' || v === '|' || v === '>-' || v === '|-' ? '' : unquote(v);
      continue;
    }
    if (lastKey && /^\s/.test(rawLine)) {
      const cont = rawLine.trim();
      out[lastKey] = out[lastKey] ? `${out[lastKey]} ${cont}` : cont;
    }
  }
  return out;
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\nt])/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  // 去掉行尾注释（` #` 开头）
  const hash = v.search(/\s#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}
