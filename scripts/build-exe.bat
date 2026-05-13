@echo off
chcp 65001 >nul
title Network Planning Tool Build Script

REM Network Planning Tool - One-click Build Script
REM Usage: build-exe.bat [win|mac|linux|all|portable] [clean]

set "TARGET=win"
set "CLEAN="

REM Parse arguments
if "%~1"=="" goto continue
if "%~1"=="win" set "TARGET=win"
if "%~1"=="mac" set "TARGET=mac"
if "%~1"=="linux" set "TARGET=linux"
if "%~1"=="all" set "TARGET=all"
if "%~1"=="portable" set "TARGET=portable"

if "%~2"=="clean" set "CLEAN=-Clean"

:continue
echo.
echo ============================================
echo    Network Planning Tool Build Script
echo ============================================
echo.
echo Target Platform: %TARGET%
if defined CLEAN echo Clean Mode: Enabled
echo.

REM Get script directory
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."

REM Call PowerShell script
echo Starting build process...
echo.

powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build-exe.ps1" -Target %TARGET% %CLEAN%

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Build failed!
    pause
    exit /b 1
)

echo.
echo ============================================
echo    Build Completed!
echo ============================================
echo.
echo Output files are located at: %PROJECT_ROOT%\frontend\release\
echo.

pause
