#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/mac-dev.sh
source "$ROOT/scripts/mac-dev.sh"

API_JOB_LABEL="app.zhixing.api-dev.test"
API_PORT=8787
test_case=""

launchctl() {
  [[ "$1" == "print" ]] || return 1
  printf 'gui/501/%s = {\n\tpid = 100\n}\n' "$API_JOB_LABEL"
}

lsof() {
  case "$test_case" in
    direct_child | nested_child)
      printf '200\n'
      ;;
    unmanaged_listener)
      printf '300\n'
      ;;
    mixed_listeners)
      printf '200\n300\n'
      ;;
    no_listener)
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

ps() {
  local pid="${*: -1}"

  case "$test_case:$pid" in
    direct_child:200 | nested_child:150 | mixed_listeners:200)
      printf '100\n'
      ;;
    nested_child:200)
      printf '150\n'
      ;;
    unmanaged_listener:300 | mixed_listeners:300)
      printf '250\n'
      ;;
    unmanaged_listener:250 | mixed_listeners:250)
      printf '1\n'
      ;;
    *)
      return 1
      ;;
  esac
}

assert_ownership() {
  local name="$1"
  local expected="$2"
  local actual=1

  test_case="$name"
  if managed_api_owns_port; then
    actual=0
  fi

  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: ${name} expected=${expected} actual=${actual}" >&2
    exit 1
  fi
  echo "PASS: ${name}"
}

assert_ownership direct_child 0
assert_ownership nested_child 0
assert_ownership unmanaged_listener 1
assert_ownership mixed_listeners 1
assert_ownership no_listener 1
