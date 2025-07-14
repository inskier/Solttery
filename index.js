require('dotenv').config();
const solanaWeb3 = require('@solana/web3.js');
const express = require('express');
const { Server } = require('ws');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs').promises;
const http = require('http');
const rateLimit = require('express-rate-limit');
const winston = require('winston');

const LOTTERY_ENTRY_AMOUNT = 0.01 * solanaWeb3.LAMPORTS_PER_SOL;
const WINNING_PAYOUT = 0.04 * solanaWeb3.LAMPORTS_PER_SOL;
const MAX_PARTICIPANTS = 5;
const PORT = process.env.PORT || 3000;
const STATE_FILE = 'lottery-state.json';
const NETWORK = process.env.SOLANA_NETWORK || 'mainnet-beta';
const MAX_TRANSACTIONS_SEEN = 1000;
const MINIMUM_FEE_LAMPORTS = 5000;

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'lottery.log' })
    ]
});

const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl(NETWORK), 'confirmed');

const secretKey = Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY_JSON || '[]'));
const LOTTERY_WALLET = solanaWeb3.Keypair.fromSecretKey(secretKey);
const LOTTERY_ADDRESS = LOTTERY_WALLET.publicKey.toBase58();

let lotteryState = {
    participants: [],
    pool: 0,
    status: 'Active',
    winner: null,
    transactionsSeen: new Set(),
    recentDepositors: [],
    pastWinners: [],
    balance: 0
};

async function loadState() {
    try {
        const data = await fs.readFile(STATE_FILE, 'utf8');
        lotteryState = JSON.parse(data);
        lotteryState.transactionsSeen = new Set(lotteryState.transactionsSeen || []);
        lotteryState.recentDepositors = lotteryState.recentDepositors || [];
        lotteryState.pastWinners = lotteryState.pastWinners || [];
        logger.info('State loaded successfully');
    } catch {
        logger.info('No previous state found, starting fresh');
    }
}

async function saveState() {
    try {
        await fs.writeFile(STATE_FILE, JSON.stringify({
            ...lotteryState,
            transactionsSeen: Array.from(lotteryState.transactionsSeen).slice(-MAX_TRANSACTIONS_SEEN)
        }));

        try {
            const stats = await fs.stat(STATE_FILE);
            if (Date.now() - stats.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
                await fs.mkdir('backup', { recursive: true });
                await fs.rename(STATE_FILE, `backup/lottery-state-${Date.now()}.json`);
                logger.info('Old state file archived');
            }
        } catch (backupError) {
            logger.warn('Backup failed', { error: backupError.message });
        }
    } catch (error) {
        logger.error('Failed to save state', { error: error.message });
    }
}

function broadcastState(error = null) {
    const payload = error ? { error } : lotteryState;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    });
}

async function updateBalance() {
    try {
        const balanceLamports = await connection.getBalance(LOTTERY_WALLET.publicKey);
        lotteryState.balance = (balanceLamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(4);
        await saveState();
        broadcastState();
    } catch (error) {
        logger.error('Balance fetch failed', { error: error.message });
    }
}

async function pickWinner() {
    try {
        lotteryState.status = 'Processing';
        broadcastState();
        await saveState();

        const winnerIndex = crypto.randomInt(0, lotteryState.participants.length);
        const winnerAddress = lotteryState.participants[winnerIndex];
        const toPubkey = new solanaWeb3.PublicKey(winnerAddress);
        const { blockhash } = await connection.getLatestBlockhash();

        const tx = new solanaWeb3.Transaction().add(
            solanaWeb3.SystemProgram.transfer({
                fromPubkey: LOTTERY_WALLET.publicKey,
                toPubkey,
                lamports: WINNING_PAYOUT
            })
        );

        tx.recentBlockhash = blockhash;
        tx.feePayer = LOTTERY_WALLET.publicKey;

        const feeEstimate = await connection.getFeeForMessage(tx.compileMessage());
        const balance = await connection.getBalance(LOTTERY_WALLET.publicKey);
        if (balance < WINNING_PAYOUT + (feeEstimate.value || MINIMUM_FEE_LAMPORTS)) {
            throw new Error('Insufficient funds for payout');
        }

        const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [LOTTERY_WALLET]);

        logger.info(`Winner selected: ${winnerAddress}, TX: ${signature}`);
        lotteryState.winner = winnerAddress;
        lotteryState.status = 'Complete';
        lotteryState.pastWinners.unshift(winnerAddress);
        if (lotteryState.pastWinners.length > 5) lotteryState.pastWinners.pop();

        await saveState();
        broadcastState();
        setTimeout(resetLottery, 10000);
    } catch (error) {
        logger.error('Error selecting winner', { error: error.message });
        lotteryState.status = 'Error';
        broadcastState(`Error selecting winner: ${error.message}`);
        setTimeout(resetLottery, 10000);
    }
}

async function resetLottery() {
    lotteryState = {
        participants: [],
        pool: 0,
        status: 'Active',
        winner: null,
        transactionsSeen: new Set(),
        recentDepositors: [],
        pastWinners: lotteryState.pastWinners,
        balance: lotteryState.balance
    };
    await saveState();
    broadcastState();
    logger.info('Lottery reset');
}

async function monitorTransactions() {
    connection.onLogs(LOTTERY_WALLET.publicKey, async (logInfo) => {
        try {
            if (lotteryState.participants.length >= MAX_PARTICIPANTS || lotteryState.status !== 'Active') return;

            const signature = logInfo.signature;
            if (lotteryState.transactionsSeen.has(signature)) return;

            lotteryState.transactionsSeen.add(signature);
            if (lotteryState.transactionsSeen.size > MAX_TRANSACTIONS_SEEN) {
                const oldest = Array.from(lotteryState.transactionsSeen)[0];
                lotteryState.transactionsSeen.delete(oldest);
            }

            const tx = await connection.getTransaction(signature, { commitment: 'confirmed' });
            if (!tx || !tx.meta || tx.meta.err) return;

            const sender = tx.transaction.message.accountKeys[0].toBase58();
            const recipient = tx.transaction.message.accountKeys[1].toBase58();
            const pre = tx.meta.preBalances[1];
            const post = tx.meta.postBalances[1];
            const amount = pre - post;

            if (recipient === LOTTERY_ADDRESS && amount === LOTTERY_ENTRY_AMOUNT) {
                if (!lotteryState.participants.includes(sender)) {
                    logger.info(`Valid entry from ${sender}`, { signature });
                    lotteryState.participants.push(sender);
                    lotteryState.pool += 0.01;
                    lotteryState.recentDepositors.unshift(sender);
                    if (lotteryState.recentDepositors.length > 5) lotteryState.recentDepositors.pop();
                    await updateBalance();
                    await saveState();
                    broadcastState();

                    if (lotteryState.participants.length === MAX_PARTICIPANTS) {
                        await pickWinner();
                    }
                }
            }
        } catch (error) {
            logger.error('Transaction monitoring error', { error: error.message });
        }
    }, 'confirmed');
}

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

app.use(bodyParser.json());
app.use(express.static('public'));

app.use('/status', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>🎰 SOLANA LOTTERY ARCADE 🎰</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
    
    * {
      box-sizing: border-box;
      image-rendering: pixelated;
      image-rendering: -moz-crisp-edges;
      image-rendering: crisp-edges;
    }
    
    body {
      background: linear-gradient(45deg, #0a0a0a 25%, #1a1a1a 25%, #1a1a1a 50%, #0a0a0a 50%, #0a0a0a 75%, #1a1a1a 75%, #1a1a1a);
      background-size: 20px 20px;
      color: #00ff41;
      font-family: 'Press Start 2P', monospace;
      padding: 10px;
      margin: 0;
      min-height: 100vh;
      animation: scanlines 0.1s linear infinite;
    }
    
    @keyframes scanlines {
      0% { background-position: 0 0; }
      100% { background-position: 20px 20px; }
    }
    
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0, 255, 65, 0.03) 2px,
        rgba(0, 255, 65, 0.03) 4px
      );
      pointer-events: none;
      z-index: 1000;
    }
    
    .container {
      max-width: 800px;
      margin: 0 auto;
      position: relative;
      z-index: 10;
    }
    
    .header {
      text-align: center;
      margin-bottom: 30px;
      position: relative;
    }
    
    .title {
      font-size: 20px;
      color: #ffff00;
      text-shadow: 
        2px 2px 0px #ff0000,
        4px 4px 0px #00ff00,
        6px 6px 0px #0000ff;
      margin: 20px 0;
      animation: titleGlow 2s ease-in-out infinite alternate;
    }
    
    @keyframes titleGlow {
      from { 
        text-shadow: 
          2px 2px 0px #ff0000,
          4px 4px 0px #00ff00,
          6px 6px 0px #0000ff;
      }
      to { 
        text-shadow: 
          2px 2px 0px #ff4444,
          4px 4px 0px #44ff44,
          6px 6px 0px #4444ff,
          0 0 20px #ffff00;
      }
    }
    
    .mario-coin {
      display: inline-block;
      width: 24px;
      height: 24px;
      background: #ffff00;
      border-radius: 50%;
      margin: 0 10px;
      animation: coinSpin 1s linear infinite;
      position: relative;
      box-shadow: 
        inset -3px -3px 0px #cccc00,
        inset 3px 3px 0px #ffffff;
    }
    
    .mario-coin::before {
      content: 'S';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 12px;
      color: #cc8800;
      font-weight: bold;
    }
    
    @keyframes coinSpin {
      0% { transform: rotateY(0deg); }
      50% { transform: rotateY(90deg) scaleX(0.3); }
      100% { transform: rotateY(180deg); }
    }
    
    .section {
      border: 3px solid #00ff41;
      border-style: ridge;
      padding: 20px;
      margin: 15px 0;
      background: 
        linear-gradient(135deg, #001100 0%, #003300 50%, #001100 100%),
        repeating-linear-gradient(
          45deg,
          #001100,
          #001100 2px,
          #002200 2px,
          #002200 4px
        );
      position: relative;
      box-shadow: 
        inset 0 0 20px rgba(0, 255, 65, 0.3),
        0 0 20px rgba(0, 255, 65, 0.2);
    }
    
    .section::before {
      content: '';
      position: absolute;
      top: -3px;
      left: -3px;
      right: -3px;
      bottom: -3px;
      background: linear-gradient(45deg, #00ff41, #ffff00, #ff0000, #00ff41);
      z-index: -1;
      border-radius: 5px;
    }
    
    .section:hover {
      animation: sectionPulse 0.5s ease-in-out;
    }
    
    @keyframes sectionPulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.02); }
      100% { transform: scale(1); }
    }
    
    .label {
      font-weight: bold;
      color: #ffffff;
      text-shadow: 1px 1px 0px #000000;
      margin-bottom: 10px;
      display: block;
      font-size: 12px;
    }
    
    .value {
      color: #00ff41;
      font-size: 14px;
      text-shadow: 0 0 10px #00ff41;
      margin-left: 10px;
    }
    
    .status-active {
      color: #00ff00;
      animation: statusBlink 1s ease-in-out infinite;
    }
    
    .status-processing {
      color: #ffff00;
      animation: statusBlink 0.3s ease-in-out infinite;
    }
    
    .status-complete {
      color: #ff6600;
      animation: statusBlink 2s ease-in-out infinite;
    }
    
    @keyframes statusBlink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0.3; }
    }
    
    .address {
      font-size: 10px;
      color: #66ffcc;
      background: #000033;
      padding: 5px;
      margin: 3px 0;
      border-left: 3px solid #00ff41;
      font-family: 'Courier New', monospace;
      text-shadow: 0 0 5px #66ffcc;
    }
    
    .address:hover {
      background: #000066;
      transform: translateX(5px);
      transition: all 0.2s ease;
    }
    
    .participants-bar {
      width: 100%;
      height: 20px;
      background: #330000;
      border: 2px solid #ff0000;
      margin: 10px 0;
      position: relative;
      overflow: hidden;
    }
    
    .participants-fill {
      height: 100%;
      background: linear-gradient(90deg, #ff0000, #ffff00, #00ff00);
      transition: width 0.5s ease;
      position: relative;
    }
    
    .participants-fill::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent);
      animation: shimmer 2s infinite;
    }
    
    @keyframes shimmer {
      0% { left: -100%; }
      100% { left: 100%; }
    }
    
    .countdown {
      font-size: 8px;
      color: #666;
      background: #000;
      padding: 5px;
      border: 1px solid #333;
      display: inline-block;
      margin: 5px;
    }
    
    .power-up {
      display: inline-block;
      width: 16px;
      height: 16px;
      background: #ff0000;
      margin: 0 5px;
      animation: powerUpFloat 2s ease-in-out infinite;
      position: relative;
    }
    
    .power-up::before {
      content: '⚡';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 10px;
      color: #ffffff;
    }
    
    @keyframes powerUpFloat {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-3px); }
    }
    
    .retro-button {
      background: linear-gradient(45deg, #ff0000, #ff4444);
      border: 3px solid #ffffff;
      color: #ffffff;
      font-family: 'Press Start 2P', monospace;
      font-size: 10px;
      padding: 10px 20px;
      cursor: pointer;
      text-shadow: 1px 1px 0px #000000;
      box-shadow: 
        inset 0 0 10px rgba(255, 255, 255, 0.2),
        0 4px 0px #cc0000;
      transition: all 0.1s ease;
    }
    
    .retro-button:hover {
      transform: translateY(2px);
      box-shadow: 
        inset 0 0 10px rgba(255, 255, 255, 0.3),
        0 2px 0px #cc0000;
    }
    
    .pixel-art {
      display: inline-block;
      width: 20px;
      height: 20px;
      background: 
        linear-gradient(to right, #ff0000 0%, #ff0000 25%, #ffff00 25%, #ffff00 50%, #00ff00 50%, #00ff00 75%, #0000ff 75%, #0000ff 100%);
      margin: 0 5px;
      animation: pixelRotate 3s linear infinite;
    }
    
    @keyframes pixelRotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    .dos-cursor {
      animation: dosCursor 1s step-start infinite;
    }
    
    @keyframes dosCursor {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="mario-coin"></div>
      <h1 class="title">🎰 SOLANA LOTTERY ARCADE 🎰</h1>
      <div class="mario-coin"></div>
      <div class="pixel-art"></div>
      <div class="power-up"></div>
      <div class="pixel-art"></div>
    </div>
    
    <div class="section">
      <div class="label">[ SYSTEM STATUS ]</div>
      <div class="value"><span id="status" class="status-active">LOADING...</span><span class="dos-cursor">_</span></div>
    </div>
    
    <div class="section">
      <div class="label">[ PARTICIPANTS ONLINE ]</div>
      <div class="value" id="participants">0 / 5</div>
      <div class="participants-bar">
        <div class="participants-fill" id="participants-bar" style="width: 0%"></div>
      </div>
    </div>
    
    <div class="section">
      <div class="label">[ PRIZE POOL ]</div>
      <div class="value" id="pool">0 SOL</div>
      <div class="mario-coin"></div>
    </div>
    
    <div class="section">
      <div class="label">[ RECENT DEPOSITORS ]</div>
      <div id="recent-depositors" class="value">Scanning blockchain...</div>
    </div>
    
    <div class="section">
      <div class="label">[ HALL OF FAME ]</div>
      <div id="past-winners" class="value">Loading champions...</div>
    </div>
    
    <div class="section">
      <div class="label">[ WALLET BALANCE ]</div>
      <div class="value" id="balance">0 SOL</div>
      <div id="last-updated" style="font-size: 8px; color: #888; margin-top: 10px;">Initializing...</div>
      <div style="font-size: 8px; color: #444; margin-top: 5px;">
        <span class="countdown">Balance update: <span id="countdown-balance">5s</span></span>
        <span class="countdown">TX scan: <span id="countdown-tx">3s</span></span>
      </div>
    </div>
  </div>
  <script>
    let balanceCountdown = 5;
    let txCountdown = 3;
    
    function countdown() {
      document.getElementById('countdown-balance').innerText = balanceCountdown + 's';
      document.getElementById('countdown-tx').innerText = txCountdown + 's';
      if (--balanceCountdown < 0) balanceCountdown = 5;
      if (--txCountdown < 0) txCountdown = 3;
    }
    
    setInterval(countdown, 1000);

    async function fetchAndUpdate() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        
        // Update status with appropriate styling
        const statusEl = document.getElementById('status');
        statusEl.innerText = data.status;
        statusEl.className = 'status-' + data.status.toLowerCase();
        
        // Update participants with progress bar
        document.getElementById('participants').innerText = data.participants + ' / 5';
        const percentage = (data.participants / 5) * 100;
        document.getElementById('participants-bar').style.width = percentage + '%';
        
        document.getElementById('pool').innerText = data.pool + ' SOL';
        document.getElementById('balance').innerText = data.balance + ' SOL';
        
        // Enhanced depositors display
        document.getElementById('recent-depositors').innerHTML = data.recentDepositors.map(function(addr) {
          return '<div class="address">' + addr + '</div>';
        }).join('') || '<div class="address">[ NO RECENT ACTIVITY ]</div>';
        
        // Enhanced winners display
        document.getElementById('past-winners').innerHTML = data.pastWinners.map(function(addr) {
          return '<div class="address">🏆 ' + addr + '</div>';
        }).join('') || '<div class="address">[ NO CHAMPIONS YET ]</div>';
        
        const now = new Date().toLocaleTimeString();
        document.getElementById('last-updated').innerText = '> LAST_UPDATE: ' + now;
      } catch (e) {
        console.error('Update failed', e);
        document.getElementById('status').innerText = 'CONNECTION_ERROR';
        document.getElementById('status').className = 'status-error';
      }
    }
    
    setInterval(fetchAndUpdate, 3000);
    window.onload = fetchAndUpdate;
  </script>
</body>
</html>`);
});

app.get('/status', (req, res) => {
    res.json({
        participants: lotteryState.participants.length,
        pool: lotteryState.pool,
        status: lotteryState.status,
        wallet: LOTTERY_ADDRESS,
        winner: lotteryState.winner,
        balance: lotteryState.balance,
        recentDepositors: lotteryState.recentDepositors,
        pastWinners: lotteryState.pastWinners
    });
});

wss.on('connection', (ws) => {
    ws.send(JSON.stringify(lotteryState));
    ws.onmessage = (message) => {
        try {
            const data = JSON.parse(message.data);
            if (data.action === 'updateBalance') {
                lotteryState.balance = data.balance;
                broadcastState();
            }
        } catch (error) {
            ws.send(JSON.stringify({ error: 'Messages not supported or invalid' }));
        }
    };
});

async function start() {
    await fs.mkdir('backup', { recursive: true });
    await loadState();
    await updateBalance();
    monitorTransactions();
    server.listen(PORT, () => logger.info(`Lottery server running on port ${PORT}`));
}

start();
