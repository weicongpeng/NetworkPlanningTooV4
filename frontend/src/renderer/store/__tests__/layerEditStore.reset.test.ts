/**
 * 切账号 / 登出时的编辑态清理（用户私有数据隔离）。
 *
 * layerEditStore 是全局内存 store（无 persist），退出登录只卸载页面、不会清它：
 * 上一账号"打开过"的图层会以编辑会话的形式渲染出来（编辑会话渲染不受图层勾选控制），
 * 下一个账号还能捡到别人未保存的改动继续编辑/保存。这里锁定 resetForUserSwitch 的口径。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useLayerEditStore } from '../layerEditStore'

function seedUserPrivateState() {
  const s = useLayerEditStore.getState()
  s.beginEdit('layer-a', 'data-1', 'polygon', [
    { geometry: { type: 'Polygon', coordinates: [[[114.7, 23.7], [114.8, 23.7], [114.8, 23.8], [114.7, 23.7]]] }, properties: {}, editable: true },
  ])
  s.copyToClipboard([
    { geometry: { type: 'Point', coordinates: [114.7, 23.7] }, properties: {}, sourceLayerName: 'layer-a' },
  ])
  s.setDrawTool('polygon')
  s.setSelectMode(true)
  s.setSnapEnabled(true)
}

describe('layerEditStore.resetForUserSwitch', () => {
  beforeEach(() => {
    useLayerEditStore.getState().resetForUserSwitch()
  })

  it('清空工作集 / 撤销栈 / 剪贴板 / 编辑态与工具状态', () => {
    seedUserPrivateState()
    const before = useLayerEditStore.getState()
    expect(Object.keys(before.workspaces)).toContain('layer-a')
    expect(before.editableLayerId).toBe('layer-a')
    expect(before.clipboard.length).toBe(1)

    useLayerEditStore.getState().resetForUserSwitch()

    const after = useLayerEditStore.getState()
    expect(after.workspaces).toEqual({})
    expect(after.editableLayerId).toBeNull()
    expect(after.clipboard).toEqual([])
    expect(after.drawTool).toBe('none')
    expect(after.selectMode).toBe(false)
    expect(after.nodeMergeMode).toBe(false)
    expect(after.inspectFeature).toBeNull()
    // 撤销栈随工作集一起丢弃：新账号不可能回退到上一账号的编辑历史
    expect(after.canUndo('layer-a')).toBe(false)
  })

  it('保留工具栏偏好（节点捕获开关不属于用户数据）', () => {
    useLayerEditStore.getState().setSnapEnabled(true)
    useLayerEditStore.getState().resetForUserSwitch()
    expect(useLayerEditStore.getState().snapEnabled).toBe(true)
  })
})
