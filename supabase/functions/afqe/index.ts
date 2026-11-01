// Antifragile Quant Engine data endpoint.
// GET /functions/v1/afqe?kind=screener|exchange&sym=LAURUSLABS   header: x-afqe-token
// The token is checked inside Postgres (only its SHA-256 is stored); fetching and caching happen in SQL (public.afqe_api).
// Deploy with verify_jwt = false (the function does its own token check).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-afqe-token, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "";
  const sym = (url.searchParams.get("sym") ?? "").toUpperCase().replace(/[^A-Z0-9&-]/g, "");
  const token = req.headers.get("x-afqe-token") ?? "";
  if (!sym || !/^(screener|exchange)$/.test(kind)) return json({ error: "need kind=screener|exchange and sym" }, 400);
  if (!token) return json({ error: "missing token", code: "bad_token" }, 401);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data, error } = await sb.rpc("afqe_api", { token, kind, sym });
  if (error) return json({ error: error.message, code: "db_error" }, 500);
  if (data && data.code === "bad_token") return json(data, 401);
  if (data && data.code === "rate_limited") return json(data, 429);
  return json(data);
});
