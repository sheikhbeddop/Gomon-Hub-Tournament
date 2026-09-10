@echo off
title Free Fire Pro Tournaments Platform
color 0A
echo ========================================================
echo   FREE FIRE TOURNAMENT SERVER (HIGH PERFORMANCE)
echo   Local URL: http://127.0.0.1:8000
echo   Admin Login: username: admin / password: admin12345
echo ========================================================
echo.
echo [*] Starting backend server in background...
start /b python app.py
timeout /t 3 /nobreak >nul
echo.
echo [*] Launching Cloudflare Online Tunnel for Mobile Players...
echo [*] নিচের লিংকটি প্লেয়ারদের পাঠিয়ে দিন:
echo.
.\cloudflared.exe tunnel --url http://127.0.0.1:8000
pause
