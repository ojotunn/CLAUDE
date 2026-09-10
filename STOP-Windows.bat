@echo off
title Stop Cladeployer
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8436 ^| findstr LISTENING') do (
  echo Stopping Cladeployer, PID %%p
  taskkill /F /PID %%p >nul 2>&1
  set FOUND=1
)
if "%FOUND%"=="0" echo Cladeployer is not running on port 8436.
echo Done.
pause
