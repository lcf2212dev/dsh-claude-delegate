# @local/dsh-claude-delegate

Plugin separado do DeepSeek Harness que expõe **uma** tool, `claude_delegate`:
delega uma tarefa a uma sessão nova e não assistida do Claude Code, com
**modelo e effort escolhidos por chamada**.

Não depende do bundle oficial `@deepseek-ai/dsh-subagent-claude-code`, de
nenhuma instância fixa de subagente e de nenhum SDK pinado. Fala direto com o
launcher do Claude Code do host (`claude -p`), que é atualizado pelo próprio
usuário (`claude update`) — por isso não há versão de SDK para acompanhar.

## Como funciona

Cada chamada vira um processo:

```
claude -p <task> --model <opus|sonnet|haiku> --effort <low|medium|high|xhigh|max> \
       --dangerously-skip-permissions --output-format json --no-session-persistence
```

- **Bypass por padrão**; com `readOnly: true` o filho roda com
  `--permission-mode plan` no lugar de `--dangerously-skip-permissions`
  (sem edições, sem comandos que exigem aprovação).
- **`model` e `effort` por chamada**; defaults da config da row.
- **Assinatura**: variáveis de credencial ambiente (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_API_KEY`) são
  removidas para o login OAuth nativo valer. Desligue com
  `isolateCredentials: false` e passe a key em `env` se quiser API key.
- **`CLAUDE_CODE_TMPDIR`** próprio (padrão `~/.cache/claude-delegate`), evitando
  o problema de `/tmp/claude-$UID` pertencer a outro usuário.
- cwd = workspace da sessão (ou `cwd` explícito), cancelamento encerra a árvore
  de processos (SIGTERM → SIGKILL após 3s).
- Sem timeout embutido: a chamada bloqueia até o filho terminar ou ser cancelada.

## Instalação

1. Link do pacote no profile (ex.: `~/.dsh/profiles/desktop/package.json`):

   ```json
   "@local/dsh-claude-delegate": "link:/caminho/para/dsh-claude-delegate"
   ```

2. Adicione `@local/dsh-claude-delegate` em `dsh.profile.bundles`.
3. Rode o `pnpm install` do profile (cria o symlink em `node_modules/@local`).
4. O HMR recompõe o profile e a tool aparece na próxima requisição do modelo.

## Configuração (row `claude-delegate`)

| campo | padrão | significado |
|---|---|---|
| `command` | `claude` | launcher estável do Claude Code (use caminho absoluto se o `PATH` do Host tiver wrappers) |
| `model` | `opus` | alias usado quando a chamada omite `model` |
| `effort` | `high` | effort usado quando a chamada omite `effort` |
| `tmpDir` | `""` → `~/.cache/claude-delegate` | exportado como `CLAUDE_CODE_TMPDIR` |
| `env` | `{}` | env extra por cima do ambiente do host |
| `timeoutMs` | `0` | limite declarativo por chamada; `0` não limita |
| `isolateCredentials` | `true` | remove credenciais ambientes para usar a assinatura |

O pacote não traz nenhum valor específico de máquina: sem override, todos os
campos usam o padrão acima. Para personalizar, sobrescreva a row no patch do
seu profile (ex.: `~/.dsh/profiles/desktop/cordis.patch.yml`), sem editar este
repositório:

```yaml
- id: claude-delegate
  name: "@local/dsh-claude-delegate"
  config:
    command: /caminho/absoluto/para/claude
    model: sonnet
    effort: medium
```

O `config` do override substitui o da row por inteiro; os campos omitidos
voltam ao padrão.

## Parâmetros da tool

- `task` *(obrigatório)* — tarefa autocontida; o filho não vê a conversa.
- `model` — `opus` \| `sonnet` \| `haiku` (cada alias resolve para a build mais recente).
- `effort` — `low` \| `medium` \| `high` \| `xhigh` \| `max` (o modelo pode rebaixar
  um nível que não suporta).
- `cwd` — diretório absoluto; omitido = workspace da sessão.
- `readOnly` — booleano, padrão `false`. Quando `true`, troca
  `--dangerously-skip-permissions` por `--permission-mode plan` (somente
  leitura/planejamento; o filho não edita arquivos nem roda comandos que
  exigem aprovação).

## Requisitos

- `claude` instalado e logado no host (assinatura) ou credencial em `env`.
- Nenhum pacote `@deepseek-ai` de subagente instalado.

## Limitações

- Execução única: sem continuação, resume, streaming ou contexto do pai.
- Bloqueante: o agente pai espera o fim da chamada (cancela pela UI).
- Se `claude update` mudar as flags usadas (`--effort`,
  `--no-session-persistence`), ajuste o array em `index.js`.
