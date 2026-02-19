#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# hums-card-gateway — network installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ECEHive/hums-card-gateway/main/install.sh | sudo bash
#
# Works on:
#   - Raspberry Pi OS / Debian / Ubuntu
#   - macOS (development / testing)
#
# What it does:
#   1. Installs Node.js if missing
#   2. Downloads the latest code from GitHub
#   3. Prompts for config values and writes config.json
#   4. Installs a systemd service (Linux) or launchd plist (macOS)
# ============================================================================

REPO="ECEHive/hums-card-gateway"
BRANCH="main"
INSTALL_DIR="/opt/hums-card-gateway"
SERVICE_NAME="hums-card-gateway"
TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"

# ---------- helpers ---------------------------------------------------------

info()  { printf "\033[1;34m[info]\033[0m  %s\n" "$*"; }
ok()    { printf "\033[1;32m[ok]\033[0m    %s\n" "$*"; }
warn()  { printf "\033[1;33m[warn]\033[0m  %s\n" "$*"; }
err()   { printf "\033[1;31m[error]\033[0m %s\n" "$*" >&2; }

need_root() {
  if [[ $EUID -ne 0 ]]; then
    err "This installer must be run as root (use sudo)."
    exit 1
  fi
}

prompt_value() {
  local varname="$1" prompt_text="$2" default="$3"
  local input
  if [[ -n "$default" && "$default" != "null" ]]; then
    read -rp "$prompt_text [$default]: " input
    eval "$varname=\"${input:-$default}\""
  else
    read -rp "$prompt_text: " input
    eval "$varname=\"$input\""
  fi
}

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    *)       echo "unknown" ;;
  esac
}

OS="$(detect_os)"

# ---------- install Node.js -------------------------------------------------

install_node() {
  if command -v node &>/dev/null; then
    ok "Node.js already installed: $(node -v)"
    return
  fi

  info "Installing Node.js..."

  if [[ "$OS" == "linux" ]]; then
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y nodejs
    else
      err "Unsupported package manager. Install Node.js manually and re-run."
      exit 1
    fi
  elif [[ "$OS" == "macos" ]]; then
    if command -v brew &>/dev/null; then
      brew install node
    else
      err "Homebrew not found. Install Node.js manually (https://nodejs.org) and re-run."
      exit 1
    fi
  else
    err "Unsupported OS. Install Node.js manually and re-run."
    exit 1
  fi

  ok "Node.js installed: $(node -v)"
}

# ---------- download from GitHub --------------------------------------------

download_release() {
  info "Downloading from ${REPO} (${BRANCH})..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  curl -fsSL "$TARBALL_URL" | tar -xz -C "$tmp_dir" --strip-components=1

  mkdir -p "$INSTALL_DIR/src"

  cp "$tmp_dir/src/index.js"   "$INSTALL_DIR/src/index.js"
  cp "$tmp_dir/src/parsers.js" "$INSTALL_DIR/src/parsers.js"
  cp "$tmp_dir/package.json"   "$INSTALL_DIR/package.json"

  if [[ ! -f "$INSTALL_DIR/config.json" ]]; then
    cp "$tmp_dir/config.json" "$INSTALL_DIR/config.json"
  else
    info "Existing config.json preserved"
  fi

  info "Installing npm dependencies..."
  cd "$INSTALL_DIR" && npm install --omit=dev
  ok "Dependencies installed"

  # Record installed version for the auto-updater
  local sha
  sha="$(curl -fsSL -H 'Accept: application/vnd.github.sha' \
    "https://api.github.com/repos/${REPO}/commits/${BRANCH}" 2>/dev/null || true)"
  if [[ -n "$sha" ]]; then
    echo "$sha" > "$INSTALL_DIR/.version"
  fi

  ok "Files installed to $INSTALL_DIR"
}

# ---------- configure -------------------------------------------------------

configure() {
  # Skip if already configured with real values
  if [[ -f "$INSTALL_DIR/config.json" ]]; then
    local existing
    existing="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$INSTALL_DIR/config.json','utf8')).endpoint||'')" 2>/dev/null || true)"
    if [[ -n "$existing" && "$existing" != "https://your-api.com/scan" ]]; then
      info "Using existing config.json"
      return
    fi
  fi

  info "Configuring gateway..."
  echo ""

  local cfg_endpoint cfg_device_id cfg_auth_token
  local cfg_serial_path cfg_vendor_id cfg_product_id cfg_baud

  prompt_value cfg_endpoint    "API endpoint URL"            "https://your-api.com/scan"
  prompt_value cfg_device_id   "Device ID"                   "hums-dcs-s116"
  prompt_value cfg_auth_token  "Auth token (or leave empty)" ""
  echo ""
  info "Serial scanner settings (leave blank to auto-detect):"
  prompt_value cfg_serial_path "Serial device path (e.g. /dev/ttyUSB0)" ""
  prompt_value cfg_vendor_id   "Vendor ID hex (e.g. 09d8)"  ""
  prompt_value cfg_product_id  "Product ID hex (e.g. 0050)" ""
  prompt_value cfg_baud        "Baud rate"                   "9600"

  json_str() { [[ -n "$1" ]] && echo "\"$1\"" || echo "null"; }

  cat > "$INSTALL_DIR/config.json" <<EOF
{
  "serialPath": $(json_str "$cfg_serial_path"),
  "vendorId": $(json_str "$cfg_vendor_id"),
  "productId": $(json_str "$cfg_product_id"),
  "baudRate": $cfg_baud,
  "endpoint": "$cfg_endpoint",
  "authToken": $(json_str "$cfg_auth_token"),
  "deviceName": "$cfg_device_id",
  "reconnectInterval": 5000,
  "sendRetries": 3,
  "sendRetryDelay": 2000
}
EOF

  ok "Config written to $INSTALL_DIR/config.json"
}

# ---------- systemd service (Linux) -----------------------------------------

install_systemd_service() {
  info "Installing systemd service..."

  cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=HUMS Card Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) ${INSTALL_DIR}/src/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  ok "systemd service installed and started"
  info "Manage: sudo systemctl {start|stop|restart|status} $SERVICE_NAME"
  info "Logs:   sudo journalctl -u $SERVICE_NAME -f"
}

# ---------- launchd service (macOS) -----------------------------------------

install_launchd_service() {
  local plist_path="$HOME/Library/LaunchAgents/com.hums.card-gateway.plist"
  info "Installing launchd agent..."

  mkdir -p "$HOME/Library/LaunchAgents"

  cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hums.card-gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>${INSTALL_DIR}/src/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/${SERVICE_NAME}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${SERVICE_NAME}.err.log</string>
</dict>
</plist>
EOF

  launchctl unload "$plist_path" 2>/dev/null || true
  launchctl load "$plist_path"
  ok "launchd agent installed and loaded"
  info "Manage: launchctl {load|unload} $plist_path"
  info "Logs:   tail -f /tmp/${SERVICE_NAME}.log"
}

# ---------- main ------------------------------------------------------------

main() {
  echo ""
  echo "========================================"
  echo "  HUMS Card Gateway — Installer"
  echo "========================================"
  echo ""

  if [[ "$OS" == "linux" ]]; then
    need_root
  fi

  install_node
  download_release
  configure

  if [[ "$OS" == "linux" ]]; then
    install_systemd_service
  elif [[ "$OS" == "macos" ]]; then
    install_launchd_service
  else
    warn "Unsupported OS for service install. Run manually: node $INSTALL_DIR/src/index.js"
  fi

  echo ""
  ok "Installation complete!"
  echo ""
}

main "$@"
