# Go toolchain from the official image (dl.google.com tarballs may be unreachable).
FROM golang:1.24-bookworm AS golang

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    GOPATH=/opt/go \
    GOBIN=/usr/local/bin \
    PATH=/usr/local/go/bin:/usr/local/bin:/opt/go/bin:$PATH \
    LANG=C.UTF-8

COPY --from=golang /usr/local/go /usr/local/go

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        gnupg \
        git \
        jq \
        sudo \
        build-essential \
        pkg-config \
        libpcap-dev \
        libpcap0.8 \
        nmap \
        sqlmap \
        hydra \
        john \
        python3 \
        python3-pip \
        python3-venv \
        nodejs \
        npm \
        mitmproxy \
        wireguard-tools \
        openvpn \
        whois \
        bind9-dnsutils \
        unzip \
    && rm -rf /var/lib/apt/lists/* \
    && go version

# ProjectDiscovery + companion Go CLIs. Failures for non-critical tools are logged;
# nuclei is required and installed first.
RUN set -eux; \
    go install -v github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest; \
    nuclei -version; \
    go install -v github.com/projectdiscovery/vulnx/cmd/vulnx@latest \
      || go install -v github.com/projectdiscovery/vulnx/v2/cmd/vulnx@latest \
      || echo "WARN: go install failed for vulnx"; \
    for pkg in \
      github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest \
      github.com/projectdiscovery/dnsx/cmd/dnsx@latest \
      github.com/projectdiscovery/httpx/cmd/httpx@latest \
      github.com/projectdiscovery/naabu/v2/cmd/naabu@latest \
      github.com/projectdiscovery/katana/cmd/katana@latest \
      github.com/projectdiscovery/tlsx/cmd/tlsx@latest \
      github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest \
      github.com/ffuf/ffuf/v2@latest \
      github.com/zricethezav/gitleaks/v8@latest \
      github.com/jpillora/chisel@latest \
      github.com/ropnop/kerbrute@latest \
    ; do \
      go install -v "$pkg" || echo "WARN: go install failed for $pkg"; \
    done; \
    rm -rf /root/go/pkg /opt/go/pkg /tmp/*

# trufflehog: release binary (go install fails due to replace directives / layout).
RUN curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh \
      | sh -s -- -b /usr/local/bin \
    && trufflehog --version \
    || echo "WARN: trufflehog install failed"

# Install semgrep into an isolated venv to avoid Debian pip RECORD conflicts.
RUN python3 -m venv /opt/semgrep-venv \
    && /opt/semgrep-venv/bin/pip install --no-cache-dir semgrep \
    && ln -sf /opt/semgrep-venv/bin/semgrep /usr/local/bin/semgrep \
    && semgrep --version

# Minimal wordlists (ffuf ships defaults; add a small SecLists-style subset).
RUN mkdir -p /opt/wordlists \
    && curl -fsSL -o /opt/wordlists/common.txt \
         https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/common.txt \
    && curl -fsSL -o /opt/wordlists/raft-small-words.txt \
         https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/raft-small-words.txt \
    || true

RUN id neo >/dev/null 2>&1 || useradd -m -s /bin/bash neo \
    && echo 'neo ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/neo \
    && chmod 0440 /etc/sudoers.d/neo \
    && mkdir -p /workspace \
    && chown -R neo:neo /workspace /opt/wordlists /home/neo

WORKDIR /workspace
USER neo

# Keep the container alive under Compose; agents docker-exec into it later.
CMD ["sleep", "infinity"]
