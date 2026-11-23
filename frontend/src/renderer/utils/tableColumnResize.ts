/**
 * 全局表格列宽拖拽（document 事件委托，应用入口调用一次）。
 *
 * 支持两类表格：
 * - <table class="npt-resizable">：首次拖拽时按当前渲染宽度生成 <colgroup> 并切换 fixed 布局，
 *   动态列、条件渲染的表格自动生效，接入前后初始布局完全一致。
 * - [data-npt-div-table] 内 [data-npt-header] 的 div 模拟表格：列宽写到容器的
 *   --npt-col-<index> CSS 变量，由 CSS 同步到表头/过滤行/虚拟滚动数据行。
 *
 * 拖拽热区为表头单元格右边缘 8px，复用 index.css 的 ::after 提示与
 * body.resizing-column 全局光标/禁选中样式。
 */
const MIN_COL_WIDTH = 48
const HANDLE_HIT_WIDTH = 8

type DragState = {
  startX: number
  startWidth: number
  apply: (width: number) => void
}

export function enableTableColumnResize(): () => void {
  let drag: DragState | null = null

  const onMouseMove = (e: MouseEvent) => {
    if (!drag) return
    drag.apply(Math.max(MIN_COL_WIDTH, drag.startWidth + e.clientX - drag.startX))
  }

  const onMouseUp = () => {
    drag = null
    document.body.classList.remove('resizing-column')
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  const startDrag = (e: MouseEvent, startWidth: number, apply: (width: number) => void) => {
    e.preventDefault()
    document.body.classList.add('resizing-column')
    drag = { startX: e.clientX, startWidth, apply }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  const ensureColgroup = (table: HTMLTableElement, count: number): HTMLTableColElement | null => {
    let group = table.querySelector(':scope > colgroup[data-npt-resize]') as HTMLTableColElement | null
    if (group && group.children.length !== count) {
      group.remove()
      group = null
    }
    if (!group) {
      group = document.createElement('colgroup')
      group.dataset.nptResize = '1'
      for (let i = 0; i < count; i += 1) group.appendChild(document.createElement('col'))
      table.insertBefore(group, table.firstChild)
    }
    return group
  }

  const handleTable = (e: MouseEvent, cell: HTMLTableCellElement) => {
    const table = cell.closest('table.npt-resizable') as HTMLTableElement | null
    if (!table) return
    const row = table.tHead?.rows[0]
    if (!row || cell.parentElement !== row) return
    const rect = cell.getBoundingClientRect()
    if (e.clientX < rect.right - HANDLE_HIT_WIDTH) return

    const cells = Array.from(row.cells)
    const index = cells.indexOf(cell)
    const group = ensureColgroup(table, cells.length)
    if (index < 0 || !group) return
    // 首次拖拽：把当前渲染宽度写进 colgroup，避免切换 fixed 布局时列宽跳变
    cells.forEach((c, i) => {
      const col = group.children[i] as HTMLTableColElement
      if (!col.style.width) col.style.width = `${Math.round(c.getBoundingClientRect().width)}px`
    })
    table.style.tableLayout = 'fixed'

    const col = group.children[index] as HTMLTableColElement
    const startWidth = parseFloat(col.style.width) || rect.width
    startDrag(e, startWidth, (width) => { col.style.width = `${width}px` })
  }

  const handleDivTable = (e: MouseEvent, target: HTMLElement) => {
    const header = target.closest('[data-npt-header]') as HTMLElement | null
    if (!header || target.parentElement !== header) return
    const root = header.closest('[data-npt-div-table]') as HTMLElement | null
    if (!root) return
    const rect = target.getBoundingClientRect()
    if (e.clientX < rect.right - HANDLE_HIT_WIDTH) return

    const cells = Array.from(header.children) as HTMLElement[]
    const index = cells.indexOf(target)
    if (index < 0) return
    cells.forEach((c, i) => {
      if (!root.style.getPropertyValue(`--npt-col-${i}`)) {
        root.style.setProperty(`--npt-col-${i}`, `${Math.round(c.getBoundingClientRect().width)}px`)
      }
    })
    const varName = `--npt-col-${index}`
    const startWidth = parseFloat(root.style.getPropertyValue(varName)) || rect.width
    // 标记为弹性的列（如小区名称）由 flex 变量驱动，拖拽后改为固定宽度，
    // 否则 flex-grow 会把用户拖出来的宽度重新吃回去
    const isFlexCol = cells[index].hasAttribute('data-npt-flex-col')
    startDrag(e, startWidth, (width) => {
      root.style.setProperty(varName, `${width}px`)
      if (isFlexCol) {
        root.style.setProperty(`${varName}-flex`, `0 0 ${width}px`)
        root.style.setProperty(`${varName}-width`, `${width}px`)
      }
    })
  }

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || drag) return
    const target = e.target as HTMLElement | null
    if (!target?.closest) return

    const cell = target.closest('th, td') as HTMLTableCellElement | null
    if (cell) {
      handleTable(e, cell)
      return
    }
    handleDivTable(e, target)
  }

  document.addEventListener('mousedown', onMouseDown)
  return () => {
    document.removeEventListener('mousedown', onMouseDown)
    onMouseUp()
  }
}
