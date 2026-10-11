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
rem    1. Finds PowerShell and hands over to the real launcher (install .ps1).
rem    2. Unblocks the downloaded files first (see below).
rem
rem  WHY THE UNBLOCK STEP EXISTS  -- READ THIS BEFORE DELETING IT
rem    Files that arrive through a browser / cloud drive are tagged with a
rem    "Mark of the Web" (an NTFS alternate data stream named Zone.Identifier,
rem    with ZoneId=3 = Internet). Windows then treats every one of them as
rem    suspicious. Real-world symptoms reported by users of an earlier build:
rem      - double-clicking the launcher "opens and instantly closes"
rem      - a security prompt flashes by too fast to read
rem      - PowerShell refuses to run the script even with Bypass
rem    The reliable cure is to strip that tag from the whole folder before we
rem    start. It is a purely local, per-file flag; removing it changes nothing
rem    about the file contents and does NOT need administrator rights.
rem ===========================================================================

setlocal enabledelayedexpansion

rem Give the console window a recognizable name, so the user can tell it apart
rem from other black windows that may be open.
title CDT Guard - Installer

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

rem ---------------------------------------------------------------------------
rem STEP 1: remove the "downloaded from the Internet" tag from this folder.
rem
rem WHY: files that arrive through a browser or a cloud drive get a "Mark of
rem the Web" - an NTFS alternate data stream named Zone.Identifier holding
rem "ZoneId=3" (= Internet). Windows then treats every one of them as
rem suspicious, and the symptom users report is exactly "double-click opens
rem and instantly closes", sometimes with a security prompt that flashes by.
rem
rem IMPORTANT - why this calls the .ps1 with -UnblockOnly instead of doing the
rem unblocking here with an inline PowerShell one-liner:
rem   Measured on a real download folder, an inline one-liner run through
rem   cmd.exe -> powershell.exe -Command left ALL 40 tagged files untouched
rem   (silent no-op), while the same Unblock-File call executed inside a
rem   PowerShell script removed all of them. The -Command form loses the
rem   pipeline when launched from cmd. So the work is delegated to the
rem   launcher script, where it actually works.
rem
rem Output goes to nul and failures are ignored on purpose: unblocking is a
rem convenience. If it cannot run, we still try the real launcher below.
rem ---------------------------------------------------------------------------
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -UnblockOnly >nul 2>nul

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
