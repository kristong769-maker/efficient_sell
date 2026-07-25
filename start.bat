@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0install-shortcut.ps1" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-shortcut.ps1" -Silent >nul 2>&1
if exist "node_modules\playwright-core" goto run

echo Installing required components...
call npm.cmd install
if errorlevel 1 goto install_failed

:run
start "" pythonw.exe "native-ui.py"
if errorlevel 1 goto run_failed
exit /b 0

:install_failed
echo.
echo Installation failed. Check the network connection and try again.
pause
exit /b 1

:run_failed
echo.
echo The program stopped with an error.
pause
exit /b 1
