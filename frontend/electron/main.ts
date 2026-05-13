import electron = require('electron')
import path = require('path')
import fs = require('fs')
import { spawn, ChildProcess } from 'child_process'

// 直接使用 electron 对象的属性，不使用解构
const app: any = electron.app
const BW: any = electron.BrowserWindow
const ipcMain: any = electron.ipcMain
const dialog: any = electron.dialog
const screen: any = electron.screen

// 在 CommonJS 模式下 __filename 和 __dirname 是全局变量
declare const __filename: string
declare const __dirname: string

let mainWindow: electron.BrowserWindow | null = null
let backendProcess: ChildProcess | null = null

// 隐藏菜单栏
try {
  // 隐藏默认菜单栏
  if (app.setAboutPanelOptions) {
    app.setAboutPanelOptions({})
  }
} catch (e) {
  console.log('Could not set app options')
}

// 开发环境检测 - 使用更可靠的方法
// 在生产环境中，src 目录不会被包含，所以可以通过检查它来判断
const isDev = fs.existsSync(path.join(__dirname, '../../src/renderer')) || process.env.NODE_ENV !== 'production'

const devLog = (...args: any[]) => {
  if (isDev) console.log(...args)
}

devLog('Electron main process starting...')
devLog('isDev:', isDev)
devLog('__dirname:', __dirname)

// 安全地访问 app 属性
try {
  devLog('app.isPackaged:', app.isPackaged)
} catch (e) {
  devLog('app.isPackaged: not available')
}

// 创建浏览器窗口
function createWindow() {
  devLog('Creating browser window...')
  try {
    devLog('app.getAppPath():', app.getAppPath())
  } catch (e) {
    devLog('app.getAppPath(): not available')
  }
  try {
    devLog('app.isPackaged:', app.isPackaged)
  } catch (e) {
    devLog('app.isPackaged: not available')
  }
  devLog('__dirname:', __dirname)
  devLog('process.resourcesPath:', process.resourcesPath)

  const preloadPath = path.join(__dirname, 'preload.js')
  devLog('Preload path:', preloadPath)

  // 检查 preload.js 是否存在
  if (!fs.existsSync(preloadPath)) {
    console.error('ERROR: preload.js not found at:', preloadPath)
  }

  mainWindow = new BW({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      backgroundThrottling: false  // 🔥 禁止后台休眠降频
    },
    backgroundColor: '#0f172a',
    show: false
  })

  // 窗口准备好后显示
  mainWindow.once('ready-to-show', () => {
    devLog('Window ready to show')
    mainWindow?.show()
  })

  // 加载应用
  if (isDev) {
    devLog('Loading development URL: http://127.0.0.1:5173')
    mainWindow.loadURL('http://127.0.0.1:5173')
    mainWindow.webContents.openDevTools()

    // 在开发环境中，如果加载失败，自动重试
    let retryCount = 0
    const maxRetries = 10

    mainWindow.webContents.on('did-fail-load', () => {
      if (retryCount < maxRetries && mainWindow) {
        retryCount++
        devLog(`Retrying to load Vite(attempt ${retryCount} / ${maxRetries})...`)
        setTimeout(() => {
          if (mainWindow) {
            mainWindow.loadURL('http://127.0.0.1:5173')
          }
        }, 2000)
      }
    })
  } else {
    // 生产环境：尝试多个可能的路径
    let htmlPath = ''
    const possiblePaths = [
      // electron-packager no-asar: resources/app/dist-renderer/index.html
      path.join(process.resourcesPath, 'app', 'dist-renderer', 'index.html'),
      // electron-packager asar: app.asar/dist-renderer/index.html
      path.join(process.resourcesPath, 'app.asar', 'dist-renderer', 'index.html'),
      // 相对于 __dirname
      path.join(__dirname, '../dist-renderer/index.html'),
      path.join(__dirname, 'dist-renderer', 'index.html')
    ]

    devLog('Production mode - searching for HTML file...')
    devLog('process.resourcesPath:', process.resourcesPath)
    devLog('__dirname:', __dirname)

    for (const testPath of possiblePaths) {
      devLog('  Checking:', testPath)
      if (fs.existsSync(testPath)) {
        htmlPath = testPath
        devLog('  ✓ FOUND HTML at:', htmlPath)
        break
      } else {
        devLog('  ✗ Not found')
      }
    }

    if (!htmlPath) {
      console.error('ERROR: HTML file not found!')
      console.error('Searched paths:', possiblePaths)
      // 显示错误页面
      mainWindow.loadURL('data:text/html;charset=utf-8,<h1 style="color:white;background:#333;padding:20px;">错误：找不到 HTML 文件</h1><p style="color:white;background:#333;padding:20px;">请查看控制台获取详细信息</p>')
    } else {
      devLog('Loading HTML file:', htmlPath)
      mainWindow.loadFile(htmlPath)
    }
  }

  mainWindow.on('closed', () => {
    devLog('Main window closed')
    mainWindow = null
  })

  // 监听加载错误
  mainWindow.webContents.on('crashed', () => {
    console.error('Renderer process crashed')
  })

  // 使用 will-navigate 事件来处理导航失败
  mainWindow.webContents.on('did-start-loading', () => {
    devLog('Started loading')
  })

  mainWindow.webContents.on('did-stop-loading', () => {
    devLog('Finished loading')
  })
}

/**
 * 🔥 后端健康检查：等待后端服务就绪
 * @param maxWait 最大等待时间（毫秒）
 */
async function waitForBackendReady(maxWait: number = 10000): Promise<void> {
  const startTime = Date.now()
  const backendUrl = 'http://127.0.0.1:8000'

  devLog('等待后端服务就绪...')

  while (Date.now() - startTime < maxWait) {
    try {
      // 使用原生 fetch (Node 18+)
      const response = await fetch(`${backendUrl}/docs`)
      if (response.ok) {
        devLog('✅ 后端服务已就绪')
        return
      }
    } catch {
      // 后端尚未就绪，继续等待
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  devLog(`⚠️ 后端在 ${maxWait / 1000} 秒内未就绪，将继续运行`)
}

// 启动后端服务
async function startBackend() {
  // 开发环境下，后端由 start_app.bat 启动，这里跳过以避免端口冲突
  if (isDev) {
    devLog('Dev mode: Skipping internal backend start')
    return
  }

  // 生产环境后端路径：优先尝试 app.asar.unpacked，然后是 app
  let backendRelPath = 'app.asar.unpacked/backend'
  const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked/backend')
  const noAsarPath = path.join(process.resourcesPath, 'app/backend')

  if (!fs.existsSync(unpackedPath) && fs.existsSync(noAsarPath)) {
    backendRelPath = 'app/backend'
    devLog('Using no-asar backend path:', noAsarPath)
  }

  const backendPath = path.join(
    process.resourcesPath,
    isDev ? '../backend' : backendRelPath
  )

  // 优先使用虚拟环境中的 Python
  let pythonExecutable = process.platform === 'win32' ? 'python' : 'python3'
  const venvPythonPath = path.join(backendPath, 'venv', 'Scripts', 'python.exe')
  const venvPythonExists = fs.existsSync(venvPythonPath)

  if (venvPythonExists) {
    pythonExecutable = venvPythonPath
    devLog('使用虚拟环境 Python:', venvPythonPath)
  } else {
    devLog('虚拟环境未找到，使用系统 Python')
  }

  backendProcess = spawn(pythonExecutable, [
    path.join(backendPath, 'main.py')
  ], {
    cwd: backendPath,
    stdio: 'inherit'
  })

  backendProcess.on('error', (error: Error) => {
    console.error('后端启动失败:', error)
  })

  backendProcess.on('exit', (code: number) => {
    devLog(`后端进程退出，代码: ${code} `)
    if (code !== 0 && backendProcess && !backendProcess.killed) {
      // 尝试重启
      setTimeout(startBackend, 5000)
    }
  })

  // 🔥 等待后端就绪
  await waitForBackendReady()
}

// IPC 通信处理
ipcMain.handle('app-version', () => {
  return app.getVersion()
})

ipcMain.handle('get-app-path', () => {
  return app.getAppPath()
})

ipcMain.handle('is-dev', () => {
  return isDev
})

// 文件对话框处理
ipcMain.handle('dialog:open-file', async (_event, options) => {
  if (!mainWindow) return undefined
  const result = await dialog.showOpenDialog(mainWindow, options)
  if (result.canceled) return undefined
  return result.filePaths[0]
})

ipcMain.handle('dialog:save-file', async (_event, options) => {
  if (!mainWindow) return undefined
  const result = await dialog.showSaveDialog(mainWindow, options)
  if (result.canceled) return undefined
  return result.filePath
})

ipcMain.handle('dialog:select-directory', async (_event, options) => {
  if (!mainWindow) return undefined
  const result = await dialog.showOpenDialog(mainWindow, {
    ...options,
    properties: ['openDirectory']
  })
  if (result.canceled) return undefined
  return result.filePaths[0]
})

// 🔥 性能优化：异步文件读取，避免阻塞主进程
// 对于大文件读取，这可以显著改善应用响应性
ipcMain.handle('read-file', async (_event, filePath: string) => {
  try {
    const buffer = await fs.promises.readFile(filePath)
    return buffer
  } catch (error) {
    console.error('Read file error:', error)
    return null
  }
})

// 🔥 性能优化：启用 GPU 加速和 V8 内存配置
// 必须在 app.whenReady() 之前执行
app.commandLine.appendSwitch('ignore-gpu-blocklist');       // 忽略显卡黑名单
app.commandLine.appendSwitch('enable-gpu-rasterization');  // 开启 GPU 光栅化
app.commandLine.appendSwitch('enable-zero-copy');           // 减少显存拷贝损耗
app.commandLine.appendSwitch('num-raster-threads', '4');    // 适配多核 CPU
app.commandLine.appendSwitch('--js-flags', '--max-old-space-size=4096')  // 增加 Node.js 堆内存限制

// 应用生命周期
app.whenReady().then(() => {
  devLog('App is ready')

  // 隐藏菜单栏 - 创建空菜单
  try {
    const Menu = electron.Menu
    Menu.setApplicationMenu(null)
  } catch (e) {
    console.log('Could not set menu')
  }

  createWindow()

  // 启动后端服务
  startBackend()

  app.on('activate', () => {
    devLog('App activated')
    if (BW.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  devLog('All windows closed')
  if (process.platform !== 'darwin') {
    // 停止后端服务
    if (backendProcess) {
      devLog('Killing backend process')
      backendProcess.kill()
    }
    app.quit()
  }
})

app.on('before-quit', () => {
  devLog('App about to quit')
  // 停止后端服务
  if (backendProcess) {
    devLog('Killing backend process')
    backendProcess.kill()
  }
})
