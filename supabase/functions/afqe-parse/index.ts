// Market-scanner parser. pg_cron calls this every 10 minutes (header x-afqe-token).
// It takes compacted Screener/BSE payloads queued by public.afqe_scan_batch, parses them with core.js
// (generated from index.html, so identical to the page), and stores one engine row per company.
// Deploy with verify_jwt = false. After regenerating core.js, push, then bump CORE_URL to the new commit.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { DOMParser } from "npm:linkedom@0.18.5";

const CORE_URL = "https://raw.githubusercontent.com/nayakvignesh113-bot/Antifragile-quant-engine/COMMIT_SHA/supabase/functions/afqe-parse/core.js";
(globalThis as any).DOMParser = DOMParser;
const core = await import(CORE_URL);

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const token = req.headers.get("x-afqe-token") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: queue, error } = await sb.rpc("afqe_parse_queue", { token, lim: 40 });
  if (error) return json({ error: error.message }, 500);
  if (!Array.isArray(queue)) return json(queue, 401);
  const out: any[] = [];
  for (const it of queue) {
    const sym = it.symbol;
    try {
      const j = it.scr;
      const hs = core.screenerHealth(j);
      if (hs.crit.length) { out.push({ symbol: sym, row: null, issues: hs.issues, crit: hs.crit, err: "layout: " + hs.crit.join(", ") }); continue; }
      const { o, checks } = core.fromScreener(j, String(j.symbol || sym).toUpperCase(), "other");
      const xi = core.parseExchange(it.exch, o, checks);
      o.sector_type = core.sectorFromIndustry(o._industry);
      delete o._prices;
      o._about = String(o._about || "").slice(0, 600);
      for (const k of Object.keys(o)) if (typeof o[k] === "number" && !isFinite(o[k])) o[k] = null;
      out.push({ symbol: sym, row: o, checks, issues: hs.issues.concat(xi), crit: [], err: null });
    } catch (e) {
      out.push({ symbol: sym, row: null, issues: [], crit: [], err: String((e as Error)?.message || e).slice(0, 200) });
    }
  }
  if (!out.length) return json({ parsed: 0 });
  const { data: st, error: e2 } = await sb.rpc("afqe_parse_store", { token, items: out });
  if (e2) return json({ error: e2.message }, 500);
  return json({ parsed: out.length, ok: out.filter((x) => x.row).length, stored: st });
});
