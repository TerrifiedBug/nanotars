# Himalaya CLI (email) — https://github.com/pimalaya/himalaya
# Pin version + sha256 so a compromised release can't silently land.
ARG HIMALAYA_VERSION=1.2.0
ARG HIMALAYA_SHA256=e04e6382e3e664ef34b01afa1a2216113194a2975d2859727647b22d9b36d4e4
RUN set -eux; \
    curl -fsSL "https://github.com/pimalaya/himalaya/releases/download/v${HIMALAYA_VERSION}/himalaya.x86_64-linux.tgz" -o /tmp/himalaya.tgz; \
    echo "${HIMALAYA_SHA256}  /tmp/himalaya.tgz" | sha256sum -c -; \
    tar -xzf /tmp/himalaya.tgz -C /usr/local/bin himalaya; \
    chmod +x /usr/local/bin/himalaya; \
    rm -f /tmp/himalaya.tgz; \
    himalaya --version
