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
 * 这里放在 profile.tsx，因为：
 *   1. profile.tsx 是 Tab 之一，默认 lazy:false，登录进入 APP 后即被挂载
 *   2. profile.tsx 负责登录/登出逻辑，心跳与登录状态天然耦合
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
