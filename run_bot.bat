@echo off
title GOMONHUB WhatsApp OTP Bot
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%"
echo ====================================================
echo Starting GOMONHUB WhatsApp Verification Bot...
echo ====================================================
node bot.js
pause
