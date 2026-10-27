/**
 * 「下载应用」弹窗（手机APP / 电脑端）。
 *
 * 从 MainLayout 抽出为独立组件，两个入口共用：
 * - 网页端：地图右侧可拖拽的悬浮下载图标（MainLayout）
 * - 桌面端：frameless 窗口自绘标题栏上的下载按钮（WindowTitleBar）
 * 数据加载（最新版本 / 桌面安装包）随弹窗打开触发，行为与原 MainLayout 内联实现一致。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Loader2, MonitorDown, Smartphone, X } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { appVersionsApi, desktopCloudApi, desktopReleasesApi } from '../services/api'

type Props = {
  open: boolean
  onClose: () => void
}

export function AppDownloadDialog({ open, onClose }: Props) {
  const { t } = useTranslation()
  const desktopMode = useAuthStore((s) => s.desktopMode)
  // 桌面端形态本身就是电脑端，不提供「电脑端」下载栏
  const [appTab, setAppTab] = useState<'mobile' | 'desktop'>('mobile')
  const [latestVersion, setLatestVersion] = useState<any>(null)
  const [versionLoading, setVersionLoading] = useState(false)
  // 电脑端：桌面版安装包分发（公开接口取最新版本，点击后交给浏览器下载）
  const [desktopRelease, setDesktopRelease] = useState<any>(null)
  const [desktopVersionLoading, setDesktopVersionLoading] = useState(false)

  // 打开弹窗时回到「手机APP」栏（原有下载方式不变）
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

  // 电脑端版本：切换/打开该栏时按需拉取（取桌面版分发里发布的安装包）
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

  if (!open) return null

  const getFullDownloadUrl = (downloadUrl: string) => {
    if (!downloadUrl) return ''
    if (downloadUrl.startsWith('http')) return downloadUrl
    const base = window.location.origin
    return `${base}${downloadUrl}`
  }

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

          {/* 下载方式切换：手机APP / 电脑端（桌面端形态不显示电脑端） */}
          {!desktopMode && (
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
          )}

          {/* 弹窗内容 */}
          <div className="p-5 flex flex-col items-center space-y-4">
            {appTab === 'desktop' ? (
              /* 电脑端：从桌面版分发取最新安装包，点击后由浏览器接管下载 */
              desktopVersionLoading ? (
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
