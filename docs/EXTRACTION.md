# Origem da extração

Projeto de origem: `asimov_typebot`, commit `dbc25139ce9ac0f1084261efea5f23b15f266c19` (correção do countdown duplicado no ingresso emitido), extraído em 7 de outubro de 2026.

`form.html` e `form.js` foram extraídos da versão completa dos dois ingressos, anterior à inclusão da carta. O script inclui também a correção presente na árvore atual: aguardar os salvamentos pendentes antes de concluir a sessão. Essa espera preserva a última resposta quando se avança rapidamente.

Os demais assets usados pelos ingressos foram copiados diretamente. `source-manifest.json` lista hashes dos arquivos preservados. A única adaptação de transporte é a configuração de `apiBase` em `public-common.js`. O GTM original foi movido para um arquivo opcional; permanece desativado na demonstração. Font Awesome 6.5.0 foi incluído localmente com CSS, fontes e licença, substituindo a URL do CDN para manter os ícones disponíveis no pacote. Foi acrescentada uma página inicial para abrir os dois exemplos.

As definições `pesquisa-leads-bf-2026` e `pesquisa-leads-bf-2026-emissao` vieram do banco local em modo somente leitura, por uma lista explícita de campos de apresentação, blocos e regras. Foram mantidos os 11 blocos de cada fluxo, IDs, opções, rótulos, condições, data, textos e links. Não foram copiados usuários, sessões, respostas, banco de dados, IDs de planilhas ou credenciais.

O servidor em `tools/serve.mjs` oferece somente a prévia local desses dois exemplos. As respostas de demonstração ficam em `.local/`, ignorada pelo Git. Não há sincronização com o projeto original. O projeto `asimov_typebot` não é modificado por essa extração.
