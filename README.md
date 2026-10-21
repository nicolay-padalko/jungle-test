# Jungle — Carteira e apostas

Backend de um desafio técnico para processar apostas e movimentar o saldo de carteiras. As operações podem chegar pela API HTTP ou por uma fila de mensagens SQS.

O projeto registra créditos e débitos, impede saldo negativo e trata operações repetidas e estornos recebidos antes da aposta original.

Desafio original: <https://github.com/junglegaming/backend-challenge>.

> O projeto ainda está em desenvolvimento. As rotas HTTP são de demonstração e não há uma rota ou script para criar carteiras. Veja [Limitações atuais](#limitações-atuais) antes de testar manualmente.

## Tecnologias

| Tecnologia | Uso no projeto |
| --- | --- |
| Bun | Executar a aplicação e os testes |
| TypeScript com `strict` | Linguagem e verificação de tipos |
| NestJS 11 | API HTTP e organização dos serviços |
| PostgreSQL 17 | Armazenar carteiras, operações e mensagens |
| MikroORM 7 | Conexão com o banco, transações e migrations |
| decimal.js | Fazer cálculos monetários com precisão decimal |
| LocalStack 4 | Simular o AWS SQS no ambiente local |
| Docker Compose | Subir PostgreSQL e LocalStack |

As regras de movimentação usam SQL escrito diretamente no serviço de aplicação.

## Termos usados neste projeto

| Termo | Significado |
| --- | --- |
| Carteira (`wallet`) | Saldo de um jogador em uma moeda |
| Ledger | Histórico de créditos e débitos, com o saldo antes e depois de cada movimento |
| Idempotência | Repetir uma operação sem movimentar o saldo novamente |
| Transação de banco | Grupo de alterações que são confirmadas ou desfeitas juntas |
| Migration | Arquivo que cria ou altera a estrutura do banco |
| Worker | Processo que trabalha em segundo plano, consumindo mensagens e publicando eventos |
| Inbox | Registro das mensagens recebidas, usado para identificar repetições |
| Outbox | Registro de eventos que serão enviados para a fila após a gravação no banco |
| DLQ | Fila que recebe mensagens que não puderam ser processadas após várias tentativas |

## Como executar localmente

### 1. Pré-requisitos

Instale o Bun e o Docker com suporte a Docker Compose. Mantenha o Docker em execução.

Os comandos abaixo usam **PowerShell** e devem ser executados na raiz do projeto.

### 2. Instalar dependências e configurar o ambiente

```powershell
bun install
Copy-Item .env.example .env
```

Se você já tem um `.env` configurado, mantenha o arquivo e compare suas variáveis com `.env.example` antes de copiar. O Bun carrega o `.env` ao executar a aplicação.

O exemplo configura o banco `jungle`, com usuário `jungle`, em `127.0.0.1:5432`. Também define a porta da API e os endereços das filas locais.

### 3. Subir o banco e o LocalStack

```powershell
docker compose up -d
docker compose -f docker-compose.sqs.yml up -d
```

O PostgreSQL usa a porta `5432` e o LocalStack usa a porta `4566`. Aguarde os serviços iniciarem antes de continuar. Para conferir o estado:

```powershell
docker compose ps
docker compose -f docker-compose.sqs.yml ps
```

### 4. Preparar o banco e as filas

```powershell
bun run migration:up
bun scripts/create-queues-fifo.ts
```

As migrations criam as tabelas e suas regras de integridade. Elas não cadastram uma carteira de exemplo.

O script cria três filas FIFO, que agrupam as mensagens para entrega em ordem dentro de cada grupo:

| Fila | Finalidade |
| --- | --- |
| `wager-transactions.fifo` | Receber operações de aposta |
| `wager-transactions-dlq.fifo` | Receber mensagens com falha após o limite de 5 recebimentos |
| `wager-events.fifo` | Receber os eventos publicados pela outbox |

O script imprime as URLs. Se forem diferentes das configuradas, atualize `SQS_QUEUE_URL` e `SQS_EVENTS_QUEUE_URL` no `.env`.

### 5. Iniciar a API e o worker

Em um terminal, inicie a API:

```powershell
bun run dev
```

Em outro terminal, inicie o worker:

```powershell
bun src/messaging/worker.ts
```

A API fica disponível em `http://localhost:3000`, salvo alteração de `PORT`. O worker recebe operações pela fila, publica os eventos e tenta novamente os estornos que aguardam uma referência.

Para verificar a API e a conexão com o banco:

```powershell
Invoke-RestMethod http://localhost:3000/health/live
Invoke-RestMethod http://localhost:3000/health/ready
```

Essas verificações não dependem de uma carteira cadastrada. A rota `/health/ready` verifica somente o PostgreSQL.

## Testar uma operação

Os exemplos desta seção exigem uma carteira existente em BRL e saldo suficiente. Ainda não há cadastro de carteira pela API nem script de carga inicial. Os testes de integração criam seus próprios dados; para conferir as regras sem preparar dados manualmente, use a seção [Testes](#testes).

Ao preparar dados manualmente, o saldo inicial deve ter uma operação `OPENING` e um crédito correspondente no ledger. Alterar apenas o saldo em `wallets` causa divergência na reconciliação. Há um exemplo dessa preparação em `test/inbox-outbox-reversals.integration.test.ts`.

### Pela API HTTP

Substitua `UUID_DA_CARTEIRA` pelo identificador de uma carteira existente. Este exemplo aposta `5.00`:

```powershell
$body = @{
  walletId = 'UUID_DA_CARTEIRA'
  providerId = 'demo'
  externalTransactionId = 'tx-1'
  idempotencyKey = 'demo:tx-1'
  roundId = 'r1'
  gameId = 'g1'
  amount = '5.00'
  currency = 'BRL'
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3000/wagers/bet' `
  -ContentType 'application/json' `
  -Body $body
```

A resposta contém `transactionId`, `status`, `balance` e `failureCode`. O saldo é uma string, como `"95.00"`.

Repetir essa aposta com os mesmos dados não gera outro débito. Para uma nova operação, use novos valores em `externalTransactionId` e `idempotencyKey`.

### Pela fila SQS

Com o worker em execução:

```powershell
$env:TEST_WALLET_ID = 'UUID_DA_CARTEIRA'
bun scripts/send-example.ts
```

O script envia uma aposta de `10.00`. Para mudar o valor, defina `$env:AMOUNT = '15.00'` antes de executá-lo.

Para testar um estorno enviado antes da aposta:

```powershell
bun scripts/send-refund-before-bet.ts
```

Esse segundo script usa o valor fixo de `20.00`. O estorno fica aguardando a aposta, que debita o saldo. Depois, o worker tenta o estorno novamente e devolve o valor, desde que a aposta tenha sido aceita.

## Rotas disponíveis

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/health/live` | Confirma que a API está respondendo |
| `GET` | `/health/ready` | Verifica a conexão com o PostgreSQL |
| `POST` | `/wagers/bet` | Registra uma aposta e debita o saldo |
| `POST` | `/wagers/win` | Registra um prêmio e credita o saldo |
| `POST` | `/wagers/loss` | Registra uma derrota, sem alterar o saldo |
| `POST` | `/wagers/refund` | Devolve o valor de uma aposta |
| `POST` | `/wagers/rollback` | Desfaz uma aposta, prêmio ou estorno |
| `POST` | `/wallets/:walletId/reconciliation` | Compara o saldo da carteira com seu histórico |

As rotas `/wagers/*` recebem os campos do exemplo HTTP. `REFUND` e `ROLLBACK` também exigem `referenceExternalTransactionId`, com o identificador externo da operação original.

No SQS, o formato é diferente: a operação vem em `data.kind`, e o valor e a moeda ficam dentro de `data.money`:

```json
{
  "messageId": "mensagem-unica-1",
  "type": "WagerTransactionRequested",
  "data": {
    "kind": "BET",
    "walletId": "UUID_DA_CARTEIRA",
    "providerId": "demo",
    "externalTransactionId": "tx-1",
    "idempotencyKey": "demo:tx-1",
    "roundId": "r1",
    "gameId": "g1",
    "money": { "amount": "5.00", "currency": "BRL" }
  }
}
```

## Regras principais

### Valores monetários

Os valores devem ser strings com exatamente duas casas decimais, como `"10.00"`. Números JSON, como `10`, e strings como `"10"`, `"1.234"` ou `"1e3"` são recusados.

O projeto aceita BRL, USD e EUR. Usa `decimal.js` nos cálculos e `numeric(20,2)` no banco, evitando cálculos de dinheiro com o tipo `number` do JavaScript. O maior valor permitido é `999999999999999999.99`.

Valores negativos não são aceitos na entrada. Apenas `LOSS` aceita `"0.00"`. O modelo atual não suporta JPY nem criptomoedas com oito casas decimais.

### Apostas e estornos

| Tipo | Efeito | Regra |
| --- | --- | --- |
| `BET` | Diminui o saldo | É rejeitado se não houver saldo suficiente |
| `WIN` | Aumenta o saldo | Não exige referência a uma aposta |
| `LOSS` | Não altera o saldo | Registra o resultado sem lançamento no ledger |
| `REFUND` | Aumenta o saldo | Deve referenciar um `BET` processado |
| `ROLLBACK` | Inverte o movimento original | Pode desfazer `BET`, `WIN` ou `REFUND` |
| `OPENING` | Registra o saldo inicial | Uso interno na preparação dos dados; não é aceito pelas rotas nem pelo consumidor SQS |

Um estorno deve ter o mesmo valor, carteira, jogador, moeda e rodada da referência, que é buscada dentro do mesmo provedor. Não há estorno parcial. Cada operação original aceita apenas uma reversão processada, considerando `REFUND` e `ROLLBACK` juntos.

Se a reversão causar saldo negativo, ela é rejeitada com `REVERSAL_INSUFFICIENT_FUNDS`.

### Operações repetidas e simultâneas

O banco identifica repetições por provedor e pelas chaves `idempotencyKey` ou `externalTransactionId`. Se os dados forem iguais, o serviço consulta o resultado gravado. Se uma dessas chaves for reutilizada com dados diferentes, ocorre `IDEMPOTENCY_CONFLICT`.

Para operações concluídas, a resposta mantém o saldo registrado no processamento, mesmo que outras operações tenham alterado a carteira depois. Uma operação em `PENDING_REFERENCE` pode ter sua resposta atualizada quando o worker resolver a referência.

Antes de alterar o saldo, o serviço trava a carteira no PostgreSQL com `FOR NO KEY UPDATE`. Assim, duas operações na mesma carteira são processadas uma por vez. Carteiras diferentes podem ser processadas em paralelo.

Por exemplo: com saldo de `100.00`, duas apostas simultâneas de `80.00` resultam em uma aposta aceita, uma rejeitada e saldo final de `20.00`. Há um teste de integração para esse caso.

### Estorno recebido antes da referência

Quando a operação original ainda não chegou ou está pendente, o estorno fica em `PENDING_REFERENCE`, sem mudar o saldo.

O worker verifica as pendências em um ciclo com pausa de um segundo. As novas tentativas são agendadas com intervalos de 2, 4, 8, 16 e 32 segundos. Se a referência continuar indisponível, o estorno é rejeitado com `REFERENCE_NOT_FOUND`. Esse prazo depende também de o worker estar ativo e conseguir processar as pendências.

### Histórico e eventos

A operação, o saldo, o ledger e os eventos da outbox são gravados na mesma transação de banco. Para mensagens SQS, a inbox também participa dessa gravação. Se houver uma falha antes da confirmação, essas alterações são desfeitas juntas.

O ledger não permite editar ou apagar lançamentos. Operações rejeitadas e `LOSS` não geram movimentos nesse histórico.

A outbox registra os eventos `WagerTransactionProcessed`, `WalletBalanceChanged`, `WagerTransactionRejected` e `WagerTransactionPendingReference`. O worker os envia para o SQS depois da confirmação no banco.

Cada evento é reservado por 60 segundos durante a publicação. Se o envio falhar, o tempo entre tentativas aumenta até 256 segundos, conforme a fórmula atual do código. Um evento pode ser reenviado se houver falha após o envio e antes da confirmação de publicação. Por isso, quem recebe precisa identificar duplicatas pelo `eventId`.

O consumidor só remove uma mensagem da fila de entrada após confirmar a operação no banco. Se ocorrer uma exceção, a mensagem fica disponível novamente após o prazo de visibilidade de 60 segundos. A fila está configurada para encaminhá-la à DLQ após o limite de 5 recebimentos.

### Reconciliação

A reconciliação soma os créditos e subtrai os débitos do ledger, comparando o resultado com o saldo salvo na carteira.

A resposta informa `walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`. Se encontrar uma diferença, o serviço registra o problema no log, sem corrigir o saldo automaticamente.

## Organização do projeto

```text
src/
  main.ts                       Inicialização da API
  app.module.ts                 Módulo principal
  app.controller.ts             Verificações de saúde da API
  domain/
    money/money.ts              Validação e cálculos de dinheiro
    wallet/wallet.ts            Regras de carteira usadas nos testes unitários
  application/
    wallet-movements.service.ts Processamento das operações
    reconciliation.service.ts   Comparação entre saldo e histórico
  messaging/
    worker.ts                   Inicialização do processo de filas
    sqs-consumer.service.ts     Recebimento de operações
    outbox-publisher.service.ts Publicação de eventos
  presentation/                 Rotas HTTP de movimentação e reconciliação
  infrastructure/persistence/   Mapeamento de carteira para o MikroORM
  migrations/                   Criação e alteração das tabelas
scripts/                        Criação das filas e envio de exemplos
test/                           Testes unitários e de integração
```

As tabelas principais são `wallets` (saldos), `wager_transactions` (operações), `ledger_entries` (histórico), `inbox_messages` (mensagens recebidas) e `outbox_messages` (eventos a publicar).

## Decisões de implementação

| Decisão | Motivo | Limitação |
| --- | --- | --- |
| Controlar repetições e concorrência no PostgreSQL | Manter as regras compartilhadas entre instâncias da aplicação | Cada operação depende do banco |
| Usar SQL explícito nas movimentações | Deixar visíveis as travas e as alterações feitas juntas | O serviço de aplicação concentra a lógica de movimentação |
| Travar uma carteira por vez | Impedir que duas operações gastem o mesmo saldo | Operações da mesma carteira precisam esperar umas pelas outras |
| Gravar eventos na outbox | Preservar o evento junto com a alteração de saldo | A publicação ocorre depois e pode ter duplicatas |
| Registrar rejeições de negócio | Permitir consultar o resultado e repeti-lo sem novo efeito | Uma operação rejeitada não é reavaliada ao reenviar as mesmas chaves |
| Permitir apenas uma reversão por referência | Evitar devolver o mesmo valor duas vezes | Alguns fluxos de estorno exigiriam regras adicionais |
| Apenas apontar divergências na reconciliação | Manter o problema visível para investigação | A correção precisa de tratamento separado |

## Testes

Para verificar os tipos e executar os testes unitários:

```powershell
bun run typecheck
bun test
```

Sem `RUN_DB_TESTS=1`, os testes de integração são ignorados. Se você já definiu essa variável no terminal, remova-a para rodar apenas os unitários:

```powershell
Remove-Item Env:RUN_DB_TESTS -ErrorAction SilentlyContinue
Remove-Item Env:RUN_SQS_TESTS -ErrorAction SilentlyContinue
```

Para incluir os testes com PostgreSQL, use um banco local descartável, configurado pelas variáveis `DB_*`, e aplique as migrations antes:

```powershell
bun run migration:up
$env:RUN_DB_TESTS = '1'
bun test
```

Para incluir também o teste de publicação no LocalStack, mantenha `RUN_DB_TESTS=1`, inicie o LocalStack e crie as filas antes de executar:

```powershell
$env:RUN_SQS_TESTS = '1'
bun test
```

> Os testes usam o banco configurado no ambiente. `inbox-outbox-reversals.integration.test.ts` grava dados no schema `public`. `wallet-movements.integration.test.ts` cria e remove schemas temporários. Não execute esses testes em um banco com dados que precisam ser preservados.

| Arquivo | O que verifica |
| --- | --- |
| `test/money.test.ts` | Formato de valores, moedas, limites e cálculos |
| `test/wallet.test.ts` | Créditos, débitos e saldo insuficiente |
| `test/wallet-movements.integration.test.ts` | Regras do banco, repetições, concorrência e histórico |
| `test/inbox-outbox-reversals.integration.test.ts` | Inbox, outbox, estornos, reconciliação e publicação de eventos |

A criação de carteira pelo serviço ainda está marcada como teste pendente (`todo`).

## Comandos úteis

| Comando | Finalidade |
| --- | --- |
| `bun run dev` | Iniciar a API com reinício ao editar arquivos |
| `bun run start` | Iniciar a API sem observar alterações |
| `bun src/messaging/worker.ts` | Iniciar o worker |
| `bun run typecheck` | Verificar os tipos do TypeScript |
| `bun test` | Executar os testes conforme as variáveis habilitadas |
| `bun run migration:up` | Aplicar migrations pendentes |
| `bun run migration:down` | Reverter a última migration; pode remover tabelas e dados |
| `bun scripts/create-queues-fifo.ts` | Criar as filas locais |

## Limitações atuais

- Não há rota `POST /wallets` nem script para criar uma carteira com saldo inicial e lançamento `OPENING`.
- A API expõe rotas separadas em `/wagers/*`. Não há `POST /wagering/transactions`, leitura do cabeçalho `Idempotency-Key` ou campo `idempotentReplay` na resposta.
- Não há rotas `GET` para consultar carteira, histórico ou transação.
- As rotas de movimentação não têm validação completa do corpo nem conversão dos erros do serviço em respostas HTTP específicas. Exceções comuns do serviço resultam em HTTP 500; rejeições de negócio são retornadas no campo `status`.
- Não há autenticação.
- O consumidor SQS não separa erros temporários de erros permanentes. Exceções seguem o mesmo fluxo de novas entregas e DLQ.
- Há logs pontuais, mas não há métricas nem um padrão de logs estruturados em toda a aplicação.
- O serviço de movimentação não usa a classe de domínio `Wallet`; ele aplica as regras diretamente com SQL e `Money`.
- A outbox não garante a ordem de publicação dos eventos de uma mesma carteira, especialmente após falhas ou com vários publicadores.
- Ainda faltam testes de vários processos independentes, interrupção do worker entre gravação e confirmação da mensagem, publicadores concorrentes e envio para a DLQ.
