require('dotenv').config();
const solanaWeb3 = require('@solana/web3.js');
const express = require('express');
const { Server } = require('ws');
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
        if (process.env.NODE_ENV !== 'production') {
            const stats = await fs.stat(STATE_FILE);
            if (Date.now() - stats.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
                await fs.mkdir('backup', { recursive: true });
                await fs.rename(STATE_FILE, `backup/lottery-state-${Date.now()}.json`);
                logger.info('Old state file archived');
            }
        }
    } catch (error) {
        logger.error('Failed to save state', { error: error.message });
    }
}

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });
app.use(bodyParser.json());

app.use('/status', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Solana Lottery</title>
  <style>
    body {
      background-color: #0f0f0f;
      color: #00ff88;
      font-family: monospace;
      padding: 20px;
    }
    h1 {
      color: #ffaa00;
      text-align: center;
    }
    .section {
      border: 1px solid #00ff88;
      padding: 15px;
      margin: 10px 0;
      background: #1a1a1a;
      border-radius: 5px;
    }
    .label {
      font-weight: bold;
    }
    .address {
      font-size: 12px;
      color: #66ffcc;
    }
  </style>
  <script>
    async function fetchAndUpdate() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        document.getElementById('status').innerText = data.status;
        document.getElementById('participants').innerText = data.participants + ' / ${MAX_PARTICIPANTS}';
        document.getElementById('pool').innerText = data.pool + ' SOL';
        document.getElementById('balance').innerText = data.balance + ' SOL';
        document.getElementById('recent-depositors').innerHTML = data.recentDepositors.map(addr => `<div class='address'>${addr}</div>`).join('') || 'None yet';
        document.getElementById('past-winners').innerHTML = data.pastWinners.map(addr => `<div class='address'>${addr}</div>`).join('') || 'None yet';
      } catch (e) {
        console.error('Update failed', e);
      }
    }
    setInterval(fetchAndUpdate, 3000);
    window.onload = fetchAndUpdate;
  </script>
</head>
<body>
  <h1>🎰 Solana Lottery</h1>
  <div class="section">
    <div class="label">Status:</div> <div id="status"></div>
  </div>
  <div class="section">
    <div class="label">Participants:</div> <div id="participants"></div>
  </div>
  <div class="section">
    <div class="label">Pool:</div> <div id="pool"></div>
  </div>
  <div class="section">
    <div class="label">Recent Depositors:</div>
    <div id="recent-depositors"></div>
  </div>
  <div class="section">
    <div class="label">Past Winners:</div>
    <div id="past-winners"></div>
  </div>
  <div class="section">
    <div class="label">Wallet Balance:</div> <div id="balance"></div>
  </div>
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

start();
