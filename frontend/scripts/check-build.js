const fs = require('fs')
const path = require('path')

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
}

const frontendDir = path.join(__dirname, '..')
const backendDir = path.join(frontendDir, '..', 'backend')

const checks = [
  {
    name: '前端 node_modules',
    path: path.join(frontendDir, 'node_modules'),
    type: 'directory',
    fixHint: '请运行: cd frontend && npm install'
  },
  {
    name: '后端虚拟环境 (venv)',
    path: path.join(backendDir, 'venv'),
    type: 'directory',
    fixHint: '请运行: cd backend && python -m venv venv && venv\\Scripts\\activate && pip install -r requirements.txt'
  },
  {
    name: '构建资源目录 (build)',
    path: path.join(frontendDir, 'build'),
    type: 'directory',
    fixHint: '请创建 build 目录并添加必要的资源文件'
  },
  {
    name: 'Vite 构建输出 (dist-renderer)',
    path: path.join(frontendDir, 'dist-renderer'),
    type: 'directory',
    fixHint: '请运行: npm run build:vite'
  },
  {
    name: 'Electron 构建输出 (dist-electron)',
    path: path.join(frontendDir, 'dist-electron'),
    type: 'directory',
    fixHint: '请运行: npm run build:electron'
  }
]

const resourceChecks = [
  {
    name: '应用图标 (build/icon.ico)',
    path: path.join(frontendDir, 'build', 'icon.ico'),
    type: 'file',
    optional: true,
    fixHint: '建议添加应用图标文件: build/icon.ico'
  },
  {
    name: '图标说明文件 (build/icon-README.txt)',
    path: path.join(frontendDir, 'build', 'icon-README.txt'),
    type: 'file',
    optional: true,
    fixHint: '可创建图标说明文件'
  }
]

function checkExists(itemPath, type) {
  try {
    if (type === 'directory') {
      return fs.existsSync(itemPath) && fs.statSync(itemPath).isDirectory()
    } else {
      return fs.existsSync(itemPath) && fs.statSync(itemPath).isFile()
    }
  } catch {
    return false
  }
}

function printHeader() {
  console.log(`\n${COLORS.bold}${COLORS.cyan}========================================${COLORS.reset}`)
  console.log(`${COLORS.bold}${COLORS.cyan}       Electron 打包前检查脚本${COLORS.reset}`)
  console.log(`${COLORS.bold}${COLORS.cyan}========================================${COLORS.reset}\n`)
}

function printResult(name, passed, fixHint, optional = false) {
  const status = passed
    ? `${COLORS.green}[PASS]${COLORS.reset}`
    : optional
      ? `${COLORS.yellow}[WARN]${COLORS.reset}`
      : `${COLORS.red}[FAIL]${COLORS.reset}`
  
  console.log(`  ${status} ${name}`)
  
  if (!passed && fixHint) {
    console.log(`         ${COLORS.yellow}→ ${fixHint}${COLORS.reset}`)
  }
}

function runChecks() {
  printHeader()
  
  let failedCount = 0
  let passedCount = 0
  let warnCount = 0
  
  console.log(`${COLORS.bold}基础环境检查:${COLORS.reset}\n`)
  
  for (const check of checks) {
    const exists = checkExists(check.path, check.type)
    printResult(check.name, exists, check.fixHint)
    
    if (exists) {
      passedCount++
    } else {
      failedCount++
    }
  }
  
  console.log(`\n${COLORS.bold}资源文件检查:${COLORS.reset}\n`)
  
  for (const check of resourceChecks) {
    const exists = checkExists(check.path, check.type)
    printResult(check.name, exists, check.fixHint, check.optional)
    
    if (exists) {
      passedCount++
    } else if (check.optional) {
      warnCount++
    } else {
      failedCount++
    }
  }
  
  console.log(`\n${COLORS.bold}========================================${COLORS.reset}`)
  console.log(`${COLORS.bold}检查结果汇总:${COLORS.reset}`)
  console.log(`  ${COLORS.green}通过: ${passedCount}${COLORS.reset}`)
  console.log(`  ${COLORS.yellow}警告: ${warnCount}${COLORS.reset}`)
  console.log(`  ${COLORS.red}失败: ${failedCount}${COLORS.reset}`)
  console.log(`${COLORS.bold}========================================${COLORS.reset}\n`)
  
  if (failedCount > 0) {
    console.log(`${COLORS.red}${COLORS.bold}✗ 存在检查失败项，请修复后再进行打包！${COLORS.reset}\n`)
    
    const hasFix = process.argv.includes('--fix')
    if (hasFix) {
      console.log(`${COLORS.cyan}--fix 参数提示:${COLORS.reset}`)
      for (const check of checks) {
        if (!checkExists(check.path, check.type)) {
          console.log(`  • ${check.name}: ${check.fixHint}`)
        }
      }
    }
    
    process.exit(1)
  }
  
  console.log(`${COLORS.green}${COLORS.bold}✓ 所有检查通过，可以进行打包！${COLORS.reset}\n`)
  process.exit(0)
}

runChecks()
