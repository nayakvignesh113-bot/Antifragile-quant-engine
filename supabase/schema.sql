-- Antifragile Quant Engine — data backend (Supabase / Postgres 17)
-- Fetches Screener.in public pages, Screener cost/asset schedules, Yahoo monthly prices and BSE filings,
-- caches them for 12 h, and returns only the tables the engine reads.
-- Applied to the live project already; kept here so it can be rebuilt.

create extension if not exists http with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists afqe;
revoke all on schema afqe from anon, authenticated;
grant usage on schema afqe to service_role;

create table if not exists afqe.cache (key text primary key, status int, body text, fetched_at timestamptz default now());
create table if not exists afqe.config (key text primary key, val text not null);
create table if not exists afqe.calls (at timestamptz default now(), kind text, sym text, ok boolean);
grant select on afqe.config to service_role;

-- Set your own access token (only its hash is stored):
-- insert into afqe.config(key,val) values ('token_sha256', encode(extensions.digest('YOUR_TOKEN','sha256'),'hex'))
--   on conflict (key) do update set val = excluded.val;

create or replace function afqe.compact(h text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(h,''),
    '<(/?)(\w+)[^>]*?>', '<\1\2>', 'g'),                               -- drop attributes
    '<(/?)(button|span|a|i|svg|path|div|p|small|sup)>', ' ', 'g'),      -- drop inline wrappers
    '\s+', ' ', 'g')
$$;

create or replace function afqe.section(body text, sid text) returns text language sql immutable as $$
  select substring(body from '<section[^>]*?id="'||sid||'".*?</section>')
$$;

-- Fixed URL templates only (no arbitrary URLs), 12 h cache.
create or replace function public.afqe_fetch(kind text, sym text, max_age_hours int default 12)
returns jsonb language plpgsql security definer set search_path = public, extensions, afqe as $$
declare u text; k text; r extensions.http_response; c afqe.cache%rowtype; hd extensions.http_header[];
  s text := upper(regexp_replace(coalesce(sym,''),'[^A-Za-z0-9&_.-]','','g')); d text := regexp_replace(coalesce(sym,''),'\D','','g');
begin
  if s = '' then return jsonb_build_object('error','empty symbol'); end if;
  u := case kind
    when 'screener_c' then 'https://www.screener.in/company/'||s||'/consolidated/'
    when 'screener_s' then 'https://www.screener.in/company/'||s||'/'
    when 'sched_c' then 'https://www.screener.in/api/company/'||d||'/schedules/?parent=Expenses&section=profit-loss&consolidated='
    when 'sched_s' then 'https://www.screener.in/api/company/'||d||'/schedules/?parent=Expenses&section=profit-loss'
    when 'schedoa_c' then 'https://www.screener.in/api/company/'||d||'/schedules/?parent=Other+Assets&section=balance-sheet&consolidated='
    when 'schedoa_s' then 'https://www.screener.in/api/company/'||d||'/schedules/?parent=Other+Assets&section=balance-sheet'
    when 'yahoo' then 'https://query1.finance.yahoo.com/v8/finance/chart/'||s||'.NS?range=10y&interval=1mo'
    when 'bse_find' then 'https://api.bseindia.com/BseIndiaAPI/api/PeerSmartSearch/w?Type=SS&text='||s
    when 'bse_header' then 'https://api.bseindia.com/BseIndiaAPI/api/ComHeadernew/w?quotetype=EQ&scripcode='||d||'&seriesid='
    when 'bse_shp' then 'https://api.bseindia.com/BseIndiaAPI/api/shpSecSummery_New/w?qtrid=&scripcode='||d
    when 'bse_res' then 'https://api.bseindia.com/BseIndiaAPI/api/GetReportNewFor_Result/w?scripcode='||d
    else null end;
  if u is null then return jsonb_build_object('error','unknown kind'); end if;
  k := kind||':'||s;
  select * into c from afqe.cache where key = k;
  if found and c.status = 200 and c.fetched_at > now() - make_interval(hours => max_age_hours) then
    return jsonb_build_object('status',c.status,'body',c.body,'cached',true,'fetched_at',c.fetched_at,'url',u);
  end if;
  hd := array[extensions.http_header('User-Agent','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'),
              extensions.http_header('Accept-Language','en-US,en;q=0.9')];
  if kind like 'bse%' then   -- BSE's API refuses requests without its own Origin/Referer and fetch-metadata headers
    hd := hd || array[extensions.http_header('Accept','application/json, text/plain, */*'),extensions.http_header('Origin','https://www.bseindia.com'),
                      extensions.http_header('Referer','https://www.bseindia.com/'),extensions.http_header('sec-fetch-site','same-site'),extensions.http_header('sec-fetch-mode','cors')];
  else
    hd := hd || array[extensions.http_header('Accept','text/html,application/json,*/*')];
  end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT','25');
  select * into r from extensions.http(('GET', u, hd, null, null)::extensions.http_request);
  insert into afqe.cache(key,status,body,fetched_at) values (k, r.status, r.content, now())
    on conflict (key) do update set status = excluded.status, body = excluded.body, fetched_at = excluded.fetched_at;
  return jsonb_build_object('status',r.status,'body',r.content,'cached',false,'fetched_at',now(),'url',u);
end $$;

-- Screener page (consolidated, falling back to standalone) + schedules + Yahoo prices, compacted (~25 KB per stock).
create or replace function public.afqe_screener(sym text) returns jsonb
language plpgsql security definer set search_path = public, extensions, afqe as $$
declare oa jsonb; r jsonb; b text; cons boolean := true; cid text; sch jsonb; y jsonb; yb jsonb; sh text;
begin
  r := public.afqe_fetch('screener_c', sym);
  if (r->>'status')::int <> 200 then return jsonb_build_object('error','Screener returned '||coalesce(r->>'status','?')||' for '||sym); end if;
  b := r->>'body';
  if position('<table' in coalesce(afqe.section(b,'profit-loss'),'')) = 0 then
    r := public.afqe_fetch('screener_s', sym); b := r->>'body'; cons := false;
  end if;
  cid := (regexp_match(b,'data-company-id="(\d+)"'))[1];
  if cid is not null then
    sch := public.afqe_fetch(case when cons then 'sched_c' else 'sched_s' end, cid);
    oa  := public.afqe_fetch(case when cons then 'schedoa_c' else 'schedoa_s' end, cid);
  end if;
  sh := substring(coalesce(afqe.section(b,'shareholding'),'') from '<div id="quarterly-shp">.*?</table>');
  y := public.afqe_fetch('yahoo', sym);
  begin yb := ((y->>'body')::jsonb)->'chart'->'result'->0; exception when others then yb := null; end;
  return jsonb_build_object(
    'symbol', upper(sym), 'consolidated', cons, 'company_id', cid,
    'name', trim(regexp_replace((regexp_match(b,'<title>\s*(.*?)\s*</title>'))[1],'\s*(share price.*|\|.*|- .*)$','')),
    'about', left(afqe.compact((regexp_match(b,'<div class="sub show-more-box about"[^>]*>(.*?)</div>'))[1]),1500),
    'top', afqe.compact(substring(b from '<ul id="top-ratios">.*?</ul>')),
    'quarters', afqe.compact(substring(afqe.section(b,'quarters') from '<table.*?</table>')),
    'profit_loss', afqe.compact(substring(afqe.section(b,'profit-loss') from '<table.*?</table>')),
    'balance_sheet', afqe.compact(substring(afqe.section(b,'balance-sheet') from '<table.*?</table>')),
    'cash_flow', afqe.compact(substring(afqe.section(b,'cash-flow') from '<table.*?</table>')),
    'ratios', afqe.compact(substring(afqe.section(b,'ratios') from '<table.*?</table>')),
    'shareholding', afqe.compact(sh),
    'schedules', case when (sch->>'status')::int = 200 then (sch->>'body')::jsonb else null end,
    'assets', case when (oa->>'status')::int = 200 then (oa->>'body')::jsonb else null end,
    'yahoo', case when yb is null then null else jsonb_build_object('t', yb->'timestamp', 'close', yb->'indicators'->'quote'->0->'close', 'price', yb->'meta'->'regularMarketPrice') end,
    'fetched_at', r->>'fetched_at', 'cached', r->'cached');
end $$;

-- BSE: scrip code, industry, shareholding filing (pledge), filed standalone results + Screener standalone quarters for the cross-check.
create or replace function public.afqe_exchange(sym text, want_screener_standalone boolean default true) returns jsonb
language plpgsql security definer set search_path = public, extensions, afqe as $$
declare f jsonb; code text; h jsonb; sh jsonb; rs jsonb; ss jsonb; m text[]; st jsonb := '{}'::jsonb; hj jsonb;
begin
  f := public.afqe_fetch('bse_find', sym, 720);
  st := st || jsonb_build_object('find', f->'status');
  if (f->>'status')::int = 200 then
    for m in select regexp_matches(f->>'body', $r$liclick\('(\d+)','[^']*'\)[^<]*<a>[^<]*<br\s*/?><span><strong>([^<]*)</strong>$r$, 'g') loop
      if upper(trim(m[2])) = upper(sym) then code := m[1]; exit; end if;
    end loop;
    if code is null then code := (regexp_match(f->>'body', $r$liclick\('(\d+)'$r$))[1]; end if;
  end if;
  if code is null then return jsonb_build_object('error','BSE code not found', 'status', st); end if;
  h  := public.afqe_fetch('bse_header', code, 168);
  sh := public.afqe_fetch('bse_shp', code);
  rs := public.afqe_fetch('bse_res', code);
  if want_screener_standalone then ss := public.afqe_fetch('screener_s', sym); end if;
  begin hj := (h->>'body')::jsonb; exception when others then hj := null; end;
  return jsonb_build_object(
    'scrip', code, 'isin', hj->>'ISIN', 'industry', hj->>'Industry', 'sector', hj->>'Sector',
    'shp_text', case when (sh->>'status')::int = 200 then regexp_replace(regexp_replace(((sh->>'body')::jsonb)->>'Data','<[^>]+>','|','g'),'\|[\s|]*\|','|','g') end,
    'results_html', case when (rs->>'status')::int = 200 then afqe.compact(((rs->>'body')::jsonb)->>'QtlyinCr') end,
    'screener_s_quarters', case when (ss->>'status')::int = 200 then afqe.compact(substring(afqe.section(ss->>'body','quarters') from '<table.*?</table>')) end,
    'status', st || jsonb_build_object('header', h->'status', 'shp', sh->'status', 'results', rs->'status', 'screener_s', ss->'status'));
exception when others then
  return jsonb_build_object('error', 'exchange fetch failed: '||sqlerrm);
end $$;

-- Entry point for the edge function: token check + 300 fetches/hour cap.
create or replace function public.afqe_api(token text, kind text, sym text) returns jsonb
language plpgsql security definer set search_path = public, extensions, afqe as $$
declare n int; r jsonb;
begin
  if coalesce(token,'') = '' or encode(extensions.digest(token,'sha256'),'hex') <> (select val from afqe.config where key='token_sha256') then
    return jsonb_build_object('error','unauthorised','code','bad_token');
  end if;
  select count(*) into n from afqe.calls where at > now() - interval '1 hour';
  if n > 300 then return jsonb_build_object('error','rate limit: 300 fetches per hour','code','rate_limited'); end if;
  if kind = 'screener' then r := public.afqe_screener(sym);
  elsif kind = 'exchange' then r := public.afqe_exchange(sym);
  else return jsonb_build_object('error','unknown kind'); end if;
  insert into afqe.calls(kind,sym,ok) values (kind, sym, r ? 'error' = false);
  return r;
end $$;

revoke all on function public.afqe_fetch(text,text,int), public.afqe_screener(text), public.afqe_exchange(text,boolean), public.afqe_api(text,text,text) from public, anon, authenticated;
grant execute on function public.afqe_fetch(text,text,int), public.afqe_screener(text), public.afqe_exchange(text,boolean), public.afqe_api(text,text,text) to service_role;
