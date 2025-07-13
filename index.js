// Autonomous Solana Lottery System - Updated with Dark Theme UI, Deposit Status & Wallet Balance
const solanaWeb3 = require('@solana/web3.js');
const express = require('express');
const { Server } = require('ws');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs').promises;
const http = require('http');
const rateLimit = require('express-rate-limit');

const LOTTERY_ENTRY_AMOUNT = 0.01 * solanaWeb3.LAMPORTS_PER_SOL;
const WINNING_PAYOUT = 0.04 * solanaWeb3.LAMPORTS_PER_SOL;
const MAX_PARTICIPANTS = 5;
const PORT = 3000;
const STATE_FILE = 'lottery-state.json';
const NETWORK = process.env.SOLANA_NETWORK || 'mainnet-beta';
const MAX_TRANSACTIONS_SEEN = 1000;
const MINIMUM_FEE_LAMPORTS = 5000;

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
  recentDeposits: [],
  balance: 0
};

async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    lotteryState = JSON.parse(data);
    lotteryState.transactionsSeen = new Set(lotteryState.transactionsSeen || []);
  } catch {
    console.log('No saved state. Starting new lottery.');
  }
}

async function saveState() {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify({
      ...lotteryState,
      transactionsSeen: Array.from(lotteryState.transactionsSeen).slice(-MAX_TRANSACTIONS_SEEN)
    }));
  } catch (error) {
    console.error('Failed to save state:', error);
  }
}

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });
app.use(bodyParser.json());
app.use('/status', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

app.get('/', (req, res) => {
  const wsProtocol = req.protocol === 'https' ? 'wss' : 'ws';
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Solana Lottery</title>
  <style>
    body {
      background-color: #121212;
      color: #e0e0e0;
      font-family: Arial, sans-serif;
      padding: 20px;
    }
    #lottery-status, #recent-deposits, #wallet-balance {
      margin-top: 20px;
      padding: 10px;
      background-color: #1e1e1e;
      border-radius: 5px;
    }
  </style>
  <script src="https://unpkg.com/@solana/web3.js@latest/lib/index.iife.js"></script>
</head>
<body>
  <h1>Solana Lottery</h1>
  <div>Lottery Wallet Address: ${LOTTERY_ADDRESS}</div>
  <div id="wallet-balance">Wallet Balance: Loading...</div>
  <div id="lottery-status">Loading...</div>
  <div id="recent-deposits">Recent Deposits:</div>
  <script>
    const ws = new WebSocket('${wsProtocol}://' + location.host);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      document.getElementById('lottery-status').innerText =
        'Participants: ' + data.participants.length + ' | Pool: ' + data.pool + ' SOL | Status: ' + data.status;
      const deposits = data.recentDeposits || [];
      document.getElementById('recent-deposits').innerHTML =
  '<strong>Recent Deposits:</strong><ul>' +
  deposits.map(d => `<li>${d}</li>`).join('') +
  '</ul>';
      document.getElementById('wallet-balance').innerText = 'Wallet Balance: ' + data.balance + ' SOL';
    };
  </script>
</body>
</html>`);
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(lotteryState));
});

function broadcastState(error = null) {
  const payload = error ? { error } : lotteryState;
  wss.clients.forEach(client => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });
}

async function monitorTransactions() {
  connection.onLogs(LOTTERY_WALLET.publicKey, async (logInfo) => {
    try {
      const signature = logInfo.signature;
      if (lotteryState.transactionsSeen.has(signature) || lotteryState.status !== 'Active') return;
      lotteryState.transactionsSeen.add(signature);

      const tx = await connection.getTransaction(signature, { commitment: 'confirmed' });
      if (!tx || !tx.meta || tx.meta.err) return;

      const sender = tx.transaction.message.accountKeys[0].toBase58();
      const recipient = tx.transaction.message.accountKeys[1].toBase58();
      const pre = tx.meta.preBalances[1];
      const post = tx.meta.postBalances[1];
      const amount = pre - post;

      if (recipient === LOTTERY_WALLET.publicKey.toBase58() && amount === LOTTERY_ENTRY_AMOUNT) {
        lotteryState.participants.push(sender);
        lotteryState.pool += 0.01;
        lotteryState.recentDeposits.unshift(sender);
        if (lotteryState.recentDeposits.length > 10) lotteryState.recentDeposits.pop();
        await updateBalance();
        await saveState();
        broadcastState();

        if (lotteryState.participants.length === MAX_PARTICIPANTS) {
          await pickWinner();
        }
      }
    } catch (error) {
      broadcastState('Transaction error: ' + error.message);
    }
  }, 'confirmed');
}

async function updateBalance() {
  try {
    const balanceLamports = await connection.getBalance(LOTTERY_WALLET.publicKey);
    lotteryState.balance = (balanceLamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(4);
  } catch (error) {
    console.error('Balance fetch failed:', error);
  }
}

async function pickWinner() {
  try {
    lotteryState.status = 'Processing';
    broadcastState();
    await saveState();

    const winnerIndex = crypto.randomInt(0, MAX_PARTICIPANTS);
    const winnerAddress = lotteryState.participants[winnerIndex];
    const toPubkey = new solanaWeb3.PublicKey(winnerAddress);
    const tx = new solanaWeb3.Transaction().add(
      solanaWeb3.SystemProgram.transfer({
        fromPubkey: LOTTERY_WALLET.publicKey,
        toPubkey,
        lamports: WINNING_PAYOUT
      })
    );

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    await solanaWeb3.sendAndConfirmTransaction(connection, tx, [LOTTERY_WALLET]);

    lotteryState.winner = winnerAddress;
    lotteryState.status = 'Complete';
    await updateBalance();
    await saveState();
    broadcastState();
    setTimeout(resetLottery, 10000);
  } catch (e) {
    lotteryState.status = 'Error';
    broadcastState('Payout error: ' + e.message);
    setTimeout(resetLottery, 15000);
  }
}

async function resetLottery() {
  lotteryState = {
    participants: [],
    pool: 0,
    status: 'Active',
    winner: null,
    transactionsSeen: new Set(),
    recentDeposits: [],
    balance: lotteryState.balance || 0
  };
  await saveState();
  broadcastState();
}

async function start() {
  await loadState();
  await updateBalance();
  monitorTransactions();
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start();
