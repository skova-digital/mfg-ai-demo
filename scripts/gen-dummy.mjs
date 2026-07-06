// ダミーデータ生成: 90日分・約300レコードの検査記録を決定論的に生成する
// 出力: scripts/seed-data.sql（INSERT 文）
// 使い方: node scripts/gen-dummy.mjs
// ※ 全データは架空。実在の企業・製品・人物とは無関係。
//   「物語」: MK-2048 × grinding だけ不良率が高く、直近3週で悪化トレンドを仕込む。
//   ダッシュボードを開いた人が異常に「気づける」ことを実演するため。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE_DATE = "2026-07-06"; // 生成基準日（この日から過去90日分）
const DAYS = 90;
const SEED = 42;

// mulberry32: seed 固定の軽量 PRNG（再現可能な生成のため Math.random は使わない）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const randInt = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;

const PRODUCTS = [
  { code: "MK-1024", spec: [11.95, 12.05] },
  { code: "MK-2048", spec: [24.9, 25.1] },
  { code: "MK-3072", spec: [7.98, 8.02] },
  { code: "ST-410", spec: [39.8, 40.2] },
  { code: "ST-520", spec: [51.7, 52.3] },
];
const PROCESSES = ["cutting", "grinding", "assembly", "final"];
const INSPECTORS = ["田中", "佐々木", "山口", "井上"]; // 架空の検査員名
const DEFECTS = ["dimension", "scratch", "burr", "stain", "other"];

// 不良率の基本設計: 通常 1.5〜3% / MK-2048×grinding は高め+直近3週で悪化
function defectRate(product, process, daysAgo) {
  if (product === "MK-2048" && process === "grinding") {
    if (daysAgo <= 21) return 0.07 + rnd() * 0.05; // 直近3週: 7〜12%
    return 0.04 + rnd() * 0.03;                    // それ以前: 4〜7%
  }
  return 0.015 + rnd() * 0.015;                    // 通常: 1.5〜3%
}

function isoDate(daysAgo) {
  const d = new Date(`${BASE_DATE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

const NOTES_OK = ["特記なし", "問題なし", "良好", "", "", ""];
const NOTES_NG = {
  dimension: ["上限ギリ。要観察", "マイナス側に振れ気味", "限度見本と比較して判定"],
  scratch: ["側面に浅いキズ", "搬送時の擦れと思われる", "梱包前に再確認要"],
  burr: ["バリ残り。面取り再指示", "エッジ部にバリ", "バリ取り後は良好"],
  stain: ["油汚れ付着。洗浄で除去可", "指紋様の汚れ"],
  other: ["原因調査中", "写真添付済み（現物は保管）"],
};

const rows = [];
for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo--) {
  const date = isoDate(daysAgo);
  const recordsToday = randInt(2, 4);
  for (let i = 0; i < recordsToday; i++) {
    const product = pick(PRODUCTS);
    const process = pick(PROCESSES);
    const inspector = pick(INSPECTORS);
    const qty = randInt(20, 120);
    const rate = defectRate(product.code, process, daysAgo);
    const defect = Math.min(qty, Math.round(qty * rate * (0.5 + rnd())));
    const hasDefect = defect > 0;
    const defectType = hasDefect
      ? (product.code === "MK-2048" && process === "grinding" && rnd() < 0.7 ? "dimension" : pick(DEFECTS))
      : null;
    const [lo, hi] = product.spec;
    const mid = (lo + hi) / 2;
    const range = (hi - lo) / 2;
    // 実測値: 合格品は規格中央付近、不良(dimension)は規格外に振る
    const measurement = defectType === "dimension"
      ? +(hi + rnd() * range * 0.6).toFixed(3)
      : +(mid + (rnd() - 0.5) * range * 1.2).toFixed(3);
    const judgement = !hasDefect ? "pass" : defect / qty > 0.08 ? "fail" : rnd() < 0.3 ? "recheck" : "fail";
    const note = hasDefect ? pick(NOTES_NG[defectType]) : pick(NOTES_OK);
    const lot = `${product.code.slice(0, 2)}-${date.replaceAll("-", "").slice(2)}${String.fromCharCode(65 + randInt(0, 2))}`;
    rows.push({
      recorded_at: date, product_code: product.code, lot_no: lot, process, inspector,
      qty_inspected: qty, qty_defect: defect, defect_type: defectType,
      measurement, spec_lower: lo, spec_upper: hi, judgement, note, source_type: "seed",
    });
  }
}

const esc = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? v : `'${String(v).replaceAll("'", "''")}'`);
const cols = "recorded_at,product_code,lot_no,process,inspector,qty_inspected,qty_defect,defect_type,measurement,spec_lower,spec_upper,judgement,note,source_type";
const values = rows.map((r) => `(${cols.split(",").map((c) => esc(r[c])).join(",")})`);
// D1 の 1 ステートメント上限に配慮して 50 行ずつの INSERT に分割する
const chunks = [];
for (let i = 0; i < values.length; i += 50) {
  chunks.push(`INSERT INTO inspection_records (${cols}) VALUES\n${values.slice(i, i + 50).join(",\n")};`);
}
const sql = `-- 自動生成: node scripts/gen-dummy.mjs（seed=${SEED}・全データ架空）\n${chunks.join("\n\n")}\n`;

const out = join(dirname(fileURLToPath(import.meta.url)), "seed-data.sql");
writeFileSync(out, sql, "utf8");
console.log(`generated ${rows.length} records -> ${out}`);
const bad = rows.filter((r) => r.product_code === "MK-2048" && r.process === "grinding");
console.log(`MK-2048 x grinding: ${bad.length} records (story: high defect rate, worsening in last 3 weeks)`);
