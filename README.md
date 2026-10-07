# Ingresso Pesquisa

Frontend completo dos dois formulários da pesquisa de leads da Black Friday 2026 da Asimov:

- **Ingresso normal (`form`)**: o ingresso aparece desde o início, recebe as respostas e ganha o carimbo de confirmação.
- **Ingresso emitido (`form_print`)**: as perguntas alimentam o terminal; ao concluir, ele imprime o ingresso com animação de papel em WebGL e carimbo.

Os dois preservam as perguntas e opções originais, os caminhos de aluno e não aluno, múltipla escolha, pré-preenchimento por URL/cookies, retorno à pergunta anterior, retomada da sessão, validação de e-mail, máscara de telefone, atalhos de teclado, countdown em horário de Brasília, confirmação, botão do WhatsApp e link de agenda. O papel da impressora tem fallback para o ingresso estático quando WebGL não está disponível ou o dispositivo não mantém o desempenho necessário.

## Rodar

Requer Node.js 20 ou mais recente. Não há dependências para instalar nem etapa de build.

```sh
npm start
```

Abra `http://127.0.0.1:8003` para escolher a experiência:

- `http://127.0.0.1:8003/f/pesquisa-leads-bf-2026`
- `http://127.0.0.1:8003/f/pesquisa-leads-bf-2026-emissao`

Para mudar a porta: `PORT=8010 npm start`.

O servidor incluído é uma **prévia local**: reproduz o contrato público da API e grava as sessões de demonstração em `.local/sessions.json`, que fica fora do Git. Não envia respostas ao sistema original ou ao Google Sheets. Os links finais são os configurados nos JSONs de exemplo. Para zerar a demonstração, pare o servidor, remova `.local/` e limpe as chaves `typebot_session_*` no armazenamento do navegador.

## Arquivos

```text
frontend/
  form.html                 # Template compartilhado dos dois modos
  config.js                 # Endereço da API e ativação opcional do GTM
  css/form.css              # Formulário, ingresso, impressora e responsividade
  css/styles.css            # Tokens, fontes e estilos compartilhados originais
  js/form.js                # Perguntas, navegação, emissão e confirmação
  js/public-common.js       # Prefill, UTMs, validação, máscara e API
  js/ticket-cloth.js         # Snapshot do ingresso e simulação do papel em WebGL
  js/theme.js               # Aplicação de tema pela URL
  js/tracking.js            # GTM original, ativado somente por configuração
  img/                      # Logo Black Friday e guilloché do ingresso
  ds/                       # Logo Asimov, temas e fontes Inter locais
  vendor/fontawesome/       # Ícones, fontes e licença locais
examples/flows/              # Configurações completas dos dois fluxos, 11 blocos cada
tools/serve.mjs              # Servidor de prévia sem dependências
docs/API.md                 # Contrato para conectar um backend real
docs/source-manifest.json   # Origem e hashes dos arquivos extraídos
```

## Configurar os fluxos

Edite os JSONs em `examples/flows/`. `flow_type` seleciona `form` ou `form_print`. As configurações incluem textos, data, rótulos do ingresso, links finais e blocos com seus IDs e condições. Reinicie a prévia depois de editar. Preserve as referências `target_block_id` ao alterar IDs; `__finish__` encerra o fluxo.

Exemplo de pré-preenchimento:

```text
/f/pesquisa-leads-bf-2026?v_aluno=Sim&v_produto=Assinatura%20Anual
```

Campos já preenchidos são registrados e pulados. `?tema=teal_asimov` seleciona um tema de `ds/themes.js`.

## Integrar a API

Sirva `frontend/form.html` nas rotas `/f/{slug}` e os demais arquivos de `frontend/` na raiz. Conecte os endpoints descritos em [docs/API.md](docs/API.md). `frontend/config.js` define `apiBase` (padrão `/api`). A prévia local não substitui persistência e integrações do backend em produção.

O GTM original está preservado em `js/tracking.js`, desativado na prévia. Para ativar na implantação, defina `trackingEnabled: true` em `config.js`.

## Verificação e origem

```sh
npm run check
```

A extração mantém o frontend dos ingressos do `asimov_typebot`, incluindo o countdown corrigido e a espera pelo salvamento das respostas antes da conclusão. Os arquivos da carta e do painel administrativo ficam no projeto original. Nenhum banco de dados, resposta de participante, usuário, credencial ou configuração de Google Sheets foi exportado. Consulte [docs/EXTRACTION.md](docs/EXTRACTION.md) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
