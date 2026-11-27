import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Package } from 'lucide-react'
import { DesktopReleasesPage } from './DesktopReleasesPage'
import { MobileReleasesPage } from './MobileReleasesPage'

type DistributionTab = 'desktop' | 'mobile'

/** 版本管理：桌面端分发（逻辑不变）与移动端分发共用一个入口。 */
export function VersionManagementPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab: DistributionTab = searchParams.get('tab') === 'mobile' ? 'mobile' : 'desktop'

  const switchTab = (next: DistributionTab) => {
    setSearchParams(next === 'desktop' ? {} : { tab: next }, { replace: true })
  }

  return (
    <div className="w-full">
      <div className="px-6 pt-5 flex items-center gap-2">
        <Package size={20} className="text-primary" />
        <h1 className="text-base font-bold">{t('versionManagement.title')}</h1>
      </div>
      <div role="tablist" className="px-6 mt-4 flex gap-6 border-b border-border">
        <button
          role="tab"
          aria-selected={activeTab === 'desktop'}
          onClick={() => switchTab('desktop')}
          className={`pb-2 text-sm border-b-2 -mb-px transition-colors ${
            activeTab === 'desktop'
              ? 'border-primary text-primary font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('versionManagement.desktopTab')}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'mobile'}
          onClick={() => switchTab('mobile')}
          className={`pb-2 text-sm border-b-2 -mb-px transition-colors ${
            activeTab === 'mobile'
              ? 'border-primary text-primary font-medium'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('versionManagement.mobileTab')}
        </button>
      </div>
      {activeTab === 'desktop' ? <DesktopReleasesPage /> : <MobileReleasesPage />}
    </div>
  )
}
