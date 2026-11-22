@echo off
title Yasno SEO
cd /d "%~dp0"
start "" http://localhost:4321
node server.js
if errorlevel 3 exit /b
pause
