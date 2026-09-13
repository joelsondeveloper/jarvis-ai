# Migração incremental: Tools first, code when necessary

## 1. Arquitetura final

O fluxo principal mantém os endpoints e a interface existentes:

```text
Usuário → MessageRouter → Groq
  conversa → Gemini → SSE
  tarefa → TaskOrchestrator
    → ToolRegistry → ferramenta nativa
    OU Qwen → ExecutionValidator → ScriptExecutor
    → PermissionManager antes do efeito
    → resultado real → Groq decide próxima etapa
    → complete → Gemini → resposta final
```

O runtime executa ações; os modelos apenas solicitam. Abertura normal de aplicativos agora usa `open_app`, sem geração de código. A política é checada antes da etapa e novamente na ferramenta registrada. O Coder permanece disponível para algoritmos e transformações personalizadas.

## 2. Arquivos criados nesta mudança

- `src/tools/native.tools.ts`: registra as novas capacidades no catálogo existente.
- `src/tools/system.runtime.ts`: operações confiáveis de aplicativos, documentos e consultas do Windows.
- `tests/native-tools.test.js`: 27 testes adicionais, sem chamadas pagas.
- `docs/tools-first.md`: este relatório.

## 3. Arquivos modificados nesta mudança

- `src/tools/tool.ts`: ToolContext ampliado, ToolResult, validação e verificação de permissão compartilhada.
- `src/tools/tool.registry.ts`: catálogo com definitions copiadas e execução protegida pelo PermissionManager.
- `src/tools/file.tools.ts`: ferramentas existentes com schemas JSON e resultado estruturado.
- `src/orchestrator/task.orchestrator.ts`: despacho genérico pelo registro, resultados reais e eventos de ferramenta.
- `src/task/task.types.ts`: argumentos genéricos, ToolResult persistido e eventos adicionais.
- `src/security/permission.manager.ts`: ações de abrir documento, mover/renomear e consultar sistema.
- `src/security/authorization.ts`: autorizações escopadas para essas ações explícitas.
- `src/ai/groq.provider.ts`: prioridade para capacidades do catálogo, Coder somente quando necessário.
- `src/ai/qwen-coder.provider.ts`: papel de especialista e remoção da orientação antiga para gerar abertura trivial.
- `src/app.ts`: injeta o catálogo completo na composição principal.
- `public/app.js`: apresenta progresso/conclusão/falha das ferramentas sem reformulação visual.
- `Readme.md`: documenta fluxo, contratos e limites atuais.

As alterações preexistentes na árvore de trabalho foram preservadas. Nenhum teste anterior foi removido ou alterado nesta migração.

## 4. Ferramentas disponíveis

| Categoria | Ferramentas |
| --- | --- |
| Arquivos | `list_directory`, `read_file`, `write_file`, `move_file`, `rename_file`, `file_exists`, `get_file_info` |
| Aplicativos/documentos | `open_app`, `open_file` |
| Sistema | `get_system_info`, `get_running_processes` |
| Compatibilidade/ação protegida | `list_files`, `delete_file` |

`list_files` preserva o nome anterior. `delete_file` nunca tem autorização automática. Movimentos não substituem destinos existentes. Operações de arquivos usam APIs Node, não scripts gerados.

## 5. ToolRegistry como fonte da verdade

Cada registro contém nome, descrição, JSON schema, validação, cálculo das permissões e execução. Ferramentas de alteração também podem fornecer fingerprint para detectar mudança entre revisão e execução.

`getDefinitions()` entrega o catálogo atual ao MessageRouter e ao loop do TaskOrchestrator. GroqProvider recebe esse catálogo no contexto JSON de cada decisão, pelo protocolo estruturado existente. Não foi criado um segundo registro nem uma lista de nomes no system prompt. Registrar uma ferramenta torna sua definition disponível na decisão seguinte.

## 6. Decisão Tool versus Coder

Groq recebe a instrução de selecionar uma ferramenta registrada sempre que ela resolver a etapa. A decisão continua compatível: `action:"tool"`, `tool` e `args` JSON serializado, ou `action:"coder"` para lógica personalizada. A preferência semântica é orientada pelo prompt; a execução e as permissões são determinísticas no runtime. Não houve avaliação paga da classificação com modelos reais.

As pontes de scripts anteriores continuam disponíveis para compatibilidade com tarefas persistidas; não são recomendadas ao modelo para novas operações já cobertas pelo catálogo. Nenhum acesso novo ao Windows foi acrescentado ao sandbox.

## 7. Permissões das ferramentas

O PermissionManager existente continua sendo a única política. O TaskOrchestrator consulta as permissões antes de executar. ToolRegistry envolve toda ferramenta registrada com nova checagem; as ferramentas construídas pelo helper também são protegidas em chamadas diretas.

Autorizações são derivadas do pedido do usuário, não de saída de modelo. Aplicativo, documento e arquivo precisam corresponder ao alvo autorizado. Mover/renomear vincula origem e destino como um par exato. Pedidos ambíguos ou fora do escopo exigem revisão. Aprovações permanecem vinculadas à etapa, expiram e são consumidas uma única vez. Delete sempre exige confirmação.

## 8. Isolamento dos scripts

ScriptExecutor e ExecutionValidator mantêm suas proteções: QuickJS, limites de memória/tempo/saída, capacidades verificadas, nenhuma chave de API, nenhum módulo Node irrestrito ou rede arbitrária. O lançador legado continua usando Node Permission Model, ambiente filtrado e `shell:false`. Python/PowerShell continuam restritos aos templates reconhecidos existentes.

As ferramentas não são expostas como objeto privilegiado dentro do sandbox. O modelo não recebe `SystemRuntime`, ToolRegistry ou o processo do servidor.

## 9. Tarefas com várias etapas e SSE

Cada etapa registra `action.kind` como `tool` ou `script`. ToolResult preserva `success` e `data`, ou `error.code/message`. O campo `output` permanece para compatibilidade e exibição. Groq recebe o ToolResult real na decisão seguinte; uma chamada que falhou não satisfaz a condição de conclusão.

O loop permite Tool → Tool e Tool → Coder → Tool, com 6 etapas, 8 decisões e 2 falhas consecutivas. Histórico, recuperação de tarefas e aprovação/negação mantêm o comportamento anterior.

O chat também recebe `tool_started`, `tool_completed` e `tool_failed`, com nome da ferramenta, identificadores e mensagem de progresso. Esses eventos não contêm prompts ou raciocínio interno. Os eventos anteriores continuam disponíveis.

## 10–11. Validação

- `npm run typecheck`: passou.
- `npm test`: 77 testes, 76 aprovados, 0 falhas e 1 ignorado por ausência de privilégio de symlink no Windows.
- Base anterior preservada: 49 aprovados e 1 ignorado.
- Novos testes: 27, incluindo API principal, Qwen não chamado em operações nativas, provider interceptado, permissões, traversal, movimentos, resultados/erros reais, fluxo misto e limites.
- Modelos e abertura de interface foram simulados. A suíte anterior mantém um teste de criação real de processo Node inofensivo.

## 12. Limitações restantes

- Workspace é a raiz de alterações. Downloads continua somente leitura. Move/rename não altera Downloads, não move diretórios e exige pasta de destino existente.
- Leitura/escrita de conteúdo continua limitada a 64 KiB. Listagens/processos retornam no máximo 200 itens.
- Apps cadastrados: Bloco de Notas e Spotify localizável. Não há instalação automática, reprodução de música ou controle da interface.
- `open_file` aceita documentos de extensões permitidas dentro das raízes. Scripts, executáveis e atalhos são bloqueados. O encaminhamento ao aplicativo padrão não comprova que a tela já renderizou o documento.
- Abertura de documentos e listagem de processos são implementadas para Windows. Abertura usa programa PowerShell fixo do runtime, com caminho passado como dado, sem concatenação de comando shell. Processos são consultados por `tasklist.exe`, sem linha de comando ou ambiente.
- Autorizações por linguagem natural são conservadoras; formulações não reconhecidas podem exigir confirmação.
- Efeitos não são transacionais: uma falha posterior não desfaz etapas anteriores. A avaliação de cumprimento do objetivo completo continua dependendo do planejador e da verificação do usuário.

## 13. Testes manuais

Reinicie `npm run dev`, atualize a página e conclua/cancele qualquer aprovação antiga antes de iniciar os testes. Use arquivos descartáveis na workspace.

1. “Abra o Bloco de Notas.” → ferramenta `open_app`, sem etapa de código.
2. “Abra o Spotify.” → `open_app`; aplicativo abre ou erro real de localização.
3. “Liste Downloads.” → `list_directory`, sem Qwen.
4. “Crie teste.txt com o texto Olá.” → `write_file`; depois “Leia teste.txt.” → conteúdo real.
5. “Renomeie teste.txt para teste-renomeado.txt.” → `rename_file`, preservando o conteúdo.
6. “Mova teste-renomeado.txt para pasta/teste-renomeado.txt.” → `move_file`; crie a pasta de destino previamente.
7. “Abra pasta/teste-renomeado.txt.” → aplicativo padrão para texto.
8. “Mostre informações do sistema.” e “Liste os processos.” → consultas nativas.
9. “Apague pasta/teste-renomeado.txt.” → confirmação obrigatória; negar deve preservar o arquivo.
10. “Explique closures em JavaScript.” → conversa Gemini, sem nova tarefa.
11. Peça uma análise personalizada dos JSON de Downloads com relatório na workspace → observe a sequência de ferramentas e eventual Coder, revisando qualquer ação fora do escopo reconhecido.
