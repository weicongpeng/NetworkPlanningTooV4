@echo off
echo ======================================
echo 网络规划工具 V2.0 - Electron 桌面应用启动脚本
echo ======================================
echo.

echo [1/4] 编译 Electron TypeScript...
cd frontend
call npm run build:electron
if %errorlevel% neq 0 (
    echo ❌ Electron TypeScript 编译失败
    pause
    exit /b 1
)
echo ✅ Electron TypeScript 编译完成
echo.

echo [2/4] 启动后端服务...
cd ..
start "Backend API Server" cmd /k "cd backend && python main.py"
echo ✅ 后端服务启动中...
echo.

echo [3/4] 等待后端服务就绪...
timeout /t 3 /nobreak > nul
echo ✅ 后端服务就绪
echo.

REM 2. Prepare Frontend (Electron)
echo [2/3] Preparing frontend (Electron)...
cd frontend

REM Swap package.json if needed
if exist "package.json.electron" (
    echo Switching to Electron configuration...
    copy /y package.json package.json.web >nul
    copy /y package.json.electron package.json >nul
)

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install --ignore-scripts
)

REM Compile TypeScript files before starting Electron
echo Compiling Electron TypeScript...
call npm run build:electron
if errorlevel 1 (
    echo [ERROR] Failed to compile Electron TypeScript
    cd ..
    pause
    exit /b 1
)

REM Verify compiled files exist
if not exist "dist-electron\main.js" (
    echo [ERROR] Electron TypeScript compilation failed - main.js not found
    cd ..
    pause
    exit /b 1
)

if not exist "dist-electron\preload.js" (
    echo [ERROR] Electron TypeScript compilation failed - preload.js not found
    cd ..
    pause
    exit /b 1
)

echo TypeScript compilation successful!

REM 3. Start Frontend
echo [3/3] Starting Electron application...
echo.
echo Note: If this is the first time, it may take a moment to compile.
echo.

REM Start Vite in a separate visible window
start "NetworkTool-React" cmd /k "npm run dev:vite"

REM Wait for Vite to start (reduced wait time for faster startup)
echo Waiting 0.5 seconds for Vite to start...
timeout /t 1 /nobreak

REM Start Electron directly - current dir is already frontend
start "NetworkTool-Electron" cmd /k "call start-electron-dev.bat"

REM Keep main window open for reference
echo.
echo =====================================
echo   Starting Application...
echo   - Backend: http://127.0.0.1:8000
echo   - Frontend Dev: http://localhost:5173
echo   - Electron Window should open shortly...
echo =====================================
echo.
echo All services started. This window can be closed.
echo Electron and Vite are running in separate windows.
timeout /t 3 /nobreak
