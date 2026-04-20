@echo off
setlocal EnableExtensions
title Root Record Weather Manager - Unsigned installer build

cd /d "%~dp0"
call npm run build:installer
set ERR=%ERRORLEVEL%

echo.
if %ERR% neq 0 (
  echo Unsigned installer build failed with exit code %ERR%.
  pause
  exit /b %ERR%
)

echo Unsigned installer build complete.
echo Output: build\output\RootRecordWeatherSetup-*.exe
echo.
pause
exit /b 0
