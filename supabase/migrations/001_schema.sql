-- =====================================================================
-- Kedu Tracking: hub de atribuição de leads
-- 001_schema.sql : tabelas, regras, funções, views e permissões
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Eventos brutos: tudo que chega é guardado antes de ser processado
-- ---------------------------------------------------------------------
create table if not exists raw_events (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,                 -- site | whatsapp | ploomes | forms
  external_id  text,                          -- id da fonte, evita duplicidade
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  status       text not null default 'pendente', -- pendente | processado | ignorado | erro
  error        text,
  unique (source, external_id)
);
create index if not exists raw_events_source_idx on raw_events (source, received_at desc);
create index if not exists raw_events_status_idx on raw_events (status) where status in ('pendente','erro');

-- ---------------------------------------------------------------------
-- 2. Leads e identidades
-- ---------------------------------------------------------------------
create table if not exists leads (
  id                  uuid primary key default gen_random_uuid(),
  nome                text,
  escola              text,
  telefone_e164       text,
  email               text,
  ploomes_deal_id     bigint,
  first_touch_id      uuid,
  last_paid_touch_id  uuid,
  ploomes_sync_sig    text,        -- assinatura do último write-back no Ploomes
  created_at          timestamptz not null default now()
);
create index if not exists leads_created_idx on leads (created_at desc);

create table if not exists identities (
  tipo        text not null check (tipo in ('ploomes_deal','telefone','cnpj','email','anon')),
  valor       text not null,
  lead_id     uuid not null references leads(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (tipo, valor)
);
create index if not exists identities_lead_idx on identities (lead_id);

-- Códigos "ref" colocados na mensagem de WhatsApp enviada pelo site
create table if not exists ref_codes (
  code        text primary key,
  anon_id     text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. Anúncios e custos (sempre pelo ID, nunca pelo nome)
-- ---------------------------------------------------------------------
create table if not exists ads (
  ad_id        text primary key,     -- 'meta:1234' | 'google:5678' | 'google:c999' (campanha PMax)
  plataforma   text not null,        -- meta | google
  campanha     text,
  campanha_id  text,
  conjunto     text,
  criativo     text,
  updated_at   timestamptz not null default now()
);

create table if not exists ad_costs (
  ad_id       text not null,
  dia         date not null,
  gasto       numeric(12,2) not null default 0,
  impressoes  integer not null default 0,
  cliques     integer not null default 0,
  primary key (ad_id, dia)
);
create index if not exists ad_costs_dia_idx on ad_costs (dia);

-- ---------------------------------------------------------------------
-- 4. Touchpoints: cada clique, visita, formulário ou mensagem
-- ---------------------------------------------------------------------
create table if not exists touchpoints (
  id               uuid primary key default gen_random_uuid(),
  client_touch_id  text unique,          -- id gerado pelo script do site (dedupe)
  raw_event_id     uuid references raw_events(id) on delete set null,
  lead_id          uuid references leads(id) on delete cascade,
  anon_id          text,
  tipo             text not null,        -- visita | form_submit | wa_click | wa_message | crm
  atribuivel       boolean not null default true, -- false = só aparece na linha do tempo
  canal            text,
  is_paid          boolean not null default false,
  ad_id            text,
  utm_source       text, utm_medium text, utm_campaign text, utm_content text, utm_term text,
  gclid            text, gbraid text, wbraid text, fbclid text, fbc text, fbp text,
  ctwa_clid        text,
  wa_source_type   text,                 -- 'ad' | 'post' (referral do WhatsApp)
  wa_headline      text,
  referrer         text,
  landing_page     text,
  occurred_at      timestamptz not null default now()
);
create index if not exists touchpoints_lead_idx on touchpoints (lead_id, occurred_at);
create index if not exists touchpoints_anon_idx on touchpoints (anon_id) where lead_id is null;
create index if not exists touchpoints_ad_idx on touchpoints (ad_id);

-- ---------------------------------------------------------------------
-- 5. Etapas do funil
-- ---------------------------------------------------------------------
-- etapas: nomes padronizados, ordem no funil e conversões a devolver
create table if not exists etapas (
  nome                text primary key,
  ordem               integer not null default 100,
  meta_evento         text,   -- nome do evento enviado ao Meta (ex: QualifiedLead). Nulo = não envia
  google_conversao_id text,   -- ID da ação de conversão no Google Ads. Nulo = não envia
  ativo               boolean not null default true
);

-- stage_map: liga o ID do estágio no Ploomes ao nome padronizado
create table if not exists stage_map (
  ploomes_stage_id  bigint primary key,
  etapa             text not null references etapas(nome) on update cascade
);

create table if not exists stage_events (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid not null references leads(id) on delete cascade,
  ploomes_deal_id   bigint not null,
  etapa             text not null,
  ploomes_stage_id  bigint,
  executivo         text,
  occurred_at       timestamptz not null default now(),
  unique (ploomes_deal_id, etapa)
);
create index if not exists stage_events_lead_idx on stage_events (lead_id);

-- ---------------------------------------------------------------------
-- 6. Conversões devolvidas para Meta e Google
-- ---------------------------------------------------------------------
create table if not exists conversions_sent (
  id              uuid primary key default gen_random_uuid(),
  stage_event_id  uuid not null references stage_events(id) on delete cascade,
  lead_id         uuid references leads(id) on delete cascade,
  plataforma      text not null,          -- meta | google
  evento          text,
  status          text not null,          -- enviado | erro | sem_dados
  resposta        jsonb,
  created_at      timestamptz not null default now(),
  unique (stage_event_id, plataforma)
);

-- =====================================================================
-- REGRAS
-- =====================================================================

-- Classificação de canal. É uma função: se a regra mudar, rode
-- "update touchpoints set canal = null;" e tudo é reclassificado.
create or replace function classify_touchpoint() returns trigger
language plpgsql as $$
declare
  s text := lower(coalesce(new.utm_source, ''));
  m text := lower(coalesce(new.utm_medium, ''));
  r text := lower(coalesce(new.referrer, ''));
  medio_pago boolean := m in ('paid','cpc','ppc','paid_social','paidsocial','paid_search','ads','display');
begin
  if new.tipo = 'crm' then
    new.canal := 'CRM (sem origem)';
    new.is_paid := false;
    return new;
  end if;

  if new.wa_source_type = 'ad' or new.ctwa_clid is not null
     or new.ad_id like 'meta:%'
     or (s in ('meta','facebook','fb','instagram','ig') and medio_pago) then
    new.canal := 'Meta Ads'; new.is_paid := true;
  elsif new.gclid is not null or new.gbraid is not null or new.wbraid is not null
     or new.ad_id like 'google:%'
     or (s in ('google','adwords','google_ads','youtube') and medio_pago) then
    new.canal := 'Google Ads'; new.is_paid := true;
  elsif medio_pago then
    new.canal := 'Outras mídias pagas'; new.is_paid := true;
  elsif m in ('email','e-mail','newsletter') or s in ('flowbiz','email','newsletter') then
    new.canal := 'E-mail'; new.is_paid := false;
  elsif s in ('facebook','fb','instagram','ig','linkedin','youtube','tiktok') or m in ('social','organic_social') then
    new.canal := 'Social orgânico'; new.is_paid := false;
  elsif s <> '' then
    new.canal := 'Outros (UTM)'; new.is_paid := false;
  elsif new.tipo = 'wa_message' then
    new.canal := 'WhatsApp direto'; new.is_paid := false;
  elsif new.fbclid is not null then
    new.canal := 'Social orgânico'; new.is_paid := false;
  elsif r ~ '(google|bing|yahoo|duckduckgo|ecosia)\.' then
    new.canal := 'Busca orgânica'; new.is_paid := false;
  elsif r ~ '(facebook|instagram|linkedin|t\.co|twitter|x\.com|youtube|tiktok)' then
    new.canal := 'Social orgânico'; new.is_paid := false;
  elsif r <> '' then
    new.canal := 'Referência'; new.is_paid := false;
  else
    new.canal := 'Direto'; new.is_paid := false;
  end if;
  return new;
end $$;

drop trigger if exists trg_classify_touchpoint on touchpoints;
create trigger trg_classify_touchpoint
  before insert or update on touchpoints
  for each row execute function classify_touchpoint();

-- Atribuição do lead:
--  primeiro toque  = toque atribuível mais antigo conhecido (o "crm" só entra se não houver outro)
--  último pago     = toque pago mais recente até a entrada do lead, numa janela de 30 dias
create or replace function recompute_attribution(p_lead uuid) returns void
language plpgsql as $$
declare
  v_created timestamptz;
  v_first uuid;
  v_last uuid;
begin
  select created_at into v_created from leads where id = p_lead;
  if not found then return; end if;

  select id into v_first from touchpoints
   where lead_id = p_lead and atribuivel and tipo <> 'crm'
   order by occurred_at asc limit 1;
  if v_first is null then
    select id into v_first from touchpoints
     where lead_id = p_lead and atribuivel
     order by occurred_at asc limit 1;
  end if;

  select id into v_last from touchpoints
   where lead_id = p_lead and atribuivel and is_paid
     and occurred_at <= v_created + interval '10 minutes'
     and occurred_at >= v_created - interval '30 days'
   order by occurred_at desc limit 1;

  update leads
     set first_touch_id = v_first,
         last_paid_touch_id = v_last
   where id = p_lead
     and (first_touch_id is distinct from v_first or last_paid_touch_id is distinct from v_last);
end $$;

create or replace function trg_touchpoint_attr() returns trigger
language plpgsql as $$
begin
  if new.lead_id is not null then
    perform recompute_attribution(new.lead_id);
  end if;
  return null;
end $$;

drop trigger if exists trg_touchpoint_attr on touchpoints;
create trigger trg_touchpoint_attr
  after insert or update of lead_id, occurred_at, atribuivel on touchpoints
  for each row execute function trg_touchpoint_attr();

-- Junta dois leads que se revelaram a mesma escola
create or replace function merge_leads(p_keep uuid, p_drop uuid) returns void
language plpgsql as $$
declare d leads%rowtype;
begin
  if p_keep = p_drop then return; end if;
  select * into d from leads where id = p_drop;
  if not found then return; end if;

  update identities   set lead_id = p_keep where lead_id = p_drop;
  update touchpoints  set lead_id = p_keep where lead_id = p_drop;
  update stage_events set lead_id = p_keep where lead_id = p_drop;
  update conversions_sent set lead_id = p_keep where lead_id = p_drop;

  update leads set
    nome            = coalesce(nome, d.nome),
    escola          = coalesce(escola, d.escola),
    telefone_e164   = coalesce(telefone_e164, d.telefone_e164),
    email           = coalesce(email, d.email),
    ploomes_deal_id = coalesce(ploomes_deal_id, d.ploomes_deal_id),
    created_at      = least(created_at, d.created_at)
  where id = p_keep;

  delete from leads where id = p_drop;
end $$;

-- Encontra (ou cria) o lead a partir de uma lista de identidades.
-- p_ids: [{"tipo":"telefone","valor":"+5585999999999"}, {"tipo":"anon","valor":"..."}]
create or replace function resolve_lead(p_ids jsonb, p_nome text default null, p_escola text default null)
returns uuid
language plpgsql as $$
declare
  v_leads uuid[];
  v_keep uuid;
  v_drop uuid;
  rec record;
begin
  -- trava por identidade para evitar leads duplicados em webhooks simultâneos
  for rec in
    select x.tipo, x.valor from jsonb_to_recordset(p_ids) as x(tipo text, valor text)
    where coalesce(x.valor,'') <> '' order by 1, 2
  loop
    perform pg_advisory_xact_lock(hashtext(rec.tipo || ':' || rec.valor));
  end loop;

  select array_agg(l.id order by l.created_at) into v_leads
    from leads l
   where l.id in (
     select i.lead_id from identities i
     join jsonb_to_recordset(p_ids) as x(tipo text, valor text)
       on i.tipo = x.tipo and i.valor = x.valor);

  if v_leads is null then
    insert into leads (nome, escola) values (nullif(p_nome,''), nullif(p_escola,''))
    returning id into v_keep;
  else
    v_keep := v_leads[1];
    if array_length(v_leads, 1) > 1 then
      foreach v_drop in array v_leads[2:array_length(v_leads,1)] loop
        perform merge_leads(v_keep, v_drop);
      end loop;
    end if;
  end if;

  insert into identities (tipo, valor, lead_id)
  select x.tipo, x.valor, v_keep
    from jsonb_to_recordset(p_ids) as x(tipo text, valor text)
   where coalesce(x.valor,'') <> ''
  on conflict (tipo, valor) do nothing;

  update leads l set
    nome   = coalesce(l.nome, nullif(p_nome,'')),
    escola = coalesce(l.escola, nullif(p_escola,'')),
    telefone_e164 = coalesce(l.telefone_e164,
      (select valor from identities where lead_id = v_keep and tipo = 'telefone' order by created_at limit 1)),
    email = coalesce(l.email,
      (select valor from identities where lead_id = v_keep and tipo = 'email' order by created_at limit 1)),
    ploomes_deal_id = coalesce(l.ploomes_deal_id,
      (select valor::bigint from identities where lead_id = v_keep and tipo = 'ploomes_deal' order by created_at limit 1))
  where l.id = v_keep;

  -- anexa as visitas anônimas do site que agora sabemos de quem são
  update touchpoints t set lead_id = v_keep
   where t.lead_id is null
     and t.anon_id in (select valor from identities where lead_id = v_keep and tipo = 'anon');

  perform recompute_attribution(v_keep);
  return v_keep;
end $$;

-- =====================================================================
-- VIEWS (o painel só lê isto)
-- =====================================================================

create or replace view v_etapas as
  select nome, ordem, meta_evento, google_conversao_id
    from etapas where ativo order by ordem, nome;

create or replace view v_leads as
select
  l.id, l.nome, l.escola, l.telefone_e164, l.email, l.ploomes_deal_id, l.created_at,
  -- primeiro toque
  ft.canal                                              as ft_canal,
  ft.is_paid                                            as ft_pago,
  ft.ad_id                                              as ft_ad_id,
  coalesce(fa.campanha, ft.utm_campaign)                as ft_campanha,
  coalesce(fa.conjunto, ft.utm_term)                    as ft_conjunto,
  coalesce(fa.criativo, ft.wa_headline, ft.utm_content) as ft_criativo,
  ft.occurred_at                                        as ft_at,
  -- último toque pago
  lt.canal                                              as lp_canal,
  lt.ad_id                                              as lp_ad_id,
  coalesce(la.campanha, lt.utm_campaign)                as lp_campanha,
  coalesce(la.conjunto, lt.utm_term)                    as lp_conjunto,
  coalesce(la.criativo, lt.wa_headline, lt.utm_content) as lp_criativo,
  lt.occurred_at                                        as lp_at,
  -- etapas atingidas (primeira data de cada)
  (select jsonb_object_agg(s.etapa, s.primeira)
     from (select etapa, min(occurred_at) primeira
             from stage_events se where se.lead_id = l.id group by etapa) s) as etapas,
  (select executivo from stage_events se
    where se.lead_id = l.id and executivo is not null
    order by occurred_at desc limit 1)                  as executivo
from leads l
left join touchpoints ft on ft.id = l.first_touch_id
left join ads fa        on fa.ad_id = ft.ad_id
left join touchpoints lt on lt.id = l.last_paid_touch_id
left join ads la        on la.ad_id = lt.ad_id;

create or replace view v_costs as
select c.dia, c.ad_id, a.plataforma, a.campanha, a.conjunto, a.criativo,
       c.gasto, c.impressoes, c.cliques
  from ad_costs c
  left join ads a on a.ad_id = c.ad_id;

create or replace view v_timeline as
select t.lead_id, t.occurred_at,
       'toque'::text as tipo,
       case t.tipo
         when 'visita'      then 'Visita ao site'
         when 'form_submit' then 'Enviou formulário'
         when 'wa_click'    then 'Clicou no WhatsApp do site'
         when 'wa_message'  then 'Mensagem no WhatsApp'
         when 'crm'         then 'Criado no Ploomes'
         else t.tipo end as titulo,
       concat_ws(' | ', t.canal,
                 coalesce(a.campanha, t.utm_campaign),
                 coalesce(a.criativo, t.wa_headline, t.utm_content)) as detalhe
  from touchpoints t
  left join ads a on a.ad_id = t.ad_id
 where t.lead_id is not null
union all
select s.lead_id, s.occurred_at, 'etapa', s.etapa,
       concat_ws(' | ', 'Ploomes #' || s.ploomes_deal_id, s.executivo)
  from stage_events s;

create or replace view v_saude as
select source,
       max(received_at) as ultimo_evento,
       count(*) filter (where received_at > now() - interval '24 hours') as eventos_24h,
       count(*) filter (where status = 'erro' and received_at > now() - interval '7 days') as erros_7d
  from raw_events
 group by source;

-- =====================================================================
-- PERMISSÕES
-- Tabelas: só o backend (service_role) acessa.
-- Views: só usuários logados no painel leem.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['raw_events','leads','identities','ref_codes','ads','ad_costs',
                           'touchpoints','etapas','stage_map','stage_events','conversions_sent']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
grant select on v_etapas, v_leads, v_costs, v_timeline, v_saude to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
