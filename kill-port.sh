#!/bin/bash
# Script to kill process on port 5001

PORT=5001

echo "🔍 Checking port $PORT..."

PID=$(lsof -ti:$PORT 2>/dev/null)

if [ -z "$PID" ]; then
    echo "✅ Port $PORT is free"
else
    echo "⚠️  Port $PORT is in use by process $PID"
    echo "🔪 Killing process $PID..."
    kill -9 $PID 2>/dev/null
    sleep 1
    
    # Verify
    if lsof -ti:$PORT >/dev/null 2>&1; then
        echo "❌ Failed to kill process"
    else
        echo "✅ Port $PORT is now free"
    fi
fi

