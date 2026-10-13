#!/usr/bin/env bash
# Runs src/api/__tests__/shared-send.it.test.ts against a throwaway Stalwart.
#
# Uses only the local image bulwark-integration-stalwart:latest (Stalwart
# 0.16; never pulled). Its entrypoint bootstraps on first start: an admin
# from STALWART_RECOVERY_ADMIN, users alice/bob/carol@example.org sharing
# TEST_ACCOUNT_PASSWORD, and the group team@example.org with carol in it.
# This script then adds bob to team with the bundled stalwart-cli, and has
# alice share one folder with bob (maySubmit) over JMAP.
#
# Everything it creates is named bulwark-sharedsend-it-<pid> and removed on
# exit. JMAP is reached over the container's plain-HTTP listener, published on
# 127.0.0.1 only. The container gets an unusable DNS server, so it can't reach
# any outside host either (the server otherwise fetches its web UI).
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=bulwark-integration-stalwart:latest
NAME="bulwark-sharedsend-it-$$"
DATA_VOL="$NAME-data"
CONFIG_VOL="$NAME-config"
ADMIN_PASS="admin-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')-harbor"
# Stalwart refuses weak passwords.
USER_PASS="it-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')-orchid-tundra"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$DATA_VOL" "$CONFIG_VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker image inspect "$IMAGE" >/dev/null

# --dns 127.0.0.1: no name resolves inside the container, so the server can't
# reach any outside host (it would fetch its web UI from github.com). Mail
# between the example.org users is delivered locally and needs no DNS.
docker run -d --pull never --name "$NAME" \
  --dns 127.0.0.1 \
  -v "$DATA_VOL:/var/lib/stalwart" -v "$CONFIG_VOL:/etc/stalwart" \
  -p 127.0.0.1::8080 \
  -e "STALWART_RECOVERY_ADMIN=admin:$ADMIN_PASS" \
  -e "TEST_ACCOUNT_PASSWORD=$USER_PASS" \
  "$IMAGE" >/dev/null

PORT=$(docker port "$NAME" 8080/tcp | grep -m1 '^127\.0\.0\.1:' | cut -d: -f2)
URL="http://127.0.0.1:$PORT"
echo "Stalwart: $NAME on $URL"

# The bootstrap restarts the server twice; wait for its final start.
for _ in $(seq 1 120); do
  if docker logs "$NAME" 2>&1 | grep -q 'Starting Stalwart (final' &&
    curl -fs -o /dev/null -u "bob@example.org:$USER_PASS" "$URL/jmap/session"; then
    break
  fi
  sleep 1
done
curl -fsS -o /dev/null -u "bob@example.org:$USER_PASS" "$URL/jmap/session"

cli() {
  docker exec -e HOME=/tmp -e STALWART_URL=http://127.0.0.1:8080 \
    -e STALWART_USER=admin -e "STALWART_PASSWORD=$ADMIN_PASS" \
    "$NAME" stalwart-cli "$@"
}
account_id() {
  cli query Account --json | grep "\"emailAddress\":\"$1\"" | sed -E 's/.*"id":"([^"]+)".*/\1/'
}
jmap() { # user, body
  curl -fsS -u "$1:$USER_PASS" -H 'Content-Type: application/json' "$URL/jmap/" -d "$2"
}

ALICE_ID=$(account_id alice@example.org)
BOB_ID=$(account_id bob@example.org)
TEAM_ID=$(account_id team@example.org)
echo "accounts: alice=$ALICE_ID bob=$BOB_ID team=$TEAM_ID"

# Bob's own identities are created on his first Identity/get, numbered in
# order. Read them before he joins team, so bob@ is his `b` and his own team@
# identity comes later (`c`), as in the research (E4). Joined first, his own
# team@ would be `b`, the same id as team@ in team's account, and the E4 case
# (an own id that names nothing in the group) would prove nothing.
jmap bob@example.org "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:submission\"],\"methodCalls\":[[\"Identity/get\",{\"accountId\":\"$BOB_ID\"},\"0\"]]}" >/dev/null

cli update Account "$BOB_ID" --field "memberGroupIds={\"$TEAM_ID\":true}"

# A folder-only share from alice to bob, with maySubmit (research E11).
FOLDER_SHARE=0
share=$(jmap alice@example.org "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Mailbox/set\",{\"accountId\":\"$ALICE_ID\",\"create\":{\"s\":{\"name\":\"Shared with bob\",\"shareWith\":{\"$BOB_ID\":{\"mayReadItems\":true,\"mayAddItems\":true,\"mayRemoveItems\":true,\"maySetSeen\":true,\"maySetKeywords\":true,\"mayCreateChild\":false,\"mayRename\":false,\"mayDelete\":false,\"maySubmit\":true}}}}},\"0\"]]}" || true)
if printf '%s' "$share" | grep -q '"created":{"s"'; then
  FOLDER_SHARE=1
  echo "folder share: alice -> bob, maySubmit"
else
  echo "folder share: not provisioned, the E11 check is skipped ($share)"
fi

STALWART_IT_URL="$URL" \
STALWART_IT_PASSWORD="$USER_PASS" \
STALWART_IT_FOLDER_SHARE="$FOLDER_SHARE" \
  npx vitest run src/api/__tests__/shared-send.it.test.ts "$@"
