# Optional Ghidra + LaurieWired/GhidraMCP (https://github.com/LaurieWired/GhidraMCP).
# GhidraMCP plugin HTTP API listens on port 8080 (control-network only; not published to host).
# Pin matches GhidraMCP 1.4 (Ghidra 11.3.2). Do not rely on building this image in CI smoke.

FROM eclipse-temurin:21-jdk-jammy

ARG GHIDRA_VERSION=11.3.2
ARG GHIDRA_DATE=20250415
ARG GHIDRAMCP_TAG=1.4
ARG GHIDRAMCP_ZIP=GhidraMCP-release-1-4.zip

ENV DEBIAN_FRONTEND=noninteractive \
    GHIDRA_INSTALL_DIR=/opt/ghidra \
    GHIDRA_MCP_PORT=8080 \
    JAVA_HOME=/opt/java/openjdk \
    PATH=/opt/ghidra:/opt/java/openjdk/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       unzip \
       python3 \
       python3-pip \
       xvfb \
       libxrender1 \
       libxtst6 \
       libxi6 \
       libxext6 \
       libx11-6 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN curl -fsSL -o ghidra.zip \
      "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip" \
  && echo "99d45035bdcc3d6627e7b1232b7b379905a9fad76c772c920602e2b5d8b2dac2  ghidra.zip" | sha256sum -c - \
  && unzip -q ghidra.zip \
  && mv "ghidra_${GHIDRA_VERSION}_PUBLIC" ghidra \
  && rm ghidra.zip

# Install LaurieWired GhidraMCP extension (embedded HTTP server on :8080).
RUN mkdir -p /opt/ghidra/Ghidra/Extensions \
  && curl -fsSL -o /tmp/GhidraMCP.zip \
       "https://github.com/LaurieWired/GhidraMCP/releases/download/${GHIDRAMCP_TAG}/${GHIDRAMCP_ZIP}" \
  && unzip -q /tmp/GhidraMCP.zip -d /opt/ghidra/Ghidra/Extensions/GhidraMCP \
  && rm /tmp/GhidraMCP.zip \
  && curl -fsSL -o /opt/ghidra/bridge_mcp_ghidra.py \
       "https://raw.githubusercontent.com/LaurieWired/GhidraMCP/${GHIDRAMCP_TAG}/bridge_mcp_ghidra.py" \
  && pip3 install --no-cache-dir mcp requests

COPY start-ghidra-mcp.sh /usr/local/bin/start-ghidra-mcp.sh
RUN chmod +x /usr/local/bin/start-ghidra-mcp.sh \
  && mkdir -p /workspace/ghidra /home/ghidra/projects \
  && useradd -m -u 10001 -s /bin/bash ghidra \
  && chown -R ghidra:ghidra /workspace /home/ghidra /opt/ghidra

USER ghidra
WORKDIR /workspace/ghidra

# MCP / GhidraMCP HTTP API (plugin default).
EXPOSE 8080

VOLUME ["/workspace/ghidra", "/home/ghidra/projects"]

ENTRYPOINT ["/usr/local/bin/start-ghidra-mcp.sh"]
