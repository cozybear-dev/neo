# Go toolchain from the official image (dl.google.com tarballs may be unreachable).
FROM golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac AS golang

FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

ENV DEBIAN_FRONTEND=noninteractive \
    GOPATH=/opt/go \
    GOBIN=/usr/local/bin \
    PATH=/usr/local/go/bin:/usr/local/bin:/opt/go/bin:$PATH \
    LANG=C.UTF-8

COPY --from=golang /usr/local/go /usr/local/go
COPY --from=golang /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# Freeze the Ubuntu package universe alongside the image and language locks.
RUN sed -i 's|http://archive.ubuntu.com/ubuntu/|https://snapshot.ubuntu.com/ubuntu/20261004T000000Z/|g; s|http://security.ubuntu.com/ubuntu/|https://snapshot.ubuntu.com/ubuntu/20261004T000000Z/|g; s|http://ports.ubuntu.com/ubuntu-ports/|https://snapshot.ubuntu.com/ubuntu/20261004T000000Z/|g' /etc/apt/sources.list.d/ubuntu.sources

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        gnupg \
        git \
        gh \
        adb \
        openssh-client \
        python3-impacket \
        jq \
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

# Required Go CLIs — any failure fails the layer (brief-required toolchain).
RUN set -eux; \
    export GOTOOLCHAIN=go1.26.8; \
    go install -v github.com/projectdiscovery/nuclei/v3/cmd/nuclei@v3.11.1; \
    nuclei -version; \
    go install -v github.com/projectdiscovery/vulnx/v2/cmd/vulnx@v2.0.2; \
    go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@v2.15.0; \
    go install -v github.com/projectdiscovery/dnsx/cmd/dnsx@v1.3.0; \
    go install -v github.com/projectdiscovery/httpx/cmd/httpx@v1.10.0; \
    go install -v github.com/projectdiscovery/naabu/v2/cmd/naabu@v2.6.1; \
    go install -v github.com/projectdiscovery/katana/cmd/katana@v1.7.0; \
    go install -v github.com/projectdiscovery/tlsx/cmd/tlsx@v1.3.0; \
    go install -v github.com/projectdiscovery/interactsh/cmd/interactsh-client@v1.3.1; \
    go install -v github.com/ffuf/ffuf/v2@v2.2.1; \
    go install -v github.com/zricethezav/gitleaks/v8@v8.30.1; \
    go install -v github.com/jpillora/chisel@v1.11.8; \
    go install -v github.com/ropnop/kerbrute@v1.0.3; \
    rm -rf /root/go/pkg /opt/go/pkg /tmp/*

# Verified upstream release checksums, no mutable remote install script.
ARG TARGETARCH
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) checksum=40377e6572495412fb9ba0bc21c9401f73b72f1d2afd11b9931bc4a5ed622866 ;; \
      arm64) checksum=372c568695d49e53517075b5f74d1ee9a19053f13661d689c7928ee1fc27d705 ;; \
      *) exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/trufflehog.tar.gz "https://github.com/trufflesecurity/trufflehog/releases/download/v3.97.9/trufflehog_3.97.9_linux_${TARGETARCH}.tar.gz"; \
    echo "$checksum  /tmp/trufflehog.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/trufflehog.tar.gz -C /usr/local/bin trufflehog; \
    rm /tmp/trufflehog.tar.gz; trufflehog --version

COPY python-requirements.txt /tmp/python-requirements.txt
# Install semgrep into an isolated venv to avoid Debian pip RECORD conflicts.
RUN python3 -m venv /opt/semgrep-venv \
    && /opt/semgrep-venv/bin/pip install --no-cache-dir --require-hashes -r /tmp/python-requirements.txt \
    && ln -sf /opt/semgrep-venv/bin/semgrep /usr/local/bin/semgrep \
    && semgrep --version

# Vendored bounded SecLists inputs; build never silently substitutes missing data.
COPY wordlists/ /opt/wordlists/
RUN echo "47fb86ca6fb3f97e5491161581900d6d99851fb16764eacddf16aa85617c956a  /opt/wordlists/common.txt" | sha256sum -c - \
    && echo "1aadf7dafde5ca68f5e5160c9206f7be6f6fc701775cdea30ba01bbb6d8db8ad  /opt/wordlists/raft-small-words.txt" | sha256sum -c -

# Ubuntu excludes documentation by default, including Impacket's CLI examples.
RUN printf '%s\n' 'path-include=/usr/share/doc/python3-impacket/examples/*' > /etc/dpkg/dpkg.cfg.d/impacket-examples \
    && apt-get update \
    && apt-get install -y --reinstall --no-install-recommends python3-impacket \
    && rm -rf /var/lib/apt/lists/* \
    && install -m 0755 /usr/share/doc/python3-impacket/examples/smbclient.py /usr/local/bin/impacket-smbclient \
    && sed -i '1c#!/usr/bin/python3' /usr/local/bin/impacket-smbclient

RUN if id ubuntu >/dev/null 2>&1; then userdel ubuntu; fi
RUN id neo >/dev/null 2>&1 || useradd -m -u 1000 -s /bin/bash neo \
    && mkdir -p /workspace \
    && chown -R neo:neo /workspace /opt/wordlists /home/neo

WORKDIR /workspace

COPY capabilities.py /usr/local/bin/neo-capabilities
RUN chmod +x /usr/local/bin/neo-capabilities
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# The worker runs without root privileges or sudo.
USER neo
ENTRYPOINT ["/entrypoint.sh"]
# Keep the container alive under Compose; agents docker-exec into it later.
CMD ["sleep", "infinity"]
