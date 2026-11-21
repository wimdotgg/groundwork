@echo off
where sh >nul 2>nul
if not errorlevel 1 goto run_path
if exist "%ProgramFiles%\Git\usr\bin\sh.exe" goto run_git
echo Git for Windows sh is required to run scripts/deploy.
exit /b 1
:run_path
sh "%~dp0deploy" %*
exit /b %ERRORLEVEL%
:run_git
set "PATH=%ProgramFiles%\Git\usr\bin;%PATH%"
"%ProgramFiles%\Git\usr\bin\sh.exe" "%~dp0deploy" %*
exit /b %ERRORLEVEL%
