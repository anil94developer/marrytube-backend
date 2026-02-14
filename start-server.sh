#!/bin/bash
# Script to start the server and handle port conflicts

PORT=5001

# Check if port is in use
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "⚠️  Port $PORT is already in use"
    echo "Killing process on port $PORT..."
    lsof -ti:$PORT | xargs kill -9 2>/dev/null
    sleep 2
fi

# Start the server
echo "🚀 Starting server on port $PORT..."
node server.js

