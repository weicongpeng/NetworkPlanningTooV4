@echo off
chcp 65001 >nul
title Network Planning Tool Build Script

REM Network Planning Tool - Simple Build Script
REM Usage: build-simple.bat [win|portable]

set "TARGET=win"
if "%~1"=="portable" set "TARGET=portable"

echo.
echo ============================================
echo    Network Planning Tool Build Script
echo ============================================
echo.
echo Target: %TARGET%
echo.

REM Get project root
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "FRONTEND_DIR=%PROJECT_ROOT%\frontend"
set "BACKEND_DIR=%PROJECT_ROOT%\backend"

echo Project Root: %PROJECT_ROOT%
echo Frontend: %FRONTEND_DIR%
echo.

REM Check required files
echo Checking required files...
if not exist "%FRONTEND_DIR%\package.json" (
    echo [ERROR] package.json not found
    pause
    exit /b 1
)
if not exist "%FRONTEND_DIR%\electron\main.ts" (
    echo [ERROR] main.ts not found
    pause
    exit /b 1
)
if not exist "%BACKEND_DIR%\main.py" (
    echo [ERROR] main.py not found
    pause
    exit /b 1
)
echo [OK] All required files found
echo.

REM Setup backend
echo Setting up backend environment...
cd /d "%BACKEND_DIR%"

if not exist "venv" (
    echo Creating Python virtual environment...
    python -m venv venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment
        pause
        exit /b 1
    )
    echo [OK] Virtual environment created
)

echo Installing backend dependencies...
call venv\Scripts\activate.bat
python -m pip install --upgrade pip
if exist "requirements.txt" (
    pip install -r requirements.txt
    if errorlevel 1 (
        echo [WARN] Some dependencies failed to install
    ) else (
        echo [OK] Backend dependencies installed
    )
) else (
    echo [WARN] requirements.txt not found
)
pip install pyinstaller
echo [OK] PyInstaller installed
echo.

REM Build frontend
echo Building frontend...
cd /d "%FRONTEND_DIR%"

if not exist "node_modules" (
    echo Installing frontend dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Failed to install frontend dependencies
        pause
        exit /b 1
    )
    echo [OK] Frontend dependencies installed
)

echo Building frontend application...
call npm run build
if errorlevel 1 (
    echo [ERROR] Frontend build failed
    pause
    exit /b 1
)
echo [OK] Frontend build completed
echo.

REM Package application
echo Packaging Electron application...
if "%TARGET%"=="portable" (
    call npm run dist:win:portable
) else (
    call npm run dist:win
)

if errorlevel 1 (
    echo [ERROR] Packaging failed
    pause
    exit /b 1
)
echo [OK] Packaging completed
echo.

REM Show results
echo ============================================
echo    Build Results
echo ============================================
echo.
if exist "%FRONTEND_DIR%\release" (
    echo Generated files:
    for %%f in ("%FRONTEND_DIR%\release\*") do (
        echo   - %%~nxf
    )
    echo.
    echo Output directory: %FRONTEND_DIR%\release\
) else (
    echo [WARN] Release directory not found
)
echo.
echo ============================================
echo    Build Completed!
echo ============================================
echo.

pause
