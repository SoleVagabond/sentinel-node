@echo off
python "%~dp0sentinel.pyz" --port 8799 %*
if errorlevel 1 pause
