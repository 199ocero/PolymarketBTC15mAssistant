#!/bin/bash
while true; do
  echo "[AutoRestart] Starting bot..."
  npm start
  echo "[AutoRestart] Bot crashed or exited. Restarting in 3 seconds..."
  sleep 3
done
