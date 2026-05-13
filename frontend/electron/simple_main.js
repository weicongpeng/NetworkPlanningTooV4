const electron = require('electron')
const path = require('path')

const { app, BrowserWindow } = electron

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    show: true
  })

  // 尝试加载 HTML
  const htmlPath = path.join(__dirname, '../dist-renderer/index.html')
  console.log('Loading HTML from:', htmlPath)
  mainWindow.loadFile(htmlPath).catch((err) => {
    console.error('Failed to load HTML:', err)
    // 如果加载失败，显示简单内容
    mainWindow.loadURL('data:text/html;charset=utf-8,<h1>Test Window</h1><p>Electron is working!</p>')
  })
}

app.whenReady().then(() => {
  console.log('App ready, creating window...')
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

console.log('Simple main loaded')
