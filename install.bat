@echo off
chcp 65001 >nul
setlocal

echo ============================================
echo  Agent Control Center 离线安装
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo        请先安装 Node.js 22.18 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "%~dp0install.js"

echo.
pause
