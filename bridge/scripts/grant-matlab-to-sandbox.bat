@echo off
REM Grant the AppContainer sandbox identity read+execute on the MATLAB install dir.
REM Needed so the sandboxed MATLAB can start (and can spawn MATLABWindow.exe for plots)
REM while still being unable to run cmd.exe / powershell.exe (they live in System32 and stay unauthorized).
echo Granting D:\MATLAB read+execute to the qq-bridge AppContainer sandbox...
icacls "D:\MATLAB" /grant "*S-1-15-2-3658635457-1815541074-1805575036-747135259-1628741545-4246522899-1797788494:(OI)(CI)RX"
echo.
echo Exit code: %ERRORLEVEL%   (0 = success)
echo You can close this window.
pause
