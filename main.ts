import "https://deno.land/std@0.208.0/dotenv/load.ts";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "https://esm.sh/@solana/web3.js@1.98.0";
import {
  getAssociatedTokenAddress,
  createInitializeMintInstruction,
  createMintToInstruction,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "https://esm.sh/@solana/spl-token@0.4.14";

// -- ENV --
const ESCROW_HEX = (Deno.env.get("ESCROW_PRIVATE_KEY") || "").trim();
const SOLANA_RPC = Deno.env.get("SOLANA_RPC") || "https://api.devnet.solana.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const MAGICBLOCK_API = "https://payments.magicblock.app";

// -- INIT --
const conn = new Connection(SOLANA_RPC, "confirmed");
const escrowKp = Keypair.fromSecretKey(
  Uint8Array.from(ESCROW_HEX.match(/.{1,2}/g)?.map((b: string) => parseInt(b, 16)) || [])
);

const USDC_MINT_PK = new PublicKey("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr");

// -- HELPERS --
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function isValidPublicKey(address: string): boolean {
  try { new PublicKey(address); return true; } catch { return false; }
}

// -- SEND TX WITH RETRY --
async function sendTxWithRetry(
  connection: Connection,
  buildTx: () => Promise<{ tx: Transaction; signers: Keypair[] }>,
  maxRetries = 3
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { tx, signers } = await buildTx();
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

      tx.recentBlockhash = blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.sign(...signers);

      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 0,
      });

      console.log(`?? [Attempt ${attempt}] Tx sent:`, signature);

      let confirmed = false;
      let blockHeight = await connection.getBlockHeight();
      while (blockHeight <= lastValidBlockHeight) {
        const status = await connection.getSignatureStatus(signature);
        const conf = status?.value?.confirmationStatus;
        console.log(`? status: ${conf ?? "null"}`);
        if (conf === "confirmed" || conf === "finalized") { confirmed = true; break; }
        if (status?.value?.err) throw new Error(`Tx failed: ${JSON.stringify(status.value.err)}`);
        await new Promise(r => setTimeout(r, 2000));
        blockHeight = await connection.getBlockHeight();
      }
      if (!confirmed) throw new Error("Confirmation timeout");
      console.log(`? Tx confirmed:`, signature);
      return signature;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[Attempt ${attempt}/${maxRetries}] Error:`, msg);
      if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 1000)); continue; }
      throw err;
    }
  }
  throw new Error("Failed after retries");
}

// -- WITHDRAW USDC FROM TEE (ephemeral ? base chain) --------------------------
// Dipanggil sebelum transfer USDC dari escrow ke siapapun.
// Owner = escrowKp karena USDC masuk ke TEE vault milik escrow saat bid.
async function withdrawFromTEE(amountUsdc: number): Promise<string> {
  const amountRaw = Math.round(amountUsdc * 1_000_000);
  console.log(`?? Withdrawing ${amountUsdc} USDC (${amountRaw} raw) from TEE...`);

  // Step 1: Minta unsigned tx dari MagicBlock API
  const res = await fetch(`${MAGICBLOCK_API}/v1/spl/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner: escrowKp.publicKey.toString(),
      mint: USDC_MINT_PK.toString(),
      amount: amountRaw,
      cluster: "devnet",
      idempotent: true,
      initAtasIfMissing: true,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`MagicBlock withdraw API error ${res.status}: ${errText}`);
  }

  const mbData = await res.json();
  console.log("?? MagicBlock withdraw response:", JSON.stringify(mbData));

  if (!mbData.transactionBase64) {
    throw new Error("MagicBlock withdraw: no transactionBase64 in response");
  }

  // Step 2: Deserialize tx
  const txBuffer = Uint8Array.from(atob(mbData.transactionBase64), c => c.charCodeAt(0));
  const tx = Transaction.from(txBuffer);

  // Step 3: Sign pakai escrowKp dan broadcast
  // sendTo = "base" ? broadcast ke Solana base chain
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = escrowKp.publicKey;
  tx.sign(escrowKp);

  const signature = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 0,
  });

  console.log(`?? Withdraw tx sent:`, signature);

  // Step 4: Tunggu confirmed
  let confirmed = false;
  let blockHeight = await conn.getBlockHeight();
  while (blockHeight <= lastValidBlockHeight) {
    const status = await conn.getSignatureStatus(signature);
    const conf = status?.value?.confirmationStatus;
    console.log(`? withdraw status: ${conf ?? "null"}`);
    if (conf === "confirmed" || conf === "finalized") { confirmed = true; break; }
    if (status?.value?.err) throw new Error(`Withdraw tx failed: ${JSON.stringify(status.value.err)}`);
    await new Promise(r => setTimeout(r, 2000));
    blockHeight = await conn.getBlockHeight();
  }
  if (!confirmed) throw new Error("Withdraw confirmation timeout");

  console.log(`? TEE withdraw confirmed:`, signature);
  return signature;
}

// -- SERVER --
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const url = new URL(req.url);
  const path = url.pathname;

  // -- POST /api/mint-nft --
  if (path === "/api/mint-nft" && req.method === "POST") {
    try {
      const { creator } = await req.json();
      if (!creator || !isValidPublicKey(creator)) {
        return json({ error: "Missing or invalid creator address" }, 400);
      }

      const mintKp = Keypair.generate();
      const mint = mintKp.publicKey;
      const rentLamports = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
      const escrowAta = await getAssociatedTokenAddress(
        mint, escrowKp.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );

      const signature = await sendTxWithRetry(conn, async () => {
        const tx = new Transaction();
        tx.add(
          SystemProgram.createAccount({
            fromPubkey: escrowKp.publicKey,
            newAccountPubkey: mint,
            space: MINT_SIZE,
            lamports: rentLamports,
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeMintInstruction(mint, 0, escrowKp.publicKey, null, TOKEN_PROGRAM_ID),
          createAssociatedTokenAccountInstruction(
            escrowKp.publicKey, escrowAta, escrowKp.publicKey, mint,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ),
          createMintToInstruction(mint, escrowAta, escrowKp.publicKey, 1, [], TOKEN_PROGRAM_ID)
        );
        return { tx, signers: [escrowKp, mintKp] };
      });

      console.log("? NFT minted:", mint.toString(), "sig:", signature);
      return json({
        success: true,
        mintAddress: mint.toString(),
        txSignature: signature,
        explorer: `https://explorer.solana.com/address/${mint.toString()}?cluster=devnet`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("? /api/mint-nft error:", msg);
      return json({ error: msg }, 500);
    }
  }

  // -- POST /api/claim-loser-usdc --
  if (path === "/api/claim-loser-usdc" && req.method === "POST") {
    try {
      const { bidId, loserWallet, amountUsdc } = await req.json();
      if (!loserWallet || !isValidPublicKey(loserWallet)) return json({ error: "Invalid loserWallet" }, 400);
      if (!amountUsdc || amountUsdc <= 0) return json({ error: "Invalid amountUsdc" }, 400);

      // -- Step 1: Withdraw USDC dari TEE ke escrow base chain --
      console.log(`?? [claim-loser-usdc] Withdrawing ${amountUsdc} USDC from TEE for bidId: ${bidId}`);
      const withdrawSig = await withdrawFromTEE(amountUsdc);
      console.log(`? TEE withdraw done:`, withdrawSig);

      // -- Step 2: Transfer dari escrow base chain ke loser --
      const loser = new PublicKey(loserWallet);
      const escrowUsdcAta = await getAssociatedTokenAddress(USDC_MINT_PK, escrowKp.publicKey);
      const loserUsdcAta = await getAssociatedTokenAddress(USDC_MINT_PK, loser);
      const amountRaw = Math.round(amountUsdc * 1_000_000);

      const signature = await sendTxWithRetry(conn, async () => {
        const tx = new Transaction();
        const loserAtaInfo = await conn.getAccountInfo(loserUsdcAta);
        if (!loserAtaInfo) tx.add(createAssociatedTokenAccountInstruction(
          escrowKp.publicKey, loserUsdcAta, loser, USDC_MINT_PK
        ));
        tx.add(createTransferInstruction(escrowUsdcAta, loserUsdcAta, escrowKp.publicKey, amountRaw));
        return { tx, signers: [escrowKp] };
      });

      return json({
        success: true,
        withdrawSignature: withdrawSig,
        signature,
        explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("? /api/claim-loser-usdc error:", msg);
      return json({ error: msg }, 500);
    }
  }

  // -- POST /api/settle-winner --
  if (path === "/api/settle-winner" && req.method === "POST") {
    try {
      const { winnerWallet, nftMint, creatorWallet, amountUsdc } = await req.json();
      if (!winnerWallet || !isValidPublicKey(winnerWallet)) return json({ error: "Invalid winnerWallet" }, 400);
      if (!nftMint || !isValidPublicKey(nftMint)) return json({ error: "Invalid nftMint" }, 400);
      if (!creatorWallet || !isValidPublicKey(creatorWallet)) return json({ error: "Invalid creatorWallet" }, 400);

      console.log("?? settle-winner payload:", { winnerWallet, nftMint, creatorWallet, amountUsdc });

      const winner = new PublicKey(winnerWallet);
      const creator = new PublicKey(creatorWallet);
      const mint = new PublicKey(nftMint);
      const amountRaw = Math.round((amountUsdc || 0) * 1_000_000);

      // -- Step 1: Withdraw USDC dari TEE ke escrow base chain (jika ada USDC) --
      let withdrawSig: string | null = null;
      if (amountUsdc && amountUsdc > 0) {
        console.log(`?? [settle-winner] Withdrawing ${amountUsdc} USDC from TEE...`);
        try {
          withdrawSig = await withdrawFromTEE(amountUsdc);
          console.log(`? TEE withdraw done:`, withdrawSig);
        } catch (wErr: unknown) {
  const wMsg = wErr instanceof Error ? wErr.message : String(wErr);
  throw new Error(`TEE withdraw failed: ${wMsg}`);
}
      }

      // Log escrow USDC balance setelah withdraw
      const _checkAta = await getAssociatedTokenAddress(USDC_MINT_PK, escrowKp.publicKey);
      const escrowUsdcInfo = await conn.getTokenAccountBalance(_checkAta).catch(() => null);
      console.log("?? Escrow USDC balance after withdraw:", escrowUsdcInfo?.value?.uiAmount ?? "ATA not found");

      // -- Step 2: Transfer NFT ke winner --
      const escrowNftAta = await getAssociatedTokenAddress(mint, escrowKp.publicKey);
      const winnerNftAta = await getAssociatedTokenAddress(mint, winner);

      const nftSig = await sendTxWithRetry(conn, async () => {
        const tx = new Transaction();
        const winnerAtaInfo = await conn.getAccountInfo(winnerNftAta);
        if (!winnerAtaInfo) tx.add(createAssociatedTokenAccountInstruction(
          escrowKp.publicKey, winnerNftAta, winner, mint
        ));
        tx.add(createTransferInstruction(escrowNftAta, winnerNftAta, escrowKp.publicKey, 1));
        return { tx, signers: [escrowKp] };
      });

      console.log("? NFT transferred, sig:", nftSig);

      // -- Step 3: Transfer USDC ke creator --
      let usdcSig: string | null = null;
      if (amountRaw > 0) {
        console.log("?? Starting USDC transfer to creator, amountRaw:", amountRaw);
        const escrowUsdcAta = await getAssociatedTokenAddress(USDC_MINT_PK, escrowKp.publicKey);
        const creatorUsdcAta = await getAssociatedTokenAddress(USDC_MINT_PK, creator);

        usdcSig = await sendTxWithRetry(conn, async () => {
          const tx = new Transaction();
          const creatorAtaInfo = await conn.getAccountInfo(creatorUsdcAta);
          if (!creatorAtaInfo) tx.add(createAssociatedTokenAccountInstruction(
            escrowKp.publicKey, creatorUsdcAta, creator, USDC_MINT_PK
          ));
          tx.add(createTransferInstruction(escrowUsdcAta, creatorUsdcAta, escrowKp.publicKey, amountRaw));
          return { tx, signers: [escrowKp] };
        });

        console.log("? USDC transferred to creator, sig:", usdcSig);
      }

      return json({
        success: true,
        withdrawSignature: withdrawSig,
        nftSignature: nftSig,
        usdcSignature: usdcSig,
        explorer: `https://explorer.solana.com/tx/${nftSig}?cluster=devnet`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("? /api/settle-winner error:", msg);
      return json({ error: msg }, 500);
    }
  }

  // -- POST /api/claim-creator-usdc --
  if (path === "/api/claim-creator-usdc" && req.method === "POST") {
    try {
      const { creatorWallet, amountUsdc } = await req.json();
      if (!creatorWallet || !isValidPublicKey(creatorWallet)) return json({ error: "Invalid creatorWallet" }, 400);
      if (!amountUsdc || amountUsdc <= 0) return json({ error: "Invalid amountUsdc" }, 400);

      const creator = new PublicKey(creatorWallet);
      const escrowUsdcAta = await getAssociatedTokenAddress(USDC_MINT_PK, escrowKp.publicKey);
      const creatorUsdcAta = await getAssociatedTokenAddress(USDC_MINT_PK, creator);
      await withdrawFromTEE(amountUsdc);

      const signature = await sendTxWithRetry(conn, async () => {
        const tx = new Transaction();
        const creatorAtaInfo = await conn.getAccountInfo(creatorUsdcAta);
        if (!creatorAtaInfo) tx.add(createAssociatedTokenAccountInstruction(
          escrowKp.publicKey, creatorUsdcAta, creator, USDC_MINT_PK
        ));
        tx.add(createTransferInstruction(escrowUsdcAta, creatorUsdcAta, escrowKp.publicKey, amountRaw));
        return { tx, signers: [escrowKp] };
      });

      return json({ success: true, signature, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("? /api/claim-creator-usdc error:", msg);
      return json({ error: msg }, 500);
    }
  }

  // -- POST /api/return-nft-to-creator --
  if (path === "/api/return-nft-to-creator" && req.method === "POST") {
    try {
      const { nft, creator } = await req.json();
      if (!nft || !isValidPublicKey(nft)) return json({ error: "Invalid nft mint" }, 400);
      if (!creator || !isValidPublicKey(creator)) return json({ error: "Invalid creator" }, 400);

      const mint = new PublicKey(nft);
      const creatorPk = new PublicKey(creator);
      const escrowNftAta = await getAssociatedTokenAddress(mint, escrowKp.publicKey);
      const creatorNftAta = await getAssociatedTokenAddress(mint, creatorPk);

      const signature = await sendTxWithRetry(conn, async () => {
        const tx = new Transaction();
        const creatorAtaInfo = await conn.getAccountInfo(creatorNftAta);
        if (!creatorAtaInfo) tx.add(createAssociatedTokenAccountInstruction(
          escrowKp.publicKey, creatorNftAta, creatorPk, mint
        ));
        tx.add(createTransferInstruction(escrowNftAta, creatorNftAta, escrowKp.publicKey, 1));
        return { tx, signers: [escrowKp] };
      });

      return json({ success: true, signature, explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("? /api/return-nft-to-creator error:", msg);
      return json({ error: msg }, 500);
    }
  }

  // -- POST /api/create-auction --
  if (path === "/api/create-auction" && req.method === "POST") {
    try {
      const { nftMint, title, imageUrl, creator, minBid, currency, durationHours } = await req.json();
      if (!nftMint || !isValidPublicKey(nftMint)) return json({ error: "Invalid nftMint" }, 400);
      if (!creator || !isValidPublicKey(creator)) return json({ error: "Invalid creator" }, 400);
      if (!title) return json({ error: "Missing title" }, 400);
      if (!SUPABASE_URL) return json({ error: "SUPABASE_URL not configured" }, 500);
      if (!SUPABASE_KEY) return json({ error: "SUPABASE_KEY not configured" }, 500);

      const endTime = new Date(Date.now() + (durationHours || 24) * 60 * 60 * 1000).toISOString();

      const res = await fetch(`${SUPABASE_URL}/rest/v1/auctions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Prefer": "return=representation",
        },
        body: JSON.stringify({
          nft_mint: nftMint,
          title,
          image_url: imageUrl || "",
          seller_wallet: creator,
          min_bid: minBid || 0,
          currency: currency || "SOL",
          duration_hours: durationHours || 24,
          end_time: endTime,
          status: "live",
          bid_count: 0,
        }),
      });

      const data = await res.json();
      if (!res.ok) return json({ error: data?.message || "Supabase insert failed" }, 500);
      return json({ success: true, auctionId: data[0]?.id, auction: data[0] });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("? /api/create-auction error:", msg);
      return json({ error: msg }, 500);
    }
  }

  // -- GET /api/creator-sales --
  if (path === "/api/creator-sales" && req.method === "GET") {
    try {
      const wallet = url.searchParams.get("wallet");
      if (!wallet || !isValidPublicKey(wallet)) return json({ error: "Invalid wallet" }, 400);
      if (!SUPABASE_URL) return json({ error: "SUPABASE_URL not configured" }, 500);

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/auctions?seller_wallet=eq.${wallet}&select=*&order=created_at.desc`,
        {
          headers: {
            "apikey": SUPABASE_KEY,
            "Authorization": `Bearer ${SUPABASE_KEY}`,
          },
        }
      );
      const data = await res.json();
      if (!res.ok) return json({ error: data?.message || "Query failed" }, 500);
      return json({ success: true, auctions: data });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("? /api/creator-sales error:", msg);
      return json({ error: msg }, 500);
    }
  }

  // -- 404 --
  return json({ error: "Not found" }, 404);
}, { hostname: "0.0.0.0", port: 8000 });
