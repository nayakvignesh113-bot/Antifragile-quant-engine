// Antifragile Quant Engine data endpoint (header x-afqe-token; token checked inside Postgres, only its SHA-256 is stored).
// GET  ?kind=screener|exchange&sym=LAURUSLABS (or a company name) · kind=scan|panel&sym=<page> · kind=state_get|alerts|baserates
// POST {kind:'state_put', body:{...}} · {kind:'alerts_seen', sym:'<last id>'}
// Deploy with verify_jwt = false (the function does its own token check).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-afqe-token, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const KINDS = /^(screener|exchange|scan|panel|state_get|state_put|alerts|alerts_seen|baserates)$/;
const NEEDS_SYM = /^(screener|exchange)$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  let kind = url.searchParams.get("kind") ?? "", rawSym = url.searchParams.get("sym") ?? "", body: unknown = null;
  if (req.method === "POST") {
    const j = await req.json().catch(() => null) as any;
    if (!j || typeof j !== "object") return json({ error: "bad JSON" }, 400);
    kind = String(j.kind ?? kind); rawSym = String(j.sym ?? rawSym); body = j.body ?? null;
  }
  // symbol or company name ("Deepak Nitrite"); names are resolved via Screener search in SQL
  const sym = rawSym.replace(/[^A-Za-z0-9&. -]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  const token = req.headers.get("x-afqe-token") ?? "";
  if (!KINDS.test(kind) || (NEEDS_SYM.test(kind) && !sym)) return json({ error: "unknown kind or missing sym" }, 400);
  if (kind === "state_put" && (req.method !== "POST" || !body || typeof body !== "object")) return json({ error: "state_put needs a POST body" }, 400);
  if (!token) return json({ error: "missing token", code: "bad_token" }, 401);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data, error } = await sb.rpc("afqe_api2", { token, kind, sym, body });
  if (error) return json({ error: error.message, code: "db_error" }, 500);
  if (data && data.code === "bad_token") return json(data, 401);
  if (data && data.code === "rate_limited") return json(data, 429);
  return json(data);
});
