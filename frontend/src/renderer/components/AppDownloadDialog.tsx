/**
 * 「下载应用」弹窗（移动 APP / 桌面端更新）。
 *
 * 从 MainLayout 抽出为独立组件，两个入口共用：
 * - 网页端：地图右侧可拖拽的悬浮下载图标（MainLayout）
 * - 桌面端：frameless 窗口自绘标题栏上的下载按钮（WindowTitleBar）
 *
 * 两栏语义：
 * - **移动 APP 下载**：二维码扫码 + 直接下载 APK（桌面端形态取服务器最新版，链接拼成绝对地址才能被手机扫到）
 * - **桌面端更新**：
 *   - 桌面端形态 → 读本机 OTA 状态（`/desktop/update/status`），显示当前/最新版本，
 *     点「立即更新」把结果交给全局 `DesktopUpdateDialog` 下载安装（不维护第二套更新 UI）
 *   - 网页端形态 → 从桌面版分发取最新安装包，点击由浏览器下载
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Download, Loader2, MonitorDown, RefreshCw, Smartphone, X } from 'lucide-react'
import type { DesktopUpdateStatus } from '@shared/types'
import { useAuthStore } from '../store/authStore'
import { useDesktopUpdateStore } from '../store/desktopUpdateStore'
import { appVersionsApi, desktopCloudApi, desktopReleasesApi, desktopUpdateApi } from '../services/api'

type Props = {
  open: boolean
  onClose: () => void
}

export function AppDownloadDialog({ open, onClose }: Props) {
  const { t } = useTranslation()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  const [appTab, setAppTab] = useState<'mobile' | 'desktop'>('mobile')
  const [latestVersion, setLatestVersion] = useState<any>(null)
  const [versionLoading, setVersionLoading] = useState(false)
  // 电脑端（网页形态）：桌面版安装包分发（公开接口取最新版本，点击后交给浏览器下载）
  const [desktopRelease, setDesktopRelease] = useState<any>(null)
  const [desktopVersionLoading, setDesktopVersionLoading] = useState(false)
  // 桌面端（桌面形态）：本机 OTA 状态
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateMessage, setUpdateMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const requestUpdateCheck = useDesktopUpdateStore((s) => s.requestCheck)

  // 打开弹窗时回到「移动 APP 下载」栏（原有下载方式不变）
  useEffect(() => {
    if (open) setAppTab('mobile')
  }, [open])

  useEffect(() => {
    if (!open) return
    setVersionLoading(true)
    // 桌面端不分发 APK：取服务器最新版本（本机接口会拼出可扫码的绝对下载地址）
    const loader = desktopMode ? desktopCloudApi.appVersion() : appVersionsApi.getLatest()
    loader
      .then((res: any) => {
        if (res?.success && res?.data) setLatestVersion(res.data)
        else setLatestVersion(null)
      })
      .catch(() => setLatestVersion(null))
      .finally(() => setVersionLoading(false))
  }, [open, desktopMode])

  // 电脑端版本（网页形态）：切换/打开该栏时按需拉取（取桌面版分发里发布的安装包）
  useEffect(() => {
    if (!open || appTab !== 'desktop' || desktopMode) return
    setDesktopVersionLoading(true)
    desktopReleasesApi
      .latestPublic()
      .then((res: any) => {
        setDesktopRelease(res?.success && res?.data ? res.data : null)
      })
      .catch(() => setDesktopRelease(null))
      .finally(() => setDesktopVersionLoading(false))
  }, [open, appTab, desktopMode])

  /** 读本机 OTA 状态（仅桌面端形态有该接口；网页端 404 不会走到这里） */
  const refreshUpdateStatus = useCallback(async (): Promise<DesktopUpdateStatus | null> => {
    setUpdateChecking(true)
    setUpdateMessage(null)
    try {
      const res = await desktopUpdateApi.status()
      const data = res?.data ?? null
      setUpdateStatus(data)
      return data
    } catch {
      setUpdateMessage({ type: 'error', text: t('desktopUpdate.checkFailed') })
      return null
    } finally {
      setUpdateChecking(false)
    }
  }, [t])

  // 桌面端形态：切到「桌面端更新」栏时拉一次状态
  useEffect(() => {
    if (!open || !desktopMode || appTab !== 'desktop') return
    void refreshUpdateStatus()
  }, [open, desktopMode, appTab, refreshUpdateStatus])

  // 手动检查：有新版本不在这里弹第二个窗口，统一交给全局更新弹窗
  const handleCheckUpdate = useCallback(async () => {
    const data = await refreshUpdateStatus()
    if (!data) return
    if (data.update_available && data.release) {
      requestUpdateCheck(data)
      onClose()
    } else {
      setUpdateMessage({ type: 'success', text: t('desktopUpdate.upToDate') })
    }
  }, [refreshUpdateStatus, requestUpdateCheck, onClose, t])

  if (!open) return null

  const getFullDownloadUrl = (downloadUrl: string) => {
    if (!downloadUrl) return ''
    if (downloadUrl.startsWith('http')) return downloadUrl
    const base = window.location.origin
    return `${base}${downloadUrl}`
  }

  const currentVersion = updateStatus?.current || t('desktopUpdate.versionUnknown')
  const release = updateStatus?.release || null
  const hasUpdate = !!(updateStatus?.update_available && release)

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-sm mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 弹窗头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <Download size={18} />
            {t('app.downloadTitle')}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted text-muted-foreground"
          >
            <X size={18} />
          </button>
        </div>

        {/* 两栏：移动 APP 下载 / 桌面端更新（两端同构，桌面端形态下栏目同样可见） */}
        <div className="flex gap-1 px-5 pt-4">
          {([
            { key: 'mobile' as const, icon: Smartphone, label: t('app.tabMobile') },
            { key: 'desktop' as const, icon: MonitorDown, label: t('app.tabDesktop') },
          ]).map((tab) => {
            const TabIcon = tab.icon
            const active = appTab === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => setAppTab(tab.key)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm rounded-lg border transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:bg-muted'
                }`}
              >
                <TabIcon size={14} />
                {tab.label}
              </button>
            )
          })}
        </div>

        {/* 弹窗内容 */}
        <div className="p-5 flex flex-col items-center space-y-4">
          {appTab === 'desktop' ? (
            desktopMode ? (
              /* ===== 桌面端形态：本机 OTA ===== */
              <>
                <MonitorDown size={44} className="text-primary" />
                <div className="text-center space-y-1">
                  <p className="text-sm font-semibold text-foreground">
                    {t('desktopUpdate.currentVersion')} V{currentVersion}
                  </p>
                  {hasUpdate && release ? (
                    <p className="text-xs text-muted-foreground">
                      {t('app.latestVersion')} V{release.version}
                      {release.file_size_display ? ` · ${release.file_size_display}` : ''}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground flex items-center justify-center gap-1">
                      <CheckCircle2 size={13} />
                      {t('desktopUpdate.upToDate')}
                    </p>
                  )}
                  {hasUpdate && release?.release_notes && (
                    <p className="text-xs text-muted-foreground max-w-xs whitespace-pre-line">
                      {release.release_notes}
                    </p>
                  )}
                </div>

                {hasUpdate && (
                  <button
                    onClick={() => {
                      // 下载/进度/重启安装都在全局更新弹窗里，这里只负责交接
                      requestUpdateCheck(updateStatus as DesktopUpdateStatus)
                      onClose()
                    }}
                    className="inline-flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity text-sm font-medium"
                  >
                    <Download size={16} />
                    <span>{t('desktopUpdate.updateNow')}</span>
                  </button>
                )}

                <button
                  onClick={handleCheckUpdate}
                  disabled={updateChecking}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary disabled:opacity-60"
                >
                  <RefreshCw size={12} className={updateChecking ? 'animate-spin' : undefined} />
                  {updateChecking ? t('desktopUpdate.checking') : t('desktopUpdate.checkButton')}
                </button>
                {updateMessage && (
                  <p className={`text-xs ${updateMessage.type === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {updateMessage.text}
                  </p>
                )}
              </>
            ) : desktopVersionLoading ? (
              /* ===== 网页端形态：下载桌面安装包 ===== */
              <div className="py-8 text-muted-foreground flex flex-col items-center gap-2">
                <Loader2 size={24} className="animate-spin" />
                <span className="text-sm">{t('app.loadingVersion')}</span>
              </div>
            ) : desktopRelease ? (
              <>
                <MonitorDown size={44} className="text-primary" />
                <div className="text-center">
                  <p className="text-sm font-semibold text-foreground">
                    {t('app.latestVersion')} V{desktopRelease.version}
                    {desktopRelease.file_size_display ? ` · ${desktopRelease.file_size_display}` : ''}
                  </p>
                  {desktopRelease.release_notes && (
                    <p className="text-xs text-muted-foreground mt-1 max-w-xs whitespace-pre-line">
                      {desktopRelease.release_notes}
                    </p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{t('app.desktopInstallHint')}</p>
                {/* 交给浏览器下载（新标签），与 APK 的 <a download> 行为区分：安装包走浏览器下载管理 */}
                <a
                  href={getFullDownloadUrl(desktopRelease.download_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity text-sm font-medium"
                >
                  <Download size={16} />
                  <span>{t('app.downloadDesktop')}</span>
                </a>
              </>
            ) : (
              <div className="py-8 text-muted-foreground text-center">
                <p className="text-sm">{t('app.desktopNoVersion')}</p>
                <p className="text-xs mt-1">{t('app.desktopUploadHint')}</p>
              </div>
            )
          ) : versionLoading ? (
            <div className="py-8 text-muted-foreground flex flex-col items-center gap-2">
              <Loader2 size={24} className="animate-spin" />
              <span className="text-sm">{t('app.loadingVersion')}</span>
            </div>
          ) : latestVersion ? (
            <>
              {/* 二维码 */}
              {(() => {
                const downloadUrl = getFullDownloadUrl(latestVersion.download_url)
                const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(downloadUrl)}`
                return (
                  <div className="bg-card p-3 rounded-lg shadow-sm border border-border">
                    <img
                      src={qrUrl}
                      alt={t('app.downloadTitle')}
                      className="w-[200px] h-[200px]"
                      crossOrigin="anonymous"
                    />
                  </div>
                )
              })()}

              {/* 版本信息 */}
              <div className="text-center">
                <p className="text-sm font-semibold text-foreground">
                  {t('app.latestVersion')} V{latestVersion.version}
                  {latestVersion.file_size_display ? ` · ${latestVersion.file_size_display}` : ''}
                </p>
                {latestVersion.changelog && (
                  <p className="text-xs text-muted-foreground mt-1 max-w-xs whitespace-pre-line">
                    {latestVersion.changelog}
                  </p>
                )}
              </div>

              {/* 扫码提示 */}
              <p className="text-xs text-muted-foreground">
                {t('app.installHint')}
              </p>

              {/* 下载按钮 */}
              <a
                href={getFullDownloadUrl(latestVersion.download_url)}
                download
                className="inline-flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity text-sm font-medium"
              >
                <Download size={16} />
                <span>{t('app.downloadApk')}</span>
              </a>
            </>
          ) : (
            <div className="py-8 text-muted-foreground text-center">
              <p className="text-sm">{t('app.noVersionAvailable')}</p>
              <p className="text-xs mt-1">{t('app.uploadApkHint')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
