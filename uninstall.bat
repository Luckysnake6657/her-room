@echo off
rem ============================================================
rem  QQAI uninstaller
rem  Deletes the app dir, keeps user data (memory/diary) by default.
rem ============================================================
setlocal
chcp 65001 >nul
echo.
echo  ============================================
echo   QQAI - Uninstall
echo  ============================================
echo.
echo  Will delete : D:\QQaibot   (app + bundled NapCat + her DSH instance)
echo  Will keep   : D:\qq-bridge\state   (her memory / diary / emotions)
echo.
choice /C YN /M "Uninstall now"
if errorlevel 2 goto :cancel

rem stop running processes first (the app + children)
taskkill /IM QQAI.exe /F >nul 2>&1
taskkill /IM NapCatWinBootMain.exe /F >nul 2>&1

echo Deleting app dir...
rmdir /s /q "D:\QQaibot" 2>nul
if exist "D:\QQaibot" (
  echo.
  echo  [X] Could not fully delete D:\QQaibot - close any window using it and retry.
) else (
  echo.
  echo  [OK] App removed.
)
echo.
echo  User data kept at: D:\qq-bridge\state
echo  To remove data too, delete D:\qq-bridge manually.
echo.
pause
exit /b 0

:cancel
echo.
echo  Cancelled.
pause
exit /b 1
