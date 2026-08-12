const escpos = require("escpos");
const { renderHtmlToImage } = require("./puppeteer.utils");
escpos.USB = require("escpos-usb");
escpos.Network = require("escpos-network");
const fs = require("fs");
const net = require("net");
const { getLocalIP } = require("./ip.utils");

let printQueue = [];
let isPrinting = false;

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
      // Fallback to auto-detecting any connected USB printer
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
  const speedLevel = options.speedLevel || 9; // 1 (slowest) to 9 (fastest)

  // 1. Hardware Initialize (ESC @) -> Reset modes and clear stale buffers
  printer.buffer.write(Buffer.from([0x1b, 0x40]));

  // 2. Select Print Speed (GS ( K) -> 1D 28 4B 02 00 31 <speedLevel>
  // High speed setting for Epson and standard ESC/POS receipt printers
  if (speedLevel >= 1 && speedLevel <= 13) {
    printer.buffer.write(Buffer.from([0x1d, 0x28, 0x4b, 0x02, 0x00, 0x31, speedLevel]));
  }

  // 3. Select Print Density (GS ( K) -> 1D 28 4B 02 00 32 00 (Standard density)
  printer.buffer.write(Buffer.from([0x1d, 0x28, 0x4b, 0x02, 0x00, 0x32, 0x00]));

  // 4. Set Line Spacing to 0 (ESC 3 0) -> Eliminates line-feed gaps between graphic bands
  printer.buffer.write(Buffer.from([0x1b, 0x33, 0x00]));

  const width = image.size.width;
  const totalHeight = image.size.height;
  const n = Math.ceil(width / 8);

  // 5. Slice image vertically into optimal height bands to avoid printer receive buffer overflow
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

    // Write GS v 0 raster header for this slice: 0x1d 0x76 0x30 0x00
    printer.buffer.write(Buffer.from([0x1d, 0x76, 0x30, 0x00]));

    // Width (n) in 16-bit Little Endian
    const widthBuf = Buffer.alloc(2);
    widthBuf.writeUInt16LE(n, 0);
    printer.buffer.write(widthBuf);

    // Height (currentHeight) in 16-bit Little Endian
    const heightBuf = Buffer.alloc(2);
    heightBuf.writeUInt16LE(currentHeight, 0);
    printer.buffer.write(heightBuf);

    // Raster pixel payload
    printer.buffer.write(Buffer.from(rasterData));
  }

  // 6. Restore line spacing to default (ESC 2)
  printer.buffer.write(Buffer.from([0x1b, 0x32]));
}

async function printJob(job) {
  const printerDevice = getPrinter(job.printer_info);

  if (!printerDevice) {
    console.error(
      `Invalid printer configuration for ${JSON.stringify(job.printer_info)}`
    );
    return Promise.reject(new Error("Invalid printer configuration"));
  }

  // Safety wrapper to prevent fatal crash if endpoint is undefined (only for USB printers)
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
    return Promise.reject(new Error("HTML content missing"));
  }

  try {
    const targetWidth = (job.printer_info && job.printer_info.paper_width === '58mm') ? 384 : (job.targetWidth || 576);
    const imagePath = await renderHtmlToImage(html, targetWidth);
    console.log("Generated image for printing:", imagePath);

    return new Promise((resolve, reject) => {
      let timeout = setTimeout(() => {
        console.error("Printer operation timed out.");
        reject(new Error("Printer operation timed out"));
      }, 15000); // 15 seconds max timeout

      escpos.Image.load(imagePath, function (image) {
        let called = false;
        printerDevice.open(function (err) {
          if (called) return;
          called = true;

          if (err) {
            clearTimeout(timeout);
            console.error("Failed to open printer device:", err);
            return reject(err);
          }

          try {
            if (job.isBuzzerRequired) {
              printerDevice.write([0x1b, 0x1e]);
              printerDevice.write([0x1b, 0x1e]);
            }

            // Print raster using hardware speed initialization and chunking
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

                resolve(); // Mark this job as complete
              });
          } catch (e) {
            clearTimeout(timeout);
            console.error("Unexpected error during print:", e);
            reject(e);
          }
        });
      });
    });
  } catch (error) {
    console.error("Error rendering or printing the HTML:", error);
    return Promise.reject(error);
  }
}

// Function to process the queue
async function processQueue() {
  if (isPrinting || printQueue.length === 0) return;

  isPrinting = true;
  const job = printQueue.shift();

  try {
    await printJob(job);
    console.log("Print job completed successfully.");
    if (typeof job._onComplete === "function") job._onComplete();
  } catch (error) {
    console.error("Error while processing print job:", error);
    if (typeof job._onError === "function") job._onError(error);
  }

  isPrinting = false;
  processQueue(); // Continue to next
}



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
      socket.setTimeout(400); // 400ms timeout
      
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

module.exports = {
    printQueue,
    processQueue,
    scanNetworkPrinters
}