@echo off
chcp 65001 >nul
title Starta CodeView - installer la voix
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
if not exist "node_modules\ws" call npm install
node scripts\install-voice.ts %*
if errorlevel 1 goto fail
echo.
pause
exit /b 0

:nonode
echo.
echo Node.js est introuvable. Installe la version 22.18 ou plus recente : https://nodejs.org
pause
exit /b 1

:fail
echo.
echo L'installation de la voix a echoue (voir ci-dessus).
pause
exit /b 1
