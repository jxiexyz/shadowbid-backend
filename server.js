require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createTransferInstruction,
  getAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const USDC_MINT = process.env.USDC_MINT;
const ESCROW_HEX = process.env.ESCROW_PRIVATE_KEY?.trim();
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';

function getKeypair() {
  const hex = (process.env.ESCROW_PRIVATE_KEY || '').trim();
  return Keypair.fromSecretKey(
    Uint8Array.from(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)))
  );
}

async function transferUsdc(connection, keypair, toWallet, amountUsdc) {
  const usdcMint = new PublicKey(USDC_MINT);
  const toPubkey = new PublicKey(toWallet);
  const escrowAta = await getAssociatedTokenAddress(usdcMint, keypair.publicKey);
  const toAta = await getAssociatedTokenAddress(usdcMint, toPubkey);

  const tx = new Transaction();
  tx.feePayer = keypair.publicKey;

  // Buat ATA kalau belum ada
  try {
    await getAccount(connection, toAta);
  } catch {
    tx.add(createAssociatedTokenAccountInstruction(keypair.publicKey, toAta, toPubkey, usdcMint));
  }

  const amountMicro = Math.round(amountUsdc * 1e6);
  tx.add(createTransferInstruction(escrowAta, toAta, keypair.publicKey, amountMicro));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(keypair);

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}

// ✅ 1. Loser claim USDC balik
app.post('/api/claim-loser-usdc', async (req, res) => {
  try {
    const { bidId, loserWallet, amountUsdc } = req.body;
    if (!bidId || !loserWallet || !amountUsdc) {
      return res.status(400).json({ error: 'Missing: bidId, loserWallet, amountUsdc' });
    }
    console.log(`[claim-loser] ${amountUsdc} USDC → ${loserWallet}`);
    const connection = new Connection(SOLANA_RPC, 'confirmed');
    const keypair = getKeypair();
    const signature = await transferUsdc(connection, keypair, loserWallet, amountUsdc);
    console.log(`[claim-loser] ✅ ${signature}`);
    res.json({ success: true, signature, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` });
  } catch (e) {
    console.error('[claim-loser] ❌', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ✅ 2. Settle winner: NFT → winner, USDC → creator
app.post('/api/settle-winner', async (req, res) => {
  try {
    const { bidId, winnerWallet, creatorWallet, amountUsdc, nftMint } = req.body;
    if (!bidId || !winnerWallet || !creatorWallet || !amountUsdc || !nftMint) {
      return res.status(400).json({ error: 'Missing: bidId, winnerWallet, creatorWallet, amountUsdc, nftMint' });
    }

    const connection = new Connection(SOLANA_RPC, 'confirmed');
    const keypair = getKeypair();

    // Transfer USDC → creator
    console.log(`[settle-winner] ${amountUsdc} USDC → creator ${creatorWallet}`);
    const usdcSig = await transferUsdc(connection, keypair, creatorWallet, amountUsdc);
    console.log(`[settle-winner] USDC ✅ ${usdcSig}`);

    // Transfer NFT → winner
    console.log(`[settle-winner] NFT ${nftMint} → winner ${winnerWallet}`);
    const nftMintPubkey = new PublicKey(nftMint);
    const winnerPubkey = new PublicKey(winnerWallet);
    const escrowNftAta = await getAssociatedTokenAddress(nftMintPubkey, keypair.publicKey);
    const winnerNftAta = await getAssociatedTokenAddress(nftMintPubkey, winnerPubkey);

    const nftTx = new Transaction();
    nftTx.feePayer = keypair.publicKey;

    try {
      await getAccount(connection, winnerNftAta);
    } catch {
      nftTx.add(createAssociatedTokenAccountInstruction(keypair.publicKey, winnerNftAta, winnerPubkey, nftMintPubkey));
    }

    nftTx.add(createTransferInstruction(escrowNftAta, winnerNftAta, keypair.publicKey, 1));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    nftTx.recentBlockhash = blockhash;
    nftTx.sign(keypair);

    const nftSig = await connection.sendRawTransaction(nftTx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction({ signature: nftSig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.log(`[settle-winner] NFT ✅ ${nftSig}`);

    res.json({
      success: true,
      usdcSignature: usdcSig,
      nftSignature: nftSig,
      explorer: {
        usdc: `https://explorer.solana.com/tx/${usdcSig}?cluster=devnet`,
        nft: `https://explorer.solana.com/tx/${nftSig}?cluster=devnet`
      }
    });
  } catch (e) {
    console.error('[settle-winner] ❌', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));