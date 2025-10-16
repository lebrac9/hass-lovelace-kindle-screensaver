const config = require("./config");
const path = require("path");
const http = require("http");
const https = require("https"); // Aggiunto per l'API Home Assistant via HTTPS
const mqtt = require('mqtt');
const { promises: fs } = require("fs");
const fsExtra = require("fs-extra");
const puppeteer = require("puppeteer");
const { CronJob } = require("cron");
const gm = require("gm");

// keep state of current state for devcies (Lanrat: per MQTT)
const stateStore = {};
const pageCacheTimes= {};
// Stato batteria per webhook (Sibbl)
const batteryStore = {}; 

var mqttClient = {};


console.logReal = console.log;
console.errorReal = console.error;
console.log = function () {
    var args = [].slice.call(arguments);
    console.logReal.apply(console.log,['[' + (new Date()).toLocaleString() + ']'].concat(args));
};
console.error = function () {
    var args = [].slice.call(arguments);
    console.errorReal.apply(console.error,['[' + (new Date()).toLocaleString() + ']'].concat(args));
};


(async () => {
    if (config.pages.length === 0) {
        return console.error("Please check your configuration");
    }
    for (const i in config.pages) {
        const pageConfig = config.pages[i];
        if (pageConfig.rotation % 90 > 0) {
            return console.error(
                `Invalid rotation value for entry ${i + 1}: ${pageConfig.rotation}`
            );
        }
    }

    if (config.realTime) {
        console.log(`Operating in realtime mode with cache.`);
    }

    if (config.mqttServer) {
        mqttConnect();
    }

    console.log("Starting browser...");
    let browser = await puppeteer.launch({
        args: [
            "--disable-dev-shm-usage",
            "--no-sandbox",
            `--lang=${config.language}`,
            config.ignoreCertificateErrors && "--ignore-certificate-errors"
        ].filter((x) => x),
        headless: config.debug !== true
    });

    console.log(`Visiting '${config.baseUrl}' to login...`);
    let page = await browser.newPage();
    await page.goto(config.baseUrl, {
        timeout: config.renderingTimeout
    });

    const hassTokens = {
        hassUrl: config.baseUrl,
        access_token: config.accessToken,
        token_type: "Bearer"
    };

    console.log("Adding authentication entry to browser's local storage...");
    await page.evaluate(
        (hassTokens, selectedLanguage) => {
            localStorage.setItem("hassTokens", hassTokens);
            localStorage.setItem("selectedLanguage", selectedLanguage);
        },
        JSON.stringify(hassTokens),
        JSON.stringify(config.language)
    );

    page.close();

    if (config.debug) {
        console.log(
            "Debug mode active, will only render once in non-headless model and keep page open"
        );
        renderAndConvertAsync(browser);
    } else {
        console.log("Starting first render...");
        renderAndConvertAsync(browser);
        if (!config.realTime) {
            console.log("Starting rendering cronjob...");
            new CronJob({
                cronTime: config.cronJob,
                onTick: () => renderAndConvertAsync(browser),
                start: true
            });
        }
    }

    const httpServer = http.createServer(async (request, response) => {
        // Parse the request
        console.log(`received request from ${request.connection.remoteAddress} for ${request.url}`);

        // support to kill the process
        if (request.url == '/exit') {
            process.exit(1);
            return;
        }

        const url = new URL(request.url, `http://${request.headers.host}`);
        // Check the page number
        const pageNumberStr = url.pathname;
        const pageNumber =
            pageNumberStr === "/" ? 0 : parseInt(pageNumberStr.substr(1));
            
        // ------------------------------------------------------------------
        //
        const batteryLevel = parseInt(url.searchParams.get("batteryLevel"));
        const isCharging = url.searchParams.get("isCharging");
        // ------------------------------------------------------------------

        if (
            isFinite(pageNumber) === false ||
            pageNumber > config.pages.length ||
            pageNumber < 0
        ) {
            console.log(`Invalid request: ${request.url} for page ${pageNumber}`);
            response.writeHead(404);
            response.end("Invalid request");
            return;
        }
        if (pageNumber == 0) {
            await renderIndexAsync(response);
            return;
        }

        try {
            // Log when the page was accessed
            const n = new Date();
            console.log(`Image ${pageNumber} was accessed`);
            saveState(request); // Lanrat: Logica stato via header/MQTT

            const pageIndex = pageNumber - 1;
            const pageConfig = config.pages[pageIndex];

            // Lanrat: Logica Real-Time con Cache (Mantenuta)
            if (config.realTime) {
                // Modificato 'pageConfig.realTimeCacheSec' per usare 'config.realTimeCacheSec' se non specifico per pagina
                const cacheDuration = pageConfig.realTimeCacheSec || config.realTimeCacheSec; 
                if (Math.round((new Date()) - pageCacheTimes[pageConfig.screenShotUrl])/1000 > cacheDuration) {
                    await renderAndConvertPageAsync(browser, pageConfig);
                } else {
                    console.log(`returning cached version of ${pageConfig.screenShotUrl}`);
                }
            }

            const data = await fs.readFile(pageConfig.outputPath);
            const stat = await fs.stat(pageConfig.outputPath);

            const lastModifiedTime = new Date(stat.mtime).toUTCString();

            response.writeHead(200, {
                "Content-Type": "image/png",
                "Content-Length": Buffer.byteLength(data),
                "Last-Modified": lastModifiedTime
            });
            response.end(data);

            // ------------------------------------------------------------------
            // 
            let pageBatteryStore = batteryStore[pageIndex];
            if (!pageBatteryStore) {
                pageBatteryStore = batteryStore[pageIndex] = {
                    batteryLevel: null,
                    isCharging: false
                };
            }
            if (!isNaN(batteryLevel) && batteryLevel >= 0 && batteryLevel <= 100) {
                let updated = false;
                
                // Aggiornamento livello batteria
                if (batteryLevel !== pageBatteryStore.batteryLevel) {
                    pageBatteryStore.batteryLevel = batteryLevel;
                    updated = true;
                    console.log(`New battery level: ${batteryLevel} for page ${pageNumber}`);
                }

                // Aggiornamento stato di carica
                const isChargingNow = (isCharging === "Yes" || isCharging === "1");

                if (isChargingNow && pageBatteryStore.isCharging !== true) {
                    pageBatteryStore.isCharging = true;
                    updated = true;
                    console.log(`Battery started charging for page ${pageNumber}`);
                } else if (!isChargingNow && pageBatteryStore.isCharging !== false) {
                    pageBatteryStore.isCharging = false;
                    updated = true;
                    console.log(`Battery stopped charging for page ${pageNumber}`);
                }
                
                // Invia l'aggiornamento tramite WebHook se c'è un aggiornamento di stato
                if (updated && pageConfig.batteryWebHook) {
                    sendBatteryLevelToHomeAssistant(pageIndex, pageBatteryStore, pageConfig.batteryWebHook);
                }
            }
            // ------------------------------------------------------------------

        } catch (e) {
            console.error(e);
            response.writeHead(404);
            response.end("Image not found");
        }
    });

    const port = config.port || 5000;
    httpServer.listen(port, () => {
        console.log(`Server is running at ${port}`);
    });
})();

// ------------------------------------------------------------------
// 
// ------------------------------------------------------------------
function sendBatteryLevelToHomeAssistant(
    pageIndex,
    batteryStore,
    batteryWebHook
) {
    const batteryStatus = JSON.stringify(batteryStore);
    const options = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(batteryStatus)
        },
        rejectUnauthorized: !config.ignoreCertificateErrors
    };
    // Utilizza la base URL configurata per l'istanza HA
    const url = `${config.baseUrl}/api/webhook/${batteryWebHook}`;
    const httpLib = url.toLowerCase().startsWith("https") ? https : http;
    const req = httpLib.request(url, options, (res) => {
        if (res.statusCode !== 200) {
            console.error(
                `Update device ${pageIndex} at ${url} status ${res.statusCode}: ${res.statusMessage}`
            );
        }
    });
    req.on("error", (e) => {
        console.error(`Update ${pageIndex} at ${url} error: ${e.message}`);
    });
    req.write(batteryStatus);
    req.end();
}
// ------------------------------------------------------------------


async function mqttConnect() {
    console.log(`Attempting to connect to mqtt://${config.mqttServer}`);
    mqttClient = mqtt.connect(`mqtt://${config.mqttServer}`,{clientId:"hass-screenshot", username: config.mqttUser, password: config.mqttPassword});
    mqttClient.on("connect",function(connack){
        console.log("MQTT Connected!");
    });
    mqttClient.on("error",function(error){
        console.error("MQTT error:" + error);
    });
}

async function mqttSendState(state) {
    if (!state || !state.name || state.name.length == 0) {
        return;
    }
    if (!mqttClient || ! mqttClient.connected) {
        console.error(`MQTT error: no client to send for ${state.name}`);
        return;
    }

    const qos = 1;
    const retain = true;
    const configTopic = `homeassistant/sensor/displays/${state.name}/config`;
    const stateTopic = `homeassistant/sensor/displays/${state.name}/state`;

    var configMqtt = {
        unique_id: state.name,
        device_class: "battery",
        state_class: "measurement",
        name: state.name,
        state_topic: stateTopic,
        unit_of_measurement: "%",
        value_template: "{{ value_json.battery_level }}",
        json_attributes_topic: stateTopic,
        json_attributes_template: "{{ value_json | tojson }}",
        expire_after: 60*60, // 1hr in seconds 
    };

    if (state.mac_address) {
        configMqtt.unique_id = `${configMqtt.unique_id}_${state.mac_address}`
    }

    // send config
    var configString = JSON.stringify(configMqtt)
    console.log(`MQTT sending config: ${configString}`);
    await mqttClient.publish(configTopic, configString, { qos: qos, retain: retain }, (error) => {
        if (error) {
            console.error(`MQTT config publish error "${configTopic}": ${error}`);
        }
    })

    // send state
    var stateString = JSON.stringify(state)
    console.log(`MQTT sending state: ${stateString}`);
    await mqttClient.publish(stateTopic, stateString, { qos: qos, retain: retain }, (error) => {
        if (error) {
            console.error(`MQTT state publish error "${stateTopic}": ${error}`);
        }
    })
}

async function renderIndexAsync(response) {
    // console.log(`Rendering Index`);
    response.writeHead(200, {
        "Content-Type": "text/html",
    });

    var index = "<html><head><title>HASS Screenshots</title></head><body><h1>Screenshots</h1><ul>";
    for (let pageIndex = 0; pageIndex < config.pages.length; pageIndex++) {
        const pageConfig = config.pages[pageIndex];
        const pageNum = pageIndex+1;

        index += `<li><h3><a href="/${pageNum}.png">${pageNum} - ${pageConfig.screenShotUrl}</a></h3> [${pageCacheTimes[pageConfig.screenShotUrl]}]</li>`;
    }
    index += `</ul><h3>State</h3><pre>${JSON.stringify(stateStore, null, 2)}</pre></body></html>`;

    response.end(index);
}

async function saveState(request) {
    var state = {};

    const headerPrefix = 'x-hass-';
    for (const h in request.headers) {
        if (h.startsWith(headerPrefix)) {
            key = h.substring(headerPrefix.length);
            var value = request.headers[h];
            if (Number(value)) {
                value = Number(value);
            }
            if (typeof value === 'string' && value.toLowerCase() == 'true') {
                value = true;
            }
            if (typeof value === 'string' && value.toLowerCase() == 'false') {
                value = false;
            }
            state[key] = value;
        }
    }

    const deviceName = state["name"];
    if (!deviceName || deviceName == '') {
        return;
    }

    state['last_seen'] = new Date();
    if (stateStore[deviceName] && stateStore[deviceName]['last_seen']) {
        state['update_interval'] = Math.round((state['last_seen'] - stateStore[deviceName]['last_seen'])/1000);
    }

    // console.log(`DEBUG: new state: ${JSON.stringify(state)}`);
    stateStore[deviceName] = state;
    if (config.mqttServer) {
        mqttSendState(state);
    }
}

async function renderAndConvertAsync(browser) {
    for (let pageIndex = 0; pageIndex < config.pages.length; pageIndex++) {
        const pageConfig = config.pages[pageIndex];
        await renderAndConvertPageAsync(browser, pageConfig);
    }
}

async function renderAndConvertPageAsync(browser, pageConfig) {
    const url = `${config.baseUrl}${pageConfig.screenShotUrl}`;

    const outputPath = pageConfig.outputPath;
    await fsExtra.ensureDir(path.dirname(outputPath));

    const tempPath = outputPath + ".temp";

    console.log(`Rendering ${url} to image...`);

    try {
        await renderUrlToImageAsync(browser, pageConfig, url, tempPath);
    } catch (e) {
        console.error(`Failed to render ${url}`);
        console.error(`Error: ${e}`);
        return
    }

    console.log(`Converting rendered screenshot of ${url} to compatible image...`);
    // Modificato il nome della funzione per riflettere la versione Sibbl con più opzioni
    await convertImageToKindleCompatiblePngAsync(
        pageConfig,
        tempPath,
        outputPath
    );

    fs.unlink(tempPath);
    console.log(`Finished ${url}`);
    pageCacheTimes[pageConfig.screenShotUrl] = new Date();
}

// ------------------------------------------------------------------
// ------------------------------------------------------------------
async function renderUrlToImageAsync(browser, pageConfig, url, path) {
    let page;
    try {
        page = await browser.newPage();
        await page.emulateMediaFeatures([
            {
                name: "prefers-color-scheme",
                value: `${pageConfig.prefersColorScheme}`
            }
        ]);

        let size = {
            width: Number(pageConfig.renderingScreenSize.width),
            height: Number(pageConfig.renderingScreenSize.height)
        };
        
        // La logica di rotazione che scambia width e height è critica
        if (pageConfig.rotation % 180 > 0) {
            size = {
                width: size.height,
                height: size.width
            };
        }

        await page.setViewport(size);
        const startTime = new Date().valueOf();
        await page.goto(url, {
            // Mantenuto waitUntil di Sibbl
            waitUntil: ["domcontentloaded", "load", "networkidle0"], 
            timeout: config.renderingTimeout
        });

        const navigateTimespan = new Date().valueOf() - startTime;
        await page.waitForSelector("home-assistant", {
            timeout: Math.max(config.renderingTimeout - navigateTimespan, 1000)
        });

        // La logica di scaling di Sibbl è migliore per il layout (uso di zoom CSS)
        await page.addStyleTag({
            content: `
                body {
                    zoom: ${pageConfig.scaling * 100}%;
                    overflow: hidden;
                }`
        });

        if (pageConfig.renderingDelay > 0) {
            await page.waitForTimeout(pageConfig.renderingDelay);
        }
        await page.screenshot({
            path,
            type: "png",
            captureBeyondViewport: false,
            clip: {
                x: 0,
                y: 0,
                ...size
            }
        });
    } catch (e) {
        console.error("Failed to render", e);
    } finally {
        if (config.debug === false) {
            await page.close();
        }
    }
}
// ------------------------------------------------------------------

// ------------------------------------------------------------------
//
// ------------------------------------------------------------------
function convertImageToKindleCompatiblePngAsync(
    pageConfig,
    inputPath,
    outputPath
) {
    return new Promise((resolve, reject) => {
        // La versione Sibbl ha più opzioni (gamma, modulare, contrasto)
        let gmInstance = gm(inputPath)
            .options({
                imageMagick: config.useImageMagick === true
            })
            // AGGIUNTE DI QUALITÀ E-INK (da Sibbl)
            .gamma(pageConfig.removeGamma ? 1.0 / 2.2 : 1.0)
            .modulate(100, 100 * (pageConfig.saturation || 1.0)) // Aggiunta saturazione (se non è definita la imposto a 1.0)
            .contrast(pageConfig.contrast || true) // Aggiunto contrasto
            // FINE AGGIUNTE DI QUALITÀ E-INK
            .dither(pageConfig.dither)
            .rotate("white", pageConfig.rotation)
            .type(pageConfig.colorMode)
            .level(pageConfig.blackLevel, pageConfig.whiteLevel) // Aggiunto level (livello di bianco e nero)
            .bitdepth(pageConfig.grayscaleDepth);

        // Per formati diversi da BMP, applichiamo la qualità
        if (pageConfig.imageFormat && pageConfig.imageFormat.toLowerCase() !== 'bmp') {
             gmInstance = gmInstance.quality(100);
        }
        
        gmInstance.write(outputPath, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}
// ------------------------------------------------------------------
