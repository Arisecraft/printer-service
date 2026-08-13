const express = require("express");
const { printQueue, processQueue, scanNetworkPrinters, getQueueStatus, clearQueue, retryQueue, saveQueueToDisk } = require("../../utils/print.utils");
const escpos = require("escpos");
escpos.USB = require("escpos-usb");

const printerRouter = express.Router();

printerRouter.post("/print", async (req, res) => {
  try {
    const printJobs = req.body.printJobs;
    if (!Array.isArray(printJobs) || printJobs.length === 0) {
      return res.status(400).json({ success: false, message: "No printJobs provided in request body" });
    }

    const jobPromises = printJobs.map((job) => {
      return new Promise((resolve, reject) => {
        const jobId = job.id || job.kot_id || job.order_id || job.bill_id || null;

        // Check if an identical or duplicate job is already queued/waiting
        const existingJob = printQueue.find(j => {
          if (jobId && j.id === jobId) return true;
          if (!jobId && j.printBody === job.printBody && JSON.stringify(j.printer_info) === JSON.stringify(job.printer_info)) {
            return true;
          }
          return false;
        });

        if (existingJob) {
          console.log(`[QUEUE] Duplicate print job ignored (ID: ${existingJob.id}). Already in queue.`);
          return resolve({
            queued: true,
            duplicate: true,
            status: existingJob.status,
            message: "Print job is already queued for printing"
          });
        }

        const finalJobId = jobId || `job_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const queueJob = {
          id: finalJobId,
          printer_info: job.printer_info,
          printBody: job.printBody,
          isBuzzerRequired: job.isBuzzerRequired,
          targetWidth: job.targetWidth,
          status: "pending",
          createdAt: Date.now(),
          retryCount: 0,
          _onComplete: (err, result) => {
            if (err) reject(err);
            else resolve(result);
          },
          _onError: (err) => reject(err),
        };

        printQueue.push(queueJob);
        saveQueueToDisk();
        processQueue();
      });
    });

    const results = await Promise.allSettled(jobPromises);

    const failedJobs = results
      .map((result, index) => {
        if (result.status === "rejected") {
          const reason = result.reason;
          return {
            index,
            reason: reason instanceof Error
              ? { message: reason.message, stack: reason.stack, ...reason }
              : reason
          };
        }
        return null;
      })
      .filter(Boolean);

    if (failedJobs.length > 0) {
      console.error("Some jobs failed:", failedJobs);
      return res.status(207).json({
        success: false,
        message: `${failedJobs.length} job(s) failed.`,
        failedJobs,
      });
    }

    res.json({
      success: true,
      message: "All print jobs processed or queued successfully",
    });
  } catch (e) {
    console.error("Unexpected error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /v1/printer/queue - Get current print queue status
printerRouter.get("/queue", (req, res) => {
  try {
    const queue = getQueueStatus();
    res.json({
      success: true,
      count: queue.length,
      queue
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /v1/printer/queue/clear - Clear print queue
printerRouter.post("/queue/clear", (req, res) => {
  try {
    const result = clearQueue();
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /v1/printer/queue/retry - Force immediate retry of queued jobs
printerRouter.post("/queue/retry", (req, res) => {
  try {
    const result = retryQueue();
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// === this api is used to find all the USB printers connected and to get their IDs ===
printerRouter.get("/findUsbPrintersAndPrint", async (req, res) => {
  try {
    // Find all USB printers
    const usbDevices = escpos.USB.findPrinter();

    if (!usbDevices.length) {
      return res.json({ success: false, message: "No USB printers found" });
    }

    let printerList = [];

    usbDevices.forEach((device) => {
      // Extract necessary details
      const vendorId = device.deviceDescriptor.idVendor;
      const productId = device.deviceDescriptor.idProduct;

      // Store printer details
      printerList.push({ type: "USB", vendorId, productId });

      // Create and print
      const printerDevice = new escpos.USB(vendorId, productId);

      // Safety wrapper to prevent fatal crash if endpoint is undefined
      if (printerDevice && typeof printerDevice.write === "function") {
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

      let called = false;
      printerDevice.open((err) => {
        if (called) return;
        called = true;

        if (err) {
          console.error("Failed to open printer device:", err);
          return;
        }

        printer
          .align("ct")
          .text(`USB Printer Found`)
          .text(`Vendor ID: ${vendorId}`)
          .text(`Product ID: ${productId}`)
          .text(`\n\nKitchen: __________`)
          .cut()
          .close();
      });
    });

    return res.json({ success: true, printers: printerList });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});


// === this api returns all the USB printes connected ===
printerRouter.get("/findUsbPrinters", (req, res) => {
  try {
    const devices = escpos.USB.findPrinter();
    res.send({
      devices,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      message: e.message,
    });
  }
});

// === this api returns all connected USB and Network printers ===
printerRouter.get("/connected", async (req, res) => {
  try {
    // 1. Scan for connected USB printers
    let usbDevices = [];
    try {
      const devices = escpos.USB.findPrinter();
      usbDevices = devices.map((device) => ({
        type: "USB",
        vendorId: device.deviceDescriptor.idVendor,
        productId: device.deviceDescriptor.idProduct,
      }));
    } catch (usbError) {
      console.error("Failed to list USB printers:", usbError);
    }

    // 2. Scan for network printers
    let networkPrinters = [];
    try {
      networkPrinters = await scanNetworkPrinters();
    } catch (netError) {
      console.error("Failed to scan network printers:", netError);
    }

    res.json({
      success: true,
      usb: usbDevices,
      network: networkPrinters,
    });
  } catch (e) {
    console.error("Failed to fetch connected printers:", e);
    res.status(500).json({
      success: false,
      message: e.message,
    });
  }
});

module.exports = printerRouter;


// const express = require("express");
// const Printer = require("@thiagoelg/node-printer");
// const { ThermalPrinter, PrinterTypes, CharacterSet } = require("node-thermal-printer");

// const printerRouter = express.Router();

// // Helper to print a specific buffer to a Windows printer name
// const printToWindowsPrinter = (printerName, buffer) => {
//   return new Promise((resolve, reject) => {
//     Printer.printDirect({
//       data: buffer,
//       printer: printerName,
//       type: "RAW",
//       success: (jobID) => {
//         console.log(`Job sent to ${printerName} with ID: ${jobID}`);
//         resolve(jobID);
//       },
//       error: (err) => {
//         console.error(`Error printing to ${printerName}:`, err);
//         reject(err);
//       },
//     });
//   });
// };

// // === 1. FIND PRINTERS (Scans Windows System Printers) ===
// printerRouter.get("/findUsbPrinters", (req, res) => {
//   try {
//     // Get all installed printers on Windows
//     const allPrinters = Printer.getPrinters();
    
//     // Filter to find likely Epson/POS printers
//     // (You can remove the filter if you want to see ALL printers)
//     const epsonPrinters = allPrinters.filter(p => 
//       p.name.toUpperCase().includes("EPSON") || 
//       p.name.toUpperCase().includes("POS") ||
//       p.name.toUpperCase().includes("THERMAL")
//     );

//     if (epsonPrinters.length === 0) {
//       return res.json({ 
//         success: false, 
//         message: "No Epson/POS printers found in Windows Devices.",
//         allDetected: allPrinters.map(p => p.name) // Return all names for debugging
//       });
//     }

//     res.json({
//       success: true,
//       devices: epsonPrinters,
//     });
//   } catch (e) {
//     console.error(e);
//     res.status(500).json({
//       success: false,
//       message: e.message,
//     });
//   }
// });

// // === 2. PRINT JOB ===
// printerRouter.post("/print", async (req, res) => {
//   try {
//     const { printerName, printJobs } = req.body;

//     if (!printerName) {
//       return res.status(400).json({ success: false, message: "printerName is required (e.g., 'EPSON TM-T82')" });
//     }

//     // Setup the printer generator
//     let printer = new ThermalPrinter({
//       type: PrinterTypes.EPSON,
//       interface: `printer:${printerName}`,
//       characterSet: CharacterSet.PC437_USA, // Standard for Epson
//       removeSpecialCharacters: false
//     });

//     // Process jobs
//     // Note: This logic assumes 'job' contains text or data. 
//     // You might need to adapt this loop depending on your exact 'printJobs' structure.
//     for (const job of printJobs) {
//       printer.alignCenter();
//       if(job.text) printer.println(job.text);
//       // Add other job types here (images, barcodes, etc based on your input structure)
//     }
    
//     printer.cut();
    
//     // Get the raw buffer generated by the library
//     const rawBuffer = printer.getBuffer();

//     // Send to Windows Spooler
//     await printToWindowsPrinter(printerName, rawBuffer);
    
//     // Clear buffer for next usage
//     printer.clear();

//     res.json({
//       success: true,
//       message: "Print job sent successfully",
//     });

//   } catch (e) {
//     console.error("Unexpected error:", e);
//     res.status(500).json({ success: false, message: e.message });
//   }
// });

// // === 3. FIND AND PRINT TEST PAGE ===
// printerRouter.get("/findUsbPrintersAndPrint", async (req, res) => {
//   try {
//     const allPrinters = Printer.getPrinters();
    
//     // Try to find the first Epson printer
//     const targetPrinter = allPrinters.find(p => p.name.toUpperCase().includes("EPSON"));

//     if (!targetPrinter) {
//       return res.json({ success: false, message: "No Epson printer found to test." });
//     }

//     const name = targetPrinter.name;

//     // Generate Test Receipt
//     let printer = new ThermalPrinter({
//       type: PrinterTypes.EPSON,
//       interface: `printer:${name}`,
//     });

//     printer.alignCenter();
//     printer.println("Windows 7 Printer Found!");
//     printer.println(`Name: ${name}`);
//     printer.drawLine();
//     printer.println("Kitchen: Ready");
//     printer.cut();

//     await printToWindowsPrinter(name, printer.getBuffer());

//     return res.json({ 
//       success: true, 
//       message: `Test printed to ${name}`,
//       printers: [targetPrinter] 
//     });

//   } catch (error) {
//     console.error("Error:", error);
//     return res.status(500).json({ success: false, message: error.message });
//   }
// });

// module.exports = printerRouter;