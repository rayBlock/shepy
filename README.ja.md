![Shepy cover](./assets/shepy-cover.png)

# Shepy

<!-- README-I18N:START -->
[English](./README.md) | **日本語**
<!-- README-I18N:END -->

Shepy は、Herdr で動く coding agent の状態を記録する daemon ベースの観測ツールです。CLI から構造化された履歴を取得でき、Pi では owner だけに cached context と通知を送り、必要なときに自動で wake します。

Herdr の `herdr agent read` は terminal stream や scrollback を読みます。Shepy は agent の session data から作業状況、message の抜粋、compact tool result、未読の outcome を取得します。Shepy は agent を操作しません。agent の start、prompt、wait、pane 操作、terminal control には公式 Herdr CLI または skill を使います。

現在は Claude Code、Codex、Gemini CLI、OpenCode、Pi のセッション履歴の取得に対応しています。

## 要件

- Node.js >= 24.18.0
- Herdr >= 0.7.0
- `shepy-pi` を使う場合は Pi >= 0.80.6

## インストール

```bash
npm install --global shepy
shepy help
```

### ソースからインストールする

ソースからbuildする場合はpnpm >= 11.9.0も必要です。

```bash
git clone https://github.com/rayBlock/shepy.git
cd shepy
pnpm install
pnpm build
npm install --global . --ignore-scripts
shepy help
```

## daemon を起動する

Shepy のagent commandとPi notificationはdaemonを必要とします。daemon は `herdr session list --json` に出る実行中の Herdr session を監視し、60 秒ごとに再スキャンします。停止した Herdr session は index しません。runtime file は標準で `~/.shepy` に置きます。別の directory を使う場合は `SHEPY_HOME` を設定します。

```bash
shepy daemon start
```

## 主なコマンド

- `shepy agent list`: 選択した workspace の最新キャッシュから status と最後の user / assistant message の抜粋を返します。鮮度が必要なときは各行の `updatedAt` を確認します。
- `shepy agent get <target>`: 明示的に詳細を取得し、1 agent の metadata、compact history、最新の compact tool result を返します。
- `shepy agent read <target> --limit N`: 明示的に履歴を読み、直近 N 件の user / assistant / compact `tool_result` message を返します。

各 agent record は、`reviewer` のような Herdr の live `name` と、`codex` のような runtime `agent` kind を別々に保持します。通常の list 出力では `name` と `agent` を別の column に表示し、JSON でも両方を返します。Herdr workspace 内では、Shepy が current workspace を自動で選びます。

```bash
shepy agent list --json
shepy agent get reviewer --json
shepy agent read reviewer --limit 20 --json
```

Herdr の外から読む場合は scope を指定します。

```bash
shepy agent list --all --json
shepy agent list --workspace wB --json
shepy agent get reviewer --workspace wB --json
shepy agent read wB:p2 --workspace wB --limit 20 --json
```

`<target>` は、選択した scope 内で pane id、terminal id、Shepy agent id の完全一致を最初に探します。次に `reviewer` のような Herdr live name を探し、live name が一致しない場合だけ `codex` のような一意の agent kind を使います。複数の running Herdr session で target が曖昧になる場合は `--session <name>` を付けます。

## Agent Skill

Agent Skill を追加する前に、Shepy CLI をインストールして daemon を起動します。次のコマンドで、対応する coding agent に Shepy の手順を追加します。

```bash
npx skills add rayBlock/shepy --skill shepy -g
```

Shepy skill は agent の status、compact history、直近の tool result を構造化データとして読み取ります。agent の確認だけなら、Shepy skill を単独で使えます。

workspace、tab、pane、terminal input/output、wait も agent から操作する場合は、公式 Herdr skill を追加します。

```bash
npx skills add ogulcancelik/herdr --skill herdr -g
```

## Pi extension

Piからextensionをインストールします。

```bash
pi install npm:shepy-pi
```

extensionにはPi 0.80.6以降が必要です。PiがHerdr内で動くとShepy daemonに接続します。接続中のPiはoffの状態でも正確なPi session pathをpresence identityとして登録します。extensionはturnごとのtool resultや最終messageのtelemetryを送信しません。

Piで`/shepy on`を入力すると、そのterminalが現在のHerdr sessionとworkspaceにおける唯一のShepy ownerになります。cached current-workspace agent context、pending件数、agent update、自動wakeを受け取るのはownerだけです。contextからowner自身のPi terminalを除き、ほかのPi terminalを含めます。通常のpromptではdaemon RPCや履歴読み込みを待たず、local cacheのsnapshotを挿入します。起動直後、reconnect直後、scope移動直後はsnapshotが届くまでcontextが一時的にない場合があります。

agentが完了またはblockedになると、visibleなShepy turnを1回開始します。通常のuser runが実行中なら、Shepyはsettleを待ちます。themed cardは最大3件を表示し、Piのexpand keyで全outcomeと長さを制限した最終responseを確認できます。nameがあるagentは`reviewer · Codex`、ないagentは`Codex`と表示します。agentの出力は信頼できない参考情報として扱い、Piは既存のuser requestに必要な作業だけを続けます。

現在のPiの状態は`/shepy`または`/shepy status`で確認し、`/shepy off`でそのPiのowner動作を解除します。offにしても別のownerへは影響しません。offまたはnon-ownerのPiは後でclaimできるよう接続を保ちますが、hidden agent context、pending件数、update、wakeは受け取りません。onのPiだけがfooterに`◆ Shepy`を表示し、未処理のoutcomeがある間は`· N agent updates`が付きます。updateを含むturnが最終assistant responseを生成してsettleし、元のeventをacknowledgeすると件数が消えます。直前までonだったPiが接続を失うと、復旧中は`◇ Shepy · reconnecting`を表示します。ownerがいない間はoutcomeを配信せず、その間に発生したoutcomeは後からclaimしてもreplayしません。reload、reconnect、別Piによる直接のowner交代では、未acknowledgedのoutcomeを保持します。ownershipはPi sessionの切り替えやpaneの移動後も同じHerdr terminalに追従し、そのterminalがgrace periodを超えて切断された場合は解除されます。

## Herdr plugin

任意のpluginはGitHub Releaseのtagからインストールします。

```bash
herdr plugin install rayBlock/shepy/packages/shepy-herdr-plugin --ref v0.5.0 --yes
```

plugin は Shepy daemon に接続し、current Herdr workspace の compact agent row を Herdr UI に表示します。row には live name と runtime kind の column、cached history の抜粋が含まれます。Herdrはrepository subdirectoryからpluginをインストールします。npmには公開せず、CLIとPi extensionだけを使う場合は不要です。

## パッケージ

| Path | 配布方法 | Purpose |
| --- | --- | --- |
| repository root | npm: `shepy` | Shepy CLIとdaemon。 |
| `packages/shepy-pi` | npm: `shepy-pi` | agent historyとagent updateのPi extension。 |
| `packages/shepy-herdr-plugin` | GitHub Releaseのsubdirectory | 任意のHerdr UI integration。npm packageではありません。 |

## 開発

```bash
pnpm install
pnpm check
pnpm build
```

package検証、npm公開、GitHub Releaseの手順は[Releasing Shepy](./docs/releasing.md)に記載しています。

DB schema を変えたら次も実行します。

```bash
pnpm db:generate
pnpm db:check
```

## ライセンス

[MIT](./LICENSE)
