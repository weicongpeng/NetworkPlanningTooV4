/**
 * useRestoreAuth —— APP 启动时从 AsyncStorage 恢复登录状态
 *
 * 问题：mapStore.isLoggedIn 是会话级状态（不持久化），APP 重启后默认 false。
 *       恢复逻辑原来只在 profile.tsx 的 useEffect 中，用户切到其他 Tab 时
 *       AuthGuard 仍看到 isLoggedIn=false，错误地显示"前往登录"遮罩。
 *
 * 方案：在根组件（App.tsx）调用此 hook，在所有页面渲染前恢复登录状态。
 *       profile.tsx 中的恢复逻辑保留（幂等操作，不冲突）。
 */

import { useEffect } from 'react';
import { useMapStore } from '../store/mapStore';
import { getStoredUser, getToken, fetchMe } from '../services/auth';

export function useRestoreAuth() {
  const setLoggedIn = useMapStore((s) => s.setLoggedIn);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // 1. 先从本地存储读取用户信息
        const stored = await getStoredUser();
        const token = await getToken();

        if (stored && token && !cancelled) {
          setLoggedIn(stored);
        }

        // 2. 若有 token，尝试从后端拉取最新用户信息（静默失败）
        if (token && !cancelled) {
          try {
            const me = await fetchMe();
            if (me && !cancelled) {
              setLoggedIn(me);
            }
          } catch {
            // token 无效或后端不可达，使用本地缓存即可
          }
        }
      } catch (e) {
        console.warn('[RestoreAuth] 恢复登录状态失败:', e);
      }
    })();

    return () => { cancelled = true; };
  }, [setLoggedIn]);
}
