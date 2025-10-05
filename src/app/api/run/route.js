import { ethers } from "ethers";
import { NextResponse } from "next/server";
import OracleHubAbi from "./abi.json";
const axios = require("axios");
const cheerio = require("cheerio");

// ---- Config ----
const TARGETS = {
  MTNN: "MTNN",
  UBA: "UBA",
  GTCO: "GTCO",
  ZENITHBANK: "ZENITHBANK",
  ARADEL: "ARADEL",
  TOTALNG: "TOTALNG",
  AIICO: "AIICO",
  CORNERST: "CORNERST",
  OKOMUOIL: "OKOMUOIL",
  PRESCO: "PRESCO",
  NESTLE: "NESTLE",
  DANGSUGAR: "DANGSUGAR",
};
const TARGET_SET = new Set(Object.values(TARGETS));
const URL =
  "https://african-markets.com/en/stock-markets/ngse/listed-companies";
const DEFAULT_BAND_WIDTH_BPS = Number.parseInt(
  process.env.BAND_WIDTH_BPS || "150",
  10
);

// ---- Helpers ----
const toNumber = (txt) => {
  if (!txt) return null;
  const clean = txt.replace(/[, ]+/g, "").trim();
  if (clean === "-" || clean === "") return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
};

const parsePercent = (txt) => {
  if (!txt) return null;
  const t = txt.replace(/[\s,%+]/g, "").trim();
  if (t === "-" || t === "") return null;
  const neg = /^-/.test(txt.trim());
  const num = Number(t.replace(/^-/, ""));
  if (!Number.isFinite(num)) return null;
  return (num / 100) * (neg ? -1 : 1);
};

const extractCode = (href) => {
  try {
    const qs = href.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    return (params.get("code") || "").toUpperCase();
  } catch {
    return "";
  }
};

// Get a fresh timestamp each request. Prefer chain time with wall-clock fallback.
async function nowSec(provider) {
  try {
    const b = await provider.getBlock("latest");
    if (b && b.timestamp) return BigInt(b.timestamp);
  } catch (e) {
    /* ignore */
  }
  return BigInt(Math.floor(Date.now() / 1000));
}

export async function GET() {
  try {
    // RPC + wallet
    const rpcUrl = process.env.RPC_URL || "https://testnet.hashio.io/api";
    const chainId = process.env.CHAIN_ID
      ? parseInt(process.env.CHAIN_ID, 10)
      : 296;
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) throw new Error("Private key missing");

    const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
    const wallet = new ethers.Wallet(privateKey, provider);
    const oracleHub = new ethers.Contract(
      process.env.ORACLEHUB_CONTRACT,
      OracleHubAbi,
      wallet
    );

    // --- SCRAPE ---
    const res = await axios.get(URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 30000,
    });

    const $ = cheerio.load(res.data);
    const $table = $("table")
      .filter((_, tbl) => {
        const headers = $(tbl).find("thead tr:first-child td, th");
        const texts = headers.map((__, h) => $(h).text().toLowerCase()).get();
        return (
          headers.length >= 5 &&
          texts.some((t) => t.includes("company")) &&
          texts.some((t) => t.includes("price"))
        );
      })
      .first();

    if (!$table || $table.length === 0)
      throw new Error("Could not locate listings table");

    const rows = [];
    const priceAssets = [];
    const pricePayloads = [];
    const bandAssets = [];
    const bandPayloads = [];

    // fresh ts (BigInt) for this request
    const ts = await nowSec(provider);

    $table.find("tbody tr").each((_, tr) => {
      const $td = $(tr).find("td");
      const $a = $td.eq(0).find("a");
      const code = extractCode($a.attr("href") || "");
      if (!code || !TARGET_SET.has(code)) return;

      const price = toNumber($td.eq(2).text().trim());
      const day = parsePercent($td.eq(3).text().trim());
      const ytd = parsePercent($td.eq(4).text().trim());
      if (price == null) return;

      const assetAddress = process.env[code];
      if (!assetAddress) {
        console.warn(`No address configured for ${code}`);
        return;
      }

      const pxE6 = BigInt(Math.round(price * 1e6)); // NGN * 1e6

      priceAssets.push(assetAddress);
      pricePayloads.push({
        priceE6: pxE6,
        seq: ts, // simple monotonic per batch
        ts: ts, // fresh ts
        hcsMsgId:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
      });

      bandAssets.push(assetAddress);
      bandPayloads.push({
        midE6: pxE6,
        widthBps: DEFAULT_BAND_WIDTH_BPS,
        ts: ts, // fresh ts
      });

      rows.push({ ticker: code, price, day, ytd });
    });

    console.table(rows);
    console.log("Price assets:", priceAssets.length);
    console.log("Band assets:", bandAssets.length);

    // --- SEND TO ORACLE: prices ---
    let priceTxHash = null;
    if (priceAssets.length > 0) {
      const tx = await oracleHub.setPrices(priceAssets, pricePayloads);
      const rec = await tx.wait();
      priceTxHash = tx.hash;
      console.log("setPrices OK:", priceTxHash, "status:", rec.status);
    } else {
      console.warn("No prices to update");
    }

    // --- SEND TO ORACLE: bands ---
    let bandTxHash = null;
    if (bandAssets.length > 0) {
      if (typeof oracleHub.setBands === "function") {
        try {
          const txb = await oracleHub.setBands(bandAssets, bandPayloads);
          const r = await txb.wait();
          bandTxHash = txb.hash;
          console.log("setBands OK:", bandTxHash, "status:", r.status);
        } catch (e) {
          console.warn(
            "setBands failed, falling back to setBand loop:",
            e?.message || e
          );
          for (let i = 0; i < bandAssets.length; i++) {
            const tx1 = await oracleHub.setBand(bandAssets[i], bandPayloads[i]);
            const r1 = await tx1.wait();
            console.log(
              `setBand ${i + 1}/${bandAssets.length} hash=${tx1.hash} status=${
                r1.status
              }`
            );
            bandTxHash = tx1.hash;
          }
        }
      } else {
        console.warn("ABI has no setBands; using setBand loop");
        for (let i = 0; i < bandAssets.length; i++) {
          const tx1 = await oracleHub.setBand(bandAssets[i], bandPayloads[i]);
          const r1 = await tx1.wait();
          console.log(
            `setBand ${i + 1}/${bandAssets.length} hash=${tx1.hash} status=${
              r1.status
            }`
          );
          bandTxHash = tx1.hash;
        }
      }
    } else {
      console.warn("No bands to update");
    }

    // ---- FX / NGN-per-USD update (optional but recommended) ----
    try {
      const tsFx = await nowSec(provider); // fresh ts for FX too

      const r = await fetch(
        "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?CMC_PRO_API_KEY=4875743b-bb4e-4671-8ba4-b8d38ad861fe&symbol=cNGN"
      );

      let rateNum = 1500; // default NGN per USD
      if (r.status === 200) {
        const body = await r.json();
        const priceUSD = body?.data?.["CNGN"]?.[0]?.quote?.["USD"]?.price;
        if (priceUSD > 0) {
          rateNum = Number(1 / priceUSD);
          rateNum = Math.round(rateNum * 1e2) / 1e2; // 2dp for stability
          console.log(`1 USD ≈ ${rateNum} NGN`);
        }
      } else {
        console.warn(
          `CMC response ${r.status} — using fallback ${rateNum} NGN`
        );
      }

      const ngnAsset = "0x00000000000000000000000000000000006a1e8c"; // your xNG-NGN oracle asset
      const rateE6 = BigInt(Math.round(rateNum * 1e6));

      const bandLoad = {
        midE6: rateE6,
        widthBps: DEFAULT_BAND_WIDTH_BPS,
        ts: tsFx,
      };
      const priceLoad = {
        priceE6: rateE6,
        seq: tsFx,
        ts: tsFx,
        hcsMsgId:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
      };

      const tx3 = await oracleHub.setPrice(ngnAsset, priceLoad);
      const r3 = await tx3.wait();
      console.log(
        `setPrice FX ${ngnAsset} hash=${tx3.hash} status=${r3.status}`
      );

      const tx4 = await oracleHub.setBand(ngnAsset, bandLoad);
      const r4 = await tx4.wait();
      console.log(
        `setBand  FX ${ngnAsset} hash=${tx4.hash} status=${r4.status}`
      );
      bandTxHash = tx4.hash;
    } catch (error) {
      console.warn("FX update failed (will not block equity bands):");
      console.warn(error);
    }

    // Optional: quick freshness audit
    try {
      const maxStale = await oracleHub.maxStaleness(); // uint64
      const nowChain = await nowSec(provider);
      for (const a of bandAssets) {
        const b = await oracleHub.getBand(a);
        const fresh = nowChain <= BigInt(b.ts) + BigInt(maxStale);
        console.log(`Freshness ${a}: ts=${b.ts} fresh=${fresh}`);
      }
    } catch (e) {
      /* optional */
    }

    return NextResponse.json(
      {
        success: true,
        pricesUpdated: priceAssets.length,
        bandsUpdated: bandAssets.length,
        priceTxHash,
        bandTxHash,
        bandWidthBps: DEFAULT_BAND_WIDTH_BPS,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Error:", err);
    return NextResponse.json(
      { success: false, error: err.message || String(err) },
      { status: 500 }
    );
  }
}
