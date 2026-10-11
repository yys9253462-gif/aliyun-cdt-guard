@echo off
rem ===========================================================================
rem  Diagnostic launcher - find out why "monitoring config" says
rem  "no machine configured yet".
rem
rem  NOTE: this file must stay pure ASCII and CRLF. cmd.exe decodes it as GBK,
rem  so any non-ASCII byte turns into garbage - and a garbled "rem" line can
rem  even be executed as a command. Keep it English here.
rem ===========================================================================
setlocal
title CDT Guard - Diagnose Monitoring Config

set "BASH="

rem --- locate Git Bash (same list as the main launcher) ---
if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles%\Git\usr\bin\bash.exe" set "BASH=%ProgramFiles%\Git\usr\bin\bash.exe"

if not defined BASH (
    echo.
    echo [ERROR] Git Bash not found. Please install Git for Windows first.
    echo.
    pause
    exit /b 1
)

pushd "%~dp0"
"%BASH%" --login -i -c "bash diagnose-config.sh"
popd

echo.
pause
endlocal
