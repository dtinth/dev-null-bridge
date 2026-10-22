# dev-null-bridge server: poller, sqlite, posting as the bot, the CLI's API and the web UI.
# Pinned to a stable Deno; bump deliberately.
FROM denoland/deno:2.9.7

# The commit script dev-null.sh serves needs curl and ssh-keygen (bash, awk, od come with Debian).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY deno.json deno.lock ./
COPY src ./src
RUN deno cache src/main.ts

# The sqlite file and the cached commit script live on the volume; the SSH key goes in ~/.ssh
# (mount it with its .pub, or pass BRIDGE_SSH_PRIVATE_KEY).
RUN mkdir -p /data /home/deno/.ssh && chown -R deno:deno /data /home/deno && chmod 700 /home/deno/.ssh
ENV BRIDGE_DB=/data/bridge.db XDG_CACHE_HOME=/data/cache HOME=/home/deno PORT=8787
VOLUME /data
USER deno
EXPOSE 8787

CMD ["run", "--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-run=bash,ssh-keygen", "--allow-sys", "src/main.ts", "serve"]
