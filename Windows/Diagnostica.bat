@echo off
title Diagnostica iStudio
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnostica.ps1"
pause
