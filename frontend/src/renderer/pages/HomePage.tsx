import {
  Database,
  Settings,
  Network,
  Layers,
  MapPin,
  Map,
  Shield,
  LucideIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function HomePage() {
  const { t } = useTranslation()

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">{t('home.title')} v2.0</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* 功能卡片 */}
        <FeatureCard
          title={t('nav.data')}
          description={t('home.dataDesc') || '导入和管理工参数据'}
          icon={Database}
          link="/data"
          iconColor="text-blue-500"
        />
        <FeatureCard
          title={t('nav.pci')}
          description={t('home.pciDesc') || 'LTE和NR的PCI自动规划'}
          icon={Settings}
          link="/pci"
          iconColor="text-purple-500"
        />
        <FeatureCard
          title={t('nav.neighbor')}
          description={t('home.neighborDesc') || '自动生成邻区关系'}
          icon={Network}
          link="/neighbor"
          iconColor="text-green-500"
        />
        <FeatureCard
          title={t('nav.tac')}
          description={t('home.tacDesc') || '对比图层TAC与现网TAC，统计一致性'}
          icon={Layers}
          link="/tac"
          iconColor="text-orange-500"
        />
        <FeatureCard
          title={t('nav.tacPlanning')}
          description={t('home.tacPlanningDesc') || '数据驱动的新站小区TAC分配'}
          icon={MapPin}
          link="/tac-planning"
          iconColor="text-red-500"
        />
        <FeatureCard
          title={t('nav.map')}
          description={t('home.mapDesc') || '查看基站分布和覆盖'}
          icon={Map}
          link="/map"
          iconColor="text-cyan-500"
        />
        <FeatureCard
          title={t('nav.config')}
          description={t('home.configDesc') || '管理系统配置'}
          icon={Shield}
          link="/license"
          iconColor="text-slate-500"
        />
      </div>

      {/* 系统状态 */}
      <div className="mt-8 p-6 bg-card rounded-lg border border-border">
        <h2 className="text-xl font-semibold mb-4">{t('home.systemStatus')}</h2>
        <div className="space-y-2">
          <StatusItem label={t('home.backendService') || '后端服务'} status="online" />
          <StatusItem label={t('home.database') || '数据库'} status="online" />
          <StatusItem label={t('home.license') || '许可证'} status="valid" />
        </div>
      </div>
    </div>
  )
}

function FeatureCard({
  title,
  description,
  icon: Icon,
  link,
  iconColor
}: {
  title: string
  description: string
  icon: LucideIcon
  link: string
  iconColor?: string
}) {
  return (
    <a
      href={link}
      className="block p-6 bg-card rounded-lg border border-border hover:border-primary transition-all duration-300 hover:shadow-md group"
    >
      <div className={`mb-4 p-3 rounded-lg bg-muted w-fit group-hover:scale-110 transition-transform ${iconColor}`}>
        <Icon size={32} />
      </div>
      <h3 className="text-lg font-semibold mb-2 group-hover:text-primary transition-colors">{title}</h3>
      <p className="text-muted-foreground text-sm">{description}</p>
    </a>
  )
}

function StatusItem({
  label,
  status
}: {
  label: string
  status: 'online' | 'offline' | 'valid' | 'invalid'
}) {
  const { t } = useTranslation()

  const statusConfig = {
    online: { color: 'text-green-500', text: t('home.online') || '运行中' },
    offline: { color: 'text-red-500', text: t('home.offline') || '离线' },
    valid: { color: 'text-green-500', text: t('home.valid') || '已激活' },
    invalid: { color: 'text-red-500', text: t('home.invalid') || '未激活' }
  }

  const config = statusConfig[status]

  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span className={config.color}>{config.text}</span>
    </div>
  )
}
