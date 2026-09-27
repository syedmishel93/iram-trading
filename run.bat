@echo off
REM IRAM Intelligence Trading - Windows. Double-click, or: run.bat --status
REM
REM Three lines of logic on purpose. Every decision this launcher makes lives in
REM run.py, so all three platforms read one copy instead of three that drift;
REM the only thing a shell can do that Python cannot is find Python.
cd /d "%~dp0"
where python >nul 2>nul && (python run.py %* & goto :eof)
where py     >nul 2>nul && (py run.py %* & goto :eof)
echo Python 3 was not found. Install it from https://www.python.org/downloads/
echo The whole backend is Python; there is no way to run this without it.
pause
