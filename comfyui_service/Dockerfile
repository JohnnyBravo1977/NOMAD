FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    COMFYUI_ROOT=/opt/ComfyUI

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ffmpeg \
    git \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    sox \
    libxext6 \
    libxrender1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

RUN git clone --depth 1 https://github.com/Comfy-Org/ComfyUI.git "${COMFYUI_ROOT}" \
  && mkdir -p /seed/custom_nodes /seed/workflows \
  && git clone --depth 1 https://github.com/Comfy-Org/ComfyUI-Manager.git /seed/custom_nodes/ComfyUI-Manager \
  && git clone --depth 1 https://github.com/1038lab/ComfyUI-QwenTTS.git /seed/custom_nodes/ComfyUI-QwenTTS \
  && cp /seed/custom_nodes/ComfyUI-QwenTTS/example_workflows/QwenTTS_sample_workflow.json /seed/workflows/QwenTTS_sample_workflow.json

RUN pip install --upgrade pip setuptools wheel \
  && pip install -r "${COMFYUI_ROOT}/requirements.txt" \
  && if [ -f /seed/custom_nodes/ComfyUI-Manager/requirements.txt ]; then pip install -r /seed/custom_nodes/ComfyUI-Manager/requirements.txt; fi \
  && if [ -f /seed/custom_nodes/ComfyUI-QwenTTS/requirements.txt ]; then \
       grep -vE '^(torch|torchaudio)([<>=].*)?$' /seed/custom_nodes/ComfyUI-QwenTTS/requirements.txt > /tmp/qwen_tts_requirements.filtered.txt \
       && pip install -r /tmp/qwen_tts_requirements.filtered.txt; \
     fi \
  && pip install --no-cache-dir \
       "transformers==4.57.3" \
       "tokenizers==0.22.2" \
       "onnxruntime==1.23.1" \
       "sox==1.5.0"

COPY entrypoint.sh /usr/local/bin/comfyui-entrypoint.sh
RUN chmod +x /usr/local/bin/comfyui-entrypoint.sh

EXPOSE 8188

ENTRYPOINT ["/usr/local/bin/comfyui-entrypoint.sh"]
