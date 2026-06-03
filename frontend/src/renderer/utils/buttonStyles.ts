/**
 * 统一按钮样式常量，所有页面引用同一套样式以确保视觉一致性。
 */

export const btn = {
  primary:
    "flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg " +
    "hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed " +
    "text-sm font-medium transition-all",

  secondary:
    "flex items-center gap-2 px-4 py-2 bg-card border border-border rounded-lg " +
    "hover:bg-muted/80 text-sm font-medium transition-colors",

  ghost:
    "px-4 py-2 text-sm font-medium border-b-2 border-transparent " +
    "text-muted-foreground hover:text-foreground transition-colors",

  activeTab:
    "px-4 py-2 text-sm font-medium border-b-2 border-blue-500 text-blue-600 " +
    "transition-colors",

  icon:
    "p-1.5 text-xs bg-card border border-border rounded-lg " +
    "hover:bg-muted/80 transition-colors",

  tabAction:
    "px-3 py-2 text-sm font-medium text-blue-600 hover:text-blue-700 " +
    "border-b-2 border-transparent hover:border-blue-300 transition-colors " +
    "flex items-center gap-1.5",

  tabActionMuted:
    "px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground " +
    "border-b-2 border-transparent hover:border-gray-300 transition-colors " +
    "flex items-center gap-1.5",

  badgeSuccess: "ml-2 px-1.5 py-0.5 text-xs bg-green-100 text-green-700 rounded-full",
  badgeCount: "ml-2 px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded-full",
  badgeError:
    "ml-2 inline-flex items-center justify-center w-5 h-5 rounded-full " +
    "bg-red-500 text-white text-[10px] font-bold",

  // 向导流程按钮样式
  wizardActive:
    "flex items-center gap-1.5 px-5 py-2 bg-blue-500 text-white rounded-lg " +
    "hover:bg-blue-600 text-sm font-medium transition-all shadow-sm",

  wizardEnabled:
    "flex items-center gap-1.5 px-5 py-2 bg-card border border-blue-400 text-blue-600 rounded-lg " +
    "hover:bg-blue-50 hover:border-blue-500 dark:hover:bg-blue-950 text-sm font-medium transition-all",

  wizardDisabled:
    "flex items-center gap-1.5 px-5 py-2 bg-muted/50 border border-border text-muted-foreground rounded-lg " +
    "cursor-not-allowed text-sm font-medium",

  wizardCancel:
    "flex items-center gap-1.5 px-5 py-2 bg-card border border-border text-muted-foreground rounded-lg " +
    "hover:bg-red-50 hover:border-red-300 hover:text-red-600 dark:hover:bg-red-950 text-sm font-medium transition-all",
}
