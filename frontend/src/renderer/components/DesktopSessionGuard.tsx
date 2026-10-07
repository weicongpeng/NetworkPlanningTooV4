import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { desktopCloudApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useToastStore } from '../store/toastStore'

/**
 * 桌面端登录态守卫：同一账号在网页端或另一台桌面端登录时，本机自动退出登录。
 * 后端也会让本机令牌失效（下次请求 401），这里只是把提示提前（不依赖用户操作）。
 */
export function DesktopSessionGuard() {
  const { t } = useTranslation()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)

  useEffect(() => {
    if (!desktopMode || !isAuthenticated) return

    let cancelled = false
    const check = async () => {
      try {
        const res = await desktopCloudApi.getSessionStatus()
        if (cancelled || !res.success) return
        if (res.data?.valid === false) {
          useToastStore
            .getState()
            .show(res.data.reason || t('desktopAuth.kicked', '该账号已在其它设备登录，本机已退出登录'))
          await useAuthStore.getState().logout()
        }
      } catch {
        // 401 时 api 拦截器已处理；其它异常静默，等下个周期
      }
    }

    void check()
    const timer = window.setInterval(check, 30000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [desktopMode, isAuthenticated, t])

  return null
}
