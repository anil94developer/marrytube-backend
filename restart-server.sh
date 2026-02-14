#!/bin/bash

# Restart Backend Server with CORS fix
# This script kills existing process and restarts the server

cd "$(dirname "$0")"

echo "🔄 Restarting MarryTube Backend Server..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Kill any existing process on port 5001
echo "📋 Checking for existing processes on port 5001..."
EXISTING_PID=$(lsof -ti:5001 2>/dev/null)
if [ ! -z "$EXISTING_PID" ]; then
  echo "⚠️  Found existing process (PID: $EXISTING_PID), killing it..."
  kill -9 $EXISTING_PID 2>/dev/null
  sleep 2
  echo "✅ Process killed"
fi

# Check if .env exists
if [ ! -f .env ]; then
  echo "❌ Error: .env file not found!"
  echo "📝 Please create .env file from .env.example"
  exit 1
fi

# Start server
echo "✅ Starting server on port 5001 with updated CORS..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
node server.js
