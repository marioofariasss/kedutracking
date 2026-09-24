-- =====================================================================
-- 002_config.sql : etapas iniciais e agendamentos
-- Ajuste os nomes para bater com o funil do Ploomes.
-- =====================================================================

-- Etapas padronizadas do funil. Estágios novos do Ploomes que não estiverem
-- no stage_map são criados aqui automaticamente com o nome do Ploomes (ordem 100).
insert into etapas (nome, ordem, meta_evento, google_conversao_id) values
  ('Lead',         10, null,            null),
  ('Filtro 1',     20, null,            null),
  ('Qualificado',  30, 'QualifiedLead', null),
  ('Agendado',     40, 'Schedule',      null),
  ('Ganho',        90, 'Purchase',      null),
  ('Perdido',      99, null,            null)
on conflict (nome) do nothing;

-- Mapeie os IDs dos estágios do Ploomes para as etapas acima.
-- Descubra os IDs com: GET https://public-api2.ploomes.com/Deals@Stages
-- Exemplo:
-- insert into stage_map (ploomes_stage_id, etapa) values
--   (110000001, 'Lead'),
--   (110000002, 'Filtro 1'),
--   (110000003, 'Qualificado'),
--   (110000004, 'Agendado')
-- on conflict (ploomes_stage_id) do update set etapa = excluded.etapa;

-- =====================================================================
-- AGENDAMENTOS
-- Troque SEU_PROJETO e SEU_SEGREDO antes de rodar este bloco.
-- (pode rodar só esta parte no SQL Editor do Supabase)
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Custos do Meta e Google: todo dia às 6h (horário UTC = 3h de Fortaleza)
select cron.schedule('kt-sync-costs', '0 6 * * *', $$
  select net.http_post(
    url     := 'https://SEU_PROJETO.supabase.co/functions/v1/sync-costs',
    headers := '{"Content-Type":"application/json","x-kt-secret":"SEU_SEGREDO"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000);
$$);

-- Devolução de conversões para Meta e Google: a cada 15 minutos
select cron.schedule('kt-send-conversions', '*/15 * * * *', $$
  select net.http_post(
    url     := 'https://SEU_PROJETO.supabase.co/functions/v1/send-conversions',
    headers := '{"Content-Type":"application/json","x-kt-secret":"SEU_SEGREDO"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);

-- Limpeza: códigos ref com mais de 180 dias
select cron.schedule('kt-clean-refs', '30 5 * * 0', $$
  delete from ref_codes where created_at < now() - interval '180 days';
$$);
