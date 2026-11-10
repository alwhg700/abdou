#!/bin/bash
# أداة مساعدة لاستدعاء أدوات MCP عبر curl — تهيئة كاملة في كل مرة
# الاستخدام: mcp-call.sh <tool-name> <arguments-json> [timeout]
set -e
TOOL="$1"
ARGS="${2:-\{\}}"
TMO="${3:-120}"

HDRS=$(curl -s -m 30 -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}' \
  -D - -o /dev/null)
SID=$(echo "$HDRS" | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')

curl -s -m 30 -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null

curl -s -N -m "$TMO" -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS}}"
