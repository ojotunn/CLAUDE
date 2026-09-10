@echo off
title Claudeploy
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
if not exist .env (
  echo No .env found, using defaults. Copy .env.example to .env to customize.
)
echo.
echo Starting Claudeploy on http://localhost:8436
echo MCP endpoint: http://localhost:8436/mcp
echo.
node --env-file-if-exists=.env src\server.js
pause
