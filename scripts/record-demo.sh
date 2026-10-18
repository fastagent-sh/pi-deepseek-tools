#!/usr/bin/env bash
# Record assets/demo.mp4 (and the gif) with vhs.
# Needs: vhs, ttyd, ffmpeg, a DeepSeek credential in the pi agent directory.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
agent="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
demo="${DEMO_DIR:-$HOME/pi-deepseek-tools}"

case "$demo" in
"$root"/*)
	# The agent directory holds credentials and must never land in the repository.
	echo "DEMO_DIR must live outside the repository ($demo)" >&2
	exit 1
	;;
esac

rm -rf "$demo"
mkdir -p "$demo/.agent"
cp "$agent/auth.json" "$demo/.agent/"
for file in models.json models-store.json; do
	if [[ -f "$agent/$file" ]]; then cp "$agent/$file" "$demo/.agent/"; fi
done
printf '{"theme":"dark","quietStartup":true}\n' >"$demo/.agent/settings.json"

cd "$root"
command -v vhs >/dev/null || {
	echo "vhs is missing: brew install vhs ttyd" >&2
	exit 1
}
vhs "${1:-scripts/demo.tape}"

# A poster frame keeps the blog embed from reserving blank space before the video starts.
ffmpeg -v error -ss 9 -i assets/demo.mp4 -frames:v 1 -vf "scale=1240:-1" assets/demo-poster.png -y
echo "poster: assets/demo-poster.png"
