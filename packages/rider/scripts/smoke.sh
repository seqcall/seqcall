#!/usr/bin/env bash
# Unattended smoke run of the plugin in a sandboxed JetBrains IDE (runIde): opens <project>, shows the
# sequence diagram of <file>:<line> (+ the class diagram with CLASS=1), waits for the plugin's
# traffic trace in the sandbox idea.log and prints the SEQCALL lines. The IDE keeps running (inspect
# it with scripts/jcef-screenshot.mjs); stop it with `scripts/smoke.sh stop`.
#   packages/rider/scripts/smoke.sh <project dir> <file> <1-based line> [column]
# IDE_PATH picks the IDE (default: the Toolbox Rider; RIDER_PATH still works), e.g.
#   IDE_PATH=~/.local/share/JetBrains/Toolbox/apps/phpstorm packages/rider/scripts/smoke.sh …
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
rider=${IDE_PATH:-${RIDER_PATH:-$HOME/.local/share/JetBrains/Toolbox/apps/rider}}
# the sandbox of this IDE: <container>/<project>/<productCode>-<version>/ (e.g. PS-2026.2.3, RD-2026.2.3.1)
product=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['productCode'] + '-' + d['version'])" "$rider/product-info.json")
sandbox() { ls -d "$here"/.intellijPlatform/sandbox/*/"$product"/ 2>/dev/null | head -1 || true; }  # none before the IDE's first run
log=$(sandbox)log_runIde/idea.log
stop() {
  local pids
  # .intellijPlatform may be a symlink (sandbox moved to another disk): match both spellings
  pids=$(ps -eo pid,args | awk -v d="$here/.intellijPlatform" -v r="$(readlink -f "$here/.intellijPlatform")" \
    '(index($0, "idea.config.path=" d) || index($0, "idea.config.path=" r)) && !/awk/ {print $1}')
  [ -n "$pids" ] && kill $pids && sleep 4 || true
}
[ "${1:-}" = stop ] && { stop; exit 0; }
project=$(cd "$1" && pwd); file=$(realpath "$2"); line=$3; column=${4:-6}
stop
rm -f "$log"
# A killed sandbox IDE leaves Chromium profile locks behind; cef_server then crashes (SIGTRAP).
rm -f "$here"/.intellijPlatform/sandbox/*/"$product"/system_runIde/jcef_cache*/Singleton*
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null
cd "$here"
SEQCALL_SMOKE_OPEN="$file:$line:$column" SEQCALL_SMOKE_CLASS=${CLASS:-0} SEQCALL_SMOKE_DELAY=${DELAY:-3} JAVA_HOME="$rider/jbr" RIDER_PATH="$rider" \
  nohup ./gradlew --no-daemon -Dorg.gradle.java.installations.paths="$rider/jbr" runIde -PopenProject="$project" \
  > "${TMPDIR:-/tmp}/seqcall-runide.log" 2>&1 &
for _ in $(seq 1 90); do
  sleep 4
  log=$(sandbox)log_runIde/idea.log
  n=$(grep -c 'SEQCALL smoke trace' "$log" 2>/dev/null || true)
  [ "${n:-0}" -ge "${TRACES:-3}" ] && break
  grep -q 'BUILD FAILED' "${TMPDIR:-/tmp}/seqcall-runide.log" && { tail -20 "${TMPDIR:-/tmp}/seqcall-runide.log"; exit 1; }
done
grep -E 'SEQCALL|Plugin to blame' "$log" | cut -c1-400
