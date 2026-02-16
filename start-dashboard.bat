@echo off
title NanoClaw Dashboard
echo.
echo   Starting NanoClaw Dashboard...
echo.

cd /d "%~dp0"

if not exist node_modules (
    echo   Installing dependencies...
    call npm install
)

start http://localhost:3000
npx tsx --env-file=.env src/dashboard.ts
pause
