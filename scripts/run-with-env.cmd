@echo off
REM Windows batch file to run a command and append stdout/stderr to MCP_STEP_LOG_PATH.
REM Usage: run-with-env.cmd <command...>

if "%~1"=="" exit /b 2
if "%MCP_STEP_LOG_PATH%"=="" exit /b 3
call %* >> "%MCP_STEP_LOG_PATH%" 2>&1
exit /b %ERRORLEVEL%
