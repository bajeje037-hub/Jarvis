@echo off
rem Doppio clic per avviare; oppure: start.bat --tailscale
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
