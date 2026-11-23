/**
 * 任务名称工具函数
 * 为任务名称自动添加时间戳后缀，实现 "用户自定义部分_YYYYMMDD_HHmmss" 的命名规范
 */

/**
 * 生成带时间戳的完整任务名称
 * @param userPart 用户自定义部分（输入框中的内容）
 * @returns "用户自定义部分_YYYYMMDD_HHmmss"
 *
 * 使用场景：
 * - 新建任务时，输入框只显示用户自定义部分（无时间戳）
 * - 提交时将完整名称（含时间戳）发送给后端和写入 taskStore
 * - 历史任务列表显示完整名称（含时间戳），与新建任务名称一致
 */
export function generateFullTaskName(userPart: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${userPart}_${timestamp}`
}
