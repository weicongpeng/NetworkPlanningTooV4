/**
 * 截图功能的全局事件总线。
 *
 * 截图弹窗从 ImComposer 提到 ImHost（应用级）挂载：这样快捷键 / 桌面端系统级热键
 * 在「协作沟通」窗口没打开、没有激活会话时也能唤起截图；截图结果再由 imStore 的
 * pendingScreenshot 队列交给当前会话的输入框，不依赖弹窗挂在哪个组件下面。
 */
/** 请求打开截图弹窗（输入框按钮 / 全局快捷键统一入口） */
export const SCREENSHOT_OPEN_EVENT = 'npt:screenshot-open'
/** 桌面壳 Win32 RegisterHotKey 或窗口级快捷键捕获后派发 */
export const SCREENSHOT_HOTKEY_EVENT = 'npt:screenshot-hotkey'
/** 打开截图设置面板（截图按钮下拉的「设置」项） */
export const SCREENSHOT_SETTINGS_EVENT = 'npt:screenshot-settings'
/** 抓屏前收起截图按钮下拉等浮层，避免它们出现在整屏快照里 */
export const SCREENSHOT_STABILIZE_EVENT = 'npt:screenshot-stabilize'

/**
 * 取景期间挂在 <body> 上：index.css 据此隐藏协作沟通会话窗口、悬浮图标等置顶浮层。
 * 网页端用它保证 getDisplayMedia 缩略图干净；桌面端开启「隐藏窗口截图」时用它保证
 * 壳层抓到的整屏快照里不出现会话窗口控件。
 */
export const CAPTURE_FLAG = 'data-npt-capturing'
/**
 * 桌面端「隐藏窗口截图」专用标记：只隐藏协作沟通会话窗口与悬浮图标。
 * 与 CAPTURE_FLAG 分开，因为桌面端取景期间弹窗根本不打开（避免把黑色遮罩截进快照），
 * 而网页端取景需要连截图工具自身的浮层一起隐藏。
 */
export const HIDE_IM_FLAG = 'data-npt-hide-im'
/** 设置面板正在录制快捷键：应用级截图快捷键监听据此让路，避免按下组合键直接触发截图 */
export const HOTKEY_RECORDING_FLAG = 'data-npt-recording-hotkey'

export function requestScreenshot(): void {
  window.dispatchEvent(new CustomEvent(SCREENSHOT_OPEN_EVENT))
}

export function fireScreenshotHotkey(): void {
  window.dispatchEvent(new CustomEvent(SCREENSHOT_HOTKEY_EVENT))
}

export function openScreenshotSettings(): void {
  window.dispatchEvent(new CustomEvent(SCREENSHOT_SETTINGS_EVENT))
}

/** 设置/清除取景标记；重复调用幂等，关闭弹窗时务必清除 */
export function setCaptureFlag(active: boolean): void {
  if (active) document.body.setAttribute(CAPTURE_FLAG, '')
  else document.body.removeAttribute(CAPTURE_FLAG)
}

/** 桌面端「隐藏窗口截图」开关：只隐藏会话窗口控件，NPT 主窗口业务内容照常可截 */
export function setHideImWindowFlag(active: boolean): void {
  if (active) document.body.setAttribute(HIDE_IM_FLAG, '')
  else document.body.removeAttribute(HIDE_IM_FLAG)
}

export function setHotkeyRecordingFlag(active: boolean): void {
  if (active) document.body.setAttribute(HOTKEY_RECORDING_FLAG, '')
  else document.body.removeAttribute(HOTKEY_RECORDING_FLAG)
}

/** 无条件清掉两个取景标记：任何一轮取景开始/结束都不允许残留，否则会话窗口会一直被隐藏 */
export function clearCaptureFlags(): void {
  document.body.removeAttribute(CAPTURE_FLAG)
  document.body.removeAttribute(HIDE_IM_FLAG)
}

/**
 * 桌面端抓屏前的 DOM 稳定化：收起下拉、清残留标记、按开关只设隐藏标记。
 * 会话窗口是 WebView2 内的 DOM 浮层，壳层抓的是某一瞬间的整屏位图；
 * 「关闭隐藏窗口截图」时必须保证它按屏幕原样出现在那一帧里，不能靠主动开窗补救。
 */
export function prepareScreenshotDom(hideImWindow: boolean): void {
  window.dispatchEvent(new CustomEvent(SCREENSHOT_STABILIZE_EVENT))
  clearCaptureFlags()
  if (hideImWindow) document.body.setAttribute(HIDE_IM_FLAG, '')
}

/**
 * 等两个渲染帧：第一帧让 React 提交状态更新、卸载截图弹窗遮罩与下拉并执行 effect cleanup，
 * 第二帧让 WebView2 完成合成（visibility / opacity 过渡生效）后再允许壳层抓屏。
 */
export function waitForStableFrames(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame !== 'function') {
      window.setTimeout(resolve, 32)
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}
