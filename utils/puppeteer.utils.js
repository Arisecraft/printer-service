const puppeteer = require('puppeteer');
const path = require('path');
const crypto = require('crypto');

// Store the browser instance to reuse it
let browser = null;

// Function to generate a unique file name
function generateUniqueFileName() {
    const timestamp = Date.now(); // Current time in milliseconds
    const randomString = crypto.randomBytes(6).toString('hex'); // Random string for uniqueness
    return `${timestamp}-${randomString}.png`; // Combine timestamp and random string
}

// Initialize the browser (launch only once)
async function initializeBrowser() {
  if (!browser || !browser.isConnected()) {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn("Failed to close existing browser:", e);
      }
    }

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
}


// Function to render HTML to an image using Puppeteer
async function renderHtmlToImage(html) {
    let page;
    try {

    if (!html) {
        throw new Error('HTML content is required');
    }

    // Ensure browser is initialized before proceeding
    await initializeBrowser();

    const uniqueFileName = generateUniqueFileName(); // Generate unique file name
    const tempFilePath = path.join(__dirname, '../prints/', uniqueFileName); // Use unique file path

    // Create a new page for the screenshot (reuse the browser instance)
    page = await browser.newPage();

        // Set the HTML content
        await page.setContent(html);

        // Set a reasonable width for the page
        await page.setViewport({ width: 600, height: 100 }); // Temporary height to start with

        // Wait for the page to load and calculate the height based on content
        const contentHeight = await page.evaluate(() => {
            const body = document.body;
            const html = document.documentElement;
            return Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight);
        });

        // Adjust viewport to auto height based on content
        await page.setViewport({ width: 580, height: contentHeight });

        // Capture the screenshot of the rendered HTML
        await page.screenshot({ path: tempFilePath });

        await page.close(); // Close the page after the screenshot is taken

        return tempFilePath; // Return the unique file path
    } catch (error) {
        console.error('Error rendering HTML:', error);
        if (page && typeof page.close === 'function') {
            try {
                await page.close();
            } catch (closeError) {
                console.error('Error closing page on fallback:', closeError);
            }
        }
        throw new Error('Failed to render HTML to image');
    }
}

// Export the function
module.exports = { renderHtmlToImage, initializeBrowser };
