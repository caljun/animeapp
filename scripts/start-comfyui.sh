#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
runtime="$root/.comfyui"
if [[ ! -x "$runtime/venv/bin/python" || ! -f "$runtime/ComfyUI/main.py" ]]; then
  echo '先に bash scripts/setup-comfyui-mac.sh を実行してください。' >&2
  exit 1
fi
# Local-only upstream; the application bridges to it on the same machine.
export PYTORCH_ENABLE_MPS_FALLBACK=1
exec "$runtime/venv/bin/python" "$runtime/ComfyUI/main.py" \
  --base-directory "$runtime" --listen 127.0.0.1 --port "${KOMA_COMFY_PORT:-8188}" \
  --offline --disable-all-custom-nodes --lowvram --preview-method none
