# JARVIS

Assistente local em TypeScript, Express e SQLite, com chat em streaming e orquestração de tarefas.

## Executar

Requer Node.js 22 ou superior. Instale com `npm install`, copie `.env.example` para `.env` e configure as chaves.
Inicie com `npm run dev` e abra http://localhost:3000.
Depois de alterar o backend, reinicie o comando; ele não usa watch.

- Gemini: conversa em streaming.
- Groq: classifica a entrada, planeja a tarefa inteira e avalia somente falhas ou resultados inesperados.
- Coder: especialista de fallback para algoritmos e transformações personalizadas no runtime QuickJS.
- SQLite: mensagens e tarefas, incluindo aprovações pendentes.

## Fluxo

O chat recebe todos os pedidos pelo mesmo endpoint. MessageRouter consulta Groq: conversa segue para Gemini; tarefa segue para TaskOrchestrator. Se o Gemini atingir cota ou ficar indisponível, o mesmo Groq usado pelo orquestrador fornece somente uma resposta textual de fallback; ele não executa ações nem substitui permissões.
O princípio é **Tools first, code when necessary**: Groq consulta o catálogo do ToolRegistry, escolhe uma ferramenta nativa e só recorre ao Qwen quando precisa de lógica personalizada.
Listagens e leituras limitadas aos recursos autorizados podem executar diretamente. Aberturas, escritas, movimentos, renomeações e consultas explícitas usam autorização para o alvo exato; fora desse escopo há revisão. Exclusões SEMPRE exigem confirmação. Cálculos isolados sem efeitos não precisam de confirmação.
**Permitir** aprova somente aquela ação; **Cancelar** encerra a tarefa sem executar a etapa pendente.
Cada aprovação expira em 10 minutos e só pode ser consumida uma vez.
Se o arquivo de uma ferramenta mudou desde a revisão, a escrita/exclusão é bloqueada.

Antes do primeiro efeito, o Groq Planner produz um plano completo, validado e persistido no SQLite. TaskOrchestrator executa as etapas pendentes em ordem; sucessos normais seguem diretamente para a próxima etapa, sem nova consulta ao modelo. Somente falhas ou expectativas não atendidas acionam Groq Evaluator. Replan cria nova versão, preservando as anteriores e as etapas concluídas.
Uma assinatura estável de ferramenta e argumentos bloqueia duplicações bem-sucedidas na mesma tarefa como `skipped_duplicate`. Repetição explícita de Notepad de 2 a 6 instâncias usa ocorrências verificadas contra o pedido do usuário. Arquivos diferentes possuem assinaturas diferentes.
O código limita o plano a 6 etapas (incluindo histórico preservado), a execução a 6 tentativas registradas, 8 decisões, 2 tentativas por etapa e 2 falhas consecutivas.
O runtime também limita as esperas: 45 segundos para cada decisão Groq/geração Qwen, 30 segundos para uma execução e 15 segundos para narração final. Um timeout de execução encerra a tarefa sem retry automático, pois pode haver efeito parcial.
Quando não há etapas pendentes nem falhas não tratadas, o estado `completed` é persistido e emitido antes da narração. Skips são registrados com motivo e enviados ao Gemini. Se Gemini falhar ou exceder o prazo, o resultado real é mostrado como fallback e cada resposta SSE termina com um único `done`. Resultados tardios não reabrem a tarefa.
O Evaluator não pode declarar conclusão com etapas pendentes ou falhas, nem fazer retry de efeito bem-sucedido.
Essas verificações não substituem a avaliação semântica do resultado pelo modelo e pelo usuário.

Ao recarregar, o navegador recupera a conversa, os resultados e a aprovação pendente.
Se o servidor reiniciar durante uma execução, a tarefa é marcada como interrompida, sem repetição automática.
Uma execução interrompida pode ter produzido efeitos parciais; confira os resultados antes de repetir.

## Recursos disponíveis

| Recurso | Ler/listar | Criar/sobrescrever/excluir |
| --- | --- | --- |
| `workspace/` do projeto | Sim | Pedido escopado; exclusão sempre com confirmação |
| Downloads do usuário | Sim | Não |

Ferramentas nativas: `list_directory`, `read_file`, `write_file`, `move_file`, `rename_file`, `file_exists`, `get_file_info`, `open_app`, `open_file`, `get_system_info`, `get_running_processes`.
`list_files` continua como nome compatível; `delete_file` mantém a confirmação obrigatória.
Os argumentos usam `resource` (`workspace` ou `downloads`) e `path` relativo.
Escrita também recebe `content`. Diretórios pais devem existir.
Não há exclusão recursiva. Arquivos têm limite de 64 KiB e listagens retornam até 200 entradas.
Caminhos fora das raízes e links simbólicos são rejeitados.

Move/rename são restritos à workspace, exigem origem e destino autorizados e não substituem um destino existente. `open_file` aceita caminho absoluto dentro das raízes ou `resource/path`, somente para documentos permitidos; executáveis, scripts e atalhos são bloqueados. O sistema encaminha ao aplicativo padrão, sem prometer que o documento já foi renderizado na tela.

Cada Tool possui definition com JSON schema, validate, permissions, execute e resultado `{success,data}` ou `{success:false,error:{code,message}}`. O registro envolve a execução com o PermissionManager existente; chamadas diretas à ferramenta registrada também verificam a autorização. Aprovações só são entregues pelo runtime à etapa correspondente.
`getDefinitions()` é a fonte da verdade. O catálogo completo é enviado à classificação, ao Planner e ao Evaluator; não há endpoint paralelo. `GroqProvider.plan` e `evaluate` usam schemas separados de saída estruturada.
TaskPlan descreve o trabalho; TaskState preserva `action.kind` como `tool` ou `script`, guarda as tentativas e ToolResult real e mantém `output` compatível. O plano aceita Tool → Tool ou Tool → Coder → Tool. Detalhes, compatibilidade e testes manuais em [docs/plan-first.md](docs/plan-first.md).

Exemplos na interface:

- “Liste os arquivos da workspace.”
- “Crie teste.txt na workspace com o texto Olá, JARVIS.” — o pedido autoriza esse arquivo.
- “Leia teste.txt na workspace.”
- “Use o coder para calcular a soma dos números de 1 até 100.” — cálculo isolado não exige confirmação.

## Runtime de scripts e controle do computador

JavaScript gerado roda em [QuickJS compilado para WebAssembly](https://github.com/justjake/quickjs-emscripten), separado do JavaScript do servidor. Abertura normal usa a Tool `open_app`, sem Qwen. As pontes antigas `jarvis.openApp` e `require("node:child_process").execFileSync` foram mantidas para compatibilidade com scripts/etapas existentes, com as mesmas verificações de alvo e argumentos; não são o caminho recomendado para novas ações nativas.

`src/security/authorization.ts` deriva permissões escopadas de comandos explícitos do usuário: abrir Bloco de Notas/Spotify, criar/ler um arquivo identificado. O relatório TXT sem nome usa `workspace/relatorio.txt` como recurso necessário. Formulações ambíguas não ampliam permissões. Ações extras exigem revisão; delete SEMPRE exige confirmação, mesmo com autorização ampla. A aprovação vale para aquela etapa e recurso, expira em 10 minutos e não pode ser reutilizada. Histórico e saídas dos modelos não criam permissões.

O lançador confiável roda com Node Permission Model (`--permission --allow-child-process`), sem permissões de filesystem, `shell:false`, timeout e ambiente filtrado, sem chaves dos provedores ou NODE_OPTIONS. Apenas o lançador recebe a capacidade Node: o código gerado continua em QuickJS. Isso é necessário porque o Permission Model do Node 22 não limita os executáveis filhos nem concede isolamento de rede para esses filhos. O aplicativo aberto conserva suas próprias capacidades normais do Windows.

Python/PowerShell aceitam templates completos reconhecidos de abertura, traduzidos para a mesma ponte: `Start-Process notepad.exe -PassThru -ErrorAction Stop`, ou `import subprocess` seguido de `subprocess.Popen(["notepad.exe"])`. Scripts de host arbitrários são bloqueados, inclusive após confirmação: não é seguro prometer exclusão sempre protegida enquanto se oferece shell irrestrito. Para arquivos, use as ferramentas ou pontes JavaScript. Rede e controle de interface/reprodução não estão implementados neste runtime.

`open_app` resolve o método de lançamento dentro do runtime: executável Win32 conhecido, protocolo registrado `spotify:` ou ativação pelo AUMID oficial da instalação Store. Nunca tenta iniciar o executável protegido interno de WindowsApps. Se nenhuma estratégia funcionar, retorna `app_not_launchable`; não baixa nem instala nada. A saída registra `app`, `launchMethod`, `pid` quando conhecido e `playbackControlled:false`. Ativação por protocolo/AUMID registra `activationRequested:true`, sem inventar PID do aplicativo nem confirmar janela visível. Abrir o aplicativo não significa tocar música.

O acesso do host é deliberadamente acompanhado por camadas de segurança: validação do schema do modelo, verificação de linguagem e tamanho, bloqueio de obfuscação e downloads de código, capacidades declaradas, confirmação no chat, verificação de alteração dos arquivos, timeout, limite de saída, ambiente mínimo e auditoria persistida. Nenhuma dessas camadas torna código arbitrário inofensivo; revise o conteúdo exibido antes de permitir.
Não há `process`, módulos Node irrestritos, rede, shell ou acesso às variáveis de ambiente no código gerado.
O runtime fornece `console.log` e quatro APIs síncronas:

```js
const result = JSON.parse(jarvis.readFile({
  resource: "workspace",
  path: "teste.txt",
}));
console.log(result.content);
```

Também existem `jarvis.listFiles`, `jarvis.writeFile` e `jarvis.deleteFile`.
Todas retornam uma string JSON. Cada chamada verifica a capacidade aprovada em tempo de execução.
A capacidade de escrita não permite exclusão.
Limites por script: 1 segundo (10 segundos para abertura), 16 MiB de memória do interpretador, 32 chamadas de arquivos, uma abertura de aplicativo e 16000 caracteres de saída.
Use somente JavaScript síncrono; TypeScript, Promise e async não são suportados.
A execução não é transacional: uma falha posterior não desfaz uma escrita já realizada.
O isolamento depende do runtime e das APIs fornecidas, e não concede acesso geral ao computador.

## API

- `POST /conversations`: cria conversa.
- `GET /conversations/:id/messages`: histórico e última tarefa.
- `POST /conversations/:id/messages/stream`: `{"prompt":"..."}`, eventos SSE `text`, `task`, `status`, `task_started`, `task_planned`, `plan_updated`, `step_started`, `step_completed`, `step_failed`, `tool_started`, `tool_completed`, `tool_failed`, `confirmation_required`, `task_completed`, `task_failed`, `done`.
- `POST /conversations/:id/messages`: alternativa JSON, com resposta e tarefa.
- `GET /conversations/:id/tasks/:taskId`: estado persistido.
- `POST /conversations/:id/tasks/:taskId/approval`: `{"approvalId":"...","allow":true}`, retorna SSE.

O servidor escuta apenas em 127.0.0.1 e rejeita origens web diferentes.
A aplicação é para uso pessoal local e não implementa autenticação multiusuário.
Não exponha essa API diretamente como serviço público.
Dados de arquivos usados em tarefas podem ser enviados aos provedores de IA como contexto.

## Verificação

```sh
npm run typecheck
npm test
```

Os testes usam IA simulada, SQLite em memória e diretórios temporários. O teste do lançador cria um processo Node inofensivo, sem abrir interfaces gráficas.
Cobrem conversa, SSE fragmentado, tarefas, aprovação/cancelamento/replay, persistência,
limites, falhas e capacidades do runtime. Testes de symlink podem ser ignorados pelo Windows
quando a conta não tem privilégio para criar links.
