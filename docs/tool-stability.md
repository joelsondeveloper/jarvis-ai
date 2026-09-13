# Correção de Spotify e término das tarefas

## Evidência e causa

O histórico confirmou a tentativa de spawn direto de `Spotify.exe` em `C:\Program Files\WindowsApps\SpotifyAB.SpotifyMusic_1.298.301.0_x64__zpdnekdrzrea0`, encerrada com `spawn EPERM`. A abstração anterior tratava o executável interno do pacote como um Win32 comum. O mecanismo adequado é ativação pelo Windows, sem alterar ACLs, desativar permissões ou elevar o aplicativo.

A consulta somente de leitura ao usuário real do Windows confirmou o AUMID `SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify`. O aplicativo não foi aberto durante os testes.

O registro da listagem de Downloads (`741af40d-3cb1-45d0-8154-e587ff15cca2`) foi criado às 11:49:16.605 UTC e concluído às 11:51:41.196 UTC de 13/09/2026: **144,591 segundos**, com uma ferramenta bem-sucedida e duas decisões. Portanto esse registro terminou, embora a interface tenha mostrado uma espera prolongada. Não havia marcação de tempo por provedor para atribuir a demora inteira a Groq ou Gemini.

O problema de código era a ausência de deadline no TaskOrchestrator para as promises externas. Após salvar `planning`, ele aguardava a avaliação Groq. Depois de `complete`, `finish()` ainda aguardava Gemini antes de persistir o estado terminal; no banco e na interface esse tempo também aparecia como planejamento. Os timeouts/retries internos dos SDKs não substituíam um limite do fluxo.

## Spotify

`src/execution/application.launcher.ts` introduz a seleção interna e determinística:

1. executável Win32 cadastrado, fora de WindowsApps;
2. protocolo `spotify:` somente se registrado;
3. AUMID descoberto em Get-StartApps, validado contra a família oficial do Spotify;
4. erro estruturado `app_not_launchable`.

Nenhum nome de estratégia, argumento extra, URI arbitrário ou código PowerShell é aceito do modelo. Os pequenos programas de consulta/ativação são fixos do runtime; o alvo validado é passado como dado de ambiente. Todos os lançamentos usam `shell:false`, executáveis do sistema por caminho absoluto, timeout e ambiente filtrado. Notepad continua Win32. PermissionManager e schemas continuam ativos.

ToolResult de sucesso contém `data.app`, `data.launchMethod` e PID quando conhecido. Para protocolos/AUMID, `activationRequested:true` expressa apenas que o Windows recebeu a solicitação; não há PID inventado nem promessa de interface visível. Uma falha total contém `error.code`, `error.message` e dados do aplicativo/método nulo. O fluxo continua sem Qwen para `open_app`.

Referências: [AUMID no Windows](https://learn.microsoft.com/en-us/windows/configuration/store/find-aumid) e [ativação por URI](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-default-app).

## Terminação

`src/task/deadline.ts` impõe limites de tempo independentemente dos SDKs e sinaliza cancelamento. O TaskOrchestrator usa 45 s para Groq, 45 s para Qwen, 30 s para execução e 15 s para a resposta final. A classificação inicial também tem deadline de 45 s.

- Decisão vazia/inválida ou exceção encerra a tarefa como failed, com erro estruturado e task_failed.
- Promise pendente de Groq/Coder/Tool/script não mantém planning/running indefinidamente.
- Timeout de execução falha a tarefa sem repetir uma ação cujo efeito pode ser parcial.
- `complete` persiste completed e emite task_completed antes da narração.
- Falha/timeout de Gemini preserva a execução concluída e apresenta o resultado real como fallback.
- Respostas tardias não avançam a tarefa nem substituem o histórico após fallback.
- O stream termina com um único done. Os testes HTTP também aguardam EOF para verificar o fechamento efetivo.
- Mantidos os limites de 6 etapas, 8 decisões e 2 falhas consecutivas.
- Mantidas sequências Tool → Tool e Tool → Coder. Não foi implementado fast path textual que pudesse considerar um objetivo satisfeito por engano.

Os deadlines controlam esperas assíncronas; não constituem isolamento contra bloqueio síncrono arbitrário do event loop. Os runtimes e subprocessos existentes continuam com seus próprios limites. Operações já entregues ao Windows podem produzir efeitos parciais; o timeout não promete desfazê-los.

## Validação

`npm run typecheck`: aprovado.

`npm test`: **102 testes, 101 aprovados, 0 falhas, 1 ignorado** por privilégio de symlink do Windows. Os 76 testes anteriores aprovados foram preservados. Os 25 novos testes estão em `tests/tool-stability.test.js`.

Cobertura nova: Notepad, WindowsApps protegido, protocolo/AUMID/fallback, argumentos extras, aplicativo ausente, Qwen não chamado, listagem até complete, decisões inválidas, exceções, promises pendentes em todos os pontos externos, respostas tardias, fallback Gemini, tool failure, continuidade de etapas, limite de etapas e SSE com done único e EOF. Sem chamadas pagas e sem abertura gráfica real.

## Repetir na interface

Reinicie o servidor e atualize a página.

1. “Abra o Spotify.” — deve usar open_app; veja `launchMethod` no resultado. A instalação Store deve usar protocolo ou AUMID, nunca spawn direto do pacote.
2. “Abra o Bloco de Notas.” — deve manter abertura Win32.
3. “Liste os arquivos da minha pasta Downloads.” — deve terminar com resposta e estado completed; se o provedor exceder o prazo, deve haver erro terminal ou fallback, nunca espera sem limite.
4. Após a listagem, envie uma conversa normal — o chat deve estar liberado.
5. Peça uma tarefa com duas etapas — deve continuar para a próxima ferramenta e terminar normalmente.

UI Automation não foi implementada.
