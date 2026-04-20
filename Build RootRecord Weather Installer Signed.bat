@echo off
setlocal EnableExtensions
title Root Record Weather Manager - Signed installer build

cd /d "%~dp0"
call npm run build:installer:signed
set ERR=%ERRORLEVEL%

echo.
if %ERR% neq 0 (
  echo Signed installer build failed with exit code %ERR%.
  pause
  exit /b %ERR%
)

echo Signed installer build complete.
echo Output: build\output\RootRecordWeatherSetup-*.exe
echo.
pause
exit /b 0
