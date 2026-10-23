@echo off
chcp 65001 >nul
title Starta CodeView
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
if not exist "node_modules\ws" call npm install
node server\index.ts
if errorlevel 1 goto fail
exit /b 0

:nonode
echo.
echo Node.js est introuvable. Installe la version 22.18 ou plus recente : https://nodejs.org
pause
exit /b 1

:fail
echo.
echo Starta CodeView s'est arrete avec une erreur (voir ci-dessus).
pause
exit /b 1
