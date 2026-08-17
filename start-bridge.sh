#!/usr/bin/env bash
# Start (or restart) the Mistok bridge inside a detached tmux session.
# Fallback runner (tmux). On macOS the bridge runs via launchd (com.mistok.bridge);
# use this only on Linux/WSL: bash ~/Code/mistok/start-bridge.sh
set -e
SESSION="mistok-bridge"
cd "$(dirname "$0")"

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" "./venv/bin/python bridge.py 2>&1 | tee /tmp/mistok-bridge.log"

# Wait for it to be up
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf http://localhost:8787/status >/dev/null 2>&1; then
        echo "[start-bridge] up after ${i}00ms"
        curl -s http://localhost:8787/status
        echo ""
        echo "[start-bridge] attach with: tmux attach -t $SESSION"
        echo "[start-bridge] stop with:   tmux kill-session -t $SESSION"
        exit 0
    fi
    sleep 0.1
done

echo "[start-bridge] FAILED to start within 1s"
echo "[start-bridge] log:"
cat /tmp/mistok-bridge.log
exit 1
