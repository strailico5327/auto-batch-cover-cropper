@echo off
cd /d "%~dp0"
python auto_batch_cover_cropper.py
if errorlevel 1 pause
