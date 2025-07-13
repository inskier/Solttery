// Your final app code will be inserted here automatically during packaging
require('dotenv').config();
// Autonomous Solana Lottery System - Production-Ready with Phantom Integration
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
const LOTTERY_ENTRY_AMOUNT = solanaWeb3.LAMPORTS_PER_SOL; // 1 SOL
const WINNING_PAYOUT = 4 * LOTTERY_ENTRY_AMOUNT; // 4 SOL
const MAX_PARTICIPANTS = 5;
const PORT = 3000;
const STATE_FILE = 'lottery-state.json';
const NETWORK = process.env.SOLANA_NETWORK || 'mainnet-beta'; // Configurable: 'devnet' or 'mainnet-beta'
const MAX_TRANSACTIONS_SEEN = 1000;
const MINIMUM_FEE_LAMPORTS = 5000;

// Logging Setup
// For production, configure Winston with file rotation or cloud logging (e.g., AWS CloudWatch)
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
// For production, use HSM or secure vault (e.g., AWS Secrets Manager) for PRIVATE_KEY_JSON
const secretKey = Uint8Array.from(JSON.parse(process.env.PRIVATE_KEY_JSON || '[]'));
const LOTTERY_WALLET = solanaWeb3.Keypair.fromSecretKey(secretKey);
const LOTTERY_ADDRESS = LOTTERY_WALLET.publicKey.toBase58();

// Lottery State
let lotteryState = {
    participants: [],
    pool: 0,
    status: 'Active',
    winner: null,
    transactionsSeen: new Set()
};

// Load/Save State
// For production, replace with database (e.g., SQLite or MongoDB)
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
        const stats = await fs.stat(STATE_FILE);
        if (Date.now() - stats.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
            await fs.rename(STATE_FILE, `backup/lottery-state-${Date.now()}.json`);
            logger.info('Old state file archived');
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
app.get('/', (req, res) => {
    // For production, generate and include a CSRF token
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Solana Lottery</title>
            <script src="https://unpkg.com/@solana/web3.js@latest/lib/index.iife.js"></script>
            <style>
                body { font-family: Arial; max-width: 800px; margin: 0 auto; padding: 20px; }
                #lottery-status { margin: 20px 0; padding: 10px; border: 1px solid #ccc; }
                #participants { margin: 20px 0; }
                .error { color: red; }
                button { padding: 10px; margin: 5px; }
            </style>
        </head>
        <body>
            <h1>Solana Lottery</h1>
            <div>Lottery Wallet: ${LOTTERY_ADDRESS}</div>
            <div>Your Wallet: <span id="wallet-address">Not connected</span></div>
            <button id="connect-wallet">Connect Phantom Wallet</button>
            <div id="lottery-status">Loading...</div>
            <h2>Participants</h2>
            <div id="participants"></div>
            <button id="join-lottery" disabled>Join Lottery (1 SOL)</button>
            <div id="error-message" class="error"></div>
            <script>
                const ws = new WebSocket('ws://' + location.host);
                const connection = new solanaWeb3.Connection('https://api.${NETWORK}.solana.com', 'confirmed');
                const LOTTERY_WALLET = new solanaWeb3.PublicKey('${LOTTERY_ADDRESS}');
                const statusDiv = document.getElementById('lottery-status');
                const participantsDiv = document.getElementById('participants');
                const connectButton = document.getElementById('connect-wallet');
                const joinButton = document.getElementById('join-lottery');
                const errorDiv = document.getElementById('error-message');
                let provider = null;

                ws.onopen = () => console.log('Connected to lottery server');
                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.error) {
                            errorDiv.textContent = 'Error: ' + data.error;
                            return;
                        }
                        statusDiv.innerHTML = \`
                            Current Participants: \${data.participants.length}/${MAX_PARTICIPANTS}<br>
                            Prize Pool: \${data.pool} SOL<br>
                            Status: \${data.status}<br>
                            \${data.winner ? \`Winner: \${data.winner}\` : ''}
                        \`;
                        participantsDiv.innerHTML = data.participants.map(p => \`<div>\${p}</div>\`).join('');
                    } catch {
                        errorDiv.textContent = 'Error: Invalid server message';
                    }
                };

                async function connectWallet() {
                    let attempts = 0;
                    const maxAttempts = 3;
                    while (attempts < maxAttempts) {
                        try {
                            provider = window.solana;
                            if (!provider || !provider.isPhantom) throw new Error('Phantom wallet not found');
                            if (provider.network !== '${NETWORK}') throw new Error('Wallet network mismatch. Switch to ${NETWORK}.');
                            await provider.connect();
                            document.getElementById('wallet-address').innerText = provider.publicKey.toString();
                            joinButton.disabled = false;
                            errorDiv.textContent = 'Wallet connected!';
                            provider.on('disconnect', async () => {
                                document.getElementById('wallet-address').innerText = 'Not connected';
                                joinButton.disabled = true;
                                errorDiv.textContent = 'Wallet disconnected. Reconnecting...';
                                await connectWallet(); // Auto-reconnect
                            });
                            break;
                        } catch (error) {
                            attempts++;
                            if (attempts === maxAttempts) {
                                errorDiv.textContent = 'Error: ' + (error.message || 'Failed to connect wallet');
                                console.error(error);
                                break;
                            }
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                }

                connectButton.addEventListener('click', connectWallet);

                joinButton.addEventListener('click', async () => {
                    try {
                        if (!provider || !provider.isPhantom) throw new Error('Phantom wallet not found');
                        joinButton.disabled = true;
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

                        errorDiv.textContent = 'Entry successful! Waiting for confirmation...';
                        joinButton.disabled = false;
                    } catch (error) {
                        joinButton.disabled = false;
                        errorDiv.textContent = 'Error: ' + (error.message || 'Transaction failed');
                        console.error(error);
                    }
                });
            </script>
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
        winner: lotteryState.winner
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
                    lotteryState.pool += 1;
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

// Pick Winner
async function pickWinner() {
    try {
        lotteryState.status = 'Processing';
        broadcastState();
        await saveState();

        const balance = await connection.getBalance(LOTTERY_WALLET.publicKey);
        const feeEstimate = await connection.getFeeForMessage(
            new solanaWeb3.Message({
                accountKeys: [LOTTERY_WALLET.publicKey.toBase58(), LOTTERY_ADDRESS],
                instructions: [
                    solanaWeb3.SystemProgram.transfer({
                        fromPubkey: LOTTERY_WALLET.publicKey,
                        toPubkey: LOTTERY_WALLET.publicKey, // Placeholder
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
        transactionsSeen: new Set()
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
    monitorTransactions();
    server.listen(PORT, () => logger.info(`Lottery server running on port ${PORT}`));
}

start();