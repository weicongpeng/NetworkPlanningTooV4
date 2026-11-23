/**
 * 协作沟通页面 → 应用级「用户设置」弹窗（MainLayout 挂载）的轻量事件通道。
 *
 * mode 决定弹窗内容：
 *  - 'app'：左侧边栏用户冒泡框「设置」→ 头像 + 修改密码（密码统一收口到这里）
 *  - 'im' ：协作沟通左下角「设置」→ 头像 + 昵称（不提供修改密码）
 */
export const USER_SETTINGS_EVENT = 'npt:user-settings'

export type UserSettingsMode = 'app' | 'im'

export function openUserSettings(mode: UserSettingsMode = 'app'): void {
  window.dispatchEvent(new CustomEvent<UserSettingsMode>(USER_SETTINGS_EVENT, { detail: mode }))
}
