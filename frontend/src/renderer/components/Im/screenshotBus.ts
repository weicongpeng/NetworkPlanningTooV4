/**
 * 截图功能的全局事件总线。
 *
 * 截图弹窗从 ImComposer 提到 ImHost（应用级）挂载：这样 Alt+Z / 桌面端系统级热键
 * 在「协作沟通」窗口没打开、没有激活会话时也能唤起截图；截图结果再由 imStore 的
 * pendingScreenshot 队列交给当前会话的输入框，不依赖弹窗挂在哪个组件下面。
 */
/** 请求打开截图弹窗（输入框按钮 / 全局快捷键统一入口） */
export const SCREENSHOT_OPEN_EVENT = 'npt:screenshot-open'
/** 桌面壳 Win32 RegisterHotKey(Alt+Z) 或窗口级 Alt+Z 捕获后派发 */
export const SCREENSHOT_HOTKEY_EVENT = 'npt:screenshot-hotkey'

export function requestScreenshot(): void {
  window.dispatchEvent(new CustomEvent(SCREENSHOT_OPEN_EVENT))
}

export function fireScreenshotHotkey(): void {
  window.dispatchEvent(new CustomEvent(SCREENSHOT_HOTKEY_EVENT))
}
