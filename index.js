require('dotenv').config();
// Autonomous Solana Lottery System - Pixelated Retro Style with Balance Countdown
const solanaWeb3 = require('@solana/web3.js');
const express = require('express');
const { Server } = require('ws');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs').promises;
const http = require('http');
const rateLimit = require('express-rate-limit');
const winston = require('winston');

// Configuration
const LOTTERY_ENTRY_AMOUNT = 0.01 * solanaWeb3.LAMPORTS_PER_SOL; // 0.01 SOL
const WINNING_PAYOUT = 0.04 * solanaWeb3.LAMPORTS_PER_SOL; // 0.04 SOL
const MAX_PARTICIPANTS = 5;
const PORT = process.env.PORT; // Use Render's dynamically assigned port
const STATE_FILE = 'lottery-state.json';
const NETWORK = process.env.SOLANA_NETWORK || 'mainnet-beta'; // Configurable: 'devnet' or 'mainnet-beta'
const MAX_TRANSACTIONS_SEEN = 1000;
const MINIMUM_FEE_LAMPORTS = 5000;

// Logging Setup
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

// Blockchain Connection
const connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl(NETWORK), 'confirmed');

// Wallet Setup
// Private key handled via Render environment settings
const secretKey = Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY_JSON || '[]'));
const LOTTERY_WALLET = solanaWeb3.Keypair.fromSecretKey(secretKey);
const LOTTERY_ADDRESS = LOTTERY_WALLET.publicKey.toBase58();

// Lottery State
let lotteryState = {
    participants: [],
    pool: 0,
    status: 'Active',
    winner: null,
    transactionsSeen: new Set(),
    recentDepositors: [], // Track last 5 depositors
    pastWinners: [],     // Track last 5 winners
    balance: 0           // Outstanding balance
};

// Load/Save State
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

// Express Server
const app = express();
const server = http.createServer(app);
const wss = new Server({ server });
app.use(bodyParser.json());

// Rate Limiting
app.use('/status', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// Serve Frontend
const wsProtocol = process.env.NODE_ENV === 'production' ? 'wss' : 'ws';
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Solana Retro Lottery</title>
            <script src="https://unpkg.com/@solana/web3.js@latest/lib/index.iife.js"></script>
            <script src="https://unpkg.com/lucide@0.4.0/dist/umd/lucide.min.js"></script>
            <style>
                @font-face {
                    font-family: 'PixelFont';
                    src: url('https://fonts.cdnfonts.com/s/174984/PressStart2P-Regular.woff') format('woff');
                }
                body {
                    font-family: 'PixelFont', monospace;
                    margin: 0;
                    padding: 0;
                    min-height: 100vh;
                    background: #1a263a;
                    color: #00cc00;
                    image-rendering: pixelated;
                }
                .container {
                    max-width: 400px;
                    margin: 10px auto;
                    padding: 10px;
                    border: 2px solid #00cc00;
                    background: #0f1a2a;
                }
                h1 {
                    text-align: center;
                    font-size: 24px;
                    margin: 10px 0;
                    color: #ff6600;
                    text-shadow: 1px 1px 0 #000;
                }
                .retro-card {
                    border: 2px solid #00cc00;
                    background: #1a2f4a;
                    padding: 8px;
                    margin-bottom: 10px;
                    image-rendering: pixelated;
                }
                .retro-grid {
                    display: grid;
                    gap: 10px;
                    margin-bottom: 10px;
                }
                .address {
                    font-size: 12px;
                    word-break: break-all;
                    color: #66ff66;
                }
                .balance, .depositors, .winners, .countdown {
                    margin: 5px 0;
                    font-size: 12px;
                }
                .button {
                    padding: 8px;
                    background: #ff6600;
                    color: #0f1a2a;
                    border: 2px solid #000;
                    border-radius: 0;
                    cursor: pointer;
                    font-size: 12px;
                    width: 100%;
                    image-rendering: pixelated;
                }
                .button:hover {
                    background: #ff9944;
                }
                .button:disabled {
                    background: #444;
                    cursor: not-allowed;
                }
                .loader {
                    border: 2px solid #444;
                    border-top: 2px solid #ff6600;
                    border-radius: 50%;
                    width: 16px;
                    height: 16px;
                    animation: spin 0.5s linear infinite;
                    margin: 0 auto;
                    display: inline-block;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .network-indicator {
                    font-size: 10px;
                    color: #66ff66;
                    text-align: center;
                    margin-bottom: 5px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔳 SOLANA LOTTERY</h1>
                <div class="network-indicator">NET: ${NETWORK}</div>
                <div class="retro-grid">
                    <div class="retro-card">
                        <h2><i data-lucide="wallet" style="width:16px;height:16px"></i> WALLET</h2>
                        <div class="address">${LOTTERY_ADDRESS}</div>
                        <p>SEND 0.01 SOL</p>
                        <div class="balance" id="wallet-balance">BAL: Loading...</div>
                        <div class="countdown" id="countdown">CHECK: 5s (Balance checked last time: N/A)</div>
                    </div>
                    <div class="retro-card">
                        <h2><i data-lucide="coin" style="width:16px;height:16px"></i> JOIN</h2>
                        <button id="join-lottery" class="button">SEND 0.01 SOL</button>
                        <div id="error-message" style="color:#ff4444"></div>
                    </div>
                </div>
                <div class="retro-card">
                    <h2><i data-lucide="users" style="width:16px;height:16px"></i> DEPOSITORS</h2>
                    <div id="recent-depositors"></div>
                </div>
                <div class="retro-card">
                    <h2><i data-lucide="trophy" style="width:16px;height:16px"></i> WINNERS</h2>
                    <div id="past-winners"></div>
                </div>
                <div class="retro-card">
                    <h2><i data-lucide="info" style="width:16px;height:16px"></i> STATUS</h2>
                    <div id="lottery-status"></div>
                </div>
                <script>
                    const LOTTERY_ADDRESS = '${LOTTERY_ADDRESS}'; // Pass as a client-side variable
                    const NETWORK = '${NETWORK}'; // Pass as a client-side variable
                    const wsProtocol = '${wsProtocol.replace(/'/g, "\\'")}'; // Escape single quotes and pass as a client-side variable
                    const ws = new WebSocket(wsProtocol + '://' + location.host);
                    const connection = new solanaWeb3.Connection('https://api.' + NETWORK + '.solana.com', 'confirmed');
                    const LOTTERY_WALLET = new solanaWeb3.PublicKey(LOTTERY_ADDRESS);
                    const statusDiv = document.getElementById('lottery-status');
                    const balanceDiv = document.getElementById('wallet-balance');
                    const countdownDiv = document.getElementById('countdown');
                    const depositorsDiv = document.getElementById('recent-depositors');
                    const winnersDiv = document.getElementById('past-winners');
                    const joinButton = document.getElementById('join-lottery');
                    const errorDiv = document.getElementById('error-message');

                    let countdown = 5;
                    let countdownInterval;

                    function startCountdown() {
                        countdownDiv.textContent = `CHECK: ${countdown}s (Balance checked last time: ${new Date().toLocaleTimeString()})`;
                        countdownInterval = setInterval(() => {
                            countdown--;
                            countdownDiv.textContent = `CHECK: ${countdown}s (Balance checked last time: ${new Date().toLocaleTimeString()})`;
                            if (countdown <= 0) {
                                clearInterval(countdownInterval);
                                updateBalance();
                                countdown = 5;
                                startCountdown();
                            }
                        }, 1000);
                    }

                    async function updateBalance() {
                        try {
                            const balanceLamports = await connection.getBalance(LOTTERY_WALLET);
                            const newBalance = (balanceLamports / solanaWeb3.LAMPORTS_PER_SOL).toFixed(4);
                            balanceDiv.textContent = 'BAL: ' + newBalance + ' SOL';
                            ws.send(JSON.stringify({ action: 'updateBalance', balance: newBalance }));
                        } catch (error) {
                            errorDiv.textContent = 'ERROR: Balance update failed';
                            console.error(error);
                        }
                    }

                    ws.onopen = () => {
                        console.log('Connected to lottery server');
                        startCountdown();
                    };
                    ws.onmessage = (event) => {
                        try {
                            const data = JSON.parse(event.data);
                            if (data.error) {
                                errorDiv.textContent = 'ERROR: ' + data.error;
                                return;
                            }
                            if (data.action === 'updateBalance') {
                                lotteryState.balance = data.balance;
                                balanceDiv.textContent = 'BAL: ' + data.balance + ' SOL';
                                countdownDiv.textContent = `CHECK: ${countdown}s (Balance checked last time: ${new Date().toLocaleTimeString()})`;
                                return;
                            }
                            statusDiv.innerHTML = \`
                                PLAYERS: \${data.participants.length}/${MAX_PARTICIPANTS}<br>
                                POOL: \${data.pool.toFixed(2)} SOL<br>
                                STATUS: \${data.status}<br>
                                \${data.winner ? 'WINNER: ' + data.winner : ''}
                            \`;
                            balanceDiv.textContent = 'BAL: ' + data.balance + ' SOL';
                            depositorsDiv.innerHTML = data.recentDepositors.map(d => \`<div class="address">\${d.slice(0, 8)}...\${d.slice(-8)}</div>\`).join('');
                            winnersDiv.innerHTML = data.pastWinners.map(w => \`<div class="address">\${w.slice(0, 8)}...\${w.slice(-8)}</div>\`).join('');
                        } catch (e) {
                            errorDiv.textContent = 'ERROR: Invalid message';
                            console.error(e);
                        }
                    };

                    joinButton.addEventListener('click', async () => {
                        try {
                            if (!window.solana || !window.solana.isPhantom) {
                                errorDiv.textContent = 'ERROR: Install Phantom at https://phantom.app/';
                                return;
                            }
                            joinButton.disabled = true;
                            joinButton.innerHTML = 'SENDING <div class="loader"></div>';
                            const provider = window.solana;
                            const transaction = new solanaWeb3.Transaction().add(
                                solanaWeb3.SystemProgram.transfer({
                                    fromPubkey: provider.publicKey,
                                    toPubkey: LOTTERY_WALLET,
                                    lamports: ${LOTTERY_ENTRY_AMOUNT}
                                })
                            );
                            transaction.feePayer = provider.publicKey;
                            const latestBlock = await connection.getLatestBlockhash();
                            transaction.recentBlockhash = latestBlock.blockhash;

                            const signed = await provider.signTransaction(transaction);
                            const signature = await connection.sendRawTransaction(signed.serialize());
                            await connection.confirmTransaction({
                                signature,
                                blockhash: latestBlock.blockhash,
                                lastValidBlockHeight: latestBlock.lastValidBlockHeight
                            }, 'confirmed');

                            errorDiv.textContent = 'SENT! TX: ' + signature;
                        } catch (error) {
                            errorDiv.textContent = 'ERROR: ' + (error.message || 'Transaction failed');
                            console.error(error);
                        } finally {
                            joinButton.disabled = false;
                            joinButton.textContent = 'SEND 0.01 SOL';
                        }
                    });

                    lucide.createIcons();
                </script>
            </div>
        </body>
        </html>
    `);
});

// Status Endpoint
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

// WebSocket Handling
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

// Transaction Monitoring
async function monitorTransactions() {
    connection.onLogs(LOTTERY_WALLET.publicKey, async (logInfo) => {
        try {
            const signature = logInfo.signature;
            if (lotteryState.transactionsSeen.has(signature) || lotteryState.status !== 'Active') return;

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
                    lotteryState.pool += 0.01; // 0.01 SOL per entry
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
            logger.error('Transaction monitoring error', { error: error.message, signature });
            broadcastState(`Transaction processing failed: ${error.message} (Signature: ${signature})`);
        }
    }, 'confirmed');
}

// Update Balance
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

// Pick Winner
async function pickWinner() {
    try {
        lotteryState.status = 'Processing';
        broadcastState();
        await saveState();

        const balance = await connection.getBalance(LOTTERY_WALLET.publicKey);
        const feeEstimate = await connection.getFeeForMessage(
            new solanaWeb3.Message({
                accountKeys: [LOTTERY_WALLET.publicKey.toBase58(), winnerAddress],
                instructions: [
                    solanaWeb3.SystemProgram.transfer({
                        fromPubkey: LOTTERY_WALLET.publicKey,
                        toPubkey: new solanaWeb3.PublicKey(winnerAddress),
                        lamports: WINNING_PAYOUT
                    })
                ],
                recentBlockhash: (await connection.getLatestBlockhash()).blockhash
            })
        );
        if (balance < WINNING_PAYOUT + (feeEstimate.value || MINIMUM_FEE_LAMPORTS)) {
            throw new Error('Insufficient funds for payout');
        }

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

        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
            try {
                const { blockhash } = await connection.getLatestBlockhash();
                tx.recentBlockhash = blockhash;
                const signature = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [LOTTERY_WALLET]);
                logger.info(`Winner: ${winnerAddress}, Payout sent`, { signature });
                lotteryState.winner = winnerAddress;
                lotteryState.status = 'Complete';
                lotteryState.pastWinners.unshift(winnerAddress);
                if (lotteryState.pastWinners.length > 5) lotteryState.pastWinners.pop();
                break;
            } catch (error) {
                attempts++;
                if (attempts === maxAttempts) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        broadcastState();
        await saveState();
        setTimeout(async () => resetLottery(), 5000);
    } catch (error) {
        logger.error('Error picking winner', { error: error.message });
        lotteryState.status = 'Error';
        broadcastState(`Payout failed: ${error.message}`);
        await saveState();
        setTimeout(async () => resetLottery(), 10000);
    }
}

// Reset Lottery
async function resetLottery() {
    lotteryState = {
        participants: [],
        pool: 0,
        status: 'Active',
        winner: null,
        transactionsSeen: new Set(),
        recentDepositors: [],
        pastWinners: lotteryState.pastWinners || [],
        balance: lotteryState.balance || 0
    };
    await saveState();
    broadcastState();
    logger.info('Lottery reset');
}

// Broadcast State
function broadcastState(error = null) {
    const payload = error ? { error } : lotteryState;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(payload));
        }
    });
}

// Initialize
async function start() {
    await fs.mkdir('backup', { recursive: true }); // Create backup directory
    await loadState();
    await updateBalance(); // Initial balance update
    monitorTransactions();
    server.listen(PORT, () => logger.info(`Lottery server running on port ${PORT}`));
}

start();
