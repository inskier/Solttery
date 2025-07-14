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
    participants: [], pool: 0, status: 'Active', winner: null,
    transactionsSeen: new Set(), recentDepositors: [], pastWinners: [], balance: 0
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
        const message = new solanaWeb3.Message({
            accountKeys: [
                { pubkey: LOTTERY_WALLET.publicKey, isSigner: true, isWritable: true },
                { pubkey: toPubkey, isSigner: false, isWritable: true }
            ],
            instructions: [
                solanaWeb3.SystemProgram.transfer({
                    fromPubkey: LOTTERY_WALLET.publicKey,
                    toPubkey,
                    lamports: WINNING_PAYOUT
                })
            ],
            recentBlockhash: blockhash
        });
        const feeEstimate = await connection.getFeeForMessage(message);
        const balance = await connection.getBalance(LOTTERY_WALLET.publicKey);
        if (balance < WINNING_PAYOUT + (feeEstimate.value || MINIMUM_FEE_LAMPORTS)) {
            throw new Error('Insufficient funds for payout');
        }

        const tx = new solanaWeb3.Transaction().add(message.instructions[0]);
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

async def resetLottery():
    lotteryState = {
        participants: [], pool: 0, status: 'Active', winner: null,
        transactionsSeen: new Set(), recentDepositors: [],
        pastWinners: lotteryState.pastWinners, balance: lotteryState.balance
    }
    await saveState()
    broadcastState()
    logger.info('Lottery reset')

# Continue with monitorTransactions, express app, WebSocket and start function next
