// 简单测试程序
const { app } = require('electron')

console.log('=== Electron Packager Test ===')
console.log('app.isPackaged:', app.isPackaged)
console.log('app.getAppPath():', app.getAppPath())
console.log('app.getPath(\'userData\'):', app.getPath('userData'))
console.log('process.resourcesPath:', process.resourcesPath)
console.log('process.execPath:', process.execPath)

app.whenReady().then(() => {
  console.log('App is ready!')
  setTimeout(() => {
    app.quit()
  }, 1000)
})
