import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { desktopCloudApi } from '../services/api'
import { useAuthStore } from '../store/authStore'
import { useToastStore } from '../store/toastStore'

/**
 * 桌面端登录态守卫：同一账号在网页端或另一台桌面端登录时，本机自动退出登录。
 * 后端也会让本机令牌失效（下次请求 401），这里只是把提示提前（不依赖用户操作）。
 *
 * 同时消费巡检结果：
 * - 离线/在线状态（单机模式离线登录后，联网即自动校验授权）
 * - 授权校验通过（一次性提示续期后的到期日）/ 授权异常（服务器明确拒绝时提示）
 */
export function DesktopSessionGuard() {
  const { t } = useTranslation()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  // 授权异常只在内容变化时提示一次（30s 轮询不重复打扰）
  const lastLicenseError = useRef('')

  useEffect(() => {
    if (!desktopMode || !isAuthenticated) return

    let cancelled = false
    const check = async () => {
      try {
        const res = await desktopCloudApi.getSessionStatus()
        if (cancelled || !res.success) return
        const data = res.data
        if (data?.valid === false) {
          useToastStore
            .getState()
            .show(data.reason || t('desktopAuth.kicked', '该账号已在其它设备登录，本机已退出登录'))
          await useAuthStore.getState().logout()
          return
        }
        if (typeof data?.offline === 'boolean') {
          useAuthStore.getState().setDesktopOffline(Boolean(data.offline))
        }
        if (data?.license_verified) {
          // 能完成校验说明已联网
          useAuthStore.getState().setDesktopOffline(false)
          useToastStore.getState().show(
            t('desktopAuth.licenseVerified', {
              date: data.license_expire_date || '-',
              defaultValue: '已连接服务器，授权校验通过（有效期至 {{date}}）',
            })
          )
        }
        if (data?.license_error && data.license_error !== lastLicenseError.current) {
          lastLicenseError.current = data.license_error
          useAuthStore.getState().setDesktopOffline(false)
          useToastStore.getState().show(
            t('desktopAuth.licenseError', {
              message: data.license_error,
              defaultValue: '授权校验异常：{{message}}',
            })
          )
        }
        // 心跳同时同步权限位：管理员在「用户管理 → 编辑」改动后无需重登即生效
        if (data?.user) {
          useAuthStore.getState().applyServerUser(data.user)
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
