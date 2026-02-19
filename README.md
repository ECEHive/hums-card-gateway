# HUMS Card Gateway

A lightweight Node.js service that reads card scans from a USB serial scanner and forwards them to an HTTPS endpoint. Designed for Raspberry Pi Zero W 2 devices, but runs on (almost) any Linux or macOS system.

## Install

Run on the target device:

```bash
curl -fsSL https://raw.githubusercontent.com/ECEHive/hums-card-gateway/main/install.sh | sudo bash
```

The installer will:

1. Install Node.js if not present
2. Download the latest code from GitHub
3. Prompt for configuration (endpoint URL, device ID, serial settings)
4. Set up a system service (systemd on Linux, launchd on macOS)

Files are installed to `/opt/hums-card-gateway`.

## Configuration

Edit `/opt/hums-card-gateway/config.json`:

```json
{
  "serialPath": null,
  "vendorId": "09d8",
  "productId": null,
  "baudRate": 9600,
  "endpoint": "https://your-api.com/scan",
  "authToken": null,
  "deviceName": "hums-dcs-s116",
  "reconnectInterval": 5000,
  "sendRetries": 3,
  "sendRetryDelay": 2000
}
```

| Field | Description |
|---|---|
| `serialPath` | Explicit device path (e.g. `/dev/ttyUSB0`). Set to `null` to auto-detect. |
| `vendorId` | USB vendor ID hex string for auto-detection. |
| `productId` | USB product ID hex string for auto-detection. |
| `baudRate` | Serial baud rate. |
| `endpoint` | URL to POST card scans to. |
| `authToken` | Optional Bearer token for the endpoint. |
| `deviceName` | Identifier for this gateway device. |

After editing, restart the service:

```bash
# Linux
sudo systemctl restart hums-card-gateway

# macOS
launchctl unload ~/Library/LaunchAgents/com.hums.card-gateway.plist
launchctl load ~/Library/LaunchAgents/com.hums.card-gateway.plist
```

## Card Formats

| Format | Raw scan | Parsed output |
|---|---|---|
| Short | `111111` | `111111` |
| Full | `1570=900000001=00=6017700001111110` | `000111111` |
| Mobile | `6017700010001111` | `6017700010001111` |

## Logs

```bash
# Linux
sudo journalctl -u hums-card-gateway -f

# macOS
tail -f /tmp/hums-card-gateway.log
```

## Updates

The service automatically checks for updates every 5 minutes. When a new version is detected on the `main` branch, it downloads the update, replaces the source files, and restarts itself.

## Re-install / Update Manually

Re-running the install command will update the code while preserving your existing `config.json`:

```bash
curl -fsSL https://raw.githubusercontent.com/ECEHive/hums-card-gateway/main/install.sh | sudo bash
```
