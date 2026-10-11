#!/bin/zsh
# One-time setup: create the standard "agent" macOS user and store its password in your Keychain.
set -euo pipefail
ROOT="${0:A:h:h}"
AGENT_USER="${1:-agent}"

if id "$AGENT_USER" &>/dev/null; then
  echo "✓ User '$AGENT_USER' already exists"
else
  echo "→ Creating standard (non-admin) user '$AGENT_USER'. You'll be asked for YOUR admin password, then a new password for the agent."
  read -s "AGENT_PW?New password for '$AGENT_USER': "; echo
  sudo sysadminctl -addUser "$AGENT_USER" -fullName "AI Agent" -password "$AGENT_PW"
  security add-generic-password -U -s mac-agent-vnc -a "$AGENT_USER" -w "$AGENT_PW"
  unset AGENT_PW
  echo "✓ Created '$AGENT_USER' and saved its password to your Keychain (service: mac-agent-vnc)"
fi

if ! security find-generic-password -s mac-agent-vnc -a "$AGENT_USER" &>/dev/null; then
  echo "→ Saving the agent password to your Keychain"
  security add-generic-password -U -s mac-agent-vnc -a "$AGENT_USER" -w
fi

cat <<EOF

Remaining manual steps:
  1. System Settings → General → Sharing → turn on "Screen Sharing".
     Click (i) → "Allow access for": add "$AGENT_USER" (or "All users").
  2. Start the agent's session: open "vnc://$AGENT_USER@localhost" (Screen Sharing app),
     sign in as $AGENT_USER, and choose "Connect to a virtual display" if asked.
     Finish the first-login setup screens in that window. Keep the window open while the agent works.
  3. Test the connection:  cd $ROOT/backend && npm install && npm run build && npm run spike
     Then open spike.png. It must show the AGENT's desktop, not yours.
EOF
