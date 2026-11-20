/**
 * 提取用户可见属性：剔除 '_' 前缀的内部字段
 * （_editId / _editStyle / _style / _shape / _ellipse / _isNew 等）。
 *
 * 手形工具属性弹窗与选择/编辑各路径统一使用，保证非编辑态与编辑态
 * 弹窗展示的属性内容一致（内部字段不呈现给用户）。
 * 始终返回新对象，不修改入参。
 */
export function cleanUserProperties(
  props: Record<string, any> | null | undefined,
): Record<string, any> {
  const out: Record<string, any> = {}
  if (!props) return out
  for (const [k, v] of Object.entries(props)) {
    if (!k.startsWith('_')) out[k] = v
  }
  return out
}
