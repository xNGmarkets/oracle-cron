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

// ---- Route ----
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
    // payloads for price + band
    const priceAssets = [];
    const pricePayloads = [];

    const bandAssets = [];
    const bandPayloads = [];

    $table.find("tbody tr").each((_, tr) => {
      const $td = $(tr).find("td");
      const $a = $td.eq(0).find("a");
      const code = extractCode($a.attr("href") || "");
      if (!code || !TARGET_SET.has(code)) return;

      const price = toNumber($td.eq(2).text().trim());
      const day = parsePercent($td.eq(3).text().trim());
      const ytd = parsePercent($td.eq(4).text().trim());
      if (price == null) return;

      // ENV should have: MTNN=0x..., ZENITHBANK=0x..., TOTALNG=0x..., etc.
      const assetAddress = process.env[code];
      if (!assetAddress) {
        console.warn(`No address configured for ${code}`);
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const pxE6 = BigInt(Math.round(price * 1e6));

      // price arrays
      priceAssets.push(assetAddress);
      pricePayloads.push({
        priceE6: pxE6,
        seq: BigInt(now), // simple monotonic seq for MVP
        ts: now,
        hcsMsgId:
          "0x0000000000000000000000000000000000000000000000000000000000000000",
      });

      // band arrays (mid = price, width = env/default BPS)
      bandAssets.push(assetAddress);
      bandPayloads.push({
        midE6: pxE6,
        widthBps: DEFAULT_BAND_WIDTH_BPS,
        ts: now,
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
      // Prefer bulk setBands; fallback to per-asset setBand if ABI/contract lacks it
      if (typeof oracleHub.setBands === "function") {
        try {
          const txb = await oracleHub.setBands(bandAssets, bandPayloads);
          const r = await txb.wait();
          bandTxHash = txb.hash;
          console.log("setBands OK:", bandTxHash, "status:", r.status);
        } catch (e) {
          console.warn("setBands failed, falling back to setBand loop:", e?.message || e);
          for (let i = 0; i < bandAssets.length; i++) {
            const tx1 = await oracleHub.setBand(bandAssets[i], bandPayloads[i]);
            const r1 = await tx1.wait();
            console.log(`setBand ${i + 1}/${bandAssets.length} hash=${tx1.hash} status=${r1.status}`);
            bandTxHash = tx1.hash;
          }
        }
      } else {
        console.warn("ABI has no setBands; using setBand loop");
        for (let i = 0; i < bandAssets.length; i++) {
          const tx1 = await oracleHub.setBand(bandAssets[i], bandPayloads[i]);
          const r1 = await tx1.wait();
          console.log(`setBand ${i + 1}/${bandAssets.length} hash=${tx1.hash} status=${r1.status}`);
          bandTxHash = tx1.hash;
        }
      }
    } else {
      console.warn("No bands to update");
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
