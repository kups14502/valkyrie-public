#!/bin/sh
# Installs the Valkyrie XR launcher and adds it to Steam once. Run by
# `frame.ps1 deploy` from ~/apps/valkyrie-xr on the headset.
set -e
here=$(cd "$(dirname "$0")" && pwd)
chmod +x "$here/valkyrie-xr.arm64" "$here/valkyrie-xr.sh"
mkdir -p "$HOME/Applications" "$HOME/.local/share/applications"
ln -sf "$here/valkyrie-xr.sh" "$HOME/Applications/valkyrie-xr.sh"
desktop="$HOME/.local/share/applications/valkyrie-xr.desktop"
cat > "$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Valkyrie XR
Exec=$HOME/Applications/valkyrie-xr.sh
Icon=$HOME/.local/share/icons/hicolor/512x512/apps/valkyrie.png
Categories=Development;
EOF
if "$HOME/.local/bin/frame-steam" has "Valkyrie XR"; then
  echo "Valkyrie XR is already in Steam"
else
  steamos-add-to-steam "$desktop"
  echo "added Valkyrie XR to Steam"
fi
