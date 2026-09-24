# Kedu Tracking — orientação para agentes

Este repositório é a fonte compartilhada do Kedu Tracking. Preserve a arquitetura e nunca grave credenciais no Git.

## Superfícies do projeto

- `dashboard/index.html`: fonte do painel estático.
- `dist/index.html`: versão publicada. Ao alterar o painel, mantenha este arquivo sincronizado.
- `site/kedu-track.js`: coletor instalado nos sites e landing pages da Kedu.
- `supabase/migrations`: modelo de dados, atribuição e permissões.
- `supabase/functions`: coletores, webhooks, sincronização de custos e conversões.

## Publicação

Todo push em `main` publica automaticamente o conteúdo de `dist/` no GitHub Pages. Antes do push:

1. valide a sintaxe do JavaScript do painel;
2. copie `dashboard/index.html` para `dist/index.html`;
3. confirme que nenhum segredo ou arquivo `.env` entrou no commit;
4. mantenha o aviso de demonstração até o Supabase real estar configurado.

O projeto também possui uma publicação privada no ChatGPT Sites. Ela é gerenciada pelo Codex e não substitui o GitHub Pages compartilhado.

## Dados e segurança

- Use somente variáveis de ambiente para chaves do Supabase, Meta, Google Ads, Ploomes e WhatsApp.
- A chave `anon` do Supabase pode ficar no painel, mas os dados devem continuar protegidos por autenticação e RLS.
- Não publique dados reais de leads, telefones, e-mails, payloads ou logs neste repositório.
- Mudanças na atribuição precisam preservar deduplicação, primeiro toque e último toque pago.

