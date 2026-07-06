#!/usr/bin/env bash
set -euo pipefail

COMFYUI_ROOT="${COMFYUI_ROOT:-/opt/ComfyUI}"

mkdir -p \
  "${COMFYUI_ROOT}/models" \
  "${COMFYUI_ROOT}/input" \
  "${COMFYUI_ROOT}/output" \
  "${COMFYUI_ROOT}/user" \
  "${COMFYUI_ROOT}/custom_nodes"

for node_dir in /seed/custom_nodes/*; do
  node_name="$(basename "${node_dir}")"
  target_dir="${COMFYUI_ROOT}/custom_nodes/${node_name}"
  if [ ! -d "${target_dir}" ]; then
    cp -a "${node_dir}" "${target_dir}"
  fi
done

mkdir -p "${COMFYUI_ROOT}/user/default/workflows"
if [ -f /seed/workflows/QwenTTS_sample_workflow.json ] && [ ! -f "${COMFYUI_ROOT}/user/default/workflows/QwenTTS_sample_workflow.json" ]; then
  cp /seed/workflows/QwenTTS_sample_workflow.json "${COMFYUI_ROOT}/user/default/workflows/QwenTTS_sample_workflow.json"
fi

cd "${COMFYUI_ROOT}"
exec python main.py --listen 0.0.0.0 --port 8188 --disable-smart-memory
