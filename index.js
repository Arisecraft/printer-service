var express = require("express");
const cors = require("cors");
const indexV1Router = require("./routes/v1/index.routes");
const { printQueue, processQueue } = require("./utils/print.utils");


var app = express();
const PORT = 7195;


// === Middlewares ===no
app.use(cors(origin="*"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));


// === Root Route === 
app.get("/", (req, res) => {
    res.send(`
        <h1 style="font-family: helvetica;text-align: center; color: #007bff;margin-top:100px">Welcome to Arisecraft Printer Service! 🖨️</h1>
        <p style="font-family: helvetica;text-align: center; font-size: 18px; color: #333;">
            Seamlessly print to any thermal printer on your network. <br>
            Fast, Reliable, and Effortless Printing!
        </p>
        `);
});


// === Main Routes ===
app.use('/v1',indexV1Router)


// === Start server === 
app.listen(PORT , () => {
    console.log(`Server running at http://localhost:${PORT}`);
    const html = `<!DOCTYPE html>
            <html lang="en">
            <head>
            <meta charset="UTF-8">
            <title>Thermal Printer Greeting</title>
            <style>
                body {
                background-color: #f4f4f4;
                font-family: "Courier New", Courier, monospace;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                }

                .printer-box {
                background-color: #fff;
                border: 2px dashed #999;
                padding: 30px 50px;
                text-align: center;
                box-shadow: 0 4px 8px rgba(0,0,0,0.1);
                margin-top:35px;
                }

                .ascii-emoji {
                font-size: 34px;
                margin-bottom: 10px;
                transform:rotate(90deg);
                border:2px solid black;
                border-radius:50%;
                width:40px;
                margin :0 auto;
                }

                .title {
                font-size: 24px;
                margin-bottom: 10px;
                font-weight: bold;
                }

                .line {
                margin: 10px 0;
                font-weight: bold;
                }

                .message {
                margin: 10px 0;
                font-size: 16px;
                }

                .footer {
                margin-top: 20px;
                font-size: 14px;
                color: #555;
                border-top: 1px solid #ccc;
                padding-top: 10px;
                }
            </style>
            </head>
            <body>
            <div class="printer-box">
                <div class="ascii-emoji"> :) </div>

                <div class="line">==============================</div>
                <div class="title">HI THERE!</div>
                <div class="line">==============================</div>

                <div class="message">Greetings for the day!</div>
                <div class="message">Printer service has started successfully.</div>

                <div class="line">==============================</div>
                <div class="footer">Have a nice day!</div>
            </div>
            </body>
            </html>
            `;
   printQueue.push({
        printer_info : {
            // printer_type : 'NETWORK',
            // ip_address: '192.168.29.243',
            // port: 9100
            printer_type : 'USB'
        },
        printBody: html,
        _onComplete: ()=>{},
        _onError: ()=>{},
    });
    processQueue();
});


// var express = require("express");
// const cors = require("cors");
// const fs = require("fs");
// const https = require("https");

// const indexV1Router = require("./routes/v1/index.routes");
// const { printQueue, processQueue } = require("./utils/print.utils");

// var app = express();
// const PORT = 7195; // HTTPS port

// // === SSL Certificate ===
// const options = {
//   key: fs.readFileSync("./server.key"),
//   cert: fs.readFileSync("./server.crt"),
// };

// // === Middlewares ===
// app.use(
//   cors({
//     origin: "https://erpdev.arisecraft.com", // must be full protocol + domain
//     methods: ["GET", "POST", "OPTIONS"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//     credentials: true,
//   })
// );

// app.use(express.json());
// app.use(express.urlencoded({ extended: false }));

// // === Root Route ===
// app.get("/", (req, res) => {
//   res.send(`
//     <h1 style="font-family: helvetica;text-align: center; color: #007bff;margin-top:100px">
//       Welcome to Arisecraft Printer Service! ???
//     </h1>
//     <p style="font-family: helvetica;text-align: center; font-size: 18px; color: #333;">
//       Seamlessly print to any thermal printer on your network. <br>
//       Fast, Reliable, and Effortless Printing!
//     </p>
//   `);
// });

// // === Main Routes ===
// app.use("/v1", indexV1Router);

// // === Start HTTPS Server ===
// https.createServer(options, app).listen(PORT, () => {
//   console.log(`?? HTTPS Server running at https://localhost:${PORT}`);

//   const html = `<!DOCTYPE html>
//   <html lang="en">
//   <head>
//   <meta charset="UTF-8">
//   <title>Thermal Printer Greeting</title>
//   <style>
//       body {
//       background-color: #f4f4f4;
//       font-family: "Courier New", Courier, monospace;
//       display: flex;
//       justify-content: center;
//       align-items: center;
//       height: 100vh;
//       margin: 0;
//       }

//       .printer-box {
//       background-color: #fff;
//       border: 2px dashed #999;
//       padding: 30px 50px;
//       text-align: center;
//       box-shadow: 0 4px 8px rgba(0,0,0,0.1);
//       margin-top:35px;
//       }

//       .ascii-emoji {
//       font-size: 34px;
//       margin-bottom: 10px;
//       transform:rotate(90deg);
//       border:2px solid black;
//       border-radius:50%;
//       width:40px;
//       margin :0 auto;
//       }

//       .title {
//       font-size: 24px;
//       margin-bottom: 10px;
//       font-weight: bold;
//       }

//       .line {
//       margin: 10px 0;
//       font-weight: bold;
//       }

//       .message {
//       margin: 10px 0;
//       font-size: 16px;
//       }

//       .footer {
//       margin-top: 20px;
//       font-size: 14px;
//       color: #555;
//       border-top: 1px solid #ccc;
//       padding-top: 10px;
//       }
//   </style>
//   </head>
//   <body>
//   <div class="printer-box">
//       <div class="ascii-emoji"> :) </div>

//       <div class="line">==============================</div>
//       <div class="title">HI THERE!</div>
//       <div class="line">==============================</div>

//       <div class="message">Greetings for the day!</div>
//       <div class="message">Printer service has started successfully.</div>

//       <div class="line">==============================</div>
//       <div class="footer">Have a nice day!</div>
//   </div>
//   </body>
//   </html>`;

//   printQueue.push({
//     printer_info: {
//       printer_type: "USB",
//     },
//     printBody: html,
//     _onComplete: () => {},
//     _onError: () => {},
//   });
// 
//   processQueue();
// });
