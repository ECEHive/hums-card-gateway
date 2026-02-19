const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { execSync } = require("child_process");
const { builtinParsers, createCardParser } = require("./parsers");

const PLATFORM = os.platform();

//
// Config
//

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  for (const key of ["endpoint", "deviceId"]) {
    if (!cfg[key]) {
      console.error(`Missing required config field: "${key}"`);
      process.exit(1);
    }
  }

  return {
    serialPath: cfg.serialPath || null,
    vendorId: cfg.vendorId || null,
    productId: cfg.productId || null,
    baudRate: cfg.baudRate || 9600,
    endpoint: cfg.endpoint,
    authToken: cfg.authToken || null,
    deviceId: cfg.deviceId,
    reconnectInterval: cfg.reconnectInterval || 5000,
    sendRetries: cfg.sendRetries || 3,
    sendRetryDelay: cfg.sendRetryDelay || 2000,
  };
}

const config = loadConfig();

//
// Logging
//

function formatLog(message, data) {
  if (!data || Object.keys(data).length === 0) return message;
  const parts = Object.entries(data)
    .map(([k, v]) => {
      if (v === null || v === undefined) return `${k}=null`;
      if (typeof v === "object") return `${k}=${JSON.stringify(v)}`;
      return `${k}=${v}`;
    })
    .join(" ");
  return `${message} | ${parts}`;
}

function log(msg, data) {
  console.log(`${new Date().toISOString()} INFO  [card-gateway] ${formatLog(msg, data)}`);
}
function logWarn(msg, data) {
  console.warn(`${new Date().toISOString()} WARN  [card-gateway] ${formatLog(msg, data)}`);
}
function logError(msg, data) {
  console.error(`${new Date().toISOString()} ERROR [card-gateway] ${formatLog(msg, data)}`);
}

//
// Card parsing
//

const parseCardData = createCardParser(builtinParsers);

//
// Serial device discovery (zero dependencies)
//

function discoverLinuxPorts() {
  const ports = [];
  const byIdDir = "/dev/serial/by-id";

  try {
    for (const name of fs.readdirSync(byIdDir)) {
      const resolved = fs.realpathSync(path.join(byIdDir, name));
      const ttyName = path.basename(resolved);
      let vendorId = null;
      let productId = null;

      try {
        const deviceDir = fs.realpathSync(`/sys/class/tty/${ttyName}/device`);
        const usbDir = path.dirname(deviceDir);
        vendorId = fs.readFileSync(path.join(usbDir, "idVendor"), "utf8").trim();
        productId = fs.readFileSync(path.join(usbDir, "idProduct"), "utf8").trim();
      } catch {}

      ports.push({ path: resolved, vendorId, productId });
    }
  } catch {}

  return ports;
}

function discoverMacPorts() {
  const ports = [];
  try {
    for (const name of fs.readdirSync("/dev")) {
      if (name.startsWith("tty.usb")) {
        ports.push({ path: `/dev/${name}`, vendorId: null, productId: null });
      }
    }
  } catch {}
  return ports;
}

function findSerialPath() {
  if (config.serialPath) return config.serialPath;

  const ports = PLATFORM === "linux" ? discoverLinuxPorts() : discoverMacPorts();
  const wantVid = config.vendorId ? config.vendorId.toLowerCase() : null;
  const wantPid = config.productId ? config.productId.toLowerCase() : null;

  if (wantVid || wantPid) {
    const matching = ports.filter((p) => {
      const vid = (p.vendorId || "").toLowerCase();
      const pid = (p.productId || "").toLowerCase();
      if (wantVid && vid !== wantVid) return false;
      if (wantPid && pid !== wantPid) return false;
      return true;
    });

    if (matching.length >= 1) {
      if (matching.length > 1) {
        log("Multiple matching ports, using first", { count: matching.length });
      }
      return matching[0].path;
    }
  }

  // No filter or no match — use first available port
  if (ports.length === 1) return ports[0].path;

  return null;
}

//
// Serial port open via stty + fs (zero dependencies)
//

function configurePort(devicePath, baudRate) {
  const flag = PLATFORM === "darwin" ? "-f" : "-F";
  execSync(
    `stty ${flag} ${devicePath} ${baudRate} cs8 -cstopb -parenb raw -echo -echoe -echok`,
    { stdio: "ignore" }
  );
}

let stream = null;
let reconnectTimer = null;

function connectScanner() {
  clearTimeout(reconnectTimer);

  const devicePath = findSerialPath();
  if (!devicePath) {
    logError("No serial device found", { retryIn: `${config.reconnectInterval / 1000}s` });
    reconnectTimer = setTimeout(connectScanner, config.reconnectInterval);
    return;
  }

  log("Opening serial port", { path: devicePath, baudRate: config.baudRate });

  try {
    configurePort(devicePath, config.baudRate);
  } catch (err) {
    logError("Failed to configure serial port", { error: err.message });
    reconnectTimer = setTimeout(connectScanner, config.reconnectInterval);
    return;
  }

  stream = fs.createReadStream(devicePath, { flags: "r" });

  let buf = "";

  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");

    while (true) {
      const idxR = buf.indexOf("\r");
      const idxN = buf.indexOf("\n");
      if (idxR === -1 && idxN === -1) break;
      const idx = idxR === -1 ? idxN : idxN === -1 ? idxR : Math.min(idxR, idxN);

      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;

      const parsed = parseCardData(line);
      if (parsed) {
        const scan = {
          id: crypto.randomUUID(),
          data: parsed,
          timestamp: new Date().toISOString(),
        };
        log("Card scanned", { cardId: scan.data });
        sendToServer(scan);
      } else {
        logWarn("Card parse failed", { raw: line });
      }
    }
  });

  stream.on("error", (err) => {
    logError("Serial read error", { error: err.message });
    scheduleReconnect();
  });

  stream.on("close", () => {
    log("Serial port closed, reconnecting...");
    scheduleReconnect();
  });

  log("Serial port opened — waiting for card scans");
}

function scheduleReconnect() {
  if (stream) {
    stream.destroy();
    stream = null;
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectScanner, config.reconnectInterval);
}

//
// HTTPS POST with retries
//

function sendToServer(scan, attempt = 1) {
  const payload = JSON.stringify({
    id: scan.id,
    cardId: scan.data,
    deviceId: config.deviceId,
    timestamp: scan.timestamp,
  });

  const url = new URL(config.endpoint);
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;

  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  };
  if (config.authToken) {
    headers["Authorization"] = `Bearer ${config.authToken}`;
  }

  const req = transport.request(
    {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers,
    },
    (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log("POST OK", { status: res.statusCode, cardId: scan.data });
        } else {
          logError("POST failed", { status: res.statusCode, cardId: scan.data, body });
          retry(scan, attempt);
        }
      });
    }
  );

  req.on("error", (err) => {
    logError("POST error", { cardId: scan.data, error: err.message });
    retry(scan, attempt);
  });

  req.write(payload);
  req.end();
}

function retry(scan, attempt) {
  if (attempt < config.sendRetries) {
    log("Retrying POST", { cardId: scan.data, attempt: `${attempt + 1}/${config.sendRetries}` });
    setTimeout(() => sendToServer(scan, attempt + 1), config.sendRetryDelay);
  } else {
    logError("Gave up sending", { cardId: scan.data, attempts: config.sendRetries });
  }
}

//
// Graceful shutdown
//

function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);
  clearTimeout(reconnectTimer);
  if (stream) stream.destroy();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

//
// Start
//

log("hums-card-gateway starting");
log("Config", { deviceId: config.deviceId, endpoint: config.endpoint });
connectScanner();
