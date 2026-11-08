/**
 * 版本号比较：a>b 返回 1，a<b 返回 -1，相等返回 0。
 * 数字段按数值比较（避免 "9" > "37" 的字符串误判），非数字段按字符串比较。
 *
 * OTA 各处提示（自动检查 / 更新就绪弹窗 / 版本栏提示条）共用这一口径，
 * 保证「目标版本不高于当前版本」时一律不提示更新。
 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '').split(/[.\-_+]/)
  const pb = String(b || '').split(/[.\-_+]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? '', 10)
    const nb = Number.parseInt(pb[i] ?? '', 10)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na > nb ? 1 : -1
    } else if ((pa[i] ?? '') !== (pb[i] ?? '')) {
      return (pa[i] ?? '') > (pb[i] ?? '') ? 1 : -1
    }
  }
  return 0
}
