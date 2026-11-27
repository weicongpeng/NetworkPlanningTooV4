/**
 * 401 上报通道：网络层只负责报告，不知道 store 的存在，避免 api/auth ↔ store 循环依赖。
 * App 根组件注册唯一处理器，统一清理本地登录态。
 */
type UnauthorizedHandler = (message: string) => void;

let handler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(next: UnauthorizedHandler | null): void {
  handler = next;
}

export function reportUnauthorized(message: string): void {
  handler?.(message);
}
