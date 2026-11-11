@echo off
rem Windows launcher: apply.cmd install | doctor | start | stop | restart | status | scan | update | reset-pair
rem It runs apply.ps1 with script permission for this one run, so no system setting has to be changed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply.ps1" %*
