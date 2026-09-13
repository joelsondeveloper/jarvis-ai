# Planejar antes de executar

## Arquitetura e causa da duplicação

O fluxo principal permanece `MessageRouter → conversa/Gemini ou TaskOrchestrator`. Para tarefas novas, o GroqProvider fornece `plan`: um plano completo, normalizado pelo PlanValidator e salvo antes da primeira execução. O runtime percorre as etapas pendentes e usa ToolRegistry ou Qwen/ExecutionValidator/ScriptExecutor, passando sempre pelo PermissionManager. Sucessos normais não provocam consultas intermediárias ao Groq. Gemini narra o resultado final.

O loop anterior pedia uma nova decisão após cada sucesso e não comparava a ação sugerida com os efeitos já registrados. Assim, seis decisões `open_app(notepad)` podiam gerar seis lançamentos. No fluxo novo, um plano simples termina após uma etapa, e sugestões duplicadas são barradas adicionalmente por assinatura.

O caminho incremental fica restrito à compatibilidade com provedores antigos sem `plan` e tarefas antigas sem plano (incluindo aprovações persistidas). A composição de produção em `src/app.ts` utiliza GroqProvider com `plan` e `evaluate`, portanto todas as novas tarefas executáveis recebem plano. Falha do Planner nunca cai no loop antigo.

## Plano e execução

TaskPlan registra objetivo, versão, descrições operacionais, execução tool/coder, dependências, ocorrência, tentativas e estados. TaskState.steps é a auditoria das tentativas reais: ação concreta, resultado, erro e vínculo `planStepId`. Uma tentativa adicional gera outro registro de execução, preservando a falha anterior.

PlanValidator rejeita plano vazio, mais de seis etapas, IDs repetidos, estados iniciais indevidos, mecanismos desconhecidos, ferramentas inexistentes, argumentos inválidos, dependências futuras/cíclicas, tarefas Coder vazias e repetições não autorizadas. Todos os argumentos conhecidos são validados antes de executar qualquer etapa. Argumentos derivados de resultados usam referências limitadas, como `{{read.data.content}}` ou `{{transform.output}}`; são resolvidos e revalidados antes do uso, sem eval.

As Tools `open_file`, `move_file` e `rename_file` têm validação estática de plano separada da checagem de existência na execução. Isso permite criar um arquivo antes de abri-lo ou movê-lo. A checagem de filesystem, escopo, fingerprint e permissão continua no momento da execução.

Estados normais: pending → running → completed/failed. Aprovação pausa a tarefa mantendo a etapa pending; Permitir consome o token antes do efeito e retoma a mesma etapa. Cancelar encerra sem executá-la. Exclusão sempre exige confirmação. Aprovação não libera o restante do plano.

## Avaliação e adaptação

O Evaluator só é chamado por falha da ferramenta/Coder/preparação, dependência não satisfeita ou resultado divergente da expectativa declarada (`expect`, por exemplo `data.exists = true`). O runtime compara essa expectativa com dados reais. Success normal continua deterministicamente.

Decisões aceitas:

- `retry`: apenas etapa failed sem sucesso registrado, dentro dos limites.
- `continue`: aceita um resultado bem-sucedido inesperado; não libera falha.
- `skip`: registra a limitação; dependentes não são automaticamente liberados.
- `modify_plan`: valida novas etapas e cria uma nova versão.
- `complete`: bloqueado se há pendências/falhas ou falta resultado comprovado.
- `fail`: encerra com motivo.

Replan preserva etapas completed e resultados já obtidos; falhas substituídas ficam skipped com motivo, e o plano anterior mantém seu estado histórico original. IDs antigos não podem ser reutilizados. O novo conjunto de etapas futuras recebe IDs novos. A versão anterior completa é clonada antes de qualquer alteração, guardando também etapas futuras abandonadas.

Limites: seis etapas no plano contando os registros preservados, seis tentativas de execução registradas, oito decisões de planejamento/avaliação, duas tentativas por etapa e duas falhas consecutivas. Deadlines preservados: 45s Planner/Evaluator/Qwen, 30s execução e 15s Gemini. Timeout de execução encerra sem retry: pode ter havido efeito parcial.

## Assinatura e repetição

Action signature = SHA-256 do nome da ferramenta e argumentos canônicos. Chaves de objetos são ordenadas recursivamente, arrays mantêm a ordem, paths são normalizados e, no Windows, comparados sem diferença de caixa. A validação das Tools normaliza aliases e valores padrão antes da assinatura.

Antes do efeito, o runtime busca uma execução bem-sucedida com a mesma assinatura e ocorrência na mesma tarefa. Havendo resultado, registra `skipped_duplicate`, reutiliza o resultado e não chama o executor. Falhas podem ter retry; outra tarefa não herda essa deduplicação. Ela não é uma garantia transacional de exatamente uma execução após falhas do sistema: por isso restart e timeout não reproduzem ações automaticamente.

Ocorrência padrão: 1. Para comandos explícitos como “Abra três Blocinhos de Notas.”, a validação reconhece quantidades de 2 a 6, em números ou palavras, e permite as ocorrências correspondentes somente para Notepad. Isso não libera processos arbitrários nem permite ao modelo inventar `allowRepeat`. Formulações fora desse conjunto conservador não concedem repetição automaticamente. Três arquivos com caminhos diferentes já têm assinaturas distintas e seguem as permissões de arquivo existentes.

## SQLite, recuperação e narração

A tabela existente `tasks` já armazena TaskState em JSON. A mudança adiciona `formatVersion: 2`, `plan` e `planVersions` ao mesmo documento. Cada salvamento atualiza plano e auditoria juntos em uma única operação SQLite. O plano corrente contém sua versão; versões substituídas ficam em `planVersions`. Não foi necessário alterar o schema SQL, recriar banco ou apagar histórico. Documentos antigos sem os novos campos permanecem legíveis.

No startup, tarefas running/planning são marcadas failed; etapas running também recebem falha de interrupção e etapas completed permanecem completed. Não há replay automático. Aprovações pendentes continuam sujeitas à expiração e à revalidação da ação.

Completed é salvo antes da chamada ao Gemini. O narrador recebe objetivo, versão/plano operacional, resultados, falhas e motivos de skips. Falha/timeout do Gemini mantém completed e produz fallback com resultado real. As garantias do sandbox, PermissionManager, AuthorizationContext, ExecutionValidator e ApplicationLauncher permanecem.

## Interface e SSE

O mesmo `POST /conversations/:id/messages/stream` entrega eventos antigos e novos: `task_planned`, `plan_updated`, `step_started`, `step_completed`, `step_failed`. Os novos eventos carregam snapshot em `task`, com `task.plan.steps`. Cada resposta SSE emite `done` uma vez; Permitir inicia outra resposta pelo endpoint de aprovação existente.

`public/app.js` mostra checklist com ✓/●/○/✕/↷, versão e aviso de plano atualizado. Usa textContent para descrições/resultados. O GET de histórico existente restaura o plano após recarregar. Sem redesenho amplo, novos endpoints, voz ou controle de interface.

## Arquivos desta mudança

Criados: `src/task/plan.types.ts`, `src/task/plan.validator.ts`, `src/task/action.signature.ts`, `tests/plan-first.test.js`, este documento.

Alterados: `src/orchestrator/task.orchestrator.ts`, `src/ai/groq.provider.ts`, `src/task/task.types.ts`, `src/task/task.state.ts`, `src/tools/tool.ts`, `src/tools/native.tools.ts`, `src/security/authorization.ts`, `src/agent/agent.service.ts`, `public/app.js`, `Readme.md`.

MessageRouter, controllers, endpoints, ScriptExecutor e ApplicationLauncher foram reutilizados sem alteração nesta etapa.

## Validação e teste manual

`npm run typecheck`: zero erros. A última execução completa registrada antes desta rodada teve 144 testes, 143 aprovados, zero falhas e um ignorado. Esta rodada adiciona regressões de compute puro, schema discriminado, dependências puladas e resiliência do Gemini; a suíte completa precisa ser repetida em ambiente com memória suficiente. Os testes usam provedores simulados, SQLite em memória e diretórios temporários; a regressão usa ApplicationLauncher real com driver simulado e não abre janelas.

Reinicie o backend e recarregue a interface antes dos testes manuais:

1. “Abra o Bloco de Notas.”: um plano de uma etapa, uma solicitação de abertura, tarefa concluída.
2. “Abra três Blocinhos de Notas.”: três ocorrências. A apresentação em janelas ou abas depende do Bloco de Notas instalado.
3. “Crie teste.txt, escreva Olá JARVIS nele e abra o arquivo.”: plano inteiro aparece antes do efeito; escrita precede abertura. Aprove apenas as ações fora do escopo reconhecido, quando solicitadas.
4. “Leia teste.txt, transforme o texto em maiúsculas e salve em maiusculas.txt.”: leitura → Coder (se necessário) → escrita; conteúdo baseado na leitura real.
5. “Apague teste.txt.”: exige confirmação; Cancelar mantém o arquivo. Repetir e Permitir apaga somente o alvo revisado.
6. “Leia arquivo-inexistente.txt e transforme seu conteúdo.”: erro/avaliação sem executar a transformação cegamente; não pode afirmar sucesso inventado.
7. Recarregue durante uma aprovação: plano e ação pendente reaparecem. Conclua a aprovação uma vez.
8. “Explique closures em JavaScript.”: conversa Gemini, sem TaskPlan.

Os testes simulados comprovam o contrato do runtime. Qualidade do plano produzido pelos modelos reais e comportamento visual dos aplicativos ainda precisam dessa conferência manual.
