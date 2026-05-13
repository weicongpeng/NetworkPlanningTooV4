// @ts-ignore: webUtils missing in types
import { contextBridge, ipcRenderer, webUtils } from 'electron'

// 暴露安全的API给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  // 应用信息
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  isDev: () => ipcRenderer.invoke('is-dev'),

  // 文件操作
  openFile: (options: any) => ipcRenderer.invoke('dialog:open-file', options),
  saveFile: (options: any) => ipcRenderer.invoke('dialog:save-file', options),
  selectDirectory: (options: any) => ipcRenderer.invoke('dialog:select-directory', options),

  // 获取文件真实路径 (Electron 28+)
  getFilePath: (file: File) => {
    // 类型检查：确保传入的是 File 对象
    if (!(file instanceof File)) {
      console.error('[preload] getFilePath: Invalid argument, expected File object');
      return '';
    }
    try {
      return webUtils.getPathForFile(file);
    } catch (error) {
      console.error('[preload] getFilePath: Error getting path for file:', error);
      return '';
    }
  },

  // 读取文件内容
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath)
})

// TypeScript 类型声明
export interface ElectronAPI {
  getAppVersion: () => Promise<string>
  getAppPath: () => Promise<string>
  isDev: () => Promise<boolean>
  openFile: (options: any) => Promise<string | undefined>
  saveFile: (options: any) => Promise<string | undefined>
  selectDirectory: (options: any) => Promise<string | undefined>
  getFilePath: (file: File) => string
  readFile: (filePath: string) => Promise<Uint8Array | null>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
