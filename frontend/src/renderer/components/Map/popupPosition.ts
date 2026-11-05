/**
 * 地图浮层（属性弹窗 / 重叠要素选择菜单）定位工具
 *
 * 弹窗使用 position:fixed（视口坐标），但地图只占页面右侧区域（左侧有图层控制面板、
 * 顶部有工具栏）。此前按 window 视口钳制（甚至完全不钳制），点击地图边缘要素时
 * 弹窗会溢出地图视窗被裁切。统一改为按「地图容器矩形」钳制，保证弹窗全尺寸可见。
 */

export interface MapViewportBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PopupSize {
  width: number
  height: number
}

/**
 * 计算弹窗固定定位坐标，使弹窗完整落在 bounds 内部。
 *
 * 优先显示在点击点右侧/下方；空间不足时翻转到左侧/上方；仍不足则贴边钳制。
 *
 * @param anchor 点击位置（clientX/clientY，视口坐标）
 * @param size   弹窗预估尺寸（高可用最大高度，内部滚动区域自行裁切）
 * @param bounds 地图容器视口矩形（getBoundingClientRect）；为空时回退到点击点右下偏移
 * @param gap    与点击点/视口边缘的间距
 */
export function clampPopupPosition(
  anchor: { x: number; y: number },
  size: PopupSize,
  bounds?: MapViewportBounds | null,
  gap = 8
): { left: number; top: number } {
  if (!bounds) {
    return { left: anchor.x + 10, top: anchor.y }
  }

  const minLeft = bounds.left + gap
  const maxLeft = Math.max(minLeft, bounds.right - gap - size.width)
  const minTop = bounds.top + gap
  const maxTop = Math.max(minTop, bounds.bottom - gap - size.height)

  // 水平：优先右侧，放不下翻到点击点左侧，最后钳制到视口内
  let left = anchor.x + 12
  if (left > maxLeft) {
    left = anchor.x - 12 - size.width
  }
  left = Math.min(Math.max(left, minLeft), maxLeft)

  // 垂直：优先下方（与点击点齐平），放不下翻到点击点上方，最后钳制
  let top = anchor.y
  if (top > maxTop) {
    top = anchor.y - size.height
  }
  top = Math.min(Math.max(top, minTop), maxTop)

  return { left, top }
}
