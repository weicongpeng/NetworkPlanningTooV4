/**
 * 网络状态监测演示页面
 *
 * 用于展示和测试网络状态指示器组件的各种状态
 */
import { useState } from 'react'
import { NetworkStatusIndicator, NetworkStatusAlert } from '../components/Map/NetworkStatusIndicator'

export default function NetworkStatusDemo() {
  const [demoAlertVisible, setDemoAlertVisible] = useState(false)
  const [demoMessage, setDemoMessage] = useState('')

  // 模拟不同的网络错误场景
  const scenarios = [
    {
      name: '网络连接异常',
      message: '无法连接到服务器，请检查网络设置',
      action: () => {
        setDemoMessage('无法连接到服务器，请检查网络设置')
        setDemoAlertVisible(true)
      }
    },
    {
      name: '后端服务离线',
      message: '后端服务未启动，请先启动后端服务',
      action: () => {
        setDemoMessage('后端服务未启动，请先启动后端服务')
        setDemoAlertVisible(true)
      }
    },
    {
      name: '地图瓦片加载失败',
      message: '在线地图瓦片加载失败，请检查网络连接',
      action: () => {
        setDemoMessage('在线地图瓦片加载失败，请检查网络连接')
        setDemoAlertVisible(true)
      }
    },
    {
      name: '请求超时',
      message: '请求超时，服务器响应时间过长',
      action: () => {
        setDemoMessage('请求超时，服务器响应时间过长')
        setDemoAlertVisible(true)
      }
    }
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-8">
      {/* 网络状态指示器 */}
      <NetworkStatusIndicator
        checkInterval={15000}
        onStatusChange={(status) => {
          console.log('网络状态变化:', status)
        }}
      />

      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-white mb-2">
          网络状态监测组件演示
        </h1>
        <p className="text-slate-400 mb-8">
          展示网络连接异常时的用户界面设计
        </p>

        {/* 演示场景 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          {scenarios.map((scenario) => (
            <button
              key={scenario.name}
              onClick={scenario.action}
              className="p-6 rounded-xl bg-slate-800/50 border border-slate-700 hover:border-rose-500/50 hover:bg-slate-800 transition-all duration-200 text-left group"
            >
              <h3 className="text-lg font-semibold text-white mb-2 group-hover:text-rose-400 transition-colors">
                {scenario.name}
              </h3>
              <p className="text-sm text-slate-400">
                {scenario.message}
              </p>
            </button>
          ))}
        </div>

        {/* 设计说明 */}
        <div className="p-6 rounded-xl bg-slate-800/30 border border-slate-700">
          <h2 className="text-xl font-semibold text-white mb-4">设计说明</h2>
          <div className="space-y-3 text-sm text-slate-300">
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-emerald-400 mt-1.5 flex-shrink-0" />
              <div>
                <strong className="text-white">航图雷达美学:</strong> 雷达扫描效果和脉冲动画，营造专业的网络规划工具氛围
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
              <div>
                <strong className="text-white">非阻塞式设计:</strong> 提示框固定在角落，不影响用户继续操作
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
              <div>
                <strong className="text-white">渐进式信息:</strong> 默认显示简洁状态，点击展开查看详细诊断信息
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-rose-400 mt-1.5 flex-shrink-0" />
              <div>
                <strong className="text-white">明确的操作引导:</strong> 提供"重试"按钮，明确的关闭选项
              </div>
            </div>
          </div>
        </div>

        {/* 状态说明 */}
        <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { status: 'online', label: '在线', color: 'emerald', desc: '所有服务正常' },
            { status: 'offline', label: '离线', color: 'rose', desc: '无法连接服务器' },
            { status: 'degraded', label: '降级', color: 'amber', desc: '部分功能受限' },
            { status: 'checking', label: '检测中', color: 'blue', desc: '正在检查状态' }
          ].map(({ status, label, color, desc }) => (
            <div key={status} className="p-4 rounded-lg bg-slate-800/50 border border-slate-700">
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-3 h-3 rounded-full bg-${color}-400`} />
                <span className="font-medium text-white">{label}</span>
              </div>
              <p className="text-xs text-slate-400">{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 演示用警告提示 */}
      <NetworkStatusAlert
        visible={demoAlertVisible}
        message={demoMessage}
        onRetry={() => {
          setDemoAlertVisible(false)
          // 模拟重试
          setTimeout(() => {
            alert('重试演示：在实际应用中，这里会重新检查网络连接')
          }, 500)
        }}
        onDismiss={() => setDemoAlertVisible(false)}
      />
    </div>
  )
}
