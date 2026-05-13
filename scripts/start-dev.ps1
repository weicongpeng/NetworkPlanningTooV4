# 启动开发环境（按顺序执行）

# ====================================================
# 本脚本帮你一次性启动所有开发环境服务
# 需要先修改下面两个变量为你的实际路径
# ====================================================

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  网络规划工具 - 移动端开发环境启动" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# ==================== 配置区（改为你的实际路径）====================
$ProjectRoot = "D:\mycode\NetworkPlanningTooV3"
$TunnelName = "pwctoos"  # 你在 Cloudflare 创建的隧道名称
# ================================================================

$BackendDir = Join-Path $ProjectRoot "backend"
$MobileDir = Join-Path $ProjectRoot "mobile-app"

# ==================== 1. 启动后端 ====================
Write-Host "[1/3] 启动后端 FastAPI ..." -ForegroundColor Yellow

# 检查后端是否已经在运行
$backendRunning = $false
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:8000/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($resp.StatusCode -eq 200) {
        $backendRunning = $true
        Write-Host "  ✅ 后端已在运行" -ForegroundColor Green
    }
} catch {}

if (-not $backendRunning) {
    $backendJob = Start-Job -ScriptBlock {
        param($dir)
        Set-Location $dir
        python main.py
    } -ArgumentList $BackendDir

    Write-Host "  ✅ 后端已启动 (等待3秒确认) ..." -ForegroundColor Green
    Start-Sleep -Seconds 3
}

# ==================== 2. 启动 Cloudflare Tunnel ====================
Write-Host "[2/3] 启动 Cloudflare Tunnel ..." -ForegroundColor Yellow

# 先检查 tunnel 是否已运行
try {
    $tunnelCheck = cloudflared tunnel list 2>&1 | Select-String -Pattern $TunnelName
    Write-Host "  ✅ Tunnel 已存在，启动" -ForegroundColor Green
} catch {}

# 启动 tunnel 但不阻塞终端（后台运行）
$tunnelProcess = Start-Process -FilePath "cloudflared" -ArgumentList "tunnel run $TunnelName" -WindowStyle Hidden -PassThru
Write-Host "  ✅ Cloudflare Tunnel 已启动 (PID: $($tunnelProcess.Id))" -ForegroundColor Green
Write-Host "   🌐 外网地址: https://apk.pengwc.asia" -ForegroundColor Cyan

# ==================== 3. 启动 Metro 开发服务器 ====================
Write-Host "[3/3] 启动 Expo Metro (Tunnel 模式) ..." -ForegroundColor Yellow

Set-Location $MobileDir
Write-Host "  📱 请在手机上扫描二维码或输入 URL 加载应用" -ForegroundColor Cyan
Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  三个服务都已就绪，可以进行开发了！" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

npx expo start --tunnel
