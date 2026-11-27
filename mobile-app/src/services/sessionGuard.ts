/** 会话失效统一处理：清凭证、停 IM 实时链路、让 AuthGuard 接管引导重新登录。 */
import { clearToken, clearStoredUser } from './auth';
import { useMapStore } from '../store/mapStore';
import { useImStore } from '../store/imStore';

let running = false;

export async function invalidateSession(message: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    await clearToken();
    await clearStoredUser();
    const im = useImStore.getState();
    im.resetForUserSwitch();
    im.setSessionExpired(message || '登录已过期，请重新登录');
    useMapStore.getState().clearLoggedIn();
  } finally {
    running = false;
  }
}
