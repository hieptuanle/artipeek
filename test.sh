#!/usr/bin/env bash
# artipeek tests. Uses temp folders and a temp config, never real repos.
#   bash test.sh
set -u
cd "$(dirname "$0")"
PORT=${TEST_PORT:-4399}
T=$(mktemp -d /tmp/artipeek-test.XXXXXX)
ROOT="$T/one"; ROOT2="$T/two"; OUTSIDE="$T/outside"; CFG="$T/cfg/config.json"
B="http://127.0.0.1:$PORT"; R="$B/r/one"
fail=0; PIDS=()
ok()  { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT
waitup() { for _ in $(seq 1 50); do curl -s -o /dev/null "$1" && return; sleep 0.1; done; }

# --- fixture ---
mkdir -p "$ROOT/docs" "$ROOT/messages/2026-10-31-x" "$ROOT/ignored" "$ROOT2" "$OUTSIDE" "$T/cfg"
cat > "$ROOT/docs/note.md" <<'EOF'
---
title: Test note
tags: [a, b]
---
# Hello

| col1 | col2 |
|---|---|
| 1 | 2 |

```bash
echo "hi"
```

- [x] done
- [ ] todo

See [[other]] and [link](../messages/2026-10-31-x/email.html) and [abs](/docs/other.md).
Footnote[^1].

[^1]: The note.
EOF
echo "# Other" > "$ROOT/docs/other.md"
echo '<html><body><h1>Email draft</h1><script>alert(1)</script></body></html>' > "$ROOT/messages/2026-10-31-x/email.html"
echo "secret" > "$OUTSIDE/passwd"
ln -s "$OUTSIDE/passwd" "$ROOT/docs/escape.txt"
echo "ignored/" > "$ROOT/.gitignore"
echo "nope" > "$ROOT/ignored/hidden.md"
echo "X=1" > "$ROOT/.env"; echo "X=" > "$ROOT/.env.example"; echo "k" > "$ROOT/docs/server.key"; echo "k" > "$ROOT/id_ed25519"
mkdir -p "$ROOT/sorttest/sub"
echo a > "$ROOT/sorttest/a.md"; touch -d '-2 days -1 hour' "$ROOT/sorttest/a.md"
echo b > "$ROOT/sorttest/b.md"; touch -d '-5 minutes -10 seconds' "$ROOT/sorttest/b.md"
echo c > "$ROOT/sorttest/sub/c.md"; touch -d '-1 hour -5 minutes' "$ROOT/sorttest/sub/c.md"
git -C "$ROOT" init -q && git -C "$ROOT" add -f .env docs/server.key id_ed25519   # tracked on purpose: deny list must still hide them
echo "# Two" > "$ROOT2/README.md"
git -C "$ROOT2" init -q
cat > "$CFG" <<EOF
{ "roots": [ { "name": "one", "path": "$ROOT" } ] }
EOF

bun server.ts --config "$CFG" --port "$PORT" > "$T/server.log" 2>&1 & PIDS+=($!)
waitup "$B/"

# --- home + sidebar ---
home=$(curl -s "$B/")
grep -q 'href="/r/one/"' <<<"$home" && grep -q 'class="rootcard"' <<<"$home" && ok "home lists folders with recent files" || bad "home"
c=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$R/")
[[ "$c" == "302 "*"/r/one/view/"* ]] && ok "folder root redirects to a file" || bad "root redirect: $c"
page=$(curl -s "$R/view/docs/note.md")
grep -q 'id="tree"' <<<"$page" && grep -q 'data-dir="messages/2026-10-31-x"' <<<"$page" \
  && grep -q 'class="current"><span class="name">note.md' <<<"$page" && ok "sidebar renders, current file highlighted" || bad "sidebar"
grep -q 'class="roots"' <<<"$page" && ok "folder switcher present" || bad "folder switcher"
grep -q 'data-menu' <<<"$page" && curl -s "$B/_/style.css" | grep -q 'body.nav-open aside' && ok "phone menu button + drawer CSS" || bad "phone menu"
grep -q 'hidden.md' <<<"$page" && bad "gitignored file listed" || ok "gitignored file not listed"
grep -q 'escape.txt' <<<"$page" && bad "outside symlink listed" || ok "outside symlink not listed"
grep -q 'data-path="\.env"\|server\.key\|id_ed25519' <<<"$page" && bad "denied file listed" || ok "deny list: .env, *.key, id_ed25519 hidden (even tracked)"
grep -q 'data-path="\.env\.example"' <<<"$page" && ok "deny list: .env.example still shown" || bad ".env.example missing"

# --- icons ---
for pt in "/_/icon.svg image/svg+xml" "/favicon.ico image/x-icon" "/_/apple-touch-icon.png image/png" "/apple-touch-icon.png image/png" "/_/icon-192.png image/png" "/_/icon-512.png image/png" "/_/manifest.webmanifest application/manifest+json"; do
  set -- $pt; r=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$B$1")
  [ "$r" = "200 $2" ] && ok "icon: $1" || bad "icon $1: $r"
done
grep -q 'rel="icon" href="/_/icon.svg"' <<<"$page" && grep -q 'rel="apple-touch-icon"' <<<"$page" && grep -q 'rel="manifest"' <<<"$page" && ok "icon links in page head" || bad "icon links"
curl -s "$B/_/manifest.webmanifest" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["start_url"]=="/" and len(d["icons"])==3' && ok "manifest is valid JSON" || bad "manifest json"

# --- markdown ---
grep -q '<table>' <<<"$page" && grep -q 'hljs-built_in\|hljs-string' <<<"$page" \
  && grep -q 'task-list-item' <<<"$page" && grep -q 'class="footnotes' <<<"$page" \
  && grep -q 'class="frontmatter"' <<<"$page" && ok "md: table, code highlight, tasks, footnote, front matter" || bad "md render"
grep -q 'href="/r/one/view/docs/other.md" class="wikilink"' <<<"$page" && ok "md: [[wikilink]] resolved" || bad "wikilink"
grep -q 'href="/r/one/view/messages/2026-10-31-x/email.html"' <<<"$page" && ok "md: relative link -> /r/one/view" || bad "relative link"
grep -q '>abs</a>' <<<"$page" && grep -q 'href="/r/one/view/docs/other.md">abs' <<<"$page" && ok "md: /root-relative link" || bad "abs link"

# --- html in sandboxed iframe ---
h=$(curl -s "$R/view/messages/2026-10-31-x/email.html")
grep -q '<iframe class="htmlframe" sandbox="allow-scripts"' <<<"$h" && ! grep -q 'allow-same-origin' <<<"$h" \
  && ok "html: sandboxed iframe (scripts yes, same origin no)" || bad "html iframe"
csp=$(curl -s -D - -o /dev/null "$R/raw/messages/2026-10-31-x/email.html" | tr -d '\r' | grep -i '^content-security-policy')
grep -q "sandbox allow-scripts;" <<<"$csp" && grep -q "default-src 'none'" <<<"$csp" && grep -q "script-src 'unsafe-inline'" <<<"$csp" \
  && ! grep -qi 'allow-same-origin\|connect-src\|https:' <<<"$csp" && ok "raw html: CSP sandbox, inline scripts only, no network" || bad "raw csp: $csp"
csp=$(curl -s -D - -o /dev/null "$R/raw/docs/other.md" | tr -d '\r' | grep -i '^content-security-policy')
grep -q "sandbox; default-src 'none'" <<<"$csp" && ! grep -q 'allow-scripts\|script-src' <<<"$csp" && ok "raw non-html: still no scripts" || bad "raw md csp: $csp"

# --- path safety ---
for p in "/r/one/view/..%2f..%2fetc/passwd" "/r/one/raw/..%2f..%2fetc/passwd" "/r/one/raw/%2fetc%2fpasswd" \
         "/r/one/view/docs/escape.txt" "/r/one/raw/docs/escape.txt" "/r/one/raw/.git/config" "/r/one/raw/ignored/hidden.md" \
         "/r/one/raw/docs/..%2f..%2f..%2fetc/passwd" "/r/one/view/docs/%2e%2e/%2e%2e/etc/passwd" "/r/one/raw/docs%5c..%5c..%5cetc%5cpasswd" \
         "/r/one/raw/.env" "/r/one/raw/docs/server.key" "/r/one/raw/id_ed25519" "/r/..%2f/raw/etc/passwd" "/r/two/raw/README.md" \
         "/r/one%2f..%2ftwo/raw/README.md" "/view/docs/note.md" "/raw/docs/note.md"; do
  code=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' "$B$p")
  [ "$code" = 404 ] && ok "404 $p" || bad "$p gave $code"
done
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$R/view/docs/note.md")
[ "$code" = 405 ] && ok "POST refused (405)" || bad "POST gave $code"

# --- config reload: add a folder ---
cat > "$CFG.tmp" <<EOF
{ "roots": [ { "name": "one", "path": "$ROOT" }, { "name": "two", "path": "$ROOT2" }, { "name": "../bad", "path": "$ROOT2" }, { "name": "home", "path": "~" } ] }
EOF
mv "$CFG.tmp" "$CFG"
got=""
for _ in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$B/r/two/view/README.md")" = 200 ] && { got=1; break; }; sleep 0.1; done
[ -n "$got" ] && ok "config change adds folder 'two' without restart" || bad "config reload"
grep -q 'href="/r/home/"' <<<"$(curl -s "$B/")" && bad "home folder accepted as root" || ok "too-wide root (~) refused"
grep -q 'bad' <<<"$(curl -s "$B/")" && bad "bad root name accepted" || ok "bad root name refused"
grep -q 'href="/r/two/"' <<<"$(curl -s "$R/view/docs/note.md")" && ok "switcher lists the new folder" || bad "switcher missing two"

# --- sidebar sort ---
order() { tr -d '\n' | sed 's/.*<ul class="tree"//' | grep -o 'data-dir="sorttest/sub"\|data-path="sorttest/[ab]\.md"' | sed 's/.*"sorttest\/\(.*\)"/\1/' | tr '\n' ' '; }
o=$(curl -s "$R/view/sorttest/a.md" | order)
[ "$o" = "sub a.md b.md " ] && ok "sort name (default)" || bad "sort name: '$o'"
hdr=$(curl -s -D - -o "$T/page" "$R/view/sorttest/a.md?sort=mtime" | tr -d '\r')
o=$(order < "$T/page")
[ "$o" = "b.md sub a.md " ] && ok "sort mtime: newest first, folder = newest file inside" || bad "sort mtime: '$o'"
grep -qi '^set-cookie: artipeek_sort=mtime' <<<"$hdr" && ok "?sort= sets the cookie" || bad "no sort cookie"
grep -q '>5m</span>' "$T/page" && grep -q '>1h</span>' "$T/page" && grep -q '>2d</span>' "$T/page" && ok "ages 5m/1h/2d" || bad "ages"
o=$(curl -s -H 'Cookie: artipeek_sort=mtime' "$R/view/sorttest/a.md" | order)
[ "$o" = "b.md sub a.md " ] && ok "cookie keeps mtime order" || bad "cookie sort: '$o'"

# --- live update (SSE), per folder ---
SSE="$T/sse"; SSE2="$T/sse2"
curl -s -N --max-time 4 "$R/events" > "$SSE" & CP=$!
curl -s -N --max-time 4 "$B/r/two/events" > "$SSE2" & CP2=$!
sleep 0.5
t0=$(date +%s%N)
echo "changed" >> "$ROOT/docs/other.md"
got=""
for _ in $(seq 1 20); do grep -q '^event: change' "$SSE" && grep -q 'docs/other.md' "$SSE" && { got=1; break; }; sleep 0.1; done
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
[ -n "$got" ] && ok "SSE change event in ${ms} ms" || bad "no SSE change event within 2 s"
grep -q 'docs/other.md' "$SSE2" && bad "change leaked to folder two's stream" || ok "events stay in their own folder"
echo "# New" > "$ROOT/docs/new.md"
got=""
for _ in $(seq 1 20); do grep -q '^event: tree' "$SSE" && { got=1; break; }; sleep 0.1; done
[ -n "$got" ] && ok "SSE tree event on new file" || bad "no SSE tree event"
kill $CP $CP2 2>/dev/null
got=""
for _ in $(seq 1 20); do grep -q 'new.md' <<<"$(curl -s "$R/part/tree?current=")" && { got=1; break; }; sleep 0.1; done
[ -n "$got" ] && ok "sidebar shows new file" || bad "new file missing"
grep -q 'X=1\|secret' "$T/server.log" && bad "file contents in log" || ok "no file contents in log"

# --- public listener (Cloudflare Access JWT), with a fake certs endpoint and local RSA keys ---
CERTS=4393; PUB=4394; MAIN2=4392; TOK="$T/tok"; mkdir -p "$TOK"
bun test-access.ts $CERTS "$TOK" > "$T/access.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 100); do [ -f "$TOK/ready" ] && break; sleep 0.1; done
cat > "$T/cfg/pub.json" <<EOF
{ "roots": [ { "name": "one", "path": "$ROOT" }, { "name": "two", "path": "$ROOT2" } ],
  "public": { "port": $PUB, "teamDomain": "test.cloudflareaccess.com", "aud": "test-aud", "emails": ["User@Example.com"],
              "roots": ["one"], "certsUrl": "http://127.0.0.1:$CERTS/cdn-cgi/access/certs" } }
EOF
bun server.ts --config "$T/cfg/pub.json" --port $MAIN2 > "$T/pub.log" 2>&1 & PIDS+=($!)
P="http://127.0.0.1:$PUB"
for _ in $(seq 1 50); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$P/")" = 403 ] && break; sleep 0.1; done
pc() { curl -s --path-as-is -o /dev/null -w '%{http_code}' "${@:2}" "$P$1"; }   # pc <path> [curl args]
hv() { echo "Cf-Access-Jwt-Assertion: $(cat "$TOK/$1.jwt")"; }
[ "$(pc /)" = 403 ] && ok "public: no token -> 403" || bad "public no token"
[ "$(pc /_/icon.svg)" = 403 ] && ok "public: icons also need a login" || bad "public icon without token"
[ "$(pc /r/one/view/docs/note.md)" = 403 ] && ok "public: no token on a file -> 403" || bad "public no token file"
for t in badsig wrongaud wrongiss expired wrongemail algnone; do
  c=$(pc /r/one/view/docs/note.md -H "$(hv $t)"); [ "$c" = 403 ] && ok "public: $t -> 403" || bad "public $t gave $c"
done
[ "$(pc /r/one/view/docs/note.md -H 'Cf-Access-Jwt-Assertion: garbage')" = 403 ] && ok "public: garbage token -> 403" || bad "public garbage"
c=$(pc /r/one/view/docs/note.md -H "$(hv valid)"); [ "$c" = 200 ] && ok "public: valid token (header) -> 200" || bad "public valid gave $c"
c=$(pc /r/one/view/docs/note.md -H "Cookie: CF_Authorization=$(cat "$TOK/valid.jwt")"); [ "$c" = 200 ] && ok "public: valid token (cookie) -> 200" || bad "public cookie gave $c"
ph=$(curl -s -H "$(hv valid)" "$P/"); pf=$(curl -s -H "$(hv valid)" "$P/r/one/view/docs/note.md")
grep -q 'href="/r/one/"' <<<"$ph" && ! grep -q '/r/two/' <<<"$ph" && ok "public: home lists only public.roots" || bad "public home roots"
grep -q 'class="roots"' <<<"$pf" && ! grep -q '/r/two/' <<<"$pf" && ok "public: switcher hides other folders" || bad "public switcher"
for p in /r/two/ /r/two/view/README.md /r/two/raw/README.md /r/two/events "/r/one%2f..%2ftwo/raw/README.md"; do
  c=$(pc "$p" -H "$(hv valid)"); [ "$c" = 404 ] && ok "public: 404 $p (not in public.roots)" || bad "public $p gave $c"
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$MAIN2/r/two/view/README.md")" = 200 ] && ok "main listener still serves 'two'" || bad "main two"
for p in "/r/one/view/..%2f..%2fetc/passwd" "/r/one/raw/docs/escape.txt" "/r/one/raw/.git/config" "/r/one/raw/.env" "/r/one/view/docs/%2e%2e/%2e%2e/etc/passwd"; do
  c=$(pc "$p" -H "$(hv valid)"); [ "$c" = 404 ] && ok "public: 404 $p" || bad "public $p gave $c"
done
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$(hv valid)" "$P/r/one/view/docs/note.md"); [ "$c" = 405 ] && ok "public: POST -> 405" || bad "public POST $c"
c=$(pc /r/one/view/docs/note.md -H "$(hv newkid)"); [ "$c" = 403 ] && ok "public: unknown kid -> 403" || bad "public newkid before rotate $c"
curl -s "http://127.0.0.1:$CERTS/rotate" >/dev/null; sleep 31   # refetch on an unknown kid is limited to every 30 s
c=$(pc /r/one/view/docs/note.md -H "$(hv newkid)"); [ "$c" = 200 ] && ok "public: rotated key fetched on unknown kid" || bad "public newkid after rotate $c"
PSSE="$T/psse"
curl -s -N --max-time 4 -H "$(hv valid)" "$P/r/one/events" > "$PSSE" & CP=$!
sleep 0.5; echo "pub change" >> "$ROOT/docs/other.md"
got=""; for _ in $(seq 1 20); do grep -q '^event: change' "$PSSE" && { got=1; break; }; sleep 0.1; done
[ -n "$got" ] && ok "public: SSE works with a valid token" || bad "public SSE"
kill $CP 2>/dev/null
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$P/r/one/events"); [ "$c" = 403 ] && ok "public: SSE without token -> 403" || bad "public SSE no token $c"
grep -q 'eyJ' "$T/pub.log" && bad "token in log" || ok "public: no tokens in log"
grep -q 'refused (bad signature)' "$T/pub.log" && ok "public: refusals logged with reason" || bad "public log reason"

# --- admin CLI (temp config, no service restart) ---
export ARTIPEEK_NO_RESTART=1
CC="$T/cfg/cli.json"; cp "$T/cfg/pub.json" "$CC"
cli() { ARTIPEEK_CONFIG="$CC" bun cli.ts "$@" 2>&1; }
jq_() { python3 -c "import json,sys;c=json.load(open('$CC'));print($1)"; }
mkdir -p "$T/three"; git -C "$T/three" init -q
cli add three "$T/three" --public >/dev/null && [ "$(jq_ '"three" in [r["name"] for r in c["roots"]] and "three" in c["public"]["roots"]')" = True ] && ok "cli: add --public" || bad "cli add"
cli add three "$T/three" | grep -q 'already exists' && ok "cli: duplicate name refused" || bad "cli dup"
cli add 'bad/name' "$T/three" | grep -q 'name:' && ok "cli: bad name refused" || bad "cli bad name"
cli add homey '~' | grep -q 'too wide' && ok "cli: home folder refused" || bad "cli home"
cli add ghost "$T/nope" | grep -q 'no such folder' && ok "cli: missing folder refused" || bad "cli missing"
cli public add ghost | grep -q 'no folder ghost' && ok "cli: public add needs a folder" || bad "cli public ghost"
cli public remove three >/dev/null && [ "$(jq_ '"three" in c["public"]["roots"]')" = False ] && ok "cli: public remove" || bad "cli public remove"
cli rename three four >/dev/null && [ "$(jq_ '[r["name"] for r in c["roots"]][-1]')" = four ] && ok "cli: rename" || bad "cli rename"
cli remove four >/dev/null && [ "$(jq_ '"four" in [r["name"] for r in c["roots"]]')" = False ] && ok "cli: remove" || bad "cli remove"
cli undo-config >/dev/null && [ "$(jq_ '"four" in [r["name"] for r in c["roots"]]')" = True ] && ok "cli: undo-config" || bad "cli undo"
cli devices add My-iPad >/dev/null && [ "$(jq_ '"my-ipad" in c.get("allowDevices",[])')" = True ] && ok "cli: devices add (lowercased)" || bad "cli devices add"
cli devices remove my-ipad >/dev/null && [ "$(jq_ '"my-ipad" in c.get("allowDevices",[])')" = False ] && ok "cli: devices remove" || bad "cli devices remove"
cli emails remove user@example.com | grep -q 'last email' && ok "cli: refuses to remove the last email" || bad "cli last email"
cli emails add not-an-email | grep -q 'usage' && ok "cli: bad email refused" || bad "cli bad email"
cli frobnicate | grep -q 'unknown command' && ok "cli: unknown command" || bad "cli unknown"
ARTIPEEK_CONFIG="$CFG" bun cli.ts add three "$T/three" >/dev/null 2>&1
got=""; for _ in $(seq 1 30); do grep -q 'href="/r/three/"' <<<"$(curl -s "$B/")" && { got=1; break; }; sleep 0.1; done
[ -n "$got" ] && ok "cli: running server picks up an added folder" || bad "cli hot reload"

# --- tailnet device check (only if Tailscale is up) ---
TIP=$(tailscale ip -4 2>/dev/null | head -1)
if [[ "$TIP" =~ ^100\. ]]; then
  SELF=$(tailscale whois --json "$TIP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Node"]["Name"].rstrip("."))')
  SELFHOST=${SELF%%.*}; SUFFIX=${SELF#*.}
  mk() { echo "{ \"tailnet\": true, \"tailnets\": [\"$2\"], \"allowDevices\": [\"$3\"], \"roots\": [ { \"name\": \"one\", \"path\": \"$ROOT\" } ] }" > "$T/cfg/$1.json"; }
  mk ok "$SUFFIX" "$SELFHOST"; mk other "$SUFFIX" some-other-device; mk wrongnet other.ts.net "$SELFHOST"
  bun server.ts --config "$T/cfg/ok.json" --port 4398 > /dev/null 2>&1 & PIDS+=($!)
  bun server.ts --config "$T/cfg/other.json" --port 4397 > /dev/null 2>&1 & PIDS+=($!)
  bun server.ts --config "$T/cfg/wrongnet.json" --port 4396 > /dev/null 2>&1 & PIDS+=($!)
  for p in 4398 4397 4396; do waitup "http://$TIP:$p/"; done
  c=$(curl -s -o /dev/null -w '%{http_code}' "http://$TIP:4398/r/one/view/docs/note.md")
  [ "$c" = 200 ] && ok "tailnet: allowed device ($SELFHOST) gets 200" || bad "tailnet allowed gave $c"
  c=$(curl -s -o /dev/null -w '%{http_code}' "http://$TIP:4397/r/one/view/docs/note.md")
  [ "$c" = 403 ] && ok "tailnet: device not in list gets 403" || bad "tailnet not-in-list gave $c"
  c=$(curl -s -o /dev/null -w '%{http_code}' "http://$TIP:4396/")
  [ "$c" = 403 ] && ok "tailnet: right name, wrong tailnet gets 403" || bad "tailnet wrong-tailnet gave $c"
  c=$(curl -s -o /dev/null -w '%{http_code}' "http://$TIP:4397/r/one/events")
  [ "$c" = 403 ] && ok "tailnet: SSE also refused" || bad "tailnet SSE gave $c"
  c=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:4397/r/one/view/docs/note.md")
  [ "$c" = 200 ] && ok "localhost always allowed" || bad "localhost gave $c"
else
  echo "skip tailnet tests (Tailscale not up)"
fi

[ $fail = 0 ] && echo "ALL OK" || echo "SOME FAILED"
exit $fail
