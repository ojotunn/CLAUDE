@echo off
title Cladeployer tests
cd /d "%~dp0"
if not exist node_modules call npm install
node --env-file-if-exists=.env --test
pause
