@echo off
where sh >nul 2>nul
if not errorlevel 1 goto run_path
if exist "%ProgramFiles%\Git\usr\bin\sh.exe" goto run_git
echo Git for Windows sh is required to run scripts/verify.
exit /b 1
:run_path
sh "%~dp0verify" %*
exit /b %ERRORLEVEL%
:run_git
"%ProgramFiles%\Git\usr\bin\sh.exe" "%~dp0verify" %*
exit /b %ERRORLEVEL%
