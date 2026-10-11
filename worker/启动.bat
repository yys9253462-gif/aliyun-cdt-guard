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
rem
rem CRITICAL - why this uses "for /f" over "dir /b" instead of the obvious
rem "for %%F in (*.ps1) do (...)"   [root cause found 2026-10-11]
rem
rem   A plain FOR-IN over a wildcard expands the matched path INSIDE a
rem   parenthesised block. cmd pairs the parentheses of that block BEFORE it
rem   considers quoting, so if the expanded path itself contains a closing
rem   paren the block is cut short at that character.
rem
rem   Repro: unpack anywhere whose path contains "(1)" (browsers append that
rem   to a second download of the same name), e.g.
rem       ...\Downloads\cdt-guard (1)\cdt-guard-worker\
rem   The expanded path is then
rem       set "PS1=C:\...\cdt-guard (1)\cdt-guard-worker\install.ps1"
rem   and cmd reports a syntax error about unexpected text after a paren
rem   (the leftover after the stray paren is treated as a command).
rem   The launcher dies instantly - the user sees a window flash and vanish.
rem
rem   Feeding names in through "for /f ... in ('dir /b')" avoids the trap:
rem   the value is read as a line of text, never inside a paren block, so a
rem   paren in the directory name is harmless. Verified on the real failing
rem   folder.
rem
rem   Keep the quoting exactly as below: the nested single quotes and the
rem   escaped caret are required to run dir from inside for /f.
rem ---------------------------------------------------------------------------
set "PS1="
set "PS1COUNT=0"
for /f "delims=" %%F in ('dir /b /a-d "*.ps1" 2^>nul') do (
    set "PS1=%~dp0%%F"
    set /a PS1COUNT+=1
)

if not defined PS1 (
    echo.
    echo [ERROR] No .ps1 launcher found in this folder.
    echo         Please make sure you extracted the WHOLE archive,
    echo         not just this single file.
    echo.
    echo         Current folder:
    echo         !CD!
    echo.
    pause
    exit /b 1
)

if not "!PS1COUNT!"=="1" (
    echo.
    echo [ERROR] Found !PS1COUNT! .ps1 files in this folder; expected exactly 1.
    echo         Please keep only the launcher that came with this package.
    echo.
    echo         Files seen:
    echo         !PS1!
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

rem ---------------------------------------------------------------------------
rem ALWAYS keep the window open, success or failure.
rem
rem WHY (measured 2026-10-11): the launcher used to pause only on failure.
rem On a normal "user quit the menu" run it exited 0, the .bat fell straight
rem through to exit, and the console window vanished the instant the menu
rem closed. Users described that as "double-click, window flashes, gone".
rem
rem A second, subtler cause was the launcher's own pause. It used PowerShell's
rem Read-Host, which returns immediately (0.025s) when stdin is redirected -
rem which is exactly what happens when cmd runs powershell with -File. So that
rem pause never actually held the window either.
rem
rem Note: comments in a .bat must avoid the gt and pipe characters, because
rem cmd still treats them as redirection even inside rem. Keep it plain text.
rem
rem This pause is cmd's real pause: it blocks and waits for a key. Verified
rem to block correctly in the same launch chain that silently defeated
rem Read-Host. Unconditional, so a clean quit is readable too.
rem ---------------------------------------------------------------------------
echo.
if not "%RC%"=="0" (
    echo [INFO] The launcher exited with code %RC%.
    echo        Scroll up to read the messages above.
)
pause

exit /b %RC%
