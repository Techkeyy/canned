#!/usr/bin/env bash
set -u

echo "== OS =="
if [ -f /etc/os-release ]; then . /etc/os-release; echo "${PRETTY_NAME:-unknown}"; fi
echo "== Memory =="
free -h 2>/dev/null || true
echo "== Disk =="
df -h / 2>/dev/null || true
echo "== Listening ports =="
ss -lntup 2>/dev/null || netstat -lntup 2>/dev/null || true
echo "== Docker =="
docker --version 2>/dev/null || true
docker compose version 2>/dev/null || true
echo "== Node =="
node --version 2>/dev/null || true
echo "== Reverse proxy =="
for command in caddy nginx traefik; do command -v "$command" 2>/dev/null && "$command" version 2>/dev/null || true; done
echo "== systemd =="
command -v systemctl >/dev/null 2>&1 && systemctl --version | head -n 1 || true
echo "== Firewall =="
ufw status 2>/dev/null || firewall-cmd --state 2>/dev/null || true
echo "== Relevant services =="
systemctl --no-pager --type=service --state=running 2>/dev/null | grep -Ei 'caddy|nginx|traefik|docker|canned|node' || true
