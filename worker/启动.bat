@echo off
rem ===========================================================================
rem  CDT Guard - Windows launcher shim (double-click me)
rem ---------------------------------------------------------------------------
rem  WHY THIS FILE EXISTS
rem    Windows does not "run" a .ps1 when you double-click it - it opens it in
rem    Notepad. Beginners then see a wall of code and think the tool is broken.
rem    A .bat file, on the other hand, IS executed on double-click.
rem
rem  ENCODING
rem    This file is intentionally pure ASCII. cmd.exe decodes .bat as GBK,
rem    so non-ASCII bytes here would turn into mojibake and could even be
rem    executed as commands. All Chinese messages live in the .ps1 file,
rem    which PowerShell reads as UTF-8 correctly.
rem
rem  WHAT IT DOES
rem    Finds PowerShell and hands over to the real launcher (install .ps1).
rem ===========================================================================

setlocal enabledelayedexpansion

rem Run from the folder this .bat lives in, so relative paths work
rem even when the user launched us from somewhere else.
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem Locate the launcher .ps1
rem
rem The real launcher has a non-ASCII (Chinese) filename. We deliberately
rem avoid typing that name here: cmd.exe decodes .bat as GBK, so a UTF-8
rem Chinese path in this file would come out garbled and never match.
rem
rem Instead we pick up the single .ps1 that ships in this folder. Layout is
rem guaranteed (pack_release.py includes exactly one PowerShell launcher),
rem and we verify the count so a stray extra .ps1 cannot silently break it.
rem ---------------------------------------------------------------------------
set "PS1="
set "PS1COUNT=0"
for %%F in ("*.ps1") do (
    set "PS1=%%~fF"
    set /a PS1COUNT+=1
)

if not defined PS1 (
    echo.
    echo [ERROR] No .ps1 launcher found in this folder.
    echo         Current folder: %CD%
    echo         Please make sure you extracted the WHOLE archive,
    echo         not just this single file.
    echo.
    pause
    exit /b 1
)

if not "%PS1COUNT%"=="1" (
    echo.
    echo [ERROR] Found %PS1COUNT% .ps1 files in this folder; expected exactly 1.
    echo         Please keep only the launcher that came with this package.
    echo         Files seen: %PS1%
    echo.
    pause
    exit /b 1
)

rem Prefer Windows PowerShell (present on every Windows since 7).
set "PSEXE="
where powershell.exe >nul 2>nul && set "PSEXE=powershell.exe"

rem Fall back to PowerShell 7+ if the classic one is missing.
if not defined PSEXE (
    where pwsh.exe >nul 2>nul && set "PSEXE=pwsh.exe"
)

if not defined PSEXE (
    echo.
    echo [ERROR] PowerShell was not found on this computer.
    echo.
    echo   Windows normally ships with it. If it is really missing,
    echo   please install PowerShell 7 from:
    echo     https://aka.ms/powershell
    echo.
    pause
    exit /b 1
)

rem -NoProfile  : ignore the user's profile (faster, fewer surprises)
rem -ExecutionPolicy Bypass : this run only; nothing is changed permanently
rem -File        : run our launcher
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%"

set "RC=%ERRORLEVEL%"

rem Keep the window open if the launcher failed, so the user can read why.
if not "%RC%"=="0" (
    echo.
    echo [INFO] The launcher exited with code %RC%.
    echo        Scroll up to read the messages above.
    echo.
    pause
)

exit /b %RC%
