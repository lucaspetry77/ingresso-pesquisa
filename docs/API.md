# Contrato público

O frontend mantém as chamadas originais. O prefixo é `frontend/config.js → apiBase` (padrão `/api`). Não usa token administrativo. Se a API estiver em outro domínio, ela precisa aceitar as requisições do domínio da página.

## GET /api/public/f/{slug}

Retorna o fluxo e seus blocos ativos, ordenados por `order_index`. Exemplos completos estão em `examples/flows/`. Campos consumidos: `id`, `name`, `flow_type`, `page_title`, `page_subtitle`, `ticket_subtitle`, `countdown_date`, `pure_end_behavior`, `final_message`, `button_text` e `blocks`.

Cada bloco inclui `id`, `type`, `content`, `variable_name`, `ticket_label`, `options`, `conditions`, `order_index` e `is_active`. Tipos: `message`, `text_input`, `email_input`, `phone_input`, `single_choice`, `multiple_choice`. Condições de navegação: `{ "answer": "Sim", "target_block_id": "id-do-bloco" }`; `__finish__` encerra a sequência. Sem condição correspondente, segue para o próximo bloco.

## POST /api/public/sessions

Recebe `{ "flow_id": "...", "meta": { "utm_source": "..." }, "prefill": { "nome": "..." } }`. `meta` e `prefill` podem ser `null`. Retorna `{ "session_id": "uuid" }`.

O backend registra os campos de pré-preenchimento que correspondem às variáveis dos blocos e guarda os demais para regras de link/integração. A página usa query params `v_*`, aliases (`nome_lead`, `email_lead`, `phone_lead`), os parâmetros aceitos em `public-common.js` e cookies `*_lead`.

## POST /api/public/sessions/answer

Recebe `{ "session_id": "...", "block_id": "...", "answer": "..." }`. Retorna `{ "ok": true }`. Deve substituir a resposta anterior do mesmo bloco na sessão; voltar e responder novamente não cria duplicatas. Múltipla escolha usa uma string separada por `", "`.

## POST /api/public/sessions/complete

Recebe `{ "session_id": "..." }`. Retorna `{ "whatsapp_link": "https://..." }` ou `null` no campo do link. Conclui a sessão e resolve o destino final. Repetir a chamada não deve repetir integrações.

A API real pode exportar as respostas para sua integração. O servidor de prévia apenas registra no arquivo local. Regras condicionais de link dos exemplos aceitam `match: "all" | "any"`, `conditions: [{ variable_name, answer }]` ou `answers: [...]`, e `link`; a primeira regra correspondente ganha. Também há suporte ao formato legado `{ variable_name, answer, link }`. Comparação de links condicionais ignora caixa e espaços nas bordas; múltipla escolha compara também cada item selecionado.

## GET /api/public/sessions/{session_id}/redirect

Registra o clique e responde `302` com o destino resolvido na conclusão. O botão final usa essa rota para manter o registro de clique.

## Confirmação

`pure_end_behavior` define `card_done`, `whatsapp_button`, `bot_message` ou `bot_message_redirect`. Os dois primeiros podem exibir o botão, o terceiro exibe a mensagem e o último redireciona automaticamente depois da confirmação. `final_message` admite interpolação de `{variavel}`. `countdown_date` sem fuso é interpretada como horário de Brasília (`-03:00`).
