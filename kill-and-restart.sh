#!/bin/bash

# Kill all node processes on port 5001 and restart server
# This ensures old processes are completely removed

cd "$(dirname "$0")"

echo "🔄 Killing all processes on port 5001..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Kill all processes on port 5001
PIDS=$(lsof -ti:5001 2>/dev/null)
if [ ! -z "$PIDS" ]; then
  echo "Found processes: $PIDS"
  echo "$PIDS" | xargs kill -9 2>/dev/null
  sleep 3
  echo "✅ All processes killed"
else
  echo "✅ No processes found on port 5001"
fi

# Double check - kill any remaining
lsof -ti:5001 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 2

# Check if .env exists
if [ ! -f .env ]; then
  echo "❌ Error: .env file not found!"
  echo "📝 Please create .env file from .env.example"
  exit 1
fi

# Start server
echo ""
echo "🚀 Starting server on port 5001..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
node server.js

