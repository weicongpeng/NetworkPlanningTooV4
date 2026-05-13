@echo off
chcp 65001 >nul

echo 复制后端文件...

xcopy "d:\mycode\NetworkPlanningTooV3\backend" "d:\mycode\NetworkPlanningTooV3\frontend\release\网络规划工具-win32-x64\resources\app.asar.unpacked\backend" /E /I /Y /Q

echo 复制完成
pause
