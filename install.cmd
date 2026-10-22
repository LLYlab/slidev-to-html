@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required: https://nodejs.org/  ^(22.12 or newer^)
  echo.
  pause
  exit /b 1
)

node tools\setup.mjs %*
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" echo Setup finished with errors.
pause
exit /b %EXITCODE%
