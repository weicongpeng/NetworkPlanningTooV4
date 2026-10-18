<#
.SYNOPSIS
  在 Windows 上部署 GitHub Actions 自托管 Runner（NetworkPlanningTooV4）

.DESCRIPTION
  - 下载 runner 2.337.0、校验 SHA256、解压到 C:\actions-runner
  - 注册为 Windows 服务（--runasservice），开机自启
  - Runner 标签：self-hosted, windows, x64, npt-windows-builder

.USAGE
  以【管理员】身份打开 PowerShell：
    .\deploy-windows-runner.ps1 -Token "<注册token>"

  注册 token 获取：仓库 Settings → Actions → Runners → New self-hosted runner
  （token 一次性、约 1 小时有效，不要提交到仓库）

.NOTES
  重复执行会以 --replace 覆盖同名 runner；升级 runner 时替换 $Version 即可。
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Token,

  [string]$Root = "C:\actions-runner",
  [string]$RunnerName = "$env:COMPUTERNAME-npt-windows",
  [string]$Labels = "self-hosted,windows,x64,npt-windows-builder",
  [string]$Version = "2.337.0"
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "请以管理员身份运行 PowerShell（右键 → 以管理员身份运行）"
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 自托管 Windows Runner 是干净系统：补齐 workflow 依赖的 git / Chocolatey / Inno Setup。
# Node、Python 由 actions/setup-node、setup-python 在 job 内安装，无需预装。
function Ensure-Choco {
  if (Get-Command choco.exe -ErrorAction SilentlyContinue) { return }
  Write-Host "安装 Chocolatey ..."
  Set-ExecutionPolicy Bypass -Scope Process -Force
  Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
  $env:Path += ";$env:ProgramData\chocolatey\bin"
}

Ensure-Choco
if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
  Write-Host "安装 Git ..."
  choco install git -y --no-progress
  if ($LASTEXITCODE -ne 0) { throw "Git 安装失败，退出码 $LASTEXITCODE" }
  $env:Path += ";C:\Program Files\Git\cmd"
}
if (-not (Test-Path "C:\Program Files (x86)\Inno Setup 6\ISCC.exe")) {
  Write-Host "安装 Inno Setup 6 ..."
  choco install innosetup -y --no-progress
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup 安装失败，退出码 $LASTEXITCODE" }
}
git config --system core.longpaths true 2>$null

$zipName = "actions-runner-win-x64-$Version.zip"
$zipPath = Join-Path $Root $zipName
$expectedHash = "1150692AFA94E71F872017E254EA55B6EECE1EECE3FE7E3A6D4C93D0A1B85CFC"

New-Item -ItemType Directory -Force -Path $Root | Out-Null
Set-Location $Root

if (-not (Test-Path $zipPath)) {
  Write-Host "下载 $zipName ..."
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$Version/$zipName" -OutFile $zipPath
}

$actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToUpper()
if ($actualHash -ne $expectedHash) {
  throw "SHA256 不匹配：$actualHash"
}

if (-not (Test-Path (Join-Path $Root "config.cmd"))) {
  Write-Host "解压 runner ..."
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $Root)
}

Write-Host "注册 Runner（名称：$RunnerName，标签：$Labels）..."
& "$Root\config.cmd" --url "https://github.com/weicongpeng/NetworkPlanningTooV4" --token "$Token" --name "$RunnerName" --labels "$Labels" --work "_work" --unattended --replace --runasservice
if ($LASTEXITCODE -ne 0) {
  throw "config.cmd 失败，退出码 $LASTEXITCODE"
}

Write-Host "启动 Runner 服务 ..."
Get-Service | Where-Object { $_.Name -like "actions.runner.*" } | ForEach-Object {
  if ($_.Status -ne "Running") { Start-Service $_.Name }
}

Get-Service | Where-Object { $_.Name -like "actions.runner.*" } | Format-Table Name, Status, StartType -AutoSize

Write-Host ""
Write-Host "完成。请到仓库 Settings → Actions → Runners 确认状态为 Idle/online。"
Write-Host "如需工作流使用该 Runner：仓库 Settings → Secrets and variables → Actions → Variables"
Write-Host "新增变量 NPT_WINDOWS_RUNNER = npt-windows-builder（工作流已支持该回退）。"
