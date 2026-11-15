const http = require('http');
const fs = require('fs');
const path = require('path');
const { startRotation, startNormal, stopRotation, getStatus } = require('./rotate.js');
const themeFilePath = path.join(__dirname, 'theme.json');

const PORT = 3030;
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const ROTATION_CONFIG_PATH = path.join(BASE_DIR, './config.json');
const BANLIST_PATH = path.join(BASE_DIR, '../server/global-banlist.json');
const RESULTS_DIR = path.join(BASE_DIR, '../server/results');
const PRESETS_PATH = path.join(BASE_DIR, 'presets.json');
const ENTRYLISTS_DIR = path.join(BASE_DIR, '../entrylists');

function getCfgPath() {
  let cfgPath = path.join(BASE_DIR, 'cfg');
  if (fs.existsSync(ROTATION_CONFIG_PATH)) {
    try {
      const conf = JSON.parse(fs.readFileSync(ROTATION_CONFIG_PATH, 'utf8'));
      if (conf.cfgPath) cfgPath = conf.cfgPath;
    } catch (e) {}
  }
  return cfgPath;
}

function getBopFilePath() {
  const targetDir = path.join(BASE_DIR, '../server/cfg');
  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (e) {}
  }
  return path.join(targetDir, 'bop.json');
}

function getEntrylistFilePath() {
  const targetDir = path.join(BASE_DIR, '../server/cfg');
  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (e) {}
  }
  return path.join(targetDir, 'entrylist.json');
}

function getCustomEntrylistsDir() {
  if (!fs.existsSync(ENTRYLISTS_DIR)) {
    try {
      fs.mkdirSync(ENTRYLISTS_DIR, { recursive: true });
    } catch (e) {}
  }
  return ENTRYLISTS_DIR;
}

function readJsonFileSync(filePath) {
  const buffer = fs.readFileSync(filePath);
  let encoding = 'utf8';

  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = 'utf16le';
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = 'utf16be';
  } else if (buffer.length >= 2 && buffer[1] === 0x00) {
    encoding = 'utf16le';
  } else if (buffer.length >= 2 && buffer[0] === 0x00) {
    encoding = 'utf08be';
  }

  let text = buffer.toString(encoding);

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\0/g, '');
  text = text
    .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g, (m, g1) => g1 || '')
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\r\n]*/g, (m, g1) => g1 || '');
  text = text.replace(/,\s*([}\]])/g, '$1');

  return JSON.parse(text);
}

// Synchronizes entrylist.json against global-banlist.json
function syncEntrylistWithBanlist() {
  const cfgDir = getCfgPath();
  const entryPath = path.join(cfgDir, 'entrylist.json');
  if (!fs.existsSync(entryPath)) return;

  try {
    let banlist = { enabled: true, entries: [] };
    if (fs.existsSync(BANLIST_PATH)) {
      banlist = JSON.parse(fs.readFileSync(BANLIST_PATH, 'utf8'));
    }

    const bannedEntries = (banlist.enabled && Array.isArray(banlist.entries)) ? banlist.entries : [];
    const banMap = new Map();
    bannedEntries.forEach(b => banMap.set(String(b.playerId), b.playerName));

    let entrylist = readJsonFileSync(entryPath);
    if (!Array.isArray(entrylist.entries)) {
      entrylist.entries = [];
    }

    // Filter out banned drivers that are no longer present in global-banlist
    entrylist.entries = entrylist.entries.filter(entry => {
      if (!Array.isArray(entry.drivers)) return true;
      if (entry.forcedCarModel === 9999) {
        return entry.drivers.some(driver => banMap.has(String(driver.playerID)));
      }
      return true;
    });

    const existingPlayerIds = new Set();
    entrylist.entries.forEach(entry => {
      if (Array.isArray(entry.drivers)) {
        entry.drivers.forEach(d => {
          if (d.playerID) existingPlayerIds.add(String(d.playerID));
        });
      }
    });

    // Append newly added banned drivers
    bannedEntries.forEach(player => {
      const pidStr = String(player.playerId);
      if (!existingPlayerIds.has(pidStr)) {
        entrylist.entries.push({
          drivers: [
            {
              firstName: player.playerName,
              playerID: pidStr
            }
          ],
          forcedCarModel: 9999,
          overrideDriverInfo: 0,
          overrideCarModelForCustomCar: 0
        });
        existingPlayerIds.add(pidStr);
      }
    });

    fs.writeFileSync(entryPath, JSON.stringify(entrylist, null, 2), 'utf16le');
    console.log('[Banlist Sync] Successfully reconciled entrylist.json with global-banlist.json.');
  } catch (err) {
    console.error('Error synchronizing banlist with entrylist:', err);
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;
  
  // 1. Handle reading theme.json
  if (req.url === '/api/theme' && req.method === 'GET') {
      fs.readFile(themeFilePath, 'utf8', (err, data) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (err) {
              res.end(JSON.stringify({ theme: 'styles.css' }));
          } else {
              res.end(data);
          }
      });
      return;
  }

  // 2. Handle writing to theme.json
  if (req.url === '/api/theme' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
          body += chunk;
      });
      req.on('end', () => {
          try {
              const parsed = JSON.parse(body);
              const themeToSave = parsed.theme;

              fs.writeFile(themeFilePath, JSON.stringify({ theme: themeToSave }, null, 2), (err) => {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  if (err) {
                      res.end(JSON.stringify({ success: false, error: 'Failed to write file' }));
                  } else {
                      res.end(JSON.stringify({ success: true, theme: themeToSave }));
                  }
              });
          } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Invalid JSON request' }));
          }
      });
      return;
  }
  
  // Serve external stylesheet
  if (req.method === 'GET' && pathname === '/styles.css') {
    const cssPath = path.join(BASE_DIR, 'styles.css');
    if (fs.existsSync(cssPath)) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(fs.readFileSync(cssPath, 'utf8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('styles.css not found');
    }
    return;
  }
  
  // Serve external stylesheet
  if (req.method === 'GET' && pathname === '/cyber.css') {
    const cssPath = path.join(BASE_DIR, 'cyber.css');
    if (fs.existsSync(cssPath)) {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
      res.end(fs.readFileSync(cssPath, 'utf8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('cyber.css not found');
    }
    return;
  }
  
  // Serve favicon
  if (req.method === 'GET' && pathname === '/icon.ico') {
    const faviconPath = path.join(BASE_DIR, 'icon.ico');
    if (fs.existsSync(faviconPath)) {
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      res.end(fs.readFileSync(faviconPath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('icon.ico not found');
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>ACC Race Host</title>
      <link rel="icon" type="image/x-icon" href="/icon.ico">
      <script src="/vue.js"></script>
      <link id="theme" rel="stylesheet" type="text/css" href="styles.css" />
    </head>
    <body>
      <div id="app">
      	
      <div class="header-bar">
		   	<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 150" preserveAspectRatio="xMidYMid meet">
				  <defs>
				    <linearGradient id="cyber" x1="0%" y1="0%" x2="100%" y2="100%">
				      <stop offset="0%" stop-color="#00c5cc"/>
				      <stop offset="32%" stop-color="#00b8ff"/>
				      <stop offset="65%" stop-color="#8b5cff"/>
				      <stop offset="100%" stop-color="#ff27d9"/>
				    </linearGradient>
				    <linearGradient id="metal" x1="0%" y1="0%" x2="100%" y2="0%">
				      <stop offset="0%" stop-color="#ffffff"/>
				      <stop offset="45%" stop-color="#c8ced8"/>
				      <stop offset="70%" stop-color="#ffffff"/>
				      <stop offset="100%" stop-color="#8d96a4"/>
				    </linearGradient>
				    <radialGradient id="background" cx="48%" cy="48%" r="75%">
				      <stop offset="0%" stop-color="#08070f"/>
				      <stop offset="55%" stop-color="#08070f"/>
				      <stop offset="100%" stop-color="#08070f"/>
				    </radialGradient>
				    <filter id="glow" x="-100%" y="-100%" width="300%" height="300%">
				      <feGaussianBlur stdDeviation="3" result="blur"/>
				      <feMerge>
				        <feMergeNode in="blur"/>
				        <feMergeNode in="SourceGraphic"/>
				      </feMerge>
				    </filter>
				    <filter id="smallGlow" x="-100%" y="-100%" width="300%" height="300%">
				      <feGaussianBlur stdDeviation="1" result="blur"/>
				      <feMerge>
				        <feMergeNode in="blur"/>
				        <feMergeNode in="SourceGraphic"/>
				      </feMerge>
				    </filter>
				    <clipPath id="roundedClip">
				      <rect x="0" y="0" width="600" height="150" rx="12" ry="12"/>
				    </clipPath>
				  </defs>
				  <g clip-path="url(#roundedClip)">
				    <rect x="0" y="0" width="600" height="150" fill="url(#background)"/>
				    <path d="M0 117.5 L205 0 L360 0 L127.5 150 L0 150 Z" fill="#0f131b"/>
				    <path d="M350 150 L590 17.5 L600 17.5 L600 85 L482.5 150 Z" fill="#10141d"/>
				    <g opacity="0.12">
				      <path d="M0 130 L225 0" stroke="#ffffff" stroke-width="0.5"/>
				      <path d="M30 150 L260 17.5" stroke="#ffffff" stroke-width="0.5"/>
				      <path d="M380 150 L600 25" stroke="#ffffff" stroke-width="0.5"/>
				      <path d="M410 150 L600 40" stroke="#ffffff" stroke-width="0.5"/>
				    </g>
				    <g transform="translate(24 21.5) scale(0.5)">
				      <path d="M104 0 L200 55 L200 157 L104 214 L8 157 L8 55 Z" fill="#090b10" stroke="#252d39" stroke-width="5"/>
				      <path d="M104 7 L193 58 L193 104" fill="none" stroke="#00c5cc" stroke-width="6" stroke-linecap="round" filter="url(#glow)"/>
				      <path d="M193 125 L193 153 L104 207" fill="none" stroke="#ff27d9" stroke-width="5" stroke-linecap="round" filter="url(#glow)"/>
				      <path d="M15 153 L15 58 L67 28" fill="none" stroke="#7b5cff" stroke-width="5" stroke-linecap="round"/>
				      <path d="M42 164 L88 47 L120 47 L168 164 L136 164 L126 133 L81 133 L71 164 Z" fill="url(#metal)"/>
				      <path d="M90 108 L116 108 L103 73 Z" fill="#090b10"/>
				      <path d="M126 47 L160 47 L128 164 L95 164 Z" fill="url(#cyber)" filter="url(#smallGlow)"/>
				      <path d="M35 181 L76 161" stroke="#00c5cc" stroke-width="4" stroke-linecap="round"/>
				      <path d="M29 194 L64 177" stroke="#ff27d9" stroke-width="3" stroke-linecap="round"/>
				    </g>
				    <g transform="translate(142.5 21.5) scale(0.5)">
				      <text x="0" y="76" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="78" font-weight="900" letter-spacing="5" fill="url(#metal)">ACC</text>
				      <text x="198" y="76" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="78" font-weight="900" letter-spacing="3" fill="url(#cyber)" filter="url(#smallGlow)">RACE</text>
				      <text x="3" y="151" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="72" font-weight="900" letter-spacing="11" fill="#ffffff">HOST</text>
				      <path d="M5 169 L580 169" stroke="#242b35" stroke-width="8"/>
				      <path d="M5 169 L365 169" stroke="url(#cyber)" stroke-width="5" stroke-linecap="round" filter="url(#smallGlow)"/>
				      <text x="7" y="205" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="700" letter-spacing="8" fill="#8e97a5">HOST ➜ RACE ➜ REPEAT</text>
				    </g>
				    <g transform="translate(485 83) scale(0.5)">
				      <path d="M0 0 L215 0 L198 59 L0 59 Z" fill="#0b0e14" stroke="#303846" stroke-width="2"/>
				      <path d="M0 0 L215 0" stroke="url(#cyber)" stroke-width="4" filter="url(#smallGlow)"/>
				      <text x="46" y="39" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="25" font-weight="900" letter-spacing="3" fill="#ffffff">v1.04</text>
				      <circle cx="180" cy="30" r="5" fill="#00c5cc" filter="url(#glow)"/>
				    </g>
				    <g font-family="Arial, Helvetica, sans-serif" font-size="5.7" font-weight="800" letter-spacing="1.5" fill="#505866">
				      <text x="485" y="135">RACE CONTROL SYSTEM</text>
				      <text x="485" y="142">SESSION MANAGEMENT</text>
				    </g>
				    <g opacity="0.85">
				      <path d="M410 29 L465 6" stroke="#00c5cc" stroke-width="2" stroke-linecap="round"/>
				      <path d="M425 36.5 L480 13.5" stroke="#7b5cff" stroke-width="1.5" stroke-linecap="round"/>
				      <path d="M440 44 L495 21" stroke="#ff27d9" stroke-width="1" stroke-linecap="round"/>
				    </g>
				    <circle cx="562.5" cy="122.5" r="1.5" fill="#00c5cc" filter="url(#smallGlow)"/>
				    <circle cx="570" cy="122.5" r="1.5" fill="#7b5cff" filter="url(#smallGlow)"/>
				    <circle cx="577.5" cy="122.5" r="1.5" fill="#ff27d9" filter="url(#smallGlow)"/>
				  </g>
				  <rect x="1" y="1" width="598" height="148" rx="11" ry="11" fill="none" stroke="#333" stroke-width="1"/>
				</svg>
				</div>
				
				<div style="margin:8px 0px 8px 0px; padding:0px 6px 0px 6px;">
				<div style="display:inline-block; width:50%; text-align:left;">
				<span class="swtichtheme" @click="toggleTheme">Switch Theme</span>
				</div>
				<div style="display:inline-block; width:50%; text-align:right;">
					<button class="btn-small btn-shutdown" @click="shutdownApp">✘ Exit Race Host</button>
				</div>
		   </div>
	
        <div v-if="config">
        	<div class="script-controls">
            <div class="controls-left">
              <div class="control-title">Server Control</div>
              <div class="button-group">
                <button class="btn-small btn-success" v-if="!serverStatus.running" @click="saveData(); startMode('rotation')">▶ Start Track Rotation</button>
                <!-- <button class="btn-small btn-blue" v-if="!serverStatus.running" :disabled="startButtonDisabled" 
                	@click="saveData(); startButtonDisabled = true; startMode('normal', 0); setTimeout(() => startButtonDisabled = false, 3000)">▶ Start Single (Track 1)</button> -->
                	
                	<button class="btn-small btn-blue" v-if="!serverStatus.running" :disabled="startButtonDisabled"  @click="startSingleTrack(0)">▶ Start Single (Track 1)</button>
    
                <button class="btn-small btn-danger" v-if="serverStatus.running" @click="stopServer" style="background: rgba(255,82,82,0.1);">■ Stop Server</button>
              </div>
            </div>
            
            <div class="controls-right">
              <div class="status-badge" :class="serverStatus.running ? 'status-running' : 'status-stopped'">
                SERVER STATUS : {{ serverStatus.running ? ('RUNNING (' + serverStatus.mode.toUpperCase() + ')') : 'STOPPED' }}
              </div>
            </div>
          </div>

          <div class="card">
            <h4 class="red-header" @click="config._showGlobal = !config._showGlobal">Server Setup<span style="color:#e53935;">{{ config._showGlobal ? '▼' : '▶' }}</span></h4>
            <div v-show="config._showGlobal" class="session-card-out">
              <div class="session-card">
              	<span class="subhead">Server Name</span>
                <div class="grid-global">
                  <div class="form-group" style="grid-column: 1 / -1;">
                    <input v-model="config.serverName" type="text" placeholder="Server Name">
                  </div>
                </div>
              </div>

              <div class="session-card">
              	<span class="subhead">Network Settings</span>
                <div class="grid-global">
                  <div class="form-group"><label>Tcp Port</label><input v-model.number="config.tcpPort" type="number"></div>
                  <div class="form-group"><label>Udp Port</label><input v-model.number="config.udpPort" type="number"></div>
                  <div class="form-group"><label>Max Car Slots</label><input v-model.number="config.maxCarSlots" type="number"></div>
                  <div class="form-group"><label>Max Connections</label><input v-model.number="config.maxConnections" type="number"></div>
                </div>
                <hr class="greyhr">
                <div class="grid-global">
                	<div class="checkbox-container">
									  <input type="checkbox" id="enableUPnP" v-model="config.enableUPnP" :true-value="1" :false-value="0"/>
									  <label>Enable UPnP</label>
									</div>
                  <div class="checkbox-container">
                    <input type="checkbox" id="registerToLobby" v-model="config.registerToLobby" :true-value="1" :false-value="0">
                    <label for="registerToLobby">Register To Lobby</label>
                  </div>
                  <div class="checkbox-container">
                    <input type="checkbox" id="lanDiscovery" v-model="config.lanDiscovery" :true-value="1" :false-value="0">
                    <label for="lanDiscovery">LAN Discovery</label>
                  </div>
                  <div class="checkbox-container">
                    <input type="checkbox" id="ignorePrematureDisconnects" v-model="config.ignorePrematureDisconnects" :true-value="1" :false-value="0">
                    <label for="ignorePrematureDisconnects">Ignore Disconnects</label>
                  </div>
                </div>
              </div>

              <div class="session-card">
              	<span class="subhead">Server Passwords</span>
                <div class="grid-global">
                  <div class="form-group"><label>Admin Password</label><input v-model="config.adminPassword" type="text" placeholder="Admin Password"></div>
                  <div class="form-group"><label>Spectator Password</label><input v-model="config.spectatorPassword" type="text" placeholder="Spectator Password"></div>
                  <div class="form-group"><label>Server Password</label><input v-model="config.password" type="text" placeholder="Server Password"></div>
                </div>
              </div>

              <div class="session-card">
              	<span class="subhead">Driver Requirements</span>
                <div class="grid-global">
                  <div class="form-group"><label>Safety Rating</label><input v-model.number="config.safetyRatingRequirement" type="number" min="-1" max="99"></div>
                  <div class="form-group">
                    <label>Track Medals</label>
                    <select v-model.number="config.trackMedalsRequirement" style="border-color: #555;">
                      <option :value="0">Disabled</option>
                      <option :value="0">0</option>
                      <option :value="1">1</option>
                      <option :value="2">2</option>
                      <option :value="3">3</option>
                    </select>
                  </div>
                  <div class="form-group"><label>Race Craft Req.</label><input v-model.number="config.racecraftRatingRequirement" type="number" min="-1" max="99"></div>
                </div>
              </div>

              <div class="session-card">
              	<span class="subhead">Session Rules & Behavior</span>
                <div class="grid-global">
                  <div class="form-group">
                    <label>Formation Type</label>
                    <select v-model.number="config.formationLapType" style="border-color: #555;">
                      <option :value="3">Position</option>
                      <option :value="1">Free</option>
                      <option :value="0">Manual</option>
                    </select>
                  </div>
                </div>
                <hr class="greyhr">
                <div class="grid-global">
                  <div class="checkbox-container">
                    <input type="checkbox" id="isRaceLocked" v-model="config.isRaceLocked" :true-value="1" :false-value="0">
                    <label for="isRaceLocked">Race Locked</label>
                  </div>
                  <div class="checkbox-container">
                    <input type="checkbox" id="allowAutoDQ" v-model="config.allowAutoDQ" :true-value="1" :false-value="0">
                    <label for="allowAutoDQ">Auto DSQ</label>
                  </div>
                  <div class="checkbox-container">
                    <input type="checkbox" id="shortFormationLap" v-model="config.shortFormationLap" :true-value="1" :false-value="0">
                    <label for="shortFormationLap">Short Formation</label>
                  </div>
                  <div class="checkbox-container">
                    <input type="checkbox" id="randomizeTrackWhenEmpty" v-model="config.randomizeTrackWhenEmpty" :true-value="1" :false-value="0">
                    <label for="randomizeTrackWhenEmpty">Randomise Empty</label>
                  </div>
                  <div class="checkbox-container" style="margin-top: 12px; margin-bottom: 5px;">
                    <input type="checkbox" id="forceEntryListConfig" v-model="config.forceEntryList" :true-value="1" :false-value="0">
                    <label for="forceEntryListConfig">Force Entry List</label>
                  </div>
                </div>
              </div>

              <div class="session-card">
              	<span class="subhead">Data Logging & Outputs</span>
                <div class="grid-global">
                  <div class="checkbox-container">
                    <input type="checkbox" id="dumpLeaderboards" v-model="config.dumpLeaderboards" :true-value="1" :false-value="0">
                    <label for="dumpLeaderboards">Dump Leaderboards</label>
                  </div>
                  <div class="checkbox-container">
                    <input type="checkbox" id="dumpEntryList" v-model="config.dumpEntryList" :true-value="1" :false-value="0">
                    <label for="dumpEntryList">Dump Entry List</label>
                  </div>
                </div>
              </div>
              
              <br>
              <div style="width:100%; text-align:right;"><button @click="saveData()">Save Settings</button></div>
            </div>

          <!-- BOP MANAGEMENT -->
            <h4 class="red-header" @click="config._showBop = !config._showBop">BOP Manager<span style="color:#e53935;">{{ config._showBop ? '▼' : '▶' }}</span></h4>
            <div v-show="config._showBop" class="session-card-out">
            	<div style="width:100%;"><span style="font-size:11px; font-weight:normal; color:#ffff00">Imported json Files Must be UTF-8 ("Save As" with notepad & Select UTF-8 Encoding)</span></div>
            	
            	<div style="display:inline-block; width:50%;">
                <span v-if="bopStatus.exists" style="color: #4caf50; font-size: 13px; font-weight: bold;">
                  ✓ bop.json active - ({{ bopStatus.entriesCount }} entries)
                </span>
                <span v-else style="color: #aaa; font-size: 11px; font-style: italic;">
                  No bop.json currently found in server/cfg folder.
                </span>
              </div>
            	<div style="display:inline-block; width: 50%; text-align:right;">
                <button class="btn-small btn-blue" style="margin-right: 5px;" @click="showBopEditor = !showBopEditor">
                  {{ showBopEditor ? 'Hide BOP Editor' : '✏️ Editor' }}
                </button>
                <input type="file" ref="bopFileInput" accept=".json" @change="handleBopFileUpload" style="display: none;">
                <button class="btn-small btn-blue" @click="$refs.bopFileInput.click()">📁 Import</button>
              </div>
                
              <div v-if="showBopEditor" class="session-card">
                <div class="flex-between">
                  <strong style="color: #fff;">Visual BOP Editor</strong>
                  <div>
                    <button class="btn-small btn-success" @click="addBopEntry">+ Add BOP Custom Entry</button>
                    <button class="btn-small btn-blue" style="margin-left: 5px;" @click="saveBopData">Save bop.json</button>
                  </div>
                </div>

                <table class="editor-table" v-if="bopData.entries && bopData.entries.length > 0">
                  <thead>
                    <tr>
                      <th>Track</th>
                      <th>Car Model</th>
                      <th>Ballast (kg)</th>
                      <th>Restrictor (%)</th>
                      <th style="text-align: right;">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(entry, bIdx) in bopData.entries" :key="bIdx">
                      <td>
                        <select v-model="entry.track">
                          <option value="*">All Tracks (*)</option>
                          <option v-for="(humanName, gameId) in availableTracks" :key="gameId" :value="gameId">{{ humanName }}</option>
                        </select>
                      </td>
                      <td>
                        <select v-model.number="entry.carModel">
                          <option v-for="(cName, cId) in carModelsMap" :key="cId" :value="Number(cId)">{{ cName }} (ID: {{ cId }})</option>
                        </select>
                      </td>
                      <td><input v-model.number="entry.ballastKg" type="number" min="-50" max="100"></td>
                      <td><input v-model.number="entry.restrictor" type="number" min="0" max="20"></td>
                      <td style="text-align: right;">
                        <button class="btn-small btn-danger" @click="bopData.entries.splice(bIdx, 1)">Delete</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div v-else style="color: #aaa; font-style: italic; padding: 10px 0;">No entries in bop.json. Click "+ Add BOP Custom Entry" to begin.</div>
               <div style="width:100%; text-align:right; margin-top:20px;"><button class="btn-small btn-blue" style="margin-left: 5px;" @click="saveBopData">Save bop.json</button></div>
              </div>
              <br>
            </div>

          <!-- ENTRY LIST MANAGER -->
            <h4 class="red-header" @click="config._showEntrylist = !config._showEntrylist">Entry List Manager<span style="color:#e53935;">{{ config._showEntrylist ? '▼' : '▶' }}</span></h4>
            <div v-show="config._showEntrylist" class="session-card-out">
            	
            	<div style="width:100%;"><span style="font-size:11px; font-weight:normal; color:#ffff00">Imported json Files Must be UTF-8 ("Save As" with notepad & Select UTF-8 Encoding)</span></div>
            	
              <!-- Custom Entrylists Selector Dropdown -->
              <div style="display: flex; gap: 10px; align-items: center; margin: 12px 0; background: rgba(255,255,255,0.03); padding: 10px; border-radius: 4px;">
                <div class="form-group" style="flex: 1; margin-bottom: 0;">
                  <label style="font-size: 11px; color: #aaa;">Select Custom Entrylist from entrylists folder</label>
                  <select v-model="selectedCustomEntrylist" style="border-color: #555;">
                    <option disabled value="">-- Choose custom entrylist file --</option>
                    <option v-for="item in customEntrylists" :key="item.name" :value="item.name">{{ item.name }}</option>
                  </select>
                </div>
                <button class="btn-small btn-success" style="height: 32px; margin-top: 15px;" @click="applySelectedCustomEntrylist" :disabled="!selectedCustomEntrylist">Apply Selected</button>
                <button class="btn-small btn-blue" style="height: 32px; margin-top: 15px;" @click="fetchCustomEntrylists">Refresh</button>
              </div>

            	<div style="display:inline-block; width:50%;">
                <span v-if="entrylistStatus.exists" style="color: #4caf50; font-size: 13px; font-weight: bold;">
                  ✓ entrylist.json active - ({{ entrylistStatus.entriesCount }} entries)
                </span>
                <span v-else style="color: #aaa; font-size: 11px; font-style: italic;">
                  No entrylist.json currently found in server/cfg folder.
                </span>
              </div>
              <div style="display:inline-block; width:50%; text-align:right;">
                <button class="btn-small btn-blue" style="margin-right: 5px;" @click="showEntrylistEditor = !showEntrylistEditor">
                  {{ showEntrylistEditor ? 'Hide Entry Editor' : '✏️ Editor' }}
                </button>
                <input type="file" ref="entrylistFileInput" accept=".json" @change="handleEntrylistFileUpload" style="display: none;">
                <button class="btn-small btn-blue" @click="$refs.entrylistFileInput.click()">📁 Import & Save As...</button>
              </div>

              <!-- Upload Custom File Name Prompt Modal -->
              <div v-if="showUploadNameModal" style="background: rgba(0,0,0,0.85); border: 1px solid #00c5cc; padding: 15px; border-radius: 6px; margin: 12px 0;">
                <strong style="color: #fff; font-size: 13px;">Save Custom Entry List File</strong>
                <p style="color: #aaa; font-size: 11px; margin: 5px 0 10px 0;">Enter a file name to store this entry list in the <code>../entrylists</code> folder:</p>
                <div style="display: flex; gap: 10px; align-items: center;">
                  <input type="text" v-model="uploadCustomFilename" placeholder="e.g. league_round1.json" style="flex: 1; padding: 6px;" />
                  <button class="btn-small btn-success" @click="confirmSaveCustomEntrylist">Save & Apply</button>
                  <button class="btn-small btn-danger" @click="showUploadNameModal = false; pendingUploadParsedData = null;">Cancel</button>
                </div>
              </div>

              <!-- VISUAL ENTRYLIST EDITOR PANEL -->
              <div v-if="showEntrylistEditor" class="session-card">
                <div class="flex-between">
                  <strong style="color: #fff;">Visual Entry List Editor <span v-if="selectedCustomEntrylist" style="font-size: 11px; color: #00c5cc;">(Editing: {{ selectedCustomEntrylist }})</span></strong>
                  <div>
                    <button class="btn-small btn-success" @click="addEntrylistRow">+ Add Car Slot</button>
                    <button class="btn-small btn-blue" style="margin-left: 5px;" @click="saveEntrylistData">Save entrylist.json</button>
                  </div>
                </div>

                <div v-if="entrylistData.entries && entrylistData.entries.length > 0">
                  <hr>
                  <div v-for="(entry, eIdx) in entrylistData.entries" :key="eIdx">
                    <div class="grid-global" style="margin-bottom:10px;">
                      <div class="checkbox-container" style="margin-top:1px;">
                        <input type="checkbox" v-model="entry.isServerAdmin" :true-value="1" :false-value="0">
                        <label>Server Admin</label>
                      </div>
                      <div class="checkbox-container" style="margin-top:0px;">
                        <input type="checkbox" v-model="entry.overrideDriverInfo" :true-value="1" :false-value="0">
                        <label>Override Driver</label>
                      </div>
                      <div class="checkbox-container" style="margin-top:1px;">
                        <input type="checkbox" v-model="entry.overrideCarModelForCustomCar" :true-value="1" :false-value="0">
                        <label>Override Car Model (JSON)</label>
                      </div>
                    </div>
                    <hr class="greyhr">
                    <div class="grid-global" style="margin-bottom:10px;">
                      <div class="form-group-entrylist">
                        <label>First Name</label>
                        <input v-if="entry.drivers && entry.drivers[0]" v-model="entry.drivers[0].firstName" type="text" placeholder="First Name">
                      </div>
                      <div class="form-group-entrylist">
                        <label>Last Name</label>
                        <input v-if="entry.drivers && entry.drivers[0]" v-model="entry.drivers[0].lastName" type="text" placeholder="Last Name">
                        <span v-else style="color:#777;">Open Slot</span>
                      </div>
                      <div class="form-group-entrylist">
                        <label>Short Name</label>
                        <input v-if="entry.drivers && entry.drivers[0]" v-model="entry.drivers[0].shortName" type="text" placeholder="Short Name">
                        <span v-else style="color:#777;">-</span>
                      </div>
                    </div>
                    <hr class="greyhr">
                    <div class="grid-global" style="margin-bottom:10px;">
                      <div class="form-group-entrylist">
                        <label>Race Number</label>
                        <input v-model.number="entry.raceNumber" type="number" placeholder="">
                      </div>
                      <div class="form-group-entrylist"><label>Driver Category</label>
                        <select v-if="entry.drivers && entry.drivers[0]" v-model.number="entry.drivers[0].driverCategory">
                          <option :value="0">0 Bronze/Overall</option>
                          <option :value="1">1 Silver/ProAm</option>
                          <option :value="2">2 Gold/Am</option>
                          <option :value="3">3 Platinum/Silver</option>
                          <option :value="4">4 National</option>
                        </select>
                      </div>
                      <div class="form-group-entrylist">
                        <label>Steam ID</label>
                        <input v-if="entry.drivers && entry.drivers[0]" v-model="entry.drivers[0].playerID" type="text" placeholder="Steam ID">
                        <span v-else style="color:#777;">-</span>
                      </div>
                    </div>
                    <hr class="greyhr">
                    <div class="grid-global" style="margin-bottom:10px;">
                      <div class="form-group-entrylist"><label>Force Car Model</label><select v-model.number="entry.forcedCarModel">
                          <option :value="-1">Free Choice (-1)</option>
                          <option :value="9999">Banned Driver Slot (9999)</option>
                          <option v-for="(cName, cId) in carModelsMap" :key="cId" :value="Number(cId)">{{ cName }}</option>
                        </select>
                      </div>
                      <div class="form-group-entrylist"><label>Ballast</label><input v-model.number="entry.ballastKg" type="number" placeholder="0"></div>
                      <div class="form-group-entrylist"><label>Restrictor</label><input v-model.number="entry.restrictor" type="number" placeholder="0"></div>
                    </div>
                    <hr class="greyhr">
                    <div style="width: 100%;">
                      <div style="display:inline-block; width:50%; text-align:left;">
                        <label>Custom Car Model (Json)</label><br>
                        <input style="width:200px; margin-top:4px;" v-model="entry.customCar" type="text" placeholder="">
                      </div>
                      <div style="display:inline-block; width:50%; text-align:right;">
                        <button style="padding:12px 25px 12px 25px;" class="btn-small btn-danger" @click="entrylistData.entries.splice(eIdx, 1)">Delete Entry</button>
                      </div>
                    </div>
                    <hr>
                  </div>
                </div>
                <div v-else style="color: #aaa; font-style: italic; padding: 10px 0;">No entries in entrylist.json.</div>
                
                <div style="width:100%; text-align:right; margin-top:20px; margin-bottom:12px;">
                  <button class="btn-small btn-blue" style="margin-left: 5px;" @click="saveEntrylistData">Save entrylist.json</button>
                </div>
              </div>
            </div>

          <!-- GLOBAL BANLIST CARD -->
            <h4 class="red-header" @click="config._showBanlist = !config._showBanlist">
              Player Ban list<span style="color:#e53935;">{{ config._showBanlist ? '▼' : '▶' }}</span>
            </h4>
            <div v-show="config._showBanlist" class="session-card">
              <div class="checkbox-container" style="margin-top: 5px; margin-bottom: 12px;">
                <input type="checkbox" id="banlistEnabled" v-model="banlist.enabled" @change="saveBanlist()">
                <label for="banlistEnabled">Enable Player Banlist</label>
              </div>

              <div style="display: flex; gap: 10px; margin-bottom: 15px; align-items: flex-end;">
                <div class="form-group" style="flex: 1;">
                  <label>Player Name</label>
                  <input v-model="newPlayerName" type="text" placeholder="e.g. Driver Name">
                </div>
                <div class="form-group" style="flex: 1;">
                  <label>Steam ID (Player ID)</label>
                  <input v-model="newPlayerId" type="text" placeholder="e.g. S76561198000000000">
                </div>
                <button class="btn-success" style="height: 32px; padding: 0 15px;" @click="addBanEntry">+ Add Driver</button>
              </div>

              <div v-if="banlist.entries && banlist.entries.length > 0">
                <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
                  <thead>
                    <tr style="border-bottom: 1px solid #444; text-align: left; color: #aaa; font-size: 11px; text-transform: uppercase;">
                      <th style="padding: 6px;">Player Name</th>
                      <th style="padding: 6px;">Steam ID</th>
                      <th style="padding: 6px; text-align: right;">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(entry, bIndex) in banlist.entries" :key="bIndex" style="border-bottom: 1px solid #2a2a2a;">
                      <td style="padding: 8px 6px; color: #fff;">{{ entry.playerName }}</td>
                      <td style="padding: 8px 6px; color: #aaa; font-family: monospace;">{{ entry.playerId }}</td>
                      <td style="padding: 8px 6px; text-align: right;">
                        <button class="btn-small btn-danger" @click="removeBanEntry(bIndex)">Remove</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <br>
              </div>
              
              <div v-else style="color: #777; font-style: italic; padding: 10px 0;">
                No banned Players currently in banlist.
                <hr class="greyhr">
              </div>
              
              <span class="subhead">Browse Session Driver Results</span>
              <div>
                <div style="display: flex; gap: 10px; align-items: center; margin-top: 8px; margin-bottom: 12px;" v-if="resultsFiles.length > 0">
                  <div class="form-group" style="flex: 1;">
                    <label>Latest 5 Result Files</label>
                    <select v-model="selectedFile" @change="fetchSessionResults" style="border-color: #555;">
                      <option v-for="file in resultsFiles" :key="file.name" :value="file.name">
                        {{ file.name }}
                      </option>
                    </select>
                  </div>
                  <button class="btn-small btn-blue" style="height: 32px; margin-top: 15px;" @click="fetchResultsFiles">Refresh List</button>
                </div>

                <div v-if="latestResults && latestResults.filename">
                  <div style="width:100%; display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
                    <div style="font-size: 11px; color: #aaa; word-break: break-all;">
                      <strong>File:</strong> {{ latestResults.filename }}<br>
                      <strong>Track / Session:</strong> {{ latestResults.trackName || 'Unknown Track' }} ({{ latestResults.sessionType || 'Session' }})
                    </div>
                  </div>

                  <div v-if="latestResults.drivers && latestResults.drivers.length > 0">
                    <table style="width: 100%; border-collapse: collapse; margin-top: 5px;">
                      <thead>
                        <tr style="border-bottom: 1px solid #444; text-align: left; color: #aaa; font-size: 11px; text-transform: uppercase;">
                          <th style="padding: 6px;">Driver Name</th>
                          <th style="padding: 6px;">Steam ID</th>
                          <th style="padding: 6px; text-align: right;">Quick Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(drv, dIndex) in paginatedDrivers" :key="dIndex" style="border-bottom: 1px solid #2a2a2a;">
                          <td style="padding: 8px 6px; color: #fff;">{{ drv.name }}</td>
                          <td style="padding: 8px 6px; color: #aaa; font-family: monospace;">{{ drv.playerId }}</td>
                          <td style="padding: 8px 6px; text-align: right;">
                            <button class="btn-small btn-danger" @click="quickBanDriver(drv)">+ Add to Banlist</button>
                          </td>
                        </tr>
                      </tbody>
                    </table>

                    <div class="pagination-container" v-if="latestResults.drivers.length > itemsPerPage">
                      <div class="pagination-controls">
                        <button class="btn-small" :disabled="currentPage === 1" @click="currentPage--">◀ Prev</button>
                        <span style="font-size: 11px; color: #fff; padding: 0 4px;">Page {{ currentPage }} of {{ totalPages }}</span>
                        <button class="btn-small" :disabled="currentPage >= totalPages" @click="currentPage++">Next ▶</button>
                      </div>
                    </div>
                  </div>
                  <div v-else style="color: #777; font-style: italic; padding: 10px 0;">
                    No driver records found, Refresh at end of session.
                  </div>
                </div>
                <div v-else-if="latestResults && latestResults.message" style="color: #777; font-style: italic; padding: 10px 0;">
                  {{ latestResults.message }}
                </div>
                <div v-else style="color: #777; font-style: italic; padding: 10px 0;">
                  Loading session results...
                </div>
              </div>
            </div>

          <!-- BACKUP & RESTORE -->
            <h4 class="red-header" @click="showBackupOptions = !showBackupOptions">
              Backup & Restore <span style="color:#e53935;">{{ showBackupOptions ? '▼' : '▶' }}</span>
            </h4>
            <div v-show="showBackupOptions" class="session-card">
              <div style="display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 5px 0;">
                <div>
                  <strong style="color: #fff;">Full Configuration Backup</strong><br>
                  <span style="color: #aaa; font-size: 11px;">Export or restore server configs, BOP lists, entrylists, and global banlists in a single JSON bundle.</span>
                </div>
                <div style="display: flex; gap: 8px;">
                  <button class="btn-small btn-blue" @click="exportBackup">⬇ Export Backup (.json)</button>
                  <input type="file" ref="backupFileInput" accept=".json" @change="importBackup" style="display: none;">
                  <button class="btn-small" @click="$refs.backupFileInput.click()">📁 Restore Backup</button>
                </div>
              </div>
            </div> 
          </div>

          <div class="card">
            <div class="flex-between" style="margin-top: 3px; margin-bottom: 1px;">
              <h2 style="margin: 0; font-size: 16px; color: #fff;">Live Track Rotation &nbsp; <span class="rotationMsg">Save Track Rotation After any Changes!</span></h2> 
              <button @click="saveData()">Save Rotation</button>
            </div>
          </div>

          <div v-for="(track, tIndex) in config.rotation" :key="tIndex" class="card">
            <div class="track-header">
              <div style="display: flex; gap: 10px; align-items: center;">
                <h3 style="color: #e53935; font-size: 16px;">{{ tIndex + 1 }}.</h3>
                <select v-model="track.track" style="width: 220px; border-color: #555;">
                  <option v-for="(humanName, gameId) in availableTracks" :key="gameId" :value="gameId">
                    {{ humanName }}
                  </option>
                </select>
                <div class="form-group">
                  <select v-model="track.carGroup" style="border-color: #555; width:133px;">
                    <option value="FreeForAll">Mixed</option>
                    <option value="GT3">GT3</option>
                    <option value="GT2">GT2</option>
                    <option value="GT4">GT4</option>
                    <option value="GTC">GTC</option>
                    <option value="TCX">TCX</option>
                  </select>
                </div>
              </div>

              <div class="actions-group">
                <button class="btn-small btn-blue" @click="moveUp(tIndex)" v-if="tIndex > 0">↑ Up</button>
                <button class="btn-small btn-blue" @click="moveDown(tIndex)" v-if="tIndex < config.rotation.length - 1">↓ Down</button>
                <!-- <button class="btn-small btn-blue" v-if="!serverStatus.running" :disabled="startButtonDisabled" 
                	@click="saveData(); startButtonDisabled = true; startMode('normal', tIndex); setTimeout(() => startButtonDisabled = false, 3000)">Run Single Track</button> -->
                	
                	<button class="btn-small btn-blue" v-if="!serverStatus.running" :disabled="startButtonDisabled" @click="startSingleTrack(tIndex)">Run Single Track</button>
                <button class="btn-small btn-danger" @click="removeTrack(tIndex)">Delete</button>
              </div>
            </div>

            <h4 class="collapsible-header" @click="track._showPits = !track._showPits">
              Pitstop Rules <span style="color:#e53935;">{{ track._showPits ? '▼' : '▶' }}</span>
            </h4>
            <div v-show="track._showPits" class="session-card-out">
              <div class="grid-global">
                <div class="form-group"><label>Mandatory Pits</label><input v-model.number="track.mandatoryPitstopCount" type="number"></div>
                <div class="checkbox-container">
                  <input type="checkbox" :id="'refuelOk-'+tIndex" v-model="track.isRefuellingAllowedInRace">
                  <label :for="'refuelOk-'+tIndex">Allow Refuelling</label>
                </div>
                <div class="checkbox-container">
                  <input type="checkbox" :id="'refuelFix-'+tIndex" v-model="track.isRefuellingTimeFixed">
                  <label :for="'refuelFix-'+tIndex">Fixed Refuel Time</label>
                </div>
              </div>
              <hr class="greyhr">
              <div class="grid-global">
                <div class="checkbox-container">
                  <input type="checkbox" :id="'reqRefuel-'+tIndex" v-model="track.isMandatoryPitstopRefuellingRequired">
                  <label :for="'reqRefuel-'+tIndex">Req. Refuelling</label>
                </div>
                <div class="checkbox-container">
                  <input type="checkbox" :id="'reqTyre-'+tIndex" v-model="track.isMandatoryPitstopTyreChangeRequired">
                  <label :for="'reqTyre-'+tIndex">Req. Tyre Change</label>
                </div>
                <div class="checkbox-container">
                  <input type="checkbox" :id="'reqSwap-'+tIndex" v-model="track.isMandatoryPitstopSwapDriverRequired">
                  <label :for="'reqSwap-'+tIndex">Req. Driver Swap</label>
                </div>
              </div>
            </div>

            <h4 class="collapsible-header" @click="track._showWeather = !track._showWeather">
              Weather <span style="color:#e53935;">{{ track._showWeather ? '▼' : '▶' }}</span>
            </h4>
            <div v-show="track._showWeather" class="session-card-out">
              <div style="width:100%; text-align:center; margin-bottom:6px;"><span class="subhead">Presets</span></div>
              <div style="width:100%;"> 
                <div class="presets-third"><button class="preset-btn-blue" @click="setWeather(track, 16, 0.3, 0.0, 1)">Default</button></div>
                <div class="presets-third"><button class="preset-btn-blue" @click="setWeather(track, 23, 0.25, 0.0, 1)">Sunny Clear</button></div>
                <div class="presets-third"><button class="preset-btn-blue" @click="setWeather(track, 19, 0.55, 0.0, 1)">Overcast</button></div>
              </div>
              
              <div style="width:100%;"> 
                <div class="presets-third"><button class="preset-btn-blue" @click="setWeather(track, 20, 0.62, 0.12, 1)">Light Rain</button></div>
                <div class="presets-third"><button class="preset-btn-blue" @click="setWeather(track, 20, 0.70, 0.27, 1)">Medium Rain</button></div>
                <div class="presets-third"><button class="preset-btn-blue" @click="setWeather(track, 16, 0.88, 0.62, 2)">Heavy Rain</button></div>
              </div>
              
              <hr class="greyhr">
              <div style="text-align:center; width:100%;"> 
                <div style="width: 25%; display: inline-block; text-align: center;">         
                  <div style="display: block; text-align: center; margin:0px 4px 7px 4px;">
                    <label>Temp (°C)</label><br><input style="margin-top:3px;" class="presetw" v-model.number="track.ambientTemp" type="number">
                  </div>
                </div>
                <div style="width: 25%; display: inline-block; text-align: center;">         
                  <div style="display: block; text-align: center; margin:0px 4px 7px 4px;">
                    <label>Cloud (0-1)</label><br><input style="margin-top:3px;" class="presetw" v-model.number="track.cloudLevel" type="number" step="0.1">
                  </div>
                </div>
                <div style="width: 25%; display: inline-block; text-align: center;">         
                  <div style="display: block; text-align: center; margin:0px 4px 7px 4px;">
                    <label>Rain (0-1)</label><br><input style="margin-top:3px;" class="presetw" v-model.number="track.rain" type="number" step="0.1">
                  </div>
                </div>
                <div style="width: 25%; display: inline-block; text-align: center;">         
                  <div style="display: block; text-align: center; margin:0px 4px 7px 4px;">
                    <label>Randomness</label><br><input style="margin-top:3px;" class="presetw" v-model.number="track.weatherRandomness" type="number">
                  </div>
                </div>
              </div>
              
              <hr class="greyhr">
              <div style="width:100%; text-align:center; margin-bottom:6px;"><span class="subhead">Custom Presets</span></div>
              <div>
                <div v-for="(preset, idx) in customPresets" :key="idx" style="width:20%; display:inline-block;">
                  <button class="preset-btn-blue" @click="setWeather(track, preset.ambientTemp, preset.cloudLevel, preset.rain, preset.weatherRandomness)">{{ preset.name }}</button><br>
                  <button class="preset-btn-save" @click="saveCustomPreset(track, idx)" title="Save Current Config to Preset">Save Preset</button>
                </div>
              </div>
            </div>

            <h4 class="collapsible-header" @click="track._showTimings = !track._showTimings">
              Timings <span style="color:#e53935;">{{ track._showTimings ? '▼' : '▶' }}</span>
            </h4>
            <div v-show="track._showTimings" class="session-card-out">
            	<div style="width:100%; color:#aaa; text-align:left; margin-top:10px; margin-bottom:12px; font-size:12px;">Nordschleife will Require a High Overtime of 450 secs. | 150 is default.</div>
            	<hr class="greyhr">
              <div class="grid-global">
                <div class="form-group"><label>Pre-Race (Sec)</label><input v-model.number="track.preRaceWaitingTimeSeconds" type="number"></div>
                <div class="form-group"><label>Overtime (Sec)</label><input v-model.number="track.sessionOverTimeSeconds" type="number"></div>
                <div class="form-group"><label>Post Qualy (Sec)</label><input v-model.number="track.postQualySeconds" type="number"></div>
                <div class="form-group"><label>Post Race (Sec)</label><input v-model.number="track.postRaceSeconds" type="number"></div>
              </div>
            </div>

            <h4 class="collapsible-header" @click="track._showSessions = !track._showSessions">
              Sessions <span style="color:#e53935;">{{ track._showSessions ? '▼' : '▶' }}</span>
            </h4>
            <div v-show="track._showSessions" style="margin-top: 25px;" class="session-card-out">
              <div style="width:100%; text-align:left; margin-top:3px; padding-left:3px;">
                <button class="btn-addsess" @click="addSessionP(track)">+ Add Practice</button> &nbsp; <button class="btn-addsess" @click="addSessionQ(track)">+ Add Quali</button> &nbsp; <button class="btn-addsess" @click="addSessionR(track)">+ Add Race</button>
              </div>
              <hr class="greyhr">

              <div v-for="(session, sIndex) in track.sessions" :key="sIndex" class="session-card">
                <div class="flex-between" style="margin-bottom: 8px;">
                  <strong style="color: #bbb; font-size: 12px;">Session {{ sIndex + 1 }}</strong>
                  <button class="btn-small btn-danger" style="padding: 2px 6px; font-size: 10px;" @click="track.sessions.splice(sIndex, 1)">Remove</button>
                </div>
                <hr class="greyhr">
                <div class="grid">
                  <div class="form-group">
                    <label>Type</label>
                    <select v-model="session.sessionType">
                      <option value="P">Practice (P)</option>
                      <option value="Q">Qualifying (Q)</option>
                      <option value="R">Race (R)</option>
                    </select>
                  </div>
                  <div class="form-group">
                    <label>Day</label>
                    <select v-model.number="session.dayOfWeekend">
                      <option :value="1">Friday (1)</option>
                      <option :value="2">Saturday (2)</option>
                      <option :value="3">Sunday (3)</option>
                    </select>
                  </div>
                  <div class="form-group"><label>Hour (0-23)</label><input v-model.number="session.hourOfDay" type="number" min="0" max="23"></div>
                  <div class="form-group"><label>Duration (Min)</label><input v-model.number="session.sessionDurationMinutes" type="number"></div>
                  <div class="form-group"><label>Time Multiplier</label><input v-model.number="session.timeMultiplier" type="number"></div>
                </div>
              </div>
              <div style="width:100%; text-align:right; margin-top:10px;"><button @click="saveData()">Save Rotation</button></div>
            </div>
          </div>
          
          <button @click="addTrack" class="add-track-btn">+ Add Track to Live Rotation</button>
          <div style="width:100%; text-align:center; margin-bottom:16px;"><button @click="saveData()">Save Rotation</button></div>
        </div>
        
        <div v-else style="text-align: center; padding: 40px; color: #aaa;">
          Loading configuration...
        </div> 
      
        <hr>
        
        <!-- WEATHER SIMULATOR -->
        <div class="card">
          <h4 id="sessionHeader" class="collapsible-header" style="cursor: pointer;">Weather Simulator<span id="sessionArrow" style="color:#e53935;">▶</span></h4>
          <div id="sessionContent" style="display: none; margin-top: 25px;">
            <div class="top-column">
              <div class="chart-container">
                <div class="chart-header">
                  <span class="section-label" style="margin-bottom:0;">72-Hour Timeline</span>
                  <div class="chart-legend">
                    <div class="legend-item"><div class="legend-color legend-rain"></div> Rain</div>
                    <div class="legend-item"><div class="legend-color legend-cloud"></div> Cloud</div>
                    <div class="legend-item"><div class="legend-color legend-temp"></div> Temp</div>
                  </div>
                </div>
                <div class="chart-wrapper">
                  <canvas id="weekendChart"></canvas>
                </div>
              </div>

              <div class="stats-grid">
                <div class="stat-card">
                  <div class="stat-label">Peak Rain</div>
                  <div id="stat-max-rain" class="stat-value cyan">--</div>
                </div>
                <div class="stat-card">
                  <div class="stat-label">Avg Cloud Cover</div>
                  <div id="stat-avg-cloud" class="stat-value slate">--</div>
                </div>
                <div class="stat-card">
                  <div class="stat-label">Temp Range</div>
                  <div id="stat-temp-range" class="stat-value red">--</div>
                </div>
              </div>
            </div>

            <br>
            <h2 class="panel-title">
              <span>Weather Parameters & Session Schedule</span>
              <span class="pulse-dot"></span>
            </h2>

            <div>
              <span class="section-label">Baseline Reference- 99% Accurate</span>
              <div class="preset-grid">
                <button type="button" data-preset="sunny" class="preset-btn">
                  <span>☀️ Sunny</span>
                  <span class="preset-sub">23°C / 0 Rain</span>
                </button>
                <button type="button" data-preset="overcast" class="preset-btn">
                  <span>☁️ Overcast</span>
                  <span class="preset-sub">19°C / 0 Rain</span>
                </button>
                <button type="button" data-preset="light-rain" class="preset-btn">
                  <span>🌦️ Light Rain</span>
                  <span class="preset-sub">20°C / 0.12</span>
                </button>
                <button type="button" data-preset="med-rain" class="preset-btn">
                  <span>🌧️ Medium Rain</span>
                  <span class="preset-sub">20°C / 0.27</span>
                </button>
                <button type="button" data-preset="heavy-rain" class="preset-btn">
                  <span>⛈️ Heavy Rain</span>
                  <span class="preset-sub">16°C / 0.62</span>
                </button>
              </div>
            </div>

            <hr class="divider">

            <div class="controls-grid">
              <div class="control-group">
                <label>Base Rain: <span id="val-rain">0.20</span></label>
                <input id="input-rain" type="range" min="0" max="1" step="0.01" value="0.2">
              </div>
              <div class="control-group">
                <label>Cloud Level: <span id="val-cloud">0.40</span></label>
                <input id="input-cloud" type="range" min="0" max="1" step="0.01" value="0.4">
              </div>
              <div class="control-group">
                <label>Randomness: <span id="val-random">3</span></label>
                <input id="input-random" type="range" min="0" max="7" step="1" value="3">
              </div>
              <div class="control-group">
                <label>Base Temp (°C): <span id="val-temp">22</span></label>
                <input id="input-temp" type="range" min="10" max="40" step="1" value="22">
              </div>
            </div>

            <hr class="divider">

            <div class="schedules-container">
              <div class="schedule-box">
                <div class="schedule-title cyan">Fri — Practice</div>
                <div class="schedule-inputs">
                  <div class="input-wrapper">
                    <span>Start Hour</span>
                    <input id="fri-hour" class="cyan" type="number" min="0" max="23" value="15">
                  </div>
                  <div class="input-wrapper">
                    <span>Duration (m)</span>
                    <input id="fri-duration" class="cyan" type="number" min="15" max="360" value="60">
                  </div>
                </div>
              </div>

              <div class="schedule-box">
                <div class="schedule-title emerald">Sat — Qualifying</div>
                <div class="schedule-inputs">
                  <div class="input-wrapper">
                    <span>Start Hour</span>
                    <input id="sat-hour" class="emerald" type="number" min="0" max="23" value="12">
                  </div>
                  <div class="input-wrapper">
                    <span>Duration (m)</span>
                    <input id="sat-duration" class="emerald" type="number" min="15" max="360" value="45">
                  </div>
                </div>
              </div>

              <div class="schedule-box">
                <div class="schedule-title red">Sun — Race</div>
                <div class="schedule-inputs">
                  <div class="input-wrapper">
                    <span>Start Hour</span>
                    <input id="sun-hour" class="red" type="number" min="0" max="23" value="14">
                  </div>
                  <div class="input-wrapper">
                    <span>Duration (m)</span>
                    <input id="sun-duration" class="red" type="number" min="15" max="360" value="90">
                  </div>
                </div>
              </div>
            </div>
            <span id="btn-simulate"></span>
          </div>
        </div>

        <div class="footer">ACC Race Host &copy; 2026<br><a href="https://www.accracehost.com/" target="_blank">www.accracehost.com</a></div>
      </div>

      <script>
        const { createApp } = Vue;

        createApp({
          data() {
            return {
              currentTheme: 'styles.css',
              customPresets: [],
              config: null,
              banlist: { enabled: true, entries: [] },
              bopStatus: { exists: false, entriesCount: 0 },
              entrylistStatus: { exists: false, entriesCount: 0 },
              customEntrylists: [],
              selectedCustomEntrylist: '',
              uploadCustomFilename: '',
              pendingUploadParsedData: null,
              showUploadNameModal: false,
              bopData: { entries: [] },
              entrylistData: { entries: [] },
              showBopEditor: false,
              showEntrylistEditor: false,
              showTelemetry: true,
              showBackupOptions: false,
              newPlayerName: '',
              newPlayerId: '',
              resultsFiles: [],
              selectedFile: '',
              latestResults: null,
              Showlatestresults: true,
              serverStatus: { running: false, mode: 'stopped' },
              startButtonDisabled: false,
              currentPage: 1,
              itemsPerPage: 8,
              availableTracks: {
                'barcelona': 'Barcelona', 'brands_hatch': 'Brands Hatch', 'circuit_of_the_americas': 'COTA',
                'donington': 'Donington Park', 'hungaroring': 'Hungaroring', 'indianapolis': 'Indianapolis',
                'kyalami': 'Kyalami', 'laguna_seca': 'Laguna Seca', 'misano': 'Misano', 'monza': 'Monza Circuit',
                'mount_panorama': 'Bathurst', 'nurburgring': 'Nürburgring', 'nurburgring_24h': 'Nordschleife',
                'oulton_park': 'Oulton Park', 'paul_ricard': 'Paul Ricard', 'red_bull_ring': 'Red Bull Ring',
                'silverstone': 'Silverstone', 'snetterton': 'Snetterton', 'spa': 'Spa-Francorchamps',
                'suzuka': 'Suzuka', 'valencia': 'Valencia', 'watkins_glen': 'Watkins Glen',
                'zandvoort': 'Zandvoort', 'zolder': 'Zolder'
              },
              carModelsMap: {
                0: "Porsche 991 GT3 R", 1: "Mercedes-AMG GT3", 2: "Ferrari 488 GT3", 3: "Audi R8 LMS",
                4: "Lamborghini Huracán GT3", 5: "Bentley Continental GT3 2018", 6: "Aston Martin Vantage V12",
                7: "Honda NSX GT3", 8: "Lexus RC F GT3", 9: "McLaren 650S GT3", 10: "Nissan GT-R Nismo GT3 2018",
                11: "BMW M6 GT3", 12: "Bentley Continental GT3 2015", 13: "Porsche 991 II GT3 Cup",
                14: "Nissan GT-R Nismo GT3 2015", 15: "BMW M4 GT4", 16: "Porsche 911 GT3 R (2019)",
                17: "Aston Martin Vantage V8 GT3", 18: "Audi R8 LMS EVO", 19: "Honda NSX GT3 Evo",
                20: "McLaren 720S GT3", 21: "Porsche 911 II GT3 R (2019)", 22: "Ferrari 488 GT3 Evo",
                23: "Mercedes-AMG GT3 EVO", 24: "BMW M4 GT3", 25: "Ferrari 296 GT3", 26: "Lamborghini Huracán GT3 EVO 2",
                27: "Porsche 992 GT3 R", 28: "McLaren 720S GT3 EVO", 29: "Audi R8 LMS GT3 EVO II", 30: "Ford Mustang GT3"
              }
            }
          },
          computed: {
            paginatedDrivers() {
              if (!this.latestResults || !Array.isArray(this.latestResults.drivers)) return [];
              const start = (this.currentPage - 1) * this.itemsPerPage;
              return this.latestResults.drivers.slice(start, start + this.itemsPerPage);
            },
            totalPages() {
              if (!this.latestResults || !Array.isArray(this.latestResults.drivers)) return 1;
              return Math.ceil(this.latestResults.drivers.length / this.itemsPerPage) || 1;
            }
          },
          async mounted() {
            fetch('/api/config')
              .then(res => res.json())
              .then(data => { 
                if (data.serverName === undefined) data.serverName = "Server Name | Powered by ACC Race Host | Track Rotation | Active Banlist";
                if (data.adminPassword === undefined) data.adminPassword = "admin";
                if (data.password === undefined) data.password = "";
                if (data.spectatorPassword === undefined) data.spectatorPassword = "spectator";
                if (data.trackMedalsRequirement === undefined) data.trackMedalsRequirement = 0;
                if (data.safetyRatingRequirement === undefined) data.safetyRatingRequirement = 60;
                if (data.racecraftRatingRequirement === undefined) data.racecraftRatingRequirement = -1;
                if (data.maxCarSlots === undefined) data.maxCarSlots = 30;
                if (data.isRaceLocked === undefined) data.isRaceLocked = 0;
                if (data.shortFormationLap === undefined) data.shortFormationLap = 1;
                if (data.dumpLeaderboards === undefined) data.dumpLeaderboards = 1;
                if (data.dumpEntryList === undefined) data.dumpEntryList = 0;
                if (data.randomizeTrackWhenEmpty === undefined) data.randomizeTrackWhenEmpty = 0;
                if (data.allowAutoDQ === undefined) data.allowAutoDQ = 1;
                if (data.ignorePrematureDisconnects === undefined) data.ignorePrematureDisconnects = 1;
                if (data.formationLapType === undefined) data.formationLapType = 3;
                if (data.udpPort === undefined) data.udpPort = 9231;
                if (data.tcpPort === undefined) data.tcpPort = 9232;
                if (data.maxConnections === undefined) data.maxConnections = 32;
                if (data.lanDiscovery === undefined) data.lanDiscovery = 0;
                if (data.enableUPnP === undefined) data.enableUPnP = 0;
                if (data.registerToLobby === undefined) data.registerToLobby = 1;
                if (data.forceEntryList === undefined) data.forceEntryList = 0;
                if (data._showBanlist === undefined) data._showBanlist = false;
                if (data._showBop === undefined) data._showBop = false;
                if (data._showEntrylist === undefined) data._showEntrylist = false;
                
                if (data.rotation) {
                  data.rotation.forEach(track => { 
                    if (!track.carGroup) track.carGroup = "FreeForAll";
                    track._showReqs = false;
                    track._showPits = false;
                    track._showWeather = false;
                    track._showSessions = false;
                    track._showTimings = false;
                  });
                }
                this.config = data; 
              })
              .catch(err => this.showToast('Failed to load config: ' + err.message));
              
            fetch('/api/presets')
              .then(res => res.json())
              .then(data => { if(data) this.customPresets = data; })
              .catch(err => console.error('Failed to load custom presets:', err));

            fetch('/api/banlist')
              .then(res => res.json())
              .then(data => {
                if (!data.entries) data.entries = [];
                if (data.enabled === undefined) data.enabled = true;
                this.banlist = data;
              })
              .catch(err => console.error('Failed to load banlist: ' + err.message));

            this.fetchBopStatus();
            this.fetchEntrylistStatus();
            this.fetchCustomEntrylists();
            this.fetchResultsFiles();
            this.checkScriptStatus();
            setInterval(this.checkScriptStatus, 3000);
           
            try {
              const response = await fetch('/api/theme');
              const data = await response.json();
              if (data && data.theme) {
                this.currentTheme = data.theme;
              }
            } catch (error) {
              console.error('Could not load theme from server, falling back to default.');
            }
            this.applyTheme(this.currentTheme);
          },
   
          methods: {
            checkScriptStatus() {
              fetch('/api/script/status')
                .then(res => res.json())
                .then(data => this.serverStatus = data)
                .catch(() => this.serverStatus = { running: false, mode: 'stopped' });
            },
            fetchBopStatus() {
              fetch('/api/bop')
                .then(res => res.json())
                .then(data => { 
                  this.bopStatus = data;
                  if (data.data) {
                    this.bopData = Array.isArray(data.data) ? { entries: data.data } : data.data;
                    if (!this.bopData.entries) this.bopData.entries = [];
                  }
                })
                .catch(err => console.error('Failed to fetch BOP status:', err));
            },
            addBopEntry() {
              if (!this.bopData.entries) this.bopData.entries = [];
              this.bopData.entries.push({
                track: "*",
                carModel: 25,
                ballastKg: 0,
                restrictor: 0
              });
            },
            saveBopData() {
              fetch('/api/bop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.bopData)
              })
              .then(res => {
                if (res.ok) {
                  this.showToast('BOP Saved!', 'success');
                  this.fetchBopStatus();
                } else this.showToast('Failed to save BOP', 'error');
              })
              .catch(err => this.showToast('Error saving bop: ' + err.message));
            },
            handleBopFileUpload(event) {
              const file = event.target.files[0];
              if (!file) return;
              
              if (file.name !== 'bop.json') {
                this.showToast('Invalid file! Please select "bop.json".', 'error');
                event.target.value = '';
                return;
              }
              
              const reader = new FileReader();
              reader.onload = (e) => {
                try {
                  const parsed = JSON.parse(e.target.result);
                  fetch('/api/bop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(parsed)
                  })
                  .then(res => {
                    if (res.ok) {
                      this.showToast('BOP Imported!');
                      this.fetchBopStatus();
                    } else {
                      this.showToast('Failed to Import BOP!', 'error');
                    }
                  })
                  .catch(err => this.showToast('Error Importing bop.json: ' + err.message));
                } catch (err) {
                  this.showToast('Invalid JSON file format!', 'error');
                }
              };
              reader.readAsText(file);
            },
            fetchEntrylistStatus() {
              fetch('/api/entrylist')
                .then(res => res.json())
                .then(data => { 
                  this.entrylistStatus = data; 
                  if (data.data) {
                    this.entrylistData = Array.isArray(data.data) ? { entries: data.data } : data.data;
                    if (!this.entrylistData.entries) this.entrylistData.entries = [];
                    if (this.entrylistData.forceEntryList === undefined) {
                      this.entrylistData.forceEntryList = 0;
                    }
                  }
                })
                .catch(err => console.error('Failed to fetch Entrylist status:', err));
            },
            fetchCustomEntrylists() {
              fetch('/api/custom-entrylists')
                .then(res => res.json())
                .then(data => { this.customEntrylists = data || []; })
                .catch(err => console.error('Failed to fetch custom entrylists:', err));
            },
            applySelectedCustomEntrylist() {
              if (!this.selectedCustomEntrylist) return;
              fetch('/api/select-custom-entrylist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: this.selectedCustomEntrylist })
              })
              .then(res => res.json())
              .then(data => {
                if (data.success) {
                  this.showToast('Applied custom entrylist: ' + this.selectedCustomEntrylist, 'success');
                  this.fetchEntrylistStatus();
                } else {
                  this.showToast('Failed to apply entrylist: ' + data.error, 'error');
                }
              })
              .catch(err => this.showToast('Error applying entrylist: ' + err.message, 'error'));
            },
            addEntrylistRow() {
              if (!this.entrylistData.entries) this.entrylistData.entries = [];
              this.entrylistData.entries.push({
                drivers: [{ firstName: "New Driver", shortName: "", driverCategory: 0, playerID: "" }],
                customCar: "",
                raceNumber: -1,
                defaultGridPosition: -1,
                forcedCarModel: -1,
                overrideDriverInfo: 0,
                isServerAdmin: 0,
                overrideCarModelForCustomCar: 0,
                ballastKg: 0,
                restrictor: 0
              });
            },
            saveEntrylistData() {
              // 1. Save to active server/cfg/entrylist.json
              fetch('/api/entrylist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.entrylistData)
              })
              .then(res => {
                if (!res.ok) throw new Error('Failed to save Entrylist');
                
                // 2. If a custom entrylist file is currently selected, also update it in ../entrylists
                if (this.selectedCustomEntrylist) {
                  return fetch('/api/save-custom-entrylist', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      filename: this.selectedCustomEntrylist,
                      data: this.entrylistData
                    })
                  });
                }
              })
              .then(res => {
                if (res && !res.ok) throw new Error('Failed to update custom entrylist file');
                this.showToast('EntryList Saved & Updated!', 'success');
                this.fetchEntrylistStatus();
                this.fetchCustomEntrylists();
              })
              .catch(err => this.showToast(err.message, 'error'));
            },
            handleEntrylistFileUpload(event) {
              const file = event.target.files[0];
              if (!file) return;

              const reader = new FileReader();
              reader.onload = (e) => {
                try {
                  const parsed = JSON.parse(e.target.result);
                  this.pendingUploadParsedData = parsed;
                  this.uploadCustomFilename = file.name;
                  this.showUploadNameModal = true;
                  event.target.value = '';
                } catch (err) {
                  this.showToast('Invalid JSON file format!', 'error');
                  event.target.value = '';
                }
              };
              reader.readAsText(file);
            },
            confirmSaveCustomEntrylist() {
              if (!this.uploadCustomFilename.trim()) {
                this.showToast('Please enter a valid file name.', 'error');
                return;
              }
              fetch('/api/save-custom-entrylist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  filename: this.uploadCustomFilename.trim(),
                  data: this.pendingUploadParsedData
                })
              })
              .then(res => res.json())
              .then(data => {
                if (data.success) {
                  this.showToast('Saved to ../entrylists/' + data.filename, 'success');
                  this.showUploadNameModal = false;
                  this.pendingUploadParsedData = null;
                  this.fetchCustomEntrylists();
                  this.selectedCustomEntrylist = data.filename;
                  this.applySelectedCustomEntrylist();
                } else {
                  this.showToast('Failed to save file: ' + data.error, 'error');
                }
              })
              .catch(err => this.showToast('Error saving file: ' + err.message, 'error'));
            },
            exportBackup() {
              window.location.href = '/api/backup/export';
            },
            async toggleTheme() {
              this.currentTheme = this.currentTheme === 'styles.css' ? 'cyber.css' : 'styles.css';
              this.applyTheme(this.currentTheme);
              try {
                await fetch('/api/theme', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ theme: this.currentTheme })
                });
              } catch (error) {
                console.error('Failed to update theme.json on server:', error);
              }
            },
            applyTheme(filename) {
              let theme = document.getElementById('theme');
              if (theme) {
                theme.setAttribute('href', filename);
              }
            },
            importBackup(event) {
              const file = event.target.files[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = (e) => {
                try {
                  const parsed = JSON.parse(e.target.result);
                  fetch('/api/backup/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(parsed)
                  })
                  .then(res => {
                    if (res.ok) {
                      alert('Backup successfully restored!');
                      location.reload();
                    } else this.showToast('Failed to restore backup file.');
                  })
                  .catch(err => this.showToast('Error restoring backup: ' + err.message));
                } catch (err) {
                  this.showToast('Invalid Backup JSON file: ' + err.message);
                }
              };
              reader.readAsText(file);
            },
            fetchResultsFiles() {
              fetch('/api/results-files')
                .then(res => res.json())
                .then(files => {
                  this.resultsFiles = files || [];
                  if (this.resultsFiles.length > 0 && !this.selectedFile) {
                    this.selectedFile = this.resultsFiles[0].name;
                  }
                  this.fetchSessionResults();
                })
                .catch(err => console.error('Failed to fetch results files:', err));
            },
            fetchSessionResults() {
              this.currentPage = 1;
              const fileParam = this.selectedFile ? ('?file=' + encodeURIComponent(this.selectedFile)) : '';
              fetch('/api/session-results' + fileParam)
                .then(res => res.json())
                .then(data => {
                  this.latestResults = data;
                  if (data && data.filename) {
                    this.selectedFile = data.filename;
                  }
                })
                .catch(err => {
                  this.latestResults = { message: 'Failed to fetch session results: ' + err.message };
                });
            },
            quickBanDriver(drv) {
              if (!drv || !drv.playerId) return;
              if (confirm('Are you sure you want to add "' + drv.name + '" (' + drv.playerId + ') to the Global Banlist?')) {
                if (!this.banlist.entries) this.banlist.entries = [];
                const exists = this.banlist.entries.some(e => String(e.playerId) === String(drv.playerId));
                if (exists) {
                  alert('Driver is already present in the global banlist.');
                  return;
                }
                this.banlist.entries.push({
                  playerName: drv.name,
                  playerId: String(drv.playerId)
                });
                this.saveBanlist();
                alert('Added ' + drv.name + ' to Global Banlist!');
              }
            },
            startMode(mode, trackIndex = 0) {
              const endpoint = mode === 'rotation' ? '/api/script/start' : '/api/script/start-normal';
              fetch(endpoint, { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trackIndex })
              })
                .then(res => {
                  if (res.ok) this.checkScriptStatus();
                  else this.showToast('Failed to start server in ' + mode + ' mode.');
                })
                .catch(err => this.showToast('Error: ' + err.message));
            },
            stopServer() {
              fetch('/api/script/stop', { method: 'POST' })
                .then(res => {
                  if (res.ok) this.checkScriptStatus();
                  else this.showToast('Failed to stop server.');
                })
                .catch(err => this.showToast('Error: ' + err.message));
              this.startButtonDisabled = false;
            },
            shutdownApp() {
              if (confirm('Are you sure you want to stop the server and close ACC Race Host?')) {
                fetch('/api/app/shutdown', { method: 'POST' })
                  .then(() => {
                    this.showToast('ACC Race Host has been shut down.');
                    window.close();
                  })
                  .catch(err => this.showToast('Error shutting down: ' + err.message));
              }
            },
            saveData() {
              const configToSave = JSON.parse(JSON.stringify(this.config));
              delete configToSave._showBanlist;
              delete configToSave._showBop;
              delete configToSave._showEntrylist;

              if (configToSave.rotation) {
                configToSave.rotation.forEach(t => {
                  delete t._showReqs;
                  delete t._showPits;
                  delete t._showWeather;
                  delete t._showSessions;
                  delete t._showTimings;
                });
              }

              fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configToSave)
              })
              .then(res => {
                if (res.ok) {
                  this.showToast('Settings Saved!', 'success');
                } else {
                  throw new Error('Save failed');
                }
              })
              .catch(err => {
                this.showToast('Error saving: ' + err.message, 'error');
              });
            },
            saveBanlist() {
              fetch('/api/banlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.banlist)
              })
              .catch(err => alert('Error saving banlist: ' + err.message));
            },
            showToast(message, type = 'success') {
              const toast = document.createElement('div');
              toast.className = 'custom-toast ' + type;
              toast.textContent = message;
              document.body.appendChild(toast);
              setTimeout(() => {
                toast.classList.add('hide');
                setTimeout(() => toast.remove(), 300);
              }, 3000);
            },
            addBanEntry() {
              if (!this.newPlayerName.trim() || !this.newPlayerId.trim()) {
                this.showToast('Please enter both Player Name and Steam ID.', 'error');
                return;
              }
              if (!this.banlist.entries) this.banlist.entries = [];
              this.banlist.entries.push({
                playerName: this.newPlayerName.trim(),
                playerId: this.newPlayerId.trim()
              });
              this.newPlayerName = '';
              this.newPlayerId = '';
              this.saveBanlist();
            },
            removeBanEntry(index) {
              if (confirm('Remove driver from global banlist?')) {
                this.banlist.entries.splice(index, 1);
                this.saveBanlist();
              }
            },
            setWeather(track, ambtemp, cloud, rain, randomness) {
              track.ambientTemp = ambtemp;
              track.cloudLevel = cloud;
              track.rain = rain;
              track.weatherRandomness = randomness;
            },
            addTrack() {
              if(!this.config.rotation) this.config.rotation = [];
              this.config.rotation.push({
                track: "monza", 
                carGroup: "FreeForAll", 
                _showReqs: false,
                _showPits: false,
                _showWeather: false,
                _showSessions: false,
                _showTimings: false,
                mandatoryPitstopCount: 0,
                isRefuellingAllowedInRace: true,
                isRefuellingTimeFixed: false,
                isMandatoryPitstopRefuellingRequired: false,
                isMandatoryPitstopTyreChangeRequired: false,
                isMandatoryPitstopSwapDriverRequired: false,
                ambientTemp: 16, cloudLevel: 0.3, rain: 0, weatherRandomness: 1, 
                preRaceWaitingTimeSeconds: 80, sessionOverTimeSeconds: 150,
                postQualySeconds: 5, postRaceSeconds: 5,
                sessions: [
                  { hourOfDay: 14, dayOfWeekend: 2, timeMultiplier: 1, sessionType: "Q", sessionDurationMinutes: 12 },
                  { hourOfDay: 14, dayOfWeekend: 3, timeMultiplier: 1, sessionType: "R", sessionDurationMinutes: 20 }
                ]
              });
            },
            removeTrack(index) { if(confirm('Remove this track?')) this.config.rotation.splice(index, 1); },
            addSessionP(track) {
              if(!track.sessions) track.sessions = [];
              track.sessions.push({ hourOfDay: 14, dayOfWeekend: 1, timeMultiplier: 1, sessionType: "P", sessionDurationMinutes: 15 });
            },
            addSessionQ(track) {
              if(!track.sessions) track.sessions = [];
              track.sessions.push({ hourOfDay: 14, dayOfWeekend: 2, timeMultiplier: 1, sessionType: "Q", sessionDurationMinutes: 12 });
            },
            addSessionR(track) {
              if(!track.sessions) track.sessions = [];
              track.sessions.push({ hourOfDay: 14, dayOfWeekend: 3, timeMultiplier: 1, sessionType: "R", sessionDurationMinutes: 20 });
            },
              startSingleTrack(trackIndex) {
						  this.saveData();
						  this.startButtonDisabled = true;
						  this.startMode('normal', trackIndex);
						  setTimeout(() => {
						    this.startButtonDisabled = false;
						  }, 3000);
						},
            moveUp(index) { const item = this.config.rotation.splice(index, 1)[0]; this.config.rotation.splice(index - 1, 0, item); },
            moveDown(index) { const item = this.config.rotation.splice(index, 1)[0]; this.config.rotation.splice(index + 1, 0, item); },
            saveCustomPreset(track, index) {
              const currentName = this.customPresets[index].name || 'Custom ' + (index + 1);
              const newName = prompt("Enter a name for this custom preset:", currentName);
              if (newName === null) return;

              this.customPresets[index] = {
                name: newName.trim() || 'Custom ' + (index + 1),
                ambientTemp: track.ambientTemp || 20,
                cloudLevel: track.cloudLevel || 0,
                rain: track.rain || 0,
                weatherRandomness: track.weatherRandomness || 1
              };

              fetch('/api/presets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.customPresets)
              })
              .then(res => {
                if(res.ok) this.showToast('Preset "' + this.customPresets[index].name + '" saved!', 'info');
                else alert('Failed to save preset.');
              })
              .catch(err => alert('Error saving preset: ' + err.message));
            }
          }
        }).mount('#app');
      </script>

      <script>
        const rainInput = document.getElementById('input-rain');
        const cloudInput = document.getElementById('input-cloud');
        const randomInput = document.getElementById('input-random');
        const tempInput = document.getElementById('input-temp');
        
        const friHourInput = document.getElementById('fri-hour');
        const friDurationInput = document.getElementById('fri-duration');
        const satHourInput = document.getElementById('sat-hour');
        const satDurationInput = document.getElementById('sat-duration');
        const sunHourInput = document.getElementById('sun-hour');
        const sunDurationInput = document.getElementById('sun-duration');

        const valRain = document.getElementById('val-rain');
        const valCloud = document.getElementById('val-cloud');
        const valRandom = document.getElementById('val-random');
        const valTemp = document.getElementById('val-temp');

        const btnSimulate = document.getElementById('btn-simulate');
        const presetButtons = document.querySelectorAll('.preset-btn');

        const statMaxRain = document.getElementById('stat-max-rain');
        const statAvgCloud = document.getElementById('stat-avg-cloud');
        const statTempRange = document.getElementById('stat-temp-range');

        const canvas = document.getElementById('weekendChart');
        const ctx = canvas.getContext('2d');

        const presets = {
            'sunny': { temp: 23, cloud: 0.25, rain: 0.00, random: 1 },
            'overcast': { temp: 19, cloud: 0.55, rain: 0.00, random: 1 },
            'light-rain': { temp: 20, cloud: 0.62, rain: 0.12, random: 1 },
            'med-rain': { temp: 20, cloud: 0.70, rain: 0.27, random: 1 },
            'heavy-rain': { temp: 16, cloud: 0.88, rain: 0.62, random: 2 }
        };

        let currentSimulationData = null;

        function updateLabels() {
            valRain.textContent = parseFloat(rainInput.value).toFixed(2);
            valCloud.textContent = parseFloat(cloudInput.value).toFixed(2);
            valRandom.textContent = randomInput.value;
            valTemp.textContent = tempInput.value;
        }

        function generateWeekendData() {
            const baseRain = parseFloat(rainInput.value);
            const baseCloud = parseFloat(cloudInput.value);
            const randomness = parseInt(randomInput.value);
            const baseTemp = parseInt(tempInput.value);

            const friStartHour = parseInt(friHourInput.value) || 15;
            const friDuration = parseInt(friDurationInput.value) || 60;
            const satStartHour = parseInt(satHourInput.value) || 12;
            const satDuration = parseInt(satDurationInput.value) || 45;
            const sunStartHour = parseInt(sunHourInput.value) || 14;
            const sunDuration = parseInt(sunDurationInput.value) || 90;

            let labels = [];
            let tooltipsList = [];
            let rainData = [];
            let cloudData = [];
            let tempData = [];

            let currentRain = baseRain;
            let currentCloud = baseCloud;

            let maxRainVal = 0;
            let totalCloudSum = 0;
            let totalPoints = 0;
            let minTempVal = 50;
            let maxTempVal = -50;

            let friStartIdx = 0, friEndIdx = 0;
            let satStartIdx = 0, satEndIdx = 0;
            let sunStartIdx = 0, sunEndIdx = 0;

            const days = ['Friday', 'Saturday', 'Sunday'];

            for (let dayIdx = 0; dayIdx < 3; dayIdx++) {
                const dayName = days[dayIdx];
                for (let hour = 0; hour < 24; hour++) {
                    let isSessionHour = false;
                    if (dayIdx === 0 && hour >= friStartHour && hour <= friStartHour + Math.ceil(friDuration / 60)) isSessionHour = true;
                    if (dayIdx === 1 && hour >= satStartHour && hour <= satStartHour + Math.ceil(satDuration / 60)) isSessionHour = true;
                    if (dayIdx === 2 && hour >= sunStartHour && hour <= sunStartHour + Math.ceil(sunDuration / 60)) isSessionHour = true;

                    const stepMinutes = isSessionHour ? 10 : 120;

                    for (let min = 0; min < 60; min += stepMinutes) {
                        const totalMinFromDayStart = (hour * 60) + min;

                        if (dayIdx === 0) {
                            if (hour === friStartHour && min === 0) friStartIdx = totalPoints;
                            if (totalMinFromDayStart >= (friStartHour * 60) + friDuration && friEndIdx === 0) friEndIdx = totalPoints;
                        } else if (dayIdx === 1) {
                            if (hour === satStartHour && min === 0) satStartIdx = totalPoints;
                            if (totalMinFromDayStart >= (satStartHour * 60) + satDuration && satEndIdx === 0) satEndIdx = totalPoints;
                        } else if (dayIdx === 2) {
                            if (hour === sunStartHour && min === 0) sunStartIdx = totalPoints;
                            if (totalMinFromDayStart >= (sunStartHour * 60) + sunDuration && sunEndIdx === 0) sunEndIdx = totalPoints;
                        }

                        let sessionTag = '';
                        if (dayIdx === 0 && totalMinFromDayStart >= (friStartHour * 60) && totalMinFromDayStart <= (friStartHour * 60) + friDuration) sessionTag = ' 🏎️ [FP]';
                        if (dayIdx === 1 && totalMinFromDayStart >= (satStartHour * 60) && totalMinFromDayStart <= (satStartHour * 60) + satDuration) sessionTag = ' ⏱️ [QUALI]';
                        if (dayIdx === 2 && totalMinFromDayStart >= (sunStartHour * 60) && totalMinFromDayStart <= (sunStartHour * 60) + sunDuration) sessionTag = ' 🏁 [RACE]';

                        labels.push(dayName.substring(0, 3) + ' ' + String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0'));
                        tooltipsList.push(dayName + ' at ' + String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0') + sessionTag);

                        const noiseScale = randomness * 0.005;
                        currentRain = Math.max(0, Math.min(1, currentRain + (Math.random() - 0.5) * noiseScale));
                        currentCloud = Math.max(0, Math.min(1, currentCloud + (Math.random() - 0.5) * noiseScale));

                        const sunCycleOffset = Math.sin(((hour + min/60 - 9) / 24) * 2 * Math.PI); 
                        let targetTemp = baseTemp + (sunCycleOffset * 7) - (currentCloud * 3);
                        const tempDrift = targetTemp + (Math.random() - 0.5) * (randomness * 0.2);

                        const rRounded = parseFloat(currentRain.toFixed(2));
                        const cRounded = parseFloat(currentCloud.toFixed(2));
                        const tRounded = parseFloat(tempDrift.toFixed(1));

                        rainData.push(rRounded);
                        cloudData.push(cRounded);
                        tempData.push(tRounded);

                        if (rRounded > maxRainVal) maxRainVal = rRounded;
                        totalCloudSum += cRounded;
                        if (tRounded < minTempVal) minTempVal = tRounded;
                        if (tRounded > maxTempVal) maxTempVal = tRounded;
                        totalPoints++;
                    }
                }
            }

            if (friEndIdx === 0) friEndIdx = friStartIdx + 3;
            if (satEndIdx === 0) satEndIdx = satStartIdx + 3;
            if (sunEndIdx === 0) sunEndIdx = sunStartIdx + 3;

            statMaxRain.textContent = maxRainVal > 0.05 ? (Math.round(maxRainVal * 100) + '% Intensity') : 'Dry';
            statAvgCloud.textContent = Math.round((totalCloudSum / totalPoints) * 100) + '%';
            statTempRange.textContent = minTempVal + '°C - ' + maxTempVal + '°C';

            const sessionWindows = [
                { startIdx: friStartIdx, endIdx: friEndIdx, color: 'rgba(6, 182, 212, 0.06)', lineColor: '#06b6d4', label: '🛠️ FP' },
                { startIdx: satStartIdx, endIdx: satEndIdx, color: 'rgba(16, 185, 129, 0.06)', lineColor: '#10b981', label: '⏱️ Q' },
                { startIdx: sunStartIdx, endIdx: sunEndIdx, color: 'rgba(220, 38, 38, 0.1)', lineColor: '#dc2626', label: '🏁 RACE' }
            ];

            currentSimulationData = { labels, rainData, cloudData, tempData, tooltipsList, sessionWindows };
            drawChart();
        }
        
      

        function drawChart() {
            if (!currentSimulationData) return;

            const width = canvas.clientWidth;
            const height = canvas.clientHeight;
            canvas.width = width * window.devicePixelRatio;
            canvas.height = height * window.devicePixelRatio;
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

            ctx.clearRect(0, 0, width, height);

            const padding = { top: 15, right: 35, bottom: 30, left: 35 };
            const chartWidth = width - padding.left - padding.right;
            const chartHeight = height - padding.top - padding.bottom;

            const { labels, rainData, cloudData, tempData, tooltipsList, sessionWindows } = currentSimulationData;
            const totalPoints = labels.length;

            function getX(i) {
                return padding.left + (i / (totalPoints - 1)) * chartWidth;
            }

            function getYRain(val) {
                return padding.top + chartHeight - (val * chartHeight);
            }

            function getYTemp(val) {
                const normalized = Math.max(0, Math.min(1, val / 50));
                return padding.top + chartHeight - (normalized * chartHeight);
            }

            sessionWindows.forEach(win => {
                const xStart = getX(win.startIdx);
                const xEnd = getX(win.endIdx);

                ctx.fillStyle = win.color;
                ctx.fillRect(xStart, padding.top, xEnd - xStart, chartHeight);

                ctx.strokeStyle = win.lineColor;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(xStart, padding.top);
                ctx.lineTo(xStart, padding.top + chartHeight);
                ctx.stroke();
                ctx.setLineDash([]);

                ctx.fillStyle = win.lineColor;
                ctx.font = 'bold 9px Segoe UI';
                ctx.fillText(win.label, xStart + 4, padding.top + 12);
            });

            ctx.strokeStyle = 'rgba(34, 34, 34, 0.8)';
            ctx.lineWidth = 1;
            for (let i = 0; i <= 4; i++) {
                const y = padding.top + (i / 4) * chartHeight;
                ctx.beginPath();
                ctx.moveTo(padding.left, y);
                ctx.lineTo(width - padding.right, y);
                ctx.stroke();

                ctx.fillStyle = '#06b6d4';
                ctx.font = '9px Segoe UI';
                ctx.textAlign = 'right';
                ctx.fillText(((4 - i) / 4).toFixed(1), padding.left - 6, y + 3);

                ctx.fillStyle = '#dc2626';
                ctx.textAlign = 'left';
                ctx.fillText(Math.round((4 - i) / 4 * 50) + '°', width - padding.right + 6, y + 3)
            }

            ctx.fillStyle = '#9ca3af';
            ctx.font = '9px Segoe UI';
            ctx.textAlign = 'center';
            const tickInterval = Math.max(1, Math.floor(totalPoints / 6));
            for (let i = 0; i < totalPoints; i += tickInterval) {
                const x = getX(i);
                ctx.fillText(labels[i], x, height - padding.bottom + 16);
            }

            ctx.strokeStyle = '#9ca3af';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            for (let i = 0; i < totalPoints; i++) {
                const x = getX(i);
                const y = getYRain(cloudData[i]);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = 'rgba(6, 182, 212, 0.1)';
            ctx.beginPath();
            ctx.moveTo(getX(0), padding.top + chartHeight);
            for (let i = 0; i < totalPoints; i++) {
                ctx.lineTo(getX(i), getYRain(rainData[i]));
            }
            ctx.lineTo(getX(totalPoints - 1), padding.top + chartHeight);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = '#06b6d4';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < totalPoints; i++) {
                const x = getX(i);
                const y = getYRain(rainData[i]);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();

            ctx.strokeStyle = '#dc2626';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < totalPoints; i++) {
                const x = getX(i);
                const y = getYTemp(tempData[i]);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        [rainInput, cloudInput, randomInput, tempInput, friHourInput, friDurationInput, satHourInput, satDurationInput, sunHourInput, sunDurationInput].forEach(input => {
            input.addEventListener('input', () => {
                updateLabels();
                generateWeekendData();
            });
        });

        btnSimulate.addEventListener('click', generateWeekendData);

        presetButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const presetKey = btn.getAttribute('data-preset');
                const preset = presets[presetKey];
                if (preset) {
                    tempInput.value = preset.temp;
                    cloudInput.value = preset.cloud;
                    rainInput.value = preset.rain;
                    randomInput.value = preset.random;
                    updateLabels();
                    generateWeekendData();
                }
            });
        });

        window.addEventListener('resize', drawChart);
        updateLabels();
        generateWeekendData();
        
        document.addEventListener('DOMContentLoaded', () => {
          const header = document.getElementById('sessionHeader');
          const content = document.getElementById('sessionContent');
          const arrow = document.getElementById('sessionArrow');

          header.addEventListener('click', () => {
              const isHidden = content.style.display === 'none' || content.style.display === '';
              if (isHidden) {
                  content.style.display = 'block';
                  arrow.textContent = '▼';
                  generateWeekendData();
              } else {
                  content.style.display = 'none';
                  arrow.textContent = '▶';
              }
          });
        });
      </script>
    </body>
    </html>
    `);
  } 
  
  else if (req.method === 'GET' && pathname === '/vue.js') {
    let vuePath = path.join(BASE_DIR, 'vue.global.prod.js');
    if (!fs.existsSync(vuePath)) {
      vuePath = path.join(BASE_DIR, 'vue.js');
    }

    if (fs.existsSync(vuePath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(fs.readFileSync(vuePath));
    } else {
      res.writeHead(404);
      res.end('Vue file not found in bin folder');
    }
  }

  else if (req.method === 'GET' && pathname === '/api/config') {
    let rotationData = {};
    if (fs.existsSync(ROTATION_CONFIG_PATH)) {
      rotationData = JSON.parse(fs.readFileSync(ROTATION_CONFIG_PATH, 'utf8'));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rotationData));
  } 
  
  else if (req.method === 'POST' && pathname === '/api/config') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      let existingRotationConfig = {};

      try {
        if (fs.existsSync(ROTATION_CONFIG_PATH)) {
          existingRotationConfig = JSON.parse(fs.readFileSync(ROTATION_CONFIG_PATH, 'utf8'));
        }
      } catch (err) {
        console.error('Error reading configuration files:', err);
      }

      const rotationConfig = {
        ...existingRotationConfig,
        serverName: parsed.serverName !== undefined ? parsed.serverName : (existingRotationConfig.serverName || ''),
        password: parsed.password !== undefined ? parsed.password : (existingRotationConfig.password || ''),
        adminPassword: parsed.adminPassword !== undefined ? parsed.adminPassword : (existingRotationConfig.adminPassword || ''),
        spectatorPassword: parsed.spectatorPassword !== undefined ? parsed.spectatorPassword : (existingRotationConfig.spectatorPassword || ''),
        trackMedalsRequirement: parsed.trackMedalsRequirement !== undefined ? parsed.trackMedalsRequirement : (existingRotationConfig.trackMedalsRequirement || 0),
        safetyRatingRequirement: parsed.safetyRatingRequirement !== undefined ? parsed.safetyRatingRequirement : (existingRotationConfig.safetyRatingRequirement || 0),
        racecraftRatingRequirement: parsed.racecraftRatingRequirement !== undefined ? parsed.racecraftRatingRequirement : (existingRotationConfig.racecraftRatingRequirement || -1),
        maxCarSlots: parsed.maxCarSlots !== undefined ? parsed.maxCarSlots : (existingRotationConfig.maxCarSlots || 30),
        isRaceLocked: parsed.isRaceLocked !== undefined ? parsed.isRaceLocked : (existingRotationConfig.isRaceLocked || 0),
        shortFormationLap: parsed.shortFormationLap !== undefined ? parsed.shortFormationLap : (existingRotationConfig.shortFormationLap || 0),
        dumpLeaderboards: parsed.dumpLeaderboards !== undefined ? parsed.dumpLeaderboards : (existingRotationConfig.dumpLeaderboards || 0),
        dumpEntryList: parsed.dumpEntryList !== undefined ? parsed.dumpEntryList : (existingRotationConfig.dumpEntryList || 0),
        randomizeTrackWhenEmpty: parsed.randomizeTrackWhenEmpty !== undefined ? parsed.randomizeTrackWhenEmpty : (existingRotationConfig.randomizeTrackWhenEmpty || 0),
        allowAutoDQ: parsed.allowAutoDQ !== undefined ? parsed.allowAutoDQ : (existingRotationConfig.allowAutoDQ || 0),
        ignorePrematureDisconnects: parsed.ignorePrematureDisconnects !== undefined ? parsed.ignorePrematureDisconnects : (existingRotationConfig.ignorePrematureDisconnects || 0),
        formationLapType: parsed.formationLapType !== undefined ? parsed.formationLapType : (existingRotationConfig.formationLapType || 0),
        udpPort: parsed.udpPort !== undefined ? parsed.udpPort : (existingRotationConfig.udpPort || 9231),
        tcpPort: parsed.tcpPort !== undefined ? parsed.tcpPort : (existingRotationConfig.tcpPort || 9232),
        maxConnections: parsed.maxConnections !== undefined ? parsed.maxConnections : (existingRotationConfig.maxConnections || 32),
        lanDiscovery: parsed.lanDiscovery !== undefined ? parsed.lanDiscovery : (existingRotationConfig.lanDiscovery || 0),
        enableUPnP: parsed.enableUPnP !== undefined ? parsed.enableUPnP : (existingRotationConfig.enableUPnP || 0),
        registerToLobby: parsed.registerToLobby !== undefined ? parsed.registerToLobby : (existingRotationConfig.registerToLobby || 1),
        forceEntryList: parsed.forceEntryList !== undefined ? parsed.forceEntryList : (existingRotationConfig.forceEntryList || 0),
        rotation: parsed.rotation
      };

      fs.writeFileSync(ROTATION_CONFIG_PATH, JSON.stringify(rotationConfig, null, 2), 'utf8');
      
      try {
        const entrylistPath = getEntrylistFilePath();
        let entrylistData = { entries: [] };
        
        if (fs.existsSync(entrylistPath)) {
          const rawData = readJsonFileSync(entrylistPath);
          if (Array.isArray(rawData)) {
            entrylistData = { entries: rawData, forceEntryList: 0 };
          } else if (rawData && typeof rawData === 'object') {
            entrylistData = rawData;
          }
        }
        
        entrylistData.forceEntryList = rotationConfig.forceEntryList;
        if (!Array.isArray(entrylistData.entries)) {
          entrylistData.entries = [];
        }

        fs.writeFileSync(entrylistPath, JSON.stringify(entrylistData, null, 2), 'utf16le');
      } catch (err) {
        console.error('Error updating entrylist.json forceEntryList:', err);
      }

      res.writeHead(200);
      res.end('OK');
    });
  }

  // CUSTOM ENTRYLISTS ENDPOINTS
  else if (req.method === 'GET' && pathname === '/api/custom-entrylists') {
    const dir = getCustomEntrylistsDir();
    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().endsWith('.json'))
        .map(f => {
          const fullPath = path.join(dir, f);
          return { name: f, mtime: fs.statSync(fullPath).mtime.getTime() };
        })
        .sort((a, b) => b.mtime - a.mtime);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
    }
    return;
  }

  else if (req.method === 'POST' && pathname === '/api/select-custom-entrylist') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const fileName = parsed.filename;
        if (!fileName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Filename is required' }));
          return;
        }

        const sourcePath = path.join(getCustomEntrylistsDir(), path.basename(fileName));
        if (!fs.existsSync(sourcePath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'File not found in entrylists folder' }));
          return;
        }

        const fileContent = fs.readFileSync(sourcePath);
        const targetPath = getEntrylistFilePath();
        fs.writeFileSync(targetPath, fileContent, 'utf16le');

        syncEntrylistWithBanlist();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  else if (req.method === 'POST' && pathname === '/api/save-custom-entrylist') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        let filename = parsed.filename;
        const fileData = parsed.data;

        if (!filename || !fileData) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Filename and data are required' }));
          return;
        }

        if (!filename.toLowerCase().endsWith('.json')) {
          filename += '.json';
        }

        const targetDir = getCustomEntrylistsDir();
        const targetPath = path.join(targetDir, path.basename(filename));
        
        fs.writeFileSync(targetPath, JSON.stringify(fileData, null, 2), 'utf8');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, filename }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  else if (req.method === 'GET' && pathname === '/api/bop') {
    const bopPath = getBopFilePath();
    if (fs.existsSync(bopPath)) {
      try {
        const bopData = readJsonFileSync(bopPath);
        const entriesCount = Array.isArray(bopData.entries) ? bopData.entries.length : (Array.isArray(bopData) ? bopData.length : 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exists: true, entriesCount, data: bopData }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exists: true, entriesCount: 0, data: { entries: [] } }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exists: false, entriesCount: 0, data: { entries: [] } }));
    }
  }

  else if (req.method === 'POST' && pathname === '/api/bop') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const bopPath = getBopFilePath();
        fs.writeFileSync(bopPath, JSON.stringify(parsed, null, 2), 'utf16le');
        res.writeHead(200);
        res.end('OK');
      } catch (err) {
        res.writeHead(500);
        res.end('Error saving bop.json: ' + err.message);
      }
    });
  }

  else if (req.method === 'GET' && pathname === '/api/entrylist') {
    const entrylistPath = getEntrylistFilePath();
    if (fs.existsSync(entrylistPath)) {
      try {
        const entrylistData = readJsonFileSync(entrylistPath);
        const entriesCount = Array.isArray(entrylistData.entries) ? entrylistData.entries.length : (Array.isArray(entrylistData) ? entrylistData.length : 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exists: true, entriesCount, data: entrylistData }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exists: true, entriesCount: 0, data: { entries: [] } }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exists: false, entriesCount: 0, data: { entries: [] } }));
    }
  }

  else if (req.method === 'POST' && pathname === '/api/entrylist') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const entrylistPath = getEntrylistFilePath();
        fs.writeFileSync(entrylistPath, JSON.stringify(parsed, null, 2), 'utf16le');
        syncEntrylistWithBanlist();
        res.writeHead(200);
        res.end('OK');
      } catch (err) {
        res.writeHead(500);
        res.end('Error saving entrylist.json: ' + err.message);
      }
    });
  }

  else if (req.method === 'GET' && pathname === '/api/presets') {
    let presets = [
      { name: "Custom 1", ambientTemp: 20, cloudLevel: 0.1, rain: 0, weatherRandomness: 1 },
      { name: "Custom 2", ambientTemp: 22, cloudLevel: 0.2, rain: 0, weatherRandomness: 2 },
      { name: "Custom 3", ambientTemp: 18, cloudLevel: 0.6, rain: 0.1, weatherRandomness: 3 },
      { name: "Custom 4", ambientTemp: 15, cloudLevel: 0.9, rain: 0.5, weatherRandomness: 4 },
      { name: "Custom 5", ambientTemp: 15, cloudLevel: 0.9, rain: 0.5, weatherRandomness: 4 }
    ];
    if (fs.existsSync(PRESETS_PATH)) {
      try { presets = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8')); } catch(e){}
    } else {
      fs.writeFileSync(PRESETS_PATH, JSON.stringify(presets, null, 2), 'utf8');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(presets));
  }

  else if (req.method === 'POST' && pathname === '/api/presets') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        fs.writeFileSync(PRESETS_PATH, JSON.stringify(parsed, null, 2), 'utf8');
        res.writeHead(200);
        res.end('OK');
      } catch (err) {
        res.writeHead(500);
        res.end('Error saving presets');
      }
    });
  }

  else if (req.method === 'GET' && pathname === '/api/backup/export') {
    try {
      let configData = fs.existsSync(ROTATION_CONFIG_PATH) ? JSON.parse(fs.readFileSync(ROTATION_CONFIG_PATH, 'utf8')) : {};
      let banlistData = fs.existsSync(BANLIST_PATH) ? JSON.parse(fs.readFileSync(BANLIST_PATH, 'utf8')) : {};
      let bopData = fs.existsSync(getBopFilePath()) ? readJsonFileSync(getBopFilePath()) : {};
      let entrylistData = fs.existsSync(getEntrylistFilePath()) ? readJsonFileSync(getEntrylistFilePath()) : {};

      const backupBundle = {
        exportedAt: new Date().toISOString(),
        config: configData,
        banlist: banlistData,
        bop: bopData,
        entrylist: entrylistData
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename=ACC-RaceHost_backup.json'
      });
      res.end(JSON.stringify(backupBundle, null, 2));
    } catch (err) {
      res.writeHead(500);
      res.end('Error generating backup: ' + err.message);
    }
  }

  else if (req.method === 'POST' && pathname === '/api/backup/import') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const backup = JSON.parse(body);
        if (backup.config) fs.writeFileSync(ROTATION_CONFIG_PATH, JSON.stringify(backup.config, null, 2), 'utf8');
        if (backup.banlist) fs.writeFileSync(BANLIST_PATH, JSON.stringify(backup.banlist, null, 2), 'utf8');
        if (backup.bop) fs.writeFileSync(getBopFilePath(), JSON.stringify(backup.bop, null, 2), 'utf16le');
        if (backup.entrylist) fs.writeFileSync(getEntrylistFilePath(), JSON.stringify(backup.entrylist, null, 2), 'utf16le');

        syncEntrylistWithBanlist();
        res.writeHead(200);
        res.end('OK');
      } catch (err) {
        res.writeHead(500);
        res.end('Error restoring backup: ' + err.message);
      }
    });
  }

  else if (req.method === 'GET' && pathname === '/api/banlist') {
    let banData = { enabled: true, entries: [] };
    if (fs.existsSync(BANLIST_PATH)) {
      try {
        banData = JSON.parse(fs.readFileSync(BANLIST_PATH, 'utf8'));
      } catch (e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(banData));
  }

  else if (req.method === 'POST' && pathname === '/api/banlist') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        fs.writeFileSync(BANLIST_PATH, JSON.stringify(parsed, null, 2), 'utf8');
        syncEntrylistWithBanlist();
        res.writeHead(200);
        res.end('OK');
      } catch (err) {
        res.writeHead(500);
        res.end('Error saving banlist');
      }
    });
  }

  else if (req.method === 'GET' && pathname === '/api/results-files') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!fs.existsSync(RESULTS_DIR)) {
      return res.end(JSON.stringify([]));
    }

    try {
      const files = fs.readdirSync(RESULTS_DIR)
        .filter(f => f.toLowerCase().endsWith('.json'))
        .map(f => {
          const fullPath = path.join(RESULTS_DIR, f);
          return { name: f, mtime: fs.statSync(fullPath).mtime.getTime() };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 6);

      res.end(JSON.stringify(files));
    } catch (err) {
      console.error('Error listing results files:', err);
      res.end(JSON.stringify([]));
    }
  }

  else if (req.method === 'GET' && (pathname === '/api/session-results' || pathname === '/api/latest-results')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    
    if (!fs.existsSync(RESULTS_DIR)) {
      return res.end(JSON.stringify({ message: 'results folder does not exist yet.' }));
    }

    try {
      const files = fs.readdirSync(RESULTS_DIR)
        .filter(f => f.toLowerCase().endsWith('.json'))
        .map(f => {
          const fullPath = path.join(RESULTS_DIR, f);
          return { name: f, path: fullPath, mtime: fs.statSync(fullPath).mtime.getTime() };
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) {
        return res.end(JSON.stringify({ message: 'Waiting for Session Results.' }));
      }

      const fileNameParam = parsedUrl.searchParams.get('file');
      let targetFile = files[0];

      if (fileNameParam) {
        const found = files.find(f => f.name === path.basename(fileNameParam));
        if (found) targetFile = found;
      }

      const resultData = readJsonFileSync(targetFile.path);
      const driversMap = new Map();

      if (Array.isArray(resultData.sessionResult && resultData.sessionResult.leaderBoardLines)) {
        resultData.sessionResult.leaderBoardLines.forEach(line => {
          if (line.car && Array.isArray(line.car.drivers)) {
            line.car.drivers.forEach(d => {
              const pId = String(d.playerId || d.playerID || '');
              if (pId && !driversMap.has(pId)) {
                const fullName = `${d.firstName || ''} ${d.lastName || ''}`.trim() || 'Unknown Driver';
                driversMap.set(pId, { name: fullName, playerId: pId });
              }
            });
          }
        });
      }

      const driversList = Array.from(driversMap.values());

      res.end(JSON.stringify({
        filename: targetFile.name,
        trackName: resultData.trackName || '',
        sessionType: resultData.sessionType || '',
        drivers: driversList
      }));

    } catch (err) {
      console.error('Error reading session results:', err);
      res.end(JSON.stringify({ message: 'Error reading session results file: ' + err.message }));
    }
  }

  else if (req.method === 'GET' && pathname === '/api/script/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus()));
  }
  
  else if (req.method === 'POST' && pathname === '/api/script/start') {
    syncEntrylistWithBanlist();
    startRotation();
    res.writeHead(200);
    res.end('Started Rotation Mode');
  }

  else if (req.method === 'POST' && pathname === '/api/script/start-normal') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      let trackIndex = 0;
      try {
        const parsed = JSON.parse(body);
        if (parsed.trackIndex !== undefined) trackIndex = parsed.trackIndex;
      } catch (e) {}
      
      syncEntrylistWithBanlist();
      startNormal(trackIndex);
      res.writeHead(200);
      res.end('Started Normal Mode');
    });
  }
  
  else if (req.method === 'POST' && pathname === '/api/script/stop') {
    await stopRotation();
    res.writeHead(200);
    res.end('Stopped');
  }

  else if (req.method === 'POST' && pathname === '/api/app/shutdown') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Shutting down application...');
    try {
      await stopRotation();
    } catch (e) {}

    setTimeout(() => {
      process.exit(0);
    }, 500);
  }
  
  else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('ACC Race Host GUI Running at http://127.0.0.1:3030');
});