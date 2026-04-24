# Google Workspace CLI — https://github.com/googleworkspace/cli
# Tarball ships {CHANGELOG.md, LICENSE, README.md, gws} under `./` — extract
# to a temp dir and move just the binary; skip the wildcards-in-tar pitfalls.
# Use the musl-static build, not gnu: the gnu variant requires glibc 2.39
# (Debian 13 / trixie), while the base image is Debian 12 with glibc 2.36.
ARG GWS_VERSION=0.22.5
ARG GWS_SHA256=4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920
RUN set -eux; \
    curl -fsSL "https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/google-workspace-cli-x86_64-unknown-linux-musl.tar.gz" -o /tmp/gws.tgz; \
    echo "${GWS_SHA256}  /tmp/gws.tgz" | sha256sum -c -; \
    mkdir -p /tmp/gws-extract; \
    tar -xzf /tmp/gws.tgz -C /tmp/gws-extract; \
    mv /tmp/gws-extract/gws /usr/local/bin/gws; \
    chmod +x /usr/local/bin/gws; \
    rm -rf /tmp/gws-extract /tmp/gws.tgz; \
    gws --version
