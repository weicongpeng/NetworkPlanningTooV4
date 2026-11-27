/**
 * useHeartbeat —— 登录后自动心跳保活
 *
 * 行为：
 *   - 监听全局 isLoggedIn 状态
 *   - 登录后：立即 ping 一次，随后每 5 分钟 ping 一次（保持 last_activity 不中断）
 *   - 退出后：自动停止
 *   - 组件卸载时也会清理 interval，避免泄漏
 *
 * 用法：在任一常驻组件中调用一次即可
 *   function App() {
 *     useHeartbeat();
 *     return <NavigationContainer>...</NavigationContainer>;
 *   }
 *
 * 必须在 App 根组件调用：底部 Tab 是懒加载的，放在 profile.tsx 时用户不进「我的」
 * 就不会挂载，心跳不跑，会话 180 分钟空闲后会被后端判定为需要重新登录。
 */

import { useEffect, useRef } from 'react';
import { useMapStore } from '../store/mapStore';
import { ping } from '../services/auth';

const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 分钟

export function useHeartbeat() {
  const isLoggedIn = useMapStore((s) => s.isLoggedIn);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // 清理上一次 interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (isLoggedIn) {
      // 登录中：立即 ping 一次，再每 5 分钟
      ping();
      intervalRef.current = setInterval(ping, HEARTBEAT_INTERVAL);
      console.log('[Heartbeat] 已启动（每 5 分钟）');
    } else {
      console.log('[Heartbeat] 已停止（未登录）');
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isLoggedIn]);
}
