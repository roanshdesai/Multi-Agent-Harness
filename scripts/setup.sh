#!/usr/bin/env bash
# Installs the plugins and skills the harness loads:
#   superpowers, claude-mem → vendor/plugins (loaded as Agent SDK plugins)
#   gstack                  → ~/.claude/skills/gstack (loaded via user settings)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGINS="$ROOT/vendor/plugins"
mkdir -p "$PLUGINS"

clone() { # repo dir
  if [ -d "$2/.git" ]; then git -C "$2" pull --ff-only; else git clone --depth 1 "https://github.com/$1.git" "$2"; fi
}

echo "→ superpowers"; clone obra/superpowers "$PLUGINS/superpowers"
echo "→ claude-mem";  clone thedotmack/claude-mem "$PLUGINS/claude-mem"
if [ -f "$PLUGINS/claude-mem/package.json" ]; then (cd "$PLUGINS/claude-mem" && npm install --omit=dev --no-audit --no-fund) || echo "  (claude-mem npm install failed; see its README)"; fi

echo "→ gstack"
mkdir -p "$HOME/.claude/skills"
clone garrytan/gstack "$HOME/.claude/skills/gstack"
if [ -x "$HOME/.claude/skills/gstack/setup" ]; then (cd "$HOME/.claude/skills/gstack" && ./setup) || echo "  (gstack ./setup failed; it needs bun — https://bun.sh)"; fi

echo "→ taste-skill (design skills from your UI links library)"
clone Leonxlnx/taste-skill "$ROOT/vendor/taste-skill"
# Copy every folder that holds a SKILL.md into ~/.claude/skills
find "$ROOT/vendor/taste-skill" -name SKILL.md -not -path "*/node_modules/*" | while read -r f; do
  d="$(dirname "$f")"; n="$(basename "$d")"
  [ "$d" = "$ROOT/vendor/taste-skill" ] && n="taste-skill"
  rm -rf "$HOME/.claude/skills/$n" && cp -R "$d" "$HOME/.claude/skills/$n" && echo "  installed skill: $n"
done

echo "→ Playwright browser for gui_test"
npx --yes playwright install chromium

[ -f "$ROOT/.env" ] || cp "$ROOT/.env.example" "$ROOT/.env"
echo "Done. Fill in $ROOT/.env, then start Hindsight:  docker compose up -d hindsight"
