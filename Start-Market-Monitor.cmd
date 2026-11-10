@echo off
setlocal
title Market Monitor
if not exist "%~dp0runtime\python.exe" (
  echo Extract the entire ZIP before opening this launcher.
  pause
  exit /b 1
)
"%~dp0runtime\python.exe" -B "%~dp0monitor.py" %*
set "market_monitor_exit=%ERRORLEVEL%"
if not "%market_monitor_exit%"=="0" pause
exit /b %market_monitor_exit%
