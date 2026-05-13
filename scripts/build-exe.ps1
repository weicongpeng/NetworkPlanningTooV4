# Network Planning Tool Build Script
# Builds the project into executable files

param(
    [Parameter()]
    [ValidateSet("win", "mac", "linux", "all", "portable")]
    [string]$Target = "win",

    [Parameter()]
    [switch]$SkipBackendSetup,

    [Parameter()]
    [switch]$SkipFrontendBuild,

    [Parameter()]
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "Continue"

# Get project directories
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$FrontendDir = Join-Path $ProjectRoot "frontend"
$BackendDir = Join-Path $ProjectRoot "backend"
$ReleaseDir = Join-Path $FrontendDir "release"

Write-Host ""
Write-Host ">>> Network Planning Tool Build Script <<<" -ForegroundColor Magenta
Write-Host ""
Write-Host "[INFO] Project Root: $ProjectRoot" -ForegroundColor Cyan
Write-Host "[INFO] Target Platform: $Target" -ForegroundColor Cyan

# Clean old builds
if ($Clean) {
    Write-Host ""
    Write-Host ">>> Cleaning Old Build Files <<<" -ForegroundColor Magenta
    Write-Host ""
    $dirsToClean = @(
        (Join-Path $FrontendDir "dist-renderer"),
        (Join-Path $FrontendDir "dist-electron"),
        (Join-Path $FrontendDir "release")
    )
    foreach ($dir in $dirsToClean) {
        if (Test-Path $dir) {
            Remove-Item -Path $dir -Recurse -Force
            Write-Host "[OK] Cleaned: $dir" -ForegroundColor Green
        }
    }
}

# Check required files
Write-Host ""
Write-Host ">>> Checking Required Files <<<" -ForegroundColor Magenta
Write-Host ""

$packageJson = Join-Path $FrontendDir "package.json"
$mainTs = Join-Path $FrontendDir "electron" "main.ts"
$mainPy = Join-Path $BackendDir "main.py"

if (-not (Test-Path $packageJson)) {
    Write-Host "[ERROR] Missing required file: $packageJson" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $mainTs)) {
    Write-Host "[ERROR] Missing required file: $mainTs" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $mainPy)) {
    Write-Host "[ERROR] Missing required file: $mainPy" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] All required files found" -ForegroundColor Green

# Backend setup
if (-not $SkipBackendSetup) {
    Write-Host ""
    Write-Host ">>> Setting Up Backend Environment <<<" -ForegroundColor Magenta
    Write-Host ""
    Set-Location $BackendDir

    # Check/create virtual environment
    $VenvDir = Join-Path $BackendDir "venv"
    if (-not (Test-Path $VenvDir)) {
        Write-Host "[INFO] Creating Python virtual environment..." -ForegroundColor Cyan
        python -m venv venv
        Write-Host "[OK] Virtual environment created" -ForegroundColor Green
    }

    # Install dependencies
    Write-Host "[INFO] Installing backend dependencies..." -ForegroundColor Cyan
    $pipPath = Join-Path $VenvDir "Scripts\pip.exe"
    if (-not (Test-Path $pipPath)) {
        Write-Host "[ERROR] pip not found: $pipPath" -ForegroundColor Red
        exit 1
    }

    $pythonPath = Join-Path $VenvDir "Scripts\python.exe"
    & $pythonPath -m pip install --upgrade pip

    $requirementsFile = Join-Path $BackendDir "requirements.txt"
    if (Test-Path $requirementsFile) {
        & $pipPath install -r $requirementsFile
        Write-Host "[OK] Backend dependencies installed" -ForegroundColor Green
    } else {
        Write-Host "[WARN] requirements.txt not found, skipping dependency installation" -ForegroundColor Yellow
    }

    & $pipPath install pyinstaller
    Write-Host "[OK] PyInstaller installed" -ForegroundColor Green
}

# Frontend build
if (-not $SkipFrontendBuild) {
    Write-Host ""
    Write-Host ">>> Building Frontend <<<" -ForegroundColor Magenta
    Write-Host ""
    Set-Location $FrontendDir

    # Check node_modules
    $NodeModulesDir = Join-Path $FrontendDir "node_modules"
    if (-not (Test-Path $NodeModulesDir)) {
        Write-Host "[INFO] Installing frontend dependencies..." -ForegroundColor Cyan
        npm install
        Write-Host "[OK] Frontend dependencies installed" -ForegroundColor Green
    }

    # Build frontend
    Write-Host "[INFO] Building frontend application..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Frontend build failed" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Frontend build completed" -ForegroundColor Green
}

# Package Electron app
Write-Host ""
Write-Host ">>> Packaging Electron Application <<<" -ForegroundColor Magenta
Write-Host ""
Set-Location $FrontendDir

$buildCommand = ""
switch ($Target) {
    "win" { $buildCommand = "npm run dist:win" }
    "mac" { $buildCommand = "npm run dist:mac" }
    "linux" { $buildCommand = "npm run dist:linux" }
    "all" { $buildCommand = "npm run dist:all" }
    "portable" { $buildCommand = "npm run dist:win:portable" }
}

Write-Host "[INFO] Executing build command: $buildCommand" -ForegroundColor Cyan
Invoke-Expression $buildCommand
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Packaging failed" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Packaging completed" -ForegroundColor Green

# Show output files
Write-Host ""
Write-Host ">>> Build Results <<<" -ForegroundColor Magenta
Write-Host ""
if (Test-Path $ReleaseDir) {
    $files = Get-ChildItem -Path $ReleaseDir -Recurse | Where-Object { -not $_.PSIsContainer }
    Write-Host "[INFO] Generated files:" -ForegroundColor Cyan
    foreach ($file in $files) {
        $size = [math]::Round($file.Length / 1MB, 2)
        Write-Host "  - $($file.Name) ($size MB)" -ForegroundColor Cyan
    }

    $totalSize = ($files | Measure-Object -Property Length -Sum).Sum
    $totalSizeMB = [math]::Round($totalSize / 1MB, 2)
    Write-Host "[OK] Total size: $totalSizeMB MB" -ForegroundColor Green
} else {
    Write-Host "[WARN] Output directory not found: $ReleaseDir" -ForegroundColor Yellow
}

Write-Host ""
Write-Host ">>> Build Process Completed <<<" -ForegroundColor Magenta
Write-Host ""
Write-Host "[INFO] Output directory: $ReleaseDir" -ForegroundColor Cyan
Write-Host "[INFO] You can distribute files in the release directory to users" -ForegroundColor Cyan

Set-Location $ProjectRoot
