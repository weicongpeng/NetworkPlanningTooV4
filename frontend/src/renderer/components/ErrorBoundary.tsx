import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 顶层错误边界：任一页面渲染抛错时给出可恢复的降级界面，而不是整棵 React 树
 * 卸载后的白屏（历史事故：3D 地图开等高线后切换页面白屏，无任何提示）。
 * 「重新加载」走整页刷新，可清掉残留的 WebGL/内存状态；用户数据都在后端，刷新安全。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 控制台保留完整堆栈：桌面端 webview 控制台与前端日志都靠它定位
    console.error('[ErrorBoundary] 页面渲染异常:', error, info.componentStack)
  }

  private handleReload = () => {
    window.location.reload()
  }

  private handleBack = () => {
    this.setState({ error: null })
    window.location.hash = ''
    window.history.replaceState(null, '', '/')
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background p-6">
        <div className="max-w-md w-full space-y-4 text-center">
          <h2 className="text-lg font-semibold text-foreground">页面出现问题</h2>
          <p className="text-sm text-muted-foreground break-all">
            {this.state.error?.message || '未知错误'}
          </p>
          <div className="flex justify-center gap-3">
            <button
              onClick={this.handleBack}
              className="px-4 py-2 border border-border rounded-lg hover:bg-muted text-sm"
            >
              返回首页
            </button>
            <button
              onClick={this.handleReload}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 text-sm font-medium"
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    )
  }
}
