# syntax=docker/dockerfile:1.7
# Build context is the project root (see docker-compose.yml).

# ---- Builder: Python venv with all wheels compiled, plus Node deps ----
FROM node:20-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-dev \
        build-essential \
        curl \
        ca-certificates \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY worker/requirements.txt /tmp/requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip && pip install --no-cache-dir -r /tmp/requirements.txt

# Best-effort auto-editor install for silence trimming. Its PyPI metadata in
# 25.x declares `pyav` (which doesn't exist on PyPI) instead of the real `av`
# package; we already installed av+ae-ffmpeg in requirements.txt, so --no-deps
# bypasses the broken declaration. If this still fails for any reason, edit.js
# falls back to the un-trimmed cut and the pipeline keeps working.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir --no-deps auto-editor==25.3.1 || \
    echo "auto-editor install skipped — silence trim will be unavailable"

WORKDIR /worker
COPY worker/package.json worker/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---- Runtime: slim, with ffmpeg + venv + node + Python ----
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        fonts-dejavu \
        fonts-dejavu-extra \
        util-linux \
        ca-certificates \
        curl \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /worker

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    DATA_DIR=/data \
    PYTHON_BIN=python3 \
    FACE_MODEL_PATH=/opt/models/face_detector_short_range.tflite

COPY --from=builder /worker/node_modules ./node_modules
COPY worker/src ./src
COPY worker/package.json ./
COPY worker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Pre-download MediaPipe face detector model.
RUN mkdir -p /opt/models \
 && curl -fsSL -o /opt/models/face_detector_short_range.tflite \
        https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite \
 && test -s /opt/models/face_detector_short_range.tflite

# Create writable data dir for non-root user
RUN mkdir -p /data && chown -R node:node /data /worker /opt/venv /opt/models

USER node
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "src/index.js"]
