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
    const imagePath = await renderHtmlToImage(html);
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

            printer
              .raster(image, "normal")
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