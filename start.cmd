@echo off
setlocal
title Digital Afterlife - Backend
pushd "%~dp0" || exit /b 1
echo Start board\start.cmd first. Keep this window open for backend logs.
node %* "src\backend\index.js"
set "START_EXIT=%ERRORLEVEL%"
echo.
echo Backend stopped. Exit code: %START_EXIT%
pause
popd
exit /b %START_EXIT%
