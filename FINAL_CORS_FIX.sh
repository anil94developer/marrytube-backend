#!/bin/bash

# FINAL CORS FIX - Kill all processes and restart with clean config

cd "$(dirname "$0")"

echo "🔴 FINAL CORS FIX - Killing ALL processes on port 5001"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Kill ALL processes on port 5001 (multiple times to be sure)
for i in {1..3}; do
  PIDS=$(lsof -ti:5001 2>/dev/null)
  if [ ! -z "$PIDS" ]; then
    echo "Killing processes: $PIDS"
    echo "$PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
done

# Final check and kill
lsof -ti:5001 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 2

# Verify no processes
REMAINING=$(lsof -ti:5001 2>/dev/null | wc -l)
if [ "$REMAINING" -gt 0 ]; then
  echo "⚠️  Warning: Still found $REMAINING process(es) on port 5001"
  echo "Trying one more time..."
  lsof -ti:5001 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 2
else
  echo "✅ All processes killed successfully"
fi

# Check if .env exists
if [ ! -f .env ]; then
  echo "❌ Error: .env file not found!"
  exit 1
fi

echo ""
echo "🚀 Starting fresh server with updated CORS configuration..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
node server.js

