@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."
call npm run build:installer
exit /b %ERRORLEVEL%
