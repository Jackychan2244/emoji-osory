#!/bin/bash
set -e

PORT=3003

echo "🚀 Starting Emoji Fingerprint Server..."

# Check if port is in use
if lsof -i :$PORT >/dev/null; then
    echo "Port $PORT is currently in use."
    PID=$(lsof -t -i :$PORT)
    echo "Killing existing process (PID $PID)..."
    kill -9 $PID
    sleep 1
    echo "✓ Port cleared."
fi

echo "▶ Running 'npm start'..."
npm start
