require('dotenv').config();
// Autonomous Solana Lottery System - Crypto-Themed with 0.01 SOL Entry and 0.04 SOL Payout
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
            <title>Solana Crypto Lottery</title>
            <script src="https://unpkg.com/@solana/web3.js@latest/lib/index.iife.js"></script>
            <script src="https://unpkg.com/lucide@0.4.0/dist/umd/lucide.min.js"></script>
            <style>
                body {
                    font-family: 'Courier New', monospace;
                    margin: 0;
                    padding: 0;
                    min-height: 100vh;
                    background: linear-gradient(135deg, #0d0d2b, #1a1a3a, #2d2d4d);
                    color: #00ffcc;
                    text-shadow: 0 0 5px #00ffcc, 0 0 10px #00ffcc;
                }
                .container {
                    max-width: 1000px;
                    margin: 0 auto;
                    padding: 20px;
                }
                h1 {
                    text-align: center;
                    font-size: 2.5em;
                    margin-bottom: 20px;
                    color: #ff9900;
                    text-shadow: 0 0 10px #ff9900;
                }
                .crypto-card {
                    background: rgba(15, 15, 35, 0.9);
                    border: 2px solid #00ffcc;
                    border-radius: 10px;
                    padding: 15px;
                    margin-bottom: 20px;
                    box-shadow: 0 0 15px rgba(0, 255, 204, 0.3);
                }
                .crypto-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                    gap: 20px;
                    margin-bottom: 20px;
                }
                .address {
                    font-size: 0.9em;
                    word-break: break-all;
                    color: #66ffcc;
                }
                .balance, .depositors, .winners {
                    margin: 10px 0;
                }
                .button {
                    padding: 10px 20px;
                    background: #ff9900;
                    color: #0d0d2b;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    transition: background 0.3s;
                    width: 100%;
                }
                .button:hover {
                    background: #ffcc66;
                }
                .button:disabled {
                    background: #666;
                    cursor: not-allowed;
                }
                .loader {
                    border: 4px solid #f3f3f3;
                    border-top: 4px solid #ff9900;
                    border-radius: 50%;
                    width: 24px;
                    height: 24px;
                    animation: spin 1s linear infinite;
                    margin: 0 auto;
                    display: inline-block;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .network-indicator {
                    font-size: 0.8em;
                    color: #66ffcc;
                    text-align: center;
                    margin-bottom: 10px;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔮 Solana Crypto Lottery</h1>
                <div class="network-indicator">Network: ${NETWORK}</div>
                <div class="crypto-grid">
                    <div class="crypto-card">
                        <h2><i data-lucide="wallet" class="text-yellow-400"></i> Lottery Wallet</h2>
                        <div class="address">${LOTTERY_ADDRESS}</div>
                        <p>Send 0.01 SOL to participate</p>
                        <div class="balance" id="wallet-balance">Balance: Loading...</div>
                    </div>
                    <div class="crypto-card">
                        <h2><i data-lucide="coins" class="text-green-400"></i> Join Lottery</h2>
                        <button id="join-lottery" class="button">Send 0.01 SOL</button>
                        <div id="error-message" class="error"></div>
                    </div>
                </div>
                <div class="crypto-card">
                    <h2><i data-lucide="users" class="text-blue-400"></i> Recent Depositors (Last 5)</h2>
                    <div id="recent-depositors"></div>
                </div>
                <div class="crypto-card">
                    <h2><i data-lucide="trophy" class="text-yellow-400"></i> Past Winners (Last 5)</h2>
                    <div id="past-winners"></div>
                </div>
                <div class="crypto-card">
                    <h2><i data-lucide="info" class="text-purple-400"></i> Lottery Status</h2>
                    <div id="lottery-status">Loading...</div>
                </div>
                <script>
                    const ws = new WebSocket('${wsProtocol}://' + location.host);
                    const connection = new solanaWeb3.Connection('https://api.${NETWORK}.solana.com', 'confirmed');
                    const LOTTERY_WALLET = new solanaWeb3.PublicKey('${LOTTERY_ADDRESS}');
                    const statusDiv = document.getElementById('lottery-status');
                    const balanceDiv = document.getElementById('wallet-balance');
                    const depositorsDiv = document.getElementById('recent-depositors');
                    const winnersDiv = document.getElementById('past-winners');
                    const joinButton = document.getElementById('join-lottery');
                    const errorDiv = document.getElementById('error-message');

                    ws.onopen = () => console.log('Connected to lottery server');
                    ws.onmessage = (event) => {
                        try {
                            const data = JSON.parse(event.data);
                            if (data.error) {
                                errorDiv.textContent = 'Error: ' + data.error;
                                return;
                            }
                            statusDiv.innerHTML = \`
                                Participants: \${data.participants.length}/${MAX_PARTICIPANTS}<br>
                                Prize Pool: \${data.pool.toFixed(2)} SOL<br>
                                Status: \${data.status}<br>
                                \${data.winner ? 'Current Winner: ' + data.winner : ''}
                            \`;
                            balanceDiv.textContent = 'Balance: ' + data.balance + ' SOL';
                            depositorsDiv.innerHTML = data.recentDepositors.map(d => \`<div class="address">\${d.slice(0, 8)}...\${d.slice(-8)}</div>\`).join('');
                            winnersDiv.innerHTML = data.pastWinners.map(w => \`<div class="address">\${w.slice(0, 8)}...\${w.slice(-8)}</div>\`).join('');
                        } catch (e) {
                            errorDiv.textContent = 'Error: Invalid server message';
                            console.error(e);
                        }
                    };

                    joinButton.addEventListener('click', async () => {
                        try {
                            if (!window.solana || !window.solana.isPhantom) {
                                errorDiv.textContent = 'Phantom wallet not found. Install at https://phantom.app/';
                                return;
                            }
                            joinButton.disabled = true;
                            joinButton.innerHTML = 'Sending <div class="loader"></div>';
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

                            errorDiv.textContent = 'Entry sent! Transaction: ' + signature;
                        } catch (error) {
                            errorDiv.textContent = 'Error: ' + (error.message || 'Transaction failed');
                            console.error(error);
                        } finally {
                            joinButton.disabled = false;
                            joinButton.textContent = 'Send 0.01 SOL';
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
    ws.on('message', () => {
        ws.send(JSON.stringify({ error: 'Messages not supported' }));
    });
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
