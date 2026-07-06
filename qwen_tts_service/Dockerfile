FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libsndfile1 \
    sox \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --no-cache-dir \
    "transformers==4.57.3" \
    "tokenizers==0.22.2" \
    "faster-qwen3-tts[demo]==0.2.6"

COPY server.py /app/server.py

EXPOSE 8000

CMD ["python", "/app/server.py"]
