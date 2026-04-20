@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."
call npm run build:installer:signed
exit /b %ERRORLEVEL%
