const escpos = require("escpos");
const { renderHtmlToImage } = require("./puppeteer.utils");
escpos.USB = require("escpos-usb");
escpos.Network = require("escpos-network");
const fs = require("fs");
const path = require("path");
const net = require("net");
const { getLocalIP } = require("./ip.utils");

const QUEUE_FILE_PATH = path.join(__dirname, "../prints/queue.json");
const MAX_RETRIES = 1000;
const RETRY_BACKOFF_MS = 5000;

let printQueue = [];
let isPrinting = false;

// Ensure prints folder exists
const printsDir = path.join(__dirname, "../prints");
if (!fs.existsSync(printsDir)) {
  try {
    fs.mkdirSync(printsDir, { recursive: true });
  } catch (err) {
    console.error("Failed to create prints directory:", err);
  }
}

// Function to save queue state to prints/queue.json
function saveQueueToDisk() {
  try {
    const serializableQueue = printQueue.map(job => ({
      id: job.id,
      printer_info: job.printer_info,
      printBody: job.printBody,
      isBuzzerRequired: job.isBuzzerRequired,
      targetWidth: job.targetWidth,
      status: job.status || "pending",
      createdAt: job.createdAt || Date.now(),
      retryCount: job.retryCount || 0,
      lastError: job.lastError || null,
      nextRetryAt: job.nextRetryAt || null
    }));

    fs.writeFileSync(QUEUE_FILE_PATH, JSON.stringify(serializableQueue, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save print queue to disk:", err.message);
  }
}

// Function to load queue state from prints/queue.json
function loadQueueFromDisk() {
  try {
    if (fs.existsSync(QUEUE_FILE_PATH)) {
      const data = fs.readFileSync(QUEUE_FILE_PATH, "utf8");
      if (data && data.trim().length > 0) {
        const loadedJobs = JSON.parse(data);
        if (Array.isArray(loadedJobs)) {
          printQueue.length = 0;
          loadedJobs.forEach(job => {
            printQueue.push({
              ...job,
              status: job.status === "printing" ? "pending" : (job.status || "pending"),
              _onComplete: () => {},
              _onError: () => {}
            });
          });
          console.log(`Loaded ${printQueue.length} job(s) from persistent queue disk file.`);
        }
      }
    }
  } catch (err) {
    console.error("Failed to load print queue from disk:", err.message);
  }
}

// Load queue on module load
loadQueueFromDisk();

// Check if a network printer is reachable via quick TCP socket connection
function isPrinterReachable(printerInfo, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!printerInfo || printerInfo.printer_type !== "Network") {
      return resolve(true); // Default true for non-network printers
    }

    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeoutMs);

    socket.on("connect", () => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(false);
    });

    socket.connect(printerInfo.port || 9100, printerInfo.ip_address);
  });
}

// Identify if an error is a recoverable printer connection / offline error
function isConnectivityError(error) {
  if (!error) return false;
  const msg = (error.message || "").toLowerCase();
  const code = error.code || "";

  return (
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ETIMEDOUT" ||
    code === "ENETUNREACH" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "PRINTER_NOT_CONNECTED" ||
    msg.includes("timed out") ||
    msg.includes("failed to open printer") ||
    msg.includes("usb endpoint is undefined") ||
    msg.includes("can not find printer") ||
    msg.includes("cannot find printer") ||
    msg.includes("printer not found") ||
    msg.includes("printer not connected") ||
    msg.includes("unreachable") ||
    msg.includes("offline") ||
    msg.includes("cannot connect")
  );
}

const getPrinter = (printerInfo) => {
  let printerDevice = null;

  if (printerInfo.printer_type === "USB") {
    const vendor_id = printerInfo.vendor_id;
    const product_id = printerInfo.product_id;

    try {
      if (vendor_id && product_id) {
        printerDevice = new escpos.USB(vendor_id, product_id);
        console.log("Initialized new USB printer with Vendor ID:", vendor_id, "Product ID:", product_id);
      } else {
        printerDevice = new escpos.USB();
        console.log("Initialized new USB printer with auto-detection");
      }
    } catch (err) {
      console.error("Failed to initialize USB printer with configured VID/PID:", err.message);
      try {
        console.log("Attempting fallback to auto-detect any connected USB printer...");
        printerDevice = new escpos.USB();
        console.log("Fallback initialized USB printer with auto-detection");
      } catch (fallbackErr) {
        console.error("Failed to auto-detect USB printer during fallback:", fallbackErr.message);
      }
    }
  } else if (printerInfo.printer_type === "Network") {
    const { Network } = escpos;
    try {
      printerDevice = new Network(
        printerInfo.ip_address,
        printerInfo.port || 9100
      );
      console.log("Initialized new Network printer:", printerInfo.ip_address);
    } catch (err) {
      console.error("Failed to initialize Network printer:", err.message);
    }
  }

  return printerDevice;
};

function printRasterOptimized(printer, image, options = {}) {
  const maxSliceHeight = options.sliceHeight || 200;
  const speedLevel = options.speedLevel || 9;

  printer.buffer.write(Buffer.from([0x1b, 0x40]));

  if (speedLevel >= 1 && speedLevel <= 13) {
    printer.buffer.write(Buffer.from([0x1d, 0x28, 0x4b, 0x02, 0x00, 0x31, speedLevel]));
  }

  printer.buffer.write(Buffer.from([0x1d, 0x28, 0x4b, 0x02, 0x00, 0x32, 0x00]));
  printer.buffer.write(Buffer.from([0x1b, 0x33, 0x00]));

  const width = image.size.width;
  const totalHeight = image.size.height;
  const n = Math.ceil(width / 8);

  for (let startY = 0; startY < totalHeight; startY += maxSliceHeight) {
    const currentHeight = Math.min(maxSliceHeight, totalHeight - startY);
    const sliceData = image.data.slice(startY * width, (startY + currentHeight) * width);

    const rasterData = new Uint8Array(n * currentHeight);

    for (let y = 0; y < currentHeight; y++) {
      for (let x = 0; x < n; x++) {
        for (let b = 0; b < 8; b++) {
          const i = x * 8 + b;
          if (i < width) {
            if (sliceData[y * width + i]) {
              rasterData[y * n + x] |= (0x80 >> (b & 0x7));
            }
          }
        }
      }
    }

    printer.buffer.write(Buffer.from([0x1d, 0x76, 0x30, 0x00]));

    const widthBuf = Buffer.alloc(2);
    widthBuf.writeUInt16LE(n, 0);
    printer.buffer.write(widthBuf);

    const heightBuf = Buffer.alloc(2);
    heightBuf.writeUInt16LE(currentHeight, 0);
    printer.buffer.write(heightBuf);

    printer.buffer.write(Buffer.from(rasterData));
  }

  printer.buffer.write(Buffer.from([0x1b, 0x32]));
}

async function printJob(job) {
  // If Network printer, pre-check if socket connection is alive before launching browser/render
  if (job.printer_info && job.printer_info.printer_type === "Network") {
    const reachable = await isPrinterReachable(job.printer_info, 2000);
    if (!reachable) {
      const err = new Error(`Network printer at ${job.printer_info.ip_address}:${job.printer_info.port || 9100} is offline or unreachable`);
      err.code = "EHOSTUNREACH";
      throw err;
    }
  }

  const printerDevice = getPrinter(job.printer_info);

  if (!printerDevice) {
    const pType = (job.printer_info && job.printer_info.printer_type) || "Unknown";
    console.error(`Printer device not found or invalid configuration for ${JSON.stringify(job.printer_info)}`);
    const err = new Error(`${pType} printer not found or not connected`);
    err.code = "PRINTER_NOT_CONNECTED";
    throw err;
  }

  if (job.printer_info && job.printer_info.printer_type === "USB" && printerDevice && typeof printerDevice.write === "function") {
    const originalWrite = printerDevice.write;
    printerDevice.write = function (data, callback) {
      if (!this.endpoint) {
        const err = new Error("USB endpoint is undefined. Cannot write to printer.");
        console.error(err.message);
        if (callback) callback(err);
        return this;
      }
      return originalWrite.call(this, data, callback);
    };
  }

  const printer = new escpos.Printer(printerDevice);
  const html = job.printBody;

  if (!html) {
    console.error("HTML content is required for job:", job);
    throw new Error("HTML content missing");
  }

  const targetWidth = (job.printer_info && job.printer_info.paper_width === '58mm') ? 384 : (job.targetWidth || 576);
  const imagePath = await renderHtmlToImage(html, targetWidth);
  console.log("Generated image for printing:", imagePath);

  return new Promise((resolve, reject) => {
    let timeout = setTimeout(() => {
      console.error("Printer operation timed out.");
      reject(new Error("Printer operation timed out"));
    }, 15000);

    escpos.Image.load(imagePath, function (image) {
      let called = false;
      printerDevice.open(function (err) {
        if (called) return;
        called = true;

        if (err) {
          clearTimeout(timeout);
          console.error("Failed to open printer device:", err);
          fs.unlink(imagePath, () => {});
          return reject(err);
        }

        try {
          if (job.isBuzzerRequired) {
            printerDevice.write([0x1b, 0x1e]);
            printerDevice.write([0x1b, 0x1e]);
          }

          printRasterOptimized(printer, image, {
            speedLevel: (job.printer_info && job.printer_info.speed_level) || 9,
            sliceHeight: (job.printer_info && job.printer_info.slice_height) || 200
          });

          printer
            .cut()
            .close(() => {
              clearTimeout(timeout);
              fs.unlink(imagePath, (err) => {
                if (err) console.error("Error deleting image file:", err);
                else console.log("Image file deleted successfully.");
              });

              resolve();
            });
        } catch (e) {
          clearTimeout(timeout);
          console.error("Unexpected error during print:", e);
          fs.unlink(imagePath, () => {});
          reject(e);
        }
      });
    });
  });
}

// Function to process the queue
async function processQueue() {
  if (isPrinting || printQueue.length === 0) return;

  // Find next eligible job: not currently printing AND (no nextRetryAt OR nextRetryAt has arrived)
  const now = Date.now();
  const jobIndex = printQueue.findIndex(
    j => j.status !== "printing" && (!j.nextRetryAt || now >= j.nextRetryAt)
  );

  if (jobIndex === -1) {
    return; // No job is ready for processing yet
  }

  isPrinting = true;
  const job = printQueue[jobIndex];
  job.status = "printing";
  saveQueueToDisk();

  try {
    await printJob(job);
    console.log(`Print job ${job.id || ''} completed successfully.`);

    // Remove job from printQueue upon success
    const removeIdx = printQueue.findIndex(j => j === job || (job.id && j.id === job.id));
    if (removeIdx !== -1) {
      printQueue.splice(removeIdx, 1);
    }
    saveQueueToDisk();

    if (typeof job._onComplete === "function") {
      job._onComplete(null, { success: true, message: "Job printed successfully" });
    }
  } catch (error) {
    console.error(`Error while processing print job ${job.id || ''}:`, error.message);

    const isRetryable = isConnectivityError(error) && ((job.retryCount || 0) < MAX_RETRIES);

    if (isRetryable) {
      job.retryCount = (job.retryCount || 0) + 1;
      job.lastError = error.message;
      job.status = "queued_offline";
      job.lastAttemptAt = Date.now();
      job.nextRetryAt = Date.now() + RETRY_BACKOFF_MS;

      console.warn(`[QUEUE] Printer offline/unreachable. Job ${job.id || ''} scheduled for retry #${job.retryCount} in ${RETRY_BACKOFF_MS / 1000}s.`);
      saveQueueToDisk();

      // Acknowledge HTTP request if not acknowledged yet so ERP doesn't hang
      if (typeof job._onComplete === "function" && !job.acknowledged) {
        job.acknowledged = true;
        job._onComplete(null, {
          queued: true,
          status: "queued_offline",
          message: "Printer offline. Job queued for automatic retry when printer power/connection returns."
        });
      }
    } else {
      // Non-retryable error or max retries reached: drop job from queue
      console.error(`[QUEUE] Job ${job.id || ''} failed permanently:`, error.message);
      const removeIdx = printQueue.findIndex(j => j === job || (job.id && j.id === job.id));
      if (removeIdx !== -1) {
        printQueue.splice(removeIdx, 1);
      }
      saveQueueToDisk();

      if (typeof job._onError === "function") {
        job._onError(error);
      }
    }
  }

  isPrinting = false;
  // Trigger next queue item processing
  setTimeout(() => processQueue(), 100);
}

// Background timer to auto-retry queued jobs every 5 seconds
setInterval(() => {
  if (!isPrinting && printQueue.length > 0) {
    processQueue();
  }
}, 5000);

async function scanNetworkPrinters() {
  const localIP = getLocalIP();
  if (localIP === '127.0.0.1') return [];

  const ipParts = localIP.split('.');
  const subnet = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;

  const promises = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${subnet}.${i}`;
    promises.push(new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(400);

      socket.on('connect', () => {
        socket.destroy();
        resolve({ type: 'Network', ip_address: ip, port: 9100 });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(null);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(null);
      });

      socket.connect(9100, ip);
    }));
  }

  const results = await Promise.all(promises);
  return results.filter(Boolean);
}

function getQueueStatus() {
  return printQueue.map(j => ({
    id: j.id,
    printer_info: j.printer_info,
    status: j.status,
    createdAt: j.createdAt,
    retryCount: j.retryCount,
    lastError: j.lastError,
    lastAttemptAt: j.lastAttemptAt,
    nextRetryAt: j.nextRetryAt
  }));
}

function clearQueue() {
  printQueue.length = 0;
  saveQueueToDisk();
  return { success: true, message: "Print queue cleared" };
}

function retryQueue() {
  printQueue.forEach(j => {
    j.nextRetryAt = null;
    if (j.status === "queued_offline") {
      j.status = "pending";
    }
  });
  saveQueueToDisk();
  processQueue();
  return { success: true, message: "Queue retry triggered" };
}

module.exports = {
  printQueue,
  processQueue,
  scanNetworkPrinters,
  getQueueStatus,
  clearQueue,
  retryQueue,
  saveQueueToDisk
};