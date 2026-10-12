const CJK = /[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/** ASCII（及其它非 CJK）字符数 ÷ 4 + CJK 字符数 ÷ 1.5，四舍五入。 */
export function estimateTokens(text: string): number {
  let other = 0;
  let cjk = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.round(other / 4 + cjk / 1.5);
}

export function skillTokens(name: string, description: string | undefined): number {
  return estimateTokens(description ? `${name} ${description}` : name);
}
