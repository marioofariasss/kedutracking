# Kedu Tracking

Sistema próprio de rastreio de leads de mídia paga. Ele liga cada lead ao canal, campanha, criativo e horário de origem, acompanha a evolução no Ploomes e mostra o custo por etapa de cada anúncio.

```
site (kedu-track.js) ─┐
WhatsApp API ─────────┤
Ploomes (webhook) ────┼──> Hub no Supabase ──> Painel de leads
Flowbiz / WordPress ──┤                   ├──> Origem escrita no Ploomes
Custos Meta e Google ─┘                   └──> Conversões devolvidas ao Meta e Google
```

## O que tem aqui

| Pasta | O que é |
|---|---|
| `supabase/migrations/001_schema.sql` | Banco: tabelas, regras de canal, junção de leads, atribuição, views |
| `supabase/migrations/002_config.sql` | Etapas iniciais do funil e agendamentos |
| `supabase/functions/collect` | Recebe os eventos do script do site |
| `supabase/functions/webhook-whatsapp` | Mensagens do WhatsApp (formato oficial da Meta ou genérico) |
| `supabase/functions/webhook-ploomes` | Negócios criados e atualizados no Ploomes |
| `supabase/functions/webhook-forms` | Leads de formulários do Flowbiz e WordPress |
| `supabase/functions/sync-costs` | Gasto diário por anúncio (Meta e Google) |
| `supabase/functions/send-conversions` | Devolve etapas do funil como conversões |
| `site/kedu-track.js` | Script de captura para o site e landing pages |
| `dashboard/index.html` | Painel (pode ir para o GitHub Pages) |

## Publicação compartilhada

Este repositório é a fonte comum para Codex e Claude. Todo push na branch `main` aciona o fluxo em `.github/workflows/pages.yml`, que publica a pasta `dist/` no GitHub Pages. O arquivo `CLAUDE.md` contém as regras de manutenção e segurança para agentes.

Enquanto as credenciais reais não forem configuradas, a versão publicada funciona com dados demonstrativos claramente identificados. Nunca envie arquivos `.env`, tokens ou dados reais de leads ao repositório.

---

## Instalação

### 1. Projeto no Supabase

1. Crie um projeto em supabase.com (região São Paulo).
2. No **SQL Editor**, rode `001_schema.sql` inteiro.
3. Rode a primeira parte de `002_config.sql` (etapas). Deixe os agendamentos para o passo 7.
4. Em **Authentication > Sign In / Providers**, desative "Allow new users to sign up".
5. Em **Authentication > Users**, crie os usuários que vão acessar o painel.

### 2. Instalar a CLI e publicar as funções

```bash
npm install -g supabase
supabase login
supabase link --project-ref SEU_PROJETO

for f in collect webhook-whatsapp webhook-ploomes webhook-forms sync-costs send-conversions; do
  supabase functions deploy $f --no-verify-jwt
done
```

As funções usam o próprio segredo (`WEBHOOK_SECRET`) em vez do JWT do Supabase, porque quem chama são sistemas externos.

### 3. Segredos

Copie `.env.example` para `.env`, preencha e rode:

```bash
supabase secrets set --env-file .env
```

Só `WEBHOOK_SECRET` e `ALLOWED_ORIGINS` são obrigatórios para começar. O resto pode ser preenchido conforme cada integração for ligada. Gere um segredo forte com `openssl rand -hex 24`.

### 4. Script no site

Hospede `site/kedu-track.js` no próprio domínio (ex: `https://kedu.com.br/kedu-track.js`) e coloque no `<head>` de todas as páginas:

```html
<script src="https://kedu.com.br/kedu-track.js"
        data-endpoint="https://SEU_PROJETO.supabase.co/functions/v1/collect"
        data-consent="auto" defer></script>
```

- **WordPress:** use o plugin WPCode (Header) ou o tema.
- **Landing pages do Flowbiz:** cole no campo de scripts do cabeçalho, se o plano permitir.
- **Consentimento (LGPD):** se o banner de cookies precisar liberar antes, use `data-consent="required"` e chame `window.keduTrack.consent()` quando a pessoa aceitar.
- `ALLOWED_ORIGINS` precisa ter todos os domínios onde o script roda, separados por vírgula.

**Formulários:** o script cria campos ocultos `kt_*` em todos os formulários e, no envio, manda telefone e e-mail para o hub. Isso já liga a visita ao lead, sem depender do webhook do formulário.

- **Elementor:** adicione campos do tipo "Oculto" com ID `kt_anon_id`, `kt_source`, `kt_medium`, `kt_campaign`, `kt_content`, `kt_term`, `kt_ad`, `kt_gclid`, `kt_fbclid`, `kt_referrer`, `kt_landing`, `kt_touch_id`, `kt_touch_ts`. O script preenche.
- **Formulário do Flowbiz dentro de iframe:** o script não alcança o que está dentro do iframe. Nesse caso a ligação vem pelo webhook do Flowbiz (passo 5), usando telefone e e-mail.

**WhatsApp do site:** todo link `wa.me` ou `api.whatsapp.com` ganha um código na mensagem, tipo "(ref K7F2)". Quando a mensagem chega, o hub sabe de qual visita ela veio.

### 5. Webhooks

Todas as URLs levam o segredo no final: `?secret=SEU_SEGREDO`.

**Formulários (Flowbiz e WordPress)**
```
https://SEU_PROJETO.supabase.co/functions/v1/webhook-forms?secret=SEU_SEGREDO
```
Aceita JSON ou formulário comum. Os campos são descobertos pelo nome (email, telefone, whatsapp, nome, escola, cnpj).

**WhatsApp**
```
https://SEU_PROJETO.supabase.co/functions/v1/webhook-whatsapp?secret=SEU_SEGREDO
```
- Se a plataforma de atendimento consegue **repassar o webhook original da Meta**, aponte para esta URL. É o melhor caminho, porque o campo `referral` (anúncio de origem) vem intacto.
- Se ela manda um formato próprio, configure para enviar: `{ "id", "phone", "name", "text", "timestamp", "referral": { "source_type", "source_id", "source_url", "headline", "ctwa_clid" } }`.
- Se for apontar a Cloud API da Meta direto para cá, use `WA_VERIFY_TOKEN` na verificação. Atenção: a Meta aceita só uma URL por número, então isso só serve se a plataforma de atendimento não precisar dela.

**Ploomes**

Crie os webhooks de negócio (criação e atualização) pela API. Confira os IDs de entidade e ação na documentação do Ploomes antes de rodar:

```bash
URL="https://SEU_PROJETO.supabase.co/functions/v1/webhook-ploomes?secret=SEU_SEGREDO"
for ACAO in 1 2; do
  curl -X POST https://public-api2.ploomes.com/Webhooks \
    -H "User-Key: SUA_CHAVE_PLOOMES" -H "Content-Type: application/json" \
    -d "{\"EntityId\": 2, \"ActionId\": $ACAO, \"CallbackUrl\": \"$URL\"}"
done
```

**Campos de origem no Ploomes (write-back):** crie campos de texto no negócio (ex: "Origem tracking", "Campanha tracking", "Criativo tracking", "Data primeiro toque", "Último toque pago"), deixe como somente leitura para o time comercial e coloque as chaves (`deal_XXXX`) nos segredos `PLOOMES_FIELD_*`.

### 6. Etapas do funil

Na primeira vez que um negócio muda de estágio, o hub cria a etapa com o nome do Ploomes. Depois, ajuste no SQL Editor:

```sql
-- ver o que foi criado
select * from stage_map;
select * from etapas order by ordem;

-- ordenar e padronizar
update etapas set ordem = 25 where nome = 'Filtro 1';
update stage_map set etapa = 'Qualificado' where ploomes_stage_id = 110000003;

-- quais etapas viram conversão
update etapas set meta_evento = 'QualifiedLead', google_conversao_id = '123456789' where nome = 'Qualificado';
```

### 7. Agendamentos

No SQL Editor, rode o bloco de agendamentos de `002_config.sql` trocando `SEU_PROJETO` e `SEU_SEGREDO`. Para carregar custos antigos uma vez:

```bash
curl -X POST "https://SEU_PROJETO.supabase.co/functions/v1/sync-costs?secret=SEU_SEGREDO" \
  -H "Content-Type: application/json" -d '{"since":"2026-01-01","until":"2026-09-24"}'
```

### 8. Painel

1. Em `dashboard/index.html`, preencha `SUPABASE_URL` e `SUPABASE_ANON_KEY` (Settings > API).
2. Publique a pasta `dashboard` no GitHub Pages (Settings > Pages > branch `main`, pasta `/dashboard`) ou abra o arquivo direto no navegador.
3. Entre com um usuário criado no passo 1.

A chave anon é pública por natureza. As tabelas ficam bloqueadas e as views só respondem para quem fez login.

---

## Padrão de parâmetros nos anúncios

O que liga o lead ao custo é o **ID do anúncio**, não o nome. Sem isso, o ranking de criativos não funciona.

**Meta (Parâmetros de URL, no nível do anúncio):**
```
utm_source=meta&utm_medium=paid&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}&kt_ad={{ad.id}}
```

**Google Ads (Sufixo do URL final, no nível da conta):**
```
utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}&utm_content={creative}&kt_ad={creative}
```
Deixe a codificação automática (gclid) ligada.

**Anúncios de clique para WhatsApp:** não precisam de nada. O anúncio de origem vem no `referral` da primeira mensagem.

---

## Como a atribuição funciona

- **Primeiro toque:** o contato mais antigo conhecido da escola. Criação manual no Ploomes só vira origem se não existir nenhum outro toque.
- **Último toque pago:** o anúncio mais recente antes de a escola virar lead, dentro de 30 dias.
- **Mesma escola, vários registros:** telefone, e-mail, CNPJ, ID do Ploomes e visitante do site são juntados num lead só. O telefone é normalizado com o nono dígito, então `85 9999-0000` e `85 99999-0000` batem.
- **Regras de canal:** ficam na função `classify_touchpoint()`. Se mudar a regra, rode `update touchpoints set canal = null;` e tudo é reclassificado.

## Testes rápidos

```bash
S="SEU_SEGREDO"; P="https://SEU_PROJETO.supabase.co/functions/v1"

# formulário
curl -X POST "$P/webhook-forms?secret=$S" -H "Content-Type: application/json" \
  -d '{"nome":"Teste","escola":"Colégio Teste","telefone":"85999990000","email":"teste@escola.com","kt_source":"meta","kt_medium":"paid","kt_ad":"123"}'

# WhatsApp vindo de anúncio
curl -X POST "$P/webhook-whatsapp?secret=$S" -H "Content-Type: application/json" \
  -d '{"id":"wamid.teste1","phone":"5585988887777","name":"João","text":"Oi","timestamp":1790000000,"referral":{"source_type":"ad","source_id":"456","headline":"Inadimplência zero","ctwa_clid":"ABC"}}'
```

Depois confira em `select * from v_leads;` e no painel. Se algo não aparecer, veja `select * from raw_events where status = 'erro' order by received_at desc;`.

## Limites conhecidos

- Quem vê o anúncio e depois procura a Kedu no Google orgânico, ou recebe o número encaminhado, aparece com a origem do caminho que usou.
- Bloqueadores de anúncio e navegadores com proteção forte cortam parte das visitas do site. O fallback pelos campos `kt_*` e pelo telefone recupera boa parte.
- Etapas do Ploomes são registradas a partir da instalação. O histórico anterior pode ser importado depois, se necessário.
- Performance Max não tem anúncio individual: custo e leads ficam no nível da campanha.
- O Meta só aceita conversões com até 7 dias. O envio roda a cada 15 minutos, então isso só é problema se o sistema ficar parado.
