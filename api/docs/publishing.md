# Publicação nas lojas

As rotas `/publishing` vivem no Code Push Server (mesmo processo e mesma sessão Bearer do painel). O front (`code-push-manager-front`) só aponta `VITE_API_BASE_URL` para este host; a publicação é `${BASE}/publishing`.

Rotas principais: `/publishing/session`, `/publishing/apps`, `/publishing/refresh`, `/publishing/preview`, `/publishing/act`, `/publishing/audit`, `/publishing/demo/reset`, `/publishing/health`.

## Variáveis de ambiente

Valores no `.env` da API (veja também `.env.example`). Documentação geral do servidor: [ENVIRONMENT.md](../ENVIRONMENT.md).

### Obrigatórias em produção (`STORE_MODE=live`)

| Variável | Valor |
| --- | --- |
| `STORE_MODE` | `live` (também: `auto` = demo sem credencial / loja com credencial; `demo` = nunca chama lojas) |
| `PLAY_SERVICE_ACCOUNT_JSON` | JSON da conta de serviço do Play Console (acesso aos pacotes), em uma linha, ou caminho de arquivo montado (ex.: `/secrets/play.json`) |
| `ASC_ISSUER_ID` | Issuer ID da chave App Store Connect |
| `ASC_KEY_ID` | Key ID da mesma chave |
| `ASC_PRIVATE_KEY` | Conteúdo do `.p8` (PEM; `\n` se for uma linha) ou caminho do arquivo (ex.: `/secrets/AuthKey.p8`) |

Sem as três `ASC_*`, iOS fica indisponível. Sem `PLAY_SERVICE_ACCOUNT_JSON`, Android fica indisponível. Em `live`, a loja usada precisa da credencial correspondente.

### Opcionais

| Variável | Padrão | Função |
| --- | --- | --- |
| `PLAY_REVIEW_FRACTION` | `0.01` | Fração do rollout Android ao enviar para revisão (`0`–`1`) |
| `PLAY_NOTES_LANGUAGE` | `pt-BR` | Idioma das notas na Play |
| `PLAY_API_URL` | Android Publisher v3 | Outro endpoint só se necessário |
| `PLAY_AUTH_SCOPE` | `https://www.googleapis.com/auth/androidpublisher` | Escopo OAuth |
| `ASC_API_URL` | `https://api.appstoreconnect.apple.com` | Outro endpoint só se necessário |
| `ASC_JWT_AUDIENCE` | `appstoreconnect-v1` | Audience do JWT |
| `APPS_FILE` | `./config/apps.json` | Catálogo de apps do board |
| `DEFAULT_RELEASE_NOTES` | texto padrão no `.env.example` | Texto inicial de What's New / notas |
| `PLAY_CONSOLE_DEVELOPER_ID` | — | ID `…/developers/{id}/…` na Console. Com `playConsoleAppId` no `apps.json`, monta o link da coluna Play Console |

### Disco, rede e instâncias

- Auditoria em `data/audit.jsonl` (precisa de escrita). Com várias instâncias, cada uma tem o próprio arquivo; volume compartilhado ou uma instância só mantém histórico único.
- Saída HTTPS para `androidpublisher.googleapis.com`, `oauth2.googleapis.com` e `api.appstoreconnect.apple.com`.

## Catálogo `apps.json`

Modelo em [config/apps.example.json](../config/apps.example.json). Campos comuns por app:

| Campo | Uso |
| --- | --- |
| `id` | Identificador estável no board |
| `name` | Nome exibido |
| `project` | Agrupamento / filtro no front |
| `androidPackage` | Package name na Play |
| `playConsoleAppId` | ID numérico do app na URL da Console (link “Publicar na Console”) |
| `iosAppId` | App Store Connect app id |

## Checklist de deploy

1. Subir a API com `STORE_MODE=live` e credenciais Play / Apple.
2. Confirmar `GET /publishing/health` com a sessão do painel (`"mode": "live"`).
3. No front, só `VITE_API_BASE_URL` aponta para este host; publicação = `/publishing`.
4. Rebuild da imagem do front se a URL base mudar (a variável entra no bundle do Vite).
