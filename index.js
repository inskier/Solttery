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
        const feeEstimate = await connection.getFeeForMessage(
            new solanaWeb3.TransactionMessage({
                payerKey: LOTTERY_WALLET.publicKey,
                recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
                instructions: []
            }).compileToV0Message()
        );
        const required = WINNING_PAYOUT + (feeEstimate.value || 5000);
        const balance = await connection.getBalance(LOTTERY_WALLET.publicKey);
        if (balance < required) throw new Error('Insufficient funds for payout + fee');

        lotteryState.status = 'Processing';
        broadcastState();
        await saveState();

        const winnerIndex = crypto.randomInt(0, lotteryState.participants.length);
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
        tx.feePayer = LOTTERY_WALLET.publicKey;

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
            const signature = logInfo.signature;
            if (lotteryState.transactionsSeen.has(signature) || lotteryState.status !== 'Active') return;
            if (lotteryState.participants.length >= MAX_PARTICIPANTS) return;

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
app.use('/status', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

app.get('/', (req, res) => {
    res.send(`<html><body><script>setInterval(()=>location.reload(),15000)</script><h1 style='color:white;background:black;font-family:monospace;padding:2em'>Solana Lottery</h1><p>Balance: <span id="balance"></span></p><script>fetch('/status').then(r=>r.json()).then(d=>document.getElementById('balance').innerText=d.balance)</script></body></html>`);
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
});

async function start() {
    await fs.mkdir('backup', { recursive: true });
    await loadState();
    await updateBalance();
    monitorTransactions();
    server.listen(PORT, () => logger.info(`Lottery server running on port ${PORT}`));
}

start().catch(err => {
    logger.error('Fatal startup error', { error: err.message });
    console.error('Startup failed:', err);
});
