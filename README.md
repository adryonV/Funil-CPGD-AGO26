# Funil de Tráfego — CPGD-AGO26 (Meta Ads)

Dashboard de funil de tráfego (Meta Ads) 100% na nuvem. Cruza duas planilhas Google
(somente leitura), agrega **sem dados pessoais** e publica no GitHub Pages.

**URL:** https://adryonv.github.io/Funil-CPGD-AGO26/

## Como funciona

- `build.mjs` (Node, sem dependências) roda no GitHub Actions:
  1. Lê a planilha de **anúncios** (aba *Meta Ads*) via export CSV.
  2. Lê a planilha de **compradores**: aba **Vendas Geral** (valor/`Bruto`) + aba
     **BASE COMPLETA** (UTMs). Cruza as duas por **primeiro nome + data** para juntar
     valor e atribuição, e resolve o anúncio de origem.
  3. Grava `public/data.json` (agregado, sem PII) e carimba o `BUILD_ID` (cache-bust).
- `public/index.html` é estático (mesma estrutura da dash de referência) e faz
  `fetch("data.json?v=<build>")`.
- GitHub Actions publica em GitHub Pages (`actions/deploy-pages`).

## Imposto

`meta.tax = 1.1385`. O `data.json` guarda o **gasto bruto**; o dashboard multiplica
pelo imposto **antes** de todas as métricas (CPM, CPC, CAC, ROAS, ticket…), então
nenhuma escapa do imposto.

## Automação

Disparo a cada 2h pelo **cron-job.org**:

- **URL:** `https://api.github.com/repos/adryonV/Funil-CPGD-AGO26/dispatches`
- **Método:** `POST`
- **Headers:** `Authorization: token <PAT>`, `Accept: application/vnd.github+json`,
  `Content-Type: application/json`, `User-Agent: cron-job`
- **Body:** `{"event_type":"rebuild"}`

Também roda por `schedule` (2h, backup), `workflow_dispatch` e no `push`.

## Fontes

- Anúncios: `1Q4KoC76d6aG7KG582jxYiLE3_bBeeNFyQ8gltg5BPq4` (aba Meta Ads, gid 0).
- Compradores: `1-03Pwug1SlYVa8JoxYQYsi5Lj5xTb1UVrpY8qfpY3u4` (abas Vendas Geral + BASE COMPLETA).

Ambas precisam estar compartilhadas como **"Qualquer pessoa com o link → Leitor"**.
