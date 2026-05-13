@echo off
REM MapInfo 地理数据处理库安装脚本
REM 用于解决 MapInfo TAB 文件解析问题

echo ========================================
echo MapInfo 地理数据处理库安装脚本
echo ========================================
echo.
echo 此脚本将安装以下依赖库：
echo   - geopandas: 地理数据处理
echo   - shapely: 几何操作
echo   - fiona: 文件 I/O
echo   - pyproj: 坐标转换
echo.
echo 按任意键继续安装...
pause > nul

echo.
echo 正在检测 Python 环境...
python --version
if errorlevel 1 (
    echo [错误] 未找到 Python，请确保 Python 已安装并添加到 PATH
    pause
    exit /b 1
)

echo.
echo ========================================
echo 方法 1: 使用 pip 安装（推荐尝试）
echo ========================================
echo.
echo 正在尝试使用 pip 安装 geopandas...
echo 注意: Windows 上可能需要预编译的 wheel 文件
echo.

pip install geopandas shapely fiona pyproj

if errorlevel 1 (
    echo.
    echo ========================================
    echo pip 安装失败，尝试方法 2
    echo ========================================
    echo.
    echo 如果你有 conda，请运行以下命令：
    echo   conda install -c conda-forge geopandas
    echo.
    echo 或者手动下载预编译的 wheel 文件：
    echo   https://www.lfd.uci.edu/~gohlke/pythonlibs/
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo 验证安装...
echo ========================================
python -c "import geopandas; print(f'geopandas 版本: {geopandas.__version__}')"
if errorlevel 1 (
    echo [错误] geopandas 安装验证失败
    pause
    exit /b 1
)

python -c "import shapely; print(f'shapely 版本: {shapely.__version__}')"
if errorlevel 1 (
    echo [错误] shapely 安装验证失败
    pause
    exit /b 1
)

echo.
echo ========================================
echo 安装成功！
echo ========================================
echo.
echo 现在可以正常解析 MapInfo TAB 文件了。
echo.
pause
