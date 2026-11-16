@echo off
sh "%~dp0verify" %*
exit /b %ERRORLEVEL%
