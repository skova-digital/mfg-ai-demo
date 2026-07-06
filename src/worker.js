// 検査記録AI デモ — Cloudflare Workers バックエンド
// API: POST /api/extract, POST /api/records, GET /api/records, GET /api/stats
// EXTRACT_MODE=sample（既定・公開用）: Claude を呼ばず fixtures の事前実行済み応答を返す
// EXTRACT_MODE=live（ローカル開発のみ）: Claude API を tool use で呼び出す

const PROCESSES = ["cutting", "grinding", "assembly", "final"];
const DEFECTS = ["dimension", "scratch", "burr", "stain", "other"];
const JUDGEMENTS = ["pass", "fail", "recheck"];
const MAX_TEXT = 4000;
const MAX_IMAGE_B64 = 5_600_000; // ~4MB 画像の base64 相当

// Claude tool use に渡す抽出スキーマ（1回の報告に複数レコードがあり得るため配列）
const EXTRACT_TOOL = {
  name: "save_inspection_records",
  description: "検査報告から構造化された検査記録を抽出して保存する",
  input_schema: {
    type: "object",
    properties: {
      records: {
        type: "array",
        items: {
          type: "object",
          properties: {
            recorded_at: { type: ["string", "null"], description: "検査日 YYYY-MM-DD。不明なら null" },
            product_code: { type: ["string", "null"] },
            lot_no: { type: ["string", "null"] },
            process: { type: ["string", "null"], enum: [...PROCESSES, null] },
            inspector: { type: ["string", "null"] },
            qty_inspected: { type: ["integer", "null"] },
            qty_defect: { type: ["integer", "null"] },
            defect_type: { type: ["string", "null"], enum: [...DEFECTS, null] },
            measurement: { type: ["number", "null"] },
            judgement: { type: ["string", "null"], enum: [...JUDGEMENTS, null] },
            note: { type: ["string", "null"], description: "原文の要点・現場コメント" },
          },
          required: ["product_code", "qty_inspected", "judgement"],
        },
      },
      questions: {
        type: "array",
        items: { type: "string" },
        description: "読み取れなかった・確信が持てない項目についての確認質問（日本語）",
      },
    },
    required: ["records", "questions"],
  },
};

const EXTRACT_SYSTEM = `あなたは製造現場の検査報告を構造化するアシスタントです。
報告文や帳票画像から検査記録を抽出し、save_inspection_records ツールで返してください。
規則:
- 読み取れない項目は null にし、questions に確認質問を入れる。推測で埋めない
- 工程の対応: 切削=cutting / 研磨=grinding / 組立=assembly / 出荷前・最終=final
- 不良分類: 寸法=dimension / キズ=scratch / バリ=burr / 汚れ=stain / その他=other
- 判定が明記されていない場合: 不良ゼロなら pass、要確認の言及があれば recheck、それ以外で不良ありなら fail
- note には現場コメントの要点を原文に忠実に残す`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/extract" && request.method === "POST") return await handleExtract(request, env);
      if (url.pathname === "/api/records" && request.method === "POST") return await saveRecords(request, env);
      if (url.pathname === "/api/records" && request.method === "GET") return await listRecords(url, env);
      if (url.pathname === "/api/stats" && request.method === "GET") return await getStats(env);
      if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(`[${url.pathname}]`, e.message, e.stack);
      return json({ error: "サーバーエラーが発生しました。時間をおいて再度お試しください。" }, 500);
    }
  },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// ---- POST /api/extract ---------------------------------------------------
async function handleExtract(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || (typeof body.text !== "string" && typeof body.image_base64 !== "string" && !body.sample_id)) {
    return json({ error: "text か image_base64、または sample_id を指定してください。" }, 400);
  }
  if (body.text && body.text.length > MAX_TEXT) return json({ error: `テキストは${MAX_TEXT}字以内にしてください。` }, 400);
  if (body.image_base64 && body.image_base64.length > MAX_IMAGE_B64) return json({ error: "画像は4MB以内にしてください。" }, 400);

  if (env.EXTRACT_MODE !== "live") {
    // デモモード: 事前実行済みの応答（fixtures）を返す
    if (!body.sample_id) {
      return json({
        demo_mode: true,
        error: "デモモードではサンプル入力をご利用ください。自由入力のライブ変換は README のローカル実行手順で試せます。",
      }, 422);
    }
    const id = String(body.sample_id).replace(/[^a-z0-9-]/g, "");
    const res = await env.ASSETS.fetch(new Request(`https://assets.local/fixtures/sample-${id}.json`));
    if (!res.ok) return json({ error: "サンプルが見つかりません。" }, 404);
    const fixture = await res.json();
    return json({ demo_mode: true, ...fixture });
  }

  // live モード（ローカル開発のみ）: Claude API を呼び出す
  if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY が未設定です（.dev.vars を確認）。" }, 500);
  const content = [];
  if (body.image_base64) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: body.image_media_type || "image/jpeg", data: body.image_base64 },
    });
  }
  content.push({ type: "text", text: body.text || "この帳票画像から検査記録を抽出してください。" });

  const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: EXTRACT_SYSTEM,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "save_inspection_records" },
      messages: [{ role: "user", content }],
    }),
  });
  if (!apiRes.ok) {
    console.error("anthropic api", apiRes.status, await apiRes.text());
    return json({ error: "AI 変換に失敗しました。時間をおいて再度お試しください。" }, 502);
  }
  const data = await apiRes.json();
  const toolUse = (data.content || []).find((c) => c.type === "tool_use");
  if (!toolUse) return json({ error: "AI から構造化結果を取得できませんでした。" }, 502);
  return json({ demo_mode: false, records: toolUse.input.records || [], questions: toolUse.input.questions || [] });
}

// ---- POST /api/records ----------------------------------------------------
function validateRecord(r) {
  if (!r || typeof r !== "object") return "レコード形式が不正です";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.recorded_at || "")) return "検査日は YYYY-MM-DD で入力してください";
  if (!r.product_code || String(r.product_code).length > 40) return "品番を入力してください（40字以内）";
  if (!PROCESSES.includes(r.process)) return "工程が不正です";
  if (!Number.isInteger(r.qty_inspected) || r.qty_inspected < 1 || r.qty_inspected > 100000) return "検査数は1〜100000の整数で入力してください";
  if (!Number.isInteger(r.qty_defect) || r.qty_defect < 0 || r.qty_defect > r.qty_inspected) return "不良数は0以上・検査数以下で入力してください";
  if (r.defect_type != null && !DEFECTS.includes(r.defect_type)) return "不良分類が不正です";
  if (!JUDGEMENTS.includes(r.judgement)) return "判定が不正です";
  if (r.measurement != null && (typeof r.measurement !== "number" || !isFinite(r.measurement))) return "実測値が不正です";
  if (r.note != null && String(r.note).length > 500) return "コメントは500字以内にしてください";
  return null;
}

async function saveRecords(request, env) {
  const body = await request.json().catch(() => null);
  const records = body?.records;
  if (!Array.isArray(records) || records.length === 0 || records.length > 50) {
    return json({ error: "records は1〜50件の配列で指定してください。" }, 400);
  }
  for (const [i, r] of records.entries()) {
    const err = validateRecord(r);
    if (err) return json({ error: `${i + 1}件目: ${err}` }, 400);
  }
  const stmt = env.DB.prepare(
    `INSERT INTO inspection_records
     (recorded_at,product_code,lot_no,process,inspector,qty_inspected,qty_defect,defect_type,measurement,judgement,note,source_type)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  await env.DB.batch(records.map((r) =>
    stmt.bind(
      r.recorded_at, r.product_code, r.lot_no || "-", r.process, r.inspector || "-",
      r.qty_inspected, r.qty_defect, r.defect_type ?? null, r.measurement ?? null,
      r.judgement, r.note ?? null, r.source_type === "sample" ? "sample" : "text"
    )
  ));
  return json({ saved: records.length });
}

// ---- GET /api/records ------------------------------------------------------
async function listRecords(url, env) {
  const p = url.searchParams;
  const conds = [];
  const binds = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.get("from") || "")) { conds.push("recorded_at >= ?"); binds.push(p.get("from")); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.get("to") || "")) { conds.push("recorded_at <= ?"); binds.push(p.get("to")); }
  if (PROCESSES.includes(p.get("process"))) { conds.push("process = ?"); binds.push(p.get("process")); }
  if (p.get("judgement") && JUDGEMENTS.includes(p.get("judgement"))) { conds.push("judgement = ?"); binds.push(p.get("judgement")); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM inspection_records ${where} ORDER BY recorded_at DESC, id DESC LIMIT 200`
  ).bind(...binds).all();
  return json({ records: results });
}

// ---- GET /api/stats --------------------------------------------------------
async function getStats(env) {
  const [kpi, weekly, byDefect, matrix, rechecks] = await Promise.all([
    env.DB.prepare(
      `SELECT SUM(qty_inspected) AS inspected, SUM(qty_defect) AS defects,
              SUM(CASE WHEN judgement='recheck' THEN 1 ELSE 0 END) AS rechecks
       FROM inspection_records WHERE recorded_at >= date((SELECT MAX(recorded_at) FROM inspection_records), '-27 days')`
    ).first(),
    env.DB.prepare(
      `SELECT strftime('%Y-%W', recorded_at) AS week, MIN(recorded_at) AS week_start,
              SUM(qty_inspected) AS inspected, SUM(qty_defect) AS defects
       FROM inspection_records GROUP BY week ORDER BY week`
    ).all(),
    env.DB.prepare(
      `SELECT defect_type, SUM(qty_defect) AS defects FROM inspection_records
       WHERE defect_type IS NOT NULL GROUP BY defect_type ORDER BY defects DESC`
    ).all(),
    env.DB.prepare(
      `SELECT product_code, process, SUM(qty_inspected) AS inspected, SUM(qty_defect) AS defects
       FROM inspection_records GROUP BY product_code, process`
    ).all(),
    env.DB.prepare(
      `SELECT recorded_at, product_code, lot_no, process, qty_inspected, qty_defect, defect_type, note
       FROM inspection_records WHERE judgement='recheck' ORDER BY recorded_at DESC LIMIT 8`
    ).all(),
  ]);
  return json({
    kpi,
    weekly: weekly.results,
    by_defect: byDefect.results,
    matrix: matrix.results,
    rechecks: rechecks.results,
  });
}
