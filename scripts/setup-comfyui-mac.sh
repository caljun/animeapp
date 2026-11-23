#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
runtime="$root/.comfyui"
revision=a88593173fa3eb31fa25f2ad2db9521f7bb74744

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'このセットアップは Apple Silicon Mac 用です。' >&2
  exit 1
fi
memory="$(sysctl -n hw.memsize)"
if (( memory < 17179869184 )); then
  echo 'この構成は統合メモリ16 GB以上を推奨します。' >&2
  exit 1
fi
free="$(df -Pk "$root" | awk 'NR == 2 {print $4}')"
if (( free < 8388608 )); then
  echo 'セットアップ前に空き容量を8 GiB以上確保してください。' >&2
  exit 1
fi
command -v python3 >/dev/null || { echo 'Python 3 をインストールしてください。' >&2; exit 1; }

mkdir -p "$runtime/models/checkpoints" "$runtime/models/controlnet"
download() {
  local url="$1" target="$2" digest="$3"
  if [[ ! -f "$target" ]]; then
    curl --fail --location --retry 2 --continue-at - "$url" --output "$target.part"
    printf '%s  %s\n' "$digest" "$target.part" | shasum -a 256 -c -
    mv "$target.part" "$target"
  else
    printf '%s  %s\n' "$digest" "$target" | shasum -a 256 -c -
  fi
}

download 'https://huggingface.co/Comfy-Org/stable-diffusion-1.5/resolve/main/v1-5-pruned-emaonly-fp16.safetensors' \
  "$runtime/models/checkpoints/v1-5-pruned-emaonly-fp16.safetensors" e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916
download 'https://huggingface.co/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/main/control_v11p_sd15_scribble_fp16.safetensors' \
  "$runtime/models/controlnet/control_v11p_sd15_scribble_fp16.safetensors" 99edfd25b54c18c0ab19fba8c5618f741aac1f8c3101e7fa62cce925ad87ae68

if [[ ! -d "$runtime/ComfyUI/.git" ]]; then
  git init "$runtime/ComfyUI"
  git -C "$runtime/ComfyUI" remote add origin https://github.com/Comfy-Org/ComfyUI.git
fi
if [[ "$(git -C "$runtime/ComfyUI" rev-parse --verify HEAD 2>/dev/null || true)" != "$revision" ]]; then
  git -C "$runtime/ComfyUI" fetch --depth 1 origin "$revision"
  git -C "$runtime/ComfyUI" checkout --detach "$revision"
fi
if [[ ! -x "$runtime/bootstrap/bin/uv" ]]; then
  python3 -m venv "$runtime/bootstrap"
  "$runtime/bootstrap/bin/pip" --disable-pip-version-check --no-cache-dir install uv==0.13.9
fi
export UV_PYTHON_INSTALL_DIR="$runtime/python"
export UV_CACHE_DIR="$runtime/uv-cache"
uv="$runtime/bootstrap/bin/uv"
if [[ ! -x "$runtime/venv/bin/python" ]]; then
  "$uv" venv --python 3.12 "$runtime/venv"
fi
"$uv" pip install --no-cache --python "$runtime/venv/bin/python" -r "$runtime/ComfyUI/requirements.txt"
"$runtime/venv/bin/python" -c 'import torch; assert torch.backends.mps.is_available(), "MPS が利用できません"; print(torch.__version__, "MPS available")'
