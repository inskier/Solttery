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
  <title>Solana Lottery</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 100%);
      color: #e2e8f0;
      font-family: 'Inter', sans-serif;
      padding: 20px;
      min-height: 100vh;
      line-height: 1.6;
    }
    
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    
    .header {
      text-align: center;
      margin-bottom: 40px;
    }
    
    .title {
      font-size: 2.5rem;
      font-weight: 600;
      color: #f8fafc;
      margin-bottom: 10px;
      letter-spacing: -0.025em;
    }
    
    .subtitle {
      font-size: 1.1rem;
      color: #94a3b8;
      font-weight: 300;
    }
    
    .section {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 24px;
      margin: 20px 0;
      backdrop-filter: blur(10px);
      transition: all 0.3s ease;
    }
    
    .section:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.2);
    }
    
    .label {
      font-weight: 500;
      color: #f1f5f9;
      margin-bottom: 12px;
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }
    
    .value {
      color: #e2e8f0;
      font-size: 1.1rem;
      font-weight: 400;
    }
    
    .status-active {
      color: #22c55e;
      font-weight: 500;
    }
    
    .status-processing {
      color: #f59e0b;
      font-weight: 500;
    }
    
    .status-complete {
      color: #3b82f6;
      font-weight: 500;
    }
    
    .address {
      font-size: 0.9rem;
      color: #cbd5e1;
      background: rgba(0, 0, 0, 0.2);
      padding: 8px 12px;
      margin: 6px 0;
      border-radius: 8px;
      font-family: 'Monaco', 'Menlo', monospace;
      border-left: 3px solid #3b82f6;
      transition: all 0.2s ease;
    }
    
    .address:hover {
      background: rgba(0, 0, 0, 0.3);
      transform: translateX(2px);
    }
    
    .wallet-address {
      font-size: 0.95rem;
      color: #f8fafc;
      background: rgba(59, 130, 246, 0.1);
      padding: 16px;
      margin: 12px 0;
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 12px;
      font-family: 'Monaco', 'Menlo', monospace;
      word-break: break-all;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    
    .wallet-address:hover {
      background: rgba(59, 130, 246, 0.15);
      border-color: rgba(59, 130, 246, 0.4);
    }
    
    .copy-button {
      background: #3b82f6;
      color: white;
      border: none;
      padding: 8px 16px;
      font-size: 0.8rem;
      font-weight: 500;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.2s ease;
      margin-left: 12px;
      flex-shrink: 0;
    }
    
    .copy-button:hover {
      background: #2563eb;
      transform: translateY(-1px);
    }
    
    .participants-bar {
      width: 100%;
      height: 8px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      margin: 16px 0;
      overflow: hidden;
    }
    
    .participants-fill {
      height: 100%;
      background: linear-gradient(90deg, #3b82f6, #22c55e);
      transition: width 0.5s ease;
      border-radius: 4px;
    }
    
    .instruction {
      font-size: 0.9rem;
      color: #94a3b8;
      margin-top: 8px;
      display: flex;
      align-items: center;
    }
    
    .instruction::before {
      content: '💡';
      margin-right: 8px;
    }
    
    .countdown {
      font-size: 0.8rem;
      color: #64748b;
      background: rgba(0, 0, 0, 0.2);
      padding: 4px 8px;
      border-radius: 4px;
      display: inline-block;
      margin: 4px 4px 0 0;
    }
    
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title">Solana Lottery</h1>
      <p class="subtitle">Decentralized lottery on the Solana blockchain</p>
    </div>
    
    <div class="section">
      <div class="label">Lottery Wallet Address</div>
      <div class="wallet-address" id="wallet-address" onclick="copyToClipboard(this.textContent)">
        <span id="wallet-text">Loading...</span>
        <button class="copy-button" onclick="event.stopPropagation(); copyToClipboard(document.getElementById('wallet-text').textContent)">Copy</button>
      </div>
      <div class="instruction">
        Send exactly 0.01 SOL to join the lottery
      </div>
    </div>
    
    <div class="grid">
      <div class="section">
        <div class="label">Status</div>
        <div class="value"><span id="status" class="status-active">Loading...</span></div>
      </div>
      
      <div class="section">
        <div class="label">Prize Pool</div>
        <div class="value" id="pool">0 SOL</div>
      </div>
      
      <div class="section">
        <div class="label">Wallet Balance</div>
        <div class="value" id="balance">0 SOL</div>
      </div>
    </div>
    
    <div class="section">
      <div class="label">Participants</div>
      <div class="value" id="participants">0 / 5</div>
      <div class="participants-bar">
        <div class="participants-fill" id="participants-bar" style="width: 0%"></div>
      </div>
    </div>
    
    <div class="section">
      <div class="label">Recent Depositors</div>
      <div id="recent-depositors" class="value">Scanning blockchain...</div>
    </div>
    
    <div class="section">
      <div class="label">Past Winners</div>
      <div id="past-winners" class="value">Loading...</div>
    </div>
    
    <div class="section">
      <div id="last-updated" style="font-size: 0.8rem; color: #64748b; margin-top: 16px;">Initializing...</div>
      <div style="margin-top: 8px;">
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
    
    function copyToClipboard(text) {
      const cleanText = text.trim();
      navigator.clipboard.writeText(cleanText).then(function() {
        const button = event.target;
        const originalText = button.textContent;
        button.textContent = 'Copied!';
        button.style.background = '#22c55e';
        setTimeout(() => {
          button.textContent = originalText;
          button.style.background = '#3b82f6';
        }, 1500);
      }).catch(function() {
        const textArea = document.createElement('textarea');
        textArea.value = cleanText;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      });
    }
    
    setInterval(countdown, 1000);

    async function fetchAndUpdate() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        
        // Update wallet address
        document.getElementById('wallet-text').textContent = data.wallet;
        
        // Update status
        const statusEl = document.getElementById('status');
        statusEl.textContent = data.status;
        statusEl.className = 'status-' + data.status.toLowerCase();
        
        // Update participants with progress bar
        document.getElementById('participants').textContent = data.participants + ' / 5';
        const percentage = (data.participants / 5) * 100;
        document.getElementById('participants-bar').style.width = percentage + '%';
        
        document.getElementById('pool').textContent = data.pool + ' SOL';
        document.getElementById('balance').textContent = data.balance + ' SOL';
        
        // Update depositors
        document.getElementById('recent-depositors').innerHTML = data.recentDepositors.map(function(addr) {
          return '<div class="address">' + addr + '</div>';
        }).join('') || '<div class="address">No recent activity</div>';
        
        // Update winners
        document.getElementById('past-winners').innerHTML = data.pastWinners.map(function(addr) {
          return '<div class="address">' + addr + '</div>';
        }).join('') || '<div class="address">No winners yet</div>';
        
        const now = new Date().toLocaleTimeString();
        document.getElementById('last-updated').textContent = 'Last updated: ' + now;
      } catch (e) {
        console.error('Update failed', e);
        document.getElementById('status').textContent = 'Connection Error';
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
