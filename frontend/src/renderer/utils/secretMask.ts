/**
 * 密钥 / Token 脱敏显示工具。
 *
 * 仅用于 UI 展示：返回的掩码字符串不是真实值，绝不能作为表单值回写保存，
 * 否则会把掩码当成新密钥提交。
 */

/**
 * 脱敏任意密钥：过短则全部掩码；否则保留头部与尾部、中间以圆点替代。
 * @param secret 原始密钥
 * @param head 保留头部字符数
 * @param tail 保留尾部字符数
 */
export function maskSecret(secret: string, head = 6, tail = 4): string {
  if (!secret) return ''
  if (secret.length <= head + tail) {
    return '•'.repeat(secret.length)
  }
  return `${secret.slice(0, head)}${'•'.repeat(8)}${secret.slice(secret.length - tail)}`
}
