# ComfyPR-Bot GCP デプロイ案比較 (Cloud Run vs GKE vs Hybrid)

作成日: 2026-04-25
対象ブランチ: `sno-bot`
GCP project: `dreamboothy-dev`
現状: VM `sno-dev-2025-08-13` の PM2 プロセス (uptime 91日)

## 目次

1. [前提と制約](#1-前提と制約)
2. [既存 GCP リソースの実態](#2-既存-gcp-リソースの実態)
3. [ボットの "fit-or-not" 要件マトリクス](#3-ボットの-fit-or-not-要件マトリクス)
4. [案 A: GKE 全部寄せ](#4-案-a-gke-全部寄せ)
5. [案 B: Cloud Run 全部寄せ](#5-案-b-cloud-run-全部寄せ)
6. [案 C: Hybrid (Cloud Run = webhook / GKE = workers)](#6-案-c-hybrid-cloud-run--webhook--gke--workers)
7. [横並び比較表](#7-横並び比較表)
8. [推奨案と根拠](#8-推奨案と根拠)
9. [即着手すべき cleanup タスク](#9-即着手すべき-cleanup-タスク)
10. [未確定事項](#10-未確定事項)

---

## 1. 前提と制約

`bot/slack-bot.ts` を読むと、bot は単体プロセス前提の状態を**3つ**保持している。これがアーキテクチャ選択の主軸になる。

| 名前                   | 場所                                                  | 性質                                                 | プロセスを跨げるか             |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `TaskInputFlows`       | `Map<workspaceId, TransformStream>` (slack-bot.ts:79) | フォローアップを走行中エージェントに inject          | ❌ 同一プロセス必須            |
| `TaskAbortControllers` | `Map<channel:ts, AbortController>` (slack-bot.ts:82)  | ❌ リアクションでキャンセル                          | ❌ 同一プロセス必須            |
| `botWorkingDir`        | `/bot/slack/{user}/{ws}` (slack-bot.ts:586)           | エージェント workspace、画像、git clone、deliverable | ⚠ ローカルFS、再起動でロスト可 |

その他の特殊要件:

- **`createTaskUser`** (`bot/task-user.ts:43`): `useradd --system` で per-task Linux user を動的生成。`spawn-as-user.ts` で `sudo -n -u <user>` 実行。Cloud Run 標準 sandbox では不可。
- **長時間実行**: Claude Agent SDK で 数十分〜数時間。Slack webhook は 3秒以内に 200。
- **状態の外部化**: `SlackBotState` は Keyv + MongoDB Atlas。dedup hash, `task-${workspaceId}`, working tasks list はすべて永続化済み (slack-bot.ts:543, 837, 994)。
- **Slack reaction → cancel** (slack-bot.ts:449-479): `❌` リアクション受信 → `TaskAbortControllers.get(key).abort()`。このルックアップは bot プロセス内 Map に依存。
- **followup inject** (slack-bot.ts:820-826): 走行中タスクの `taskInputFlow.writable.getWriter().write(...)` で後続メッセージを差し込む。これも同一プロセス前提。

---

## 2. 既存 GCP リソースの実態

### GKE cluster `prbot` (asia-northeast1, 91日目, 3 nodes RUNNING)

| ns                        | 中身                                | 状態                               |
| ------------------------- | ----------------------------------- | ---------------------------------- |
| `default/caddy`           | LB `34.85.47.171` (= `stukivx.xyz`) | RUNNING                            |
| `default/tinyauth`        | 認証 proxy                          | RUNNING                            |
| `default/claude-pods`     | headless Service                    | RUNNING                            |
| `default/ws-{8hex}-svc`   | 40+ 件の **残骸 Service**           | 要 cleanup                         |
| `codesearch/postgresql`   | Postgres                            | **`ContainerCreating` 25日詰まり** |
| `codesearch/redis-master` | Redis                               | **`ContainerCreating` 25日詰まり** |
| **bot 本体 Deployment**   | —                                   | **無い** (ここがゼロ)              |

### Artifact Registry `prbot-images` (asia-northeast1)

- `prbot-ws:20260315-6648281` (828MB) — workspace pod 用イメージ、約40日前ビルド
- `codepod:latest` (5.7GB) — 旧版

### Cloud Run (project: dreamboothy-dev)

bot 用は無し。`snotest` (caddy), `easylabel`, `team-dash`, `comfy-notion-email-syncing` のみ稼働。

### 結論

GKE クラスタは **既にお金を払っている** (3 node, asia-northeast1)。Cloud Run はゼロから足す必要あり。`stukivx.xyz` (caddy + tinyauth) は **既に GKE の中**で動いており、Slack webhook を Cloud Run 側に出すと外向き経路が分裂する。

---

## 3. ボットの "fit-or-not" 要件マトリクス

| 要件                               | Cloud Run Service           | Cloud Run Job    | GKE Deployment   | GKE Job/Pod |
| ---------------------------------- | --------------------------- | ---------------- | ---------------- | ----------- |
| Webhook 即200 (3秒)                | ◎                           | × (起動5-30秒)   | ○                | ×           |
| 数十分〜数時間タスク               | △ (60分上限※)               | ◎ (24h上限)      | ◎                | ◎           |
| 同一プロセス Map (cancel/followup) | △ (min=1, concurrency=制限) | × (job per task) | ◎                | ×           |
| `useradd` / `sudo`                 | × (gVisor固定UID)           | ×                | ◎ (privileged可) | ◎           |
| ローカルFS workspace               | × (`/tmp` のみ tmpfs)       | ×                | ◎ (PV/emptyDir)  | ◎           |
| Caddy/tinyauth と統合              | △ (Cloud Run Ingress別)     | —                | ◎                | ◎           |
| コスト (idle時)                    | ◎ ゼロスケール可            | ◎                | × (3 node常駐)   | ×           |

※ Cloud Run Service の request timeout は 60分が上限 (2024年以降の設定で延長されたが、上限変更要確認)。

---

## 4. 案 A: GKE 全部寄せ

### 4.1 アーキテクチャ

```
Slack ──webhook──► caddy LB (34.85.47.171, stukivx.xyz)
                     │ Caddyfile に /slack/events ルート追加
                     ▼
                 ComfyPR-Bot Deployment (replicas=1)
                   ├─ container: bot (slack-bot.ts そのまま)
                   ├─ emptyDir or PVC: /bot/slack workspace
                   ├─ securityContext: privileged (useradd 用)
                   └─ env from Secret (Slack/GH/Anthropic/Mongo)
                     │
                     │ in-process fork (現状そのまま)
                     ▼
                 task-* Linux user (sudo -u) + Claude Agent SDK
                     │
                     ▼
                 MongoDB Atlas (state) / GitHub / Slack API
```

オプション: 「重いタスクだけ別 Pod に飛ばす」を Phase 2 として追加可能 (workspace pods は既にイメージ `prbot-ws:20260315-6648281` がある)。

### 4.2 必要な新規コンポーネント

- **Deployment** `comfypr-bot` (1 replica) — シングルトン保証のため `strategy: Recreate`
- **Service** `comfypr-bot-svc` (ClusterIP, port 3000)
- **Caddyfile 追記** — `stukivx.xyz/slack/*` を `comfypr-bot-svc:3000` に reverse_proxy
- **Secret** `comfypr-bot-secrets` (Slack/GH/Anthropic/OpenAI/Notion/Mongo)
- **PVC** `bot-workspace-pvc` (ReadWriteOnce, 50GB) — workspace 永続化
- **Cloud Build trigger** — `git push origin sno-bot` → `prbot-images/comfypr-bot:<sha>` ビルド → `kubectl set image`
- **ServiceAccount + Workload Identity** — Secret Manager を直接読む権限 (kube Secret 経由でも可)

### 4.3 コード変更の規模 (小)

- `Dockerfile` 改訂: 現状の `node` ベースに `sudo`, `useradd` 権限を付ける。`USER root` のまま起動 (本番セキュリティ的に gVisor 相当の隔離は GKE node OS + Linux user で代替)。
- `bot/slack-bot.ts` の `botWorkingDir = '/bot/slack/...'` をそのまま使用 (PVC マウント先を `/bot` にする)
- `createTaskUser`, `spawn-as-user.ts` **そのまま動く** (privileged container かつ root起動なら `useradd` 可)
- `process.env.PRBOT_PORT` などは ConfigMap/Secret で注入
- Health endpoint `/status` は既存 (slack-bot.ts:181)

差分はおそらく **100行未満** + Helm/manifest YAML 数百行。

### 4.4 長時間タスクの扱い

GKE Pod に request timeout は無い。Pod が生きている限りエージェントは走り続ける。Pod 再起動時の中断は MongoDB の `task-${workspaceId}` を `RestartManager` (`bot/RestartManager.ts`) で再開 — 既存ロジックがある。

### 4.5 cancel / followup inject

**コード変更ゼロ**で動く。`TaskAbortControllers` も `TaskInputFlows` も同一プロセス内 Map のまま。これが案 A の最大の利点。

### 4.6 コスト試算 (月額)

- GKE cluster は既に課金中 → 追加 $0
- Cloud Build: $5-10
- Artifact Registry: 数GB → $1
- PVC 50GB: $8-10 (PD-balanced)
- **追加コスト: ~$15-20/月**

### 4.7 運用負荷

- ログ: `kubectl logs` または Cloud Logging (GKE デフォルト連携)
- メトリクス: Cloud Monitoring (GKE デフォルト)
- credentials rotation: `kubectl rollout restart deploy/comfypr-bot` で Secret 再読込
- 障害復旧: `RestartManager` + Pod restart で自動 — 現状 VM の PM2 と同等
- **新規運用知識: kubectl, Caddyfile, Workload Identity** — 中程度の学習コスト

### 4.8 既存資産活用度

**◎ 最大活用**: caddy ingress, tinyauth, Artifact Registry, MongoDB 接続経路、すべて再利用。`stukivx.xyz` ドメインに `/slack/events` を追加するだけ。

### 4.9 移行リスクと段階プラン

| Phase | 内容                                                                       | 期間  |
| ----- | -------------------------------------------------------------------------- | ----- |
| 0     | Dockerfile 整備、ローカル `docker run` で `bun bot/index.ts` 動作確認      | 0.5日 |
| 1     | manifest 作成 (Deployment/Service/PVC/Secret) → staging namespace に apply | 1日   |
| 2     | Slack app の **Event URL を staging に切替**、test channel で動作確認      | 0.5日 |
| 3     | 本番 namespace に promote、PM2 を停止、VM 解約                             | 0.5日 |

リスク: **`useradd` がコンテナ内で動くか実機検証必須**。`gcr.io/google.com/cloudsdktool` ベースだと apt 制限あり。`oven/bun:debian` か `node:bookworm` ベースが無難。

### 4.10 Pros / Cons

**Pros**

- コード変更最小 (現状の Map 前提を壊さない)
- 既存 caddy/tinyauth/AR と完全統合
- 既に課金中のクラスタを使い切る
- privileged container で `useradd` 動く

**Cons**

- `useradd` のセキュリティ前提 (privileged) はクラウドネイティブ的に "anti-pattern"
- シングルトン Deployment はスケールアウト不可 (= 現状の VM と同じ制約)
- 既存クラスタの煩雑さ (ws-\* 残骸, codesearch stuck) を引き継ぐ

**適した状況**: 「現状動いてるものをクラウドネイティブで包みたい、コード書き換えたくない」 ← 一番楽。

---

## 5. 案 B: Cloud Run 全部寄せ

### 5.1 アーキテクチャ

`tmp/cloudrun-migration.md` のプランがそのまま該当。

```
Slack ──► Cloud Run Service "comfypr-bot-webhook" (min=1, always-on)
            │ verify sig, dedup, placeholder, enqueue
            ▼
          Pub/Sub topic "bot-tasks"
            │
            ▼ (Eventarc)
          Cloud Run Job "comfypr-bot-worker" (per task)
            │ Claude Agent SDK 実行 (24h上限)
            │ workspace = /tmp/workspace/<ws>
            ▼
          GCS bucket (artifacts) / MongoDB Atlas (state)

cancel ──► Pub/Sub topic "bot-cancels" ──► running workers (subscribe)
followup ──► Pub/Sub topic "bot-followups" ──► running workers (subscribe)
```

### 5.2 必要な新規コンポーネント

- Cloud Run Service (webhook, min=1, concurrency=80)
- Cloud Run Job (worker, parallelism per task)
- Pub/Sub topics: `bot-tasks`, `bot-cancels`, `bot-followups`
- Eventarc trigger: Pub/Sub → Job
- GCS bucket `comfypr-bot-artifacts`
- Secret Manager (7 secrets)
- Cloud Build (image build pipeline)
- (任意) Cloud Run Service 用 Custom Domain → `stukivx.xyz/slack` を Cloud Run に**移動** または別ドメイン

### 5.3 コード変更の規模 (大)

- `bot/webhook-receiver.ts` 新規 — `slack-bot.ts` の event 受付部分 (200行ほど) をコピー
- `bot/worker.ts` 新規 — Cloud Run Job のエントリ。Pub/Sub message を env で受け、`spawnBotOnSlackMessageEvent` を1回だけ実行して exit
- `bot/task-user.ts`, `bot/spawn-as-user.ts` を **削除または no-op 化** — Cloud Run gVisor が隔離を提供するので per-task user 不要
- `botWorkingDir` を `/tmp/workspace/<ws>` に変更 — git clone, attachments, deliverables もすべて `/tmp` (各 Job は新規 tmpfs)
- **`TaskAbortControllers` Map 完全廃止** → cancel は Pub/Sub topic + worker 側 subscribe + workspaceId match で broadcast abort
- **`TaskInputFlows` Map 完全廃止** → followup も Pub/Sub topic 経由。worker 側で long-running subscribe を持ち、TransformStream に inject
- `RestartManager.ts` の意味合いが変わる (Job は単発、再起動概念なし)
- deliverable は `/tmp` から GCS upload に切替 (slack-bot.ts:1140 の `prbot slack post` の参照ファイルパスを GCS URL or 一時署名 URL に)

差分は **800-1500行**。コア設計の作り直し。

### 5.4 長時間タスクの扱い

- Cloud Run Job: 最大 **24時間** タスク実行可
- Cloud Run Service (webhook): 60分上限だが webhook は秒単位で完了するので無関係

### 5.5 cancel / followup inject の代替設計

**現状 (in-process Map)** → **Pub/Sub broadcast + workspaceId match**:

```ts
// worker.ts (Cloud Run Job)
const ws = process.env.WORKSPACE_ID;
const ac = new AbortController();
const inputFlow = new TransformStream<string, string>();

// cancel subscribe
pubsub.subscription("bot-cancels-sub").on("message", (msg) => {
  if (msg.attributes.workspaceId === ws) ac.abort();
  msg.ack();
});

// followup subscribe
pubsub.subscription("bot-followups-sub").on("message", (msg) => {
  if (msg.attributes.workspaceId === ws) {
    inputFlow.writable.getWriter().write(msg.data.toString());
  }
  msg.ack();
});
```

注意点:

- 各 Job が独自 subscription を作るのか、shared subscription にして filter するのか — shared だと "他の job への msg を ack してしまう" 問題。**filter による subscription 動的作成**が安全だが、Pub/Sub の動的 subscription 作成は遅延あり (5-30秒)。
- これは設計上の "穴" で、検証必須。

### 5.6 コスト試算

- Cloud Run Service min=1 (always-on, 0.5 vCPU, 512MB): **~$15/月**
- Cloud Run Job (タスク数依存、1日10件 × 30分平均 × 1 vCPU / 2GB): **~$10-20/月**
- Pub/Sub: ~$1
- Eventarc: ~$1
- GCS: 5GB → ~$0.5
- Secret Manager: ~$1
- Artifact Registry: ~$1
- **合計: ~$30-40/月**

GKE クラスタを **削除しない**前提だと**追加コスト**。クラスタ縮小なら相殺可。

### 5.7 運用負荷

- ログ: Cloud Logging に集約 (◎)
- メトリクス: Cloud Monitoring (◎)
- credentials rotation: Secret Manager の version bump → Cloud Run 自動 reload
- 障害復旧: Job が落ちても Eventarc retry あり、ただし**冪等性が必要** (重複実行で重複Slack投稿しないように dedup hash を強化)
- **新規運用知識: Pub/Sub, Eventarc, Cloud Run Jobs, GCS** — 中〜高

### 5.8 既存資産活用度

**△ 中**: caddy/tinyauth は使わない。Artifact Registry のみ再利用。`stukivx.xyz` の取り扱い要設計 (Cloud Run の Custom Domain か、GKE caddy が Cloud Run に reverse_proxy するハイブリッド構成)。

### 5.9 移行リスクと段階プラン

`tmp/cloudrun-migration.md` の Phase 0-3 を踏襲。Phase 1 単独 (lift & shift) は **60分超タスクで本番障害**になるので、Phase 2 まで一気に行く必要あり (= ロールバック窓が短い)。

### 5.10 Pros / Cons

**Pros**

- スケールアウト、ゼロスケール可
- privileged 不要、cloud native ベストプラクティス準拠
- 24時間タスク、Job timeout も緩い
- credentials/ログ/メトリクスが標準で整う
- VM/GKE の運用負荷から完全離脱

**Cons**

- コード変更が最大 (cancel/followup の再設計コスト大)
- Pub/Sub 動的 subscription の設計が "穴" (実装次第で fragile)
- caddy/tinyauth/stukivx.xyz が宙に浮く
- Cold start の影響 (Job 起動 5-30秒、Slack 即返信は webhook receiver 側で吸収済みだが Job 起動遅延 = ユーザ体感反応遅れ)

**適した状況**: 「クラウドネイティブに作り直す覚悟があり、将来スケールさせたい」「VM/GKE 運用を完全に手放したい」。

---

## 6. 案 C: Hybrid (Cloud Run = webhook / GKE = workers)

### 6.1 アーキテクチャ

```
Slack ──► caddy (GKE, stukivx.xyz)
            │ /slack/events
            ▼
          ComfyPR-Bot Webhook Pod (GKE Deployment, replicas=2)
            │ Slack 即200, dedup, placeholder
            │ ──Pub/Sub or kube API──►
            ▼
          Worker Pod 起動 (GKE Job, per task)
            ├─ namespace = bot-workers
            ├─ image = prbot-images/comfypr-bot
            ├─ securityContext: privileged (useradd 可)
            ├─ emptyDir: /bot/slack/<ws>
            ├─ env: WORKSPACE_ID, EVENT_PAYLOAD_JSON
            └─ ttlSecondsAfterFinished: 3600
            ▼
          MongoDB / GitHub / Slack
```

または Webhook 側を Cloud Run Service にして、Worker は GKE Job:

```
Slack ──► Cloud Run Service "comfypr-bot-webhook" (min=1)
            │ Pub/Sub publish
            ▼
          Pub/Sub "bot-tasks"
            │ (Eventarc → kube API gateway, または Knative Eventing)
            ▼
          GKE Job (per task, privileged, useradd 可)
```

後者は webhook 側のコード変更が小さく (200行コピー)、worker 側は `slack-bot.ts` をほぼそのまま使える。

### 6.2 必要な新規コンポーネント

- Cloud Run Service `comfypr-bot-webhook` (min=1) **または** GKE Deployment for webhook
- GKE Job template (worker)
- Pub/Sub or Kubernetes Job API 直接呼出
- Bridge: Cloud Run → kube API は Workload Identity 経由 (kube ServiceAccount に GSA 紐付け、Cloud Run から `kubectl create job`)
- Secret Manager + External Secrets Operator (kube に同期)
- caddy Caddyfile 追記 (webhook ルート)

### 6.3 コード変更の規模 (中)

- `bot/webhook-receiver.ts` 新規 — slack-bot.ts の前半 (event 受付、dedup、placeholder 投稿) をコピー、`spawnBotOnSlackMessageEvent` の代わりに kube Job を spawn
- `bot/worker-entrypoint.ts` 新規 — env から event payload 取得、`spawnBotOnSlackMessageEvent(event)` を1回呼んで exit
- `slack-bot.ts` の同一プロセス前提部分は **Job 内では成立** (1 Job = 1 task = 1 process なので Map のサイズは常に 1)
- cancel/followup は **kube exec or signals** で実装:
  - cancel: webhook が `kubectl delete pod -l workspaceId=<ws>` で Pod を削除 → Pod 内の SDK が SIGTERM 受けて abort
  - followup: webhook が `kubectl exec -i job-<ws> -- /bin/sh -c "echo $msg > /tmp/inputs/<id>"` で名前付き fifo に書き込み、worker は fifo を読んで `taskInputFlow` に inject
  - **より素直**: webhook は MongoDB に `pending-followup` を書き、worker が定期 poll (1秒) — 整合性は緩いが実装は10行

差分は **300-500行**。

### 6.4 長時間タスクの扱い

GKE Job に上限なし。TTL 設定で完了後自動削除。

### 6.5 cancel / followup inject

- **cancel**: kube label selector で Pod 削除 → SIGTERM → SDK abort。実装は webhook 側に `kubectl` library 1関数。
- **followup**: MongoDB poll パターン推奨。`SlackBotState.set('followup-${ws}', text)` を webhook 側で書き、worker が 1秒間隔で読み出して `taskInputFlow` に注入。worker 内の `TaskInputFlows` Map は 1要素のままなのでロジック変更最小。

### 6.6 コスト試算

- 既存 GKE 3 node はそのまま → $0
- Cloud Run Service webhook (min=1): **~$15/月**
- Pub/Sub (使うなら): ~$1
- Job 実行は既存 node のスケジューラ枠内 → $0 (CPU/RAM が node 容量を超えるなら Cluster Autoscaler で node 増 = +$30-60/月)
- **合計: ~$15-20/月**

webhook も GKE に置く full-GKE Hybrid なら **$0** (既存クラスタ内)。

### 6.7 運用負荷

- ログ: Cloud Logging で webhook + GKE Job 統合
- メトリクス: Cloud Monitoring + Pod metrics
- credentials rotation: Secret Manager + External Secrets で完全自動 (再起動も rolling update で吸収)
- 障害復旧: webhook は Cloud Run の自動 retry、worker Job は kube 側で `backoffLimit`
- **新規運用知識: kube Job API, External Secrets, (任意で) Pub/Sub**

### 6.8 既存資産活用度

**○ 高**: GKE クラスタ、Artifact Registry、(GKE-only 構成なら) caddy/tinyauth すべて活用。Cloud Run webhook 採用なら caddy はバイパスされる。

### 6.9 移行リスクと段階プラン

| Phase | 内容                                                                                          | 期間  |
| ----- | --------------------------------------------------------------------------------------------- | ----- |
| 0     | Dockerfile 整備 + AR push                                                                     | 0.5日 |
| 1     | webhook 受付ロジックを `webhook-receiver.ts` に切り出し、Cloud Run (or GKE Deployment) に置く | 1日   |
| 2     | `worker-entrypoint.ts` 作成、GKE Job template 整備                                            | 1日   |
| 3     | webhook → kube Job spawn、staging で1往復                                                     | 1日   |
| 4     | cancel/followup の MongoDB poll 実装                                                          | 0.5日 |
| 5     | 本番切替                                                                                      | 0.5日 |

合計 **4-5日**。

リスク: webhook → kube API spawn の権限管理 (Workload Identity)、Job spawn rate limit (kube-apiserver QPS)。

### 6.10 Pros / Cons

**Pros**

- 各役割を最適サービスに割当 (webhook = stateless serverless, worker = privileged + 長時間)
- `useradd` を諦めずに済む (案 A の利点 + 案 B のスケーラビリティ)
- 1 Job = 1 process なので同一プロセス前提コードは Job 内で温存
- スケールアウト可能 (Job 並列数)

**Cons**

- 2 surface (Cloud Run + GKE) を運用する必要あり
- cancel/followup の cross-process 設計は必須 (案 B より軽いが案 A よりは重い)
- webhook → kube spawn の権限管理が複雑

**適した状況**: 「コード書き換えコストを抑えつつ、長時間タスク・スケールアウト・privileged 隔離を全部欲しい」「既存 GKE を活用しつつクラウドネイティブに進む」。

---

## 7. 横並び比較表

| 項目                     | A: GKE 全部    | B: Cloud Run 全部    | C: Hybrid       |
| ------------------------ | -------------- | -------------------- | --------------- |
| コード変更行数           | < 100          | 800-1500             | 300-500         |
| 移行期間                 | 2日            | 5-7日                | 4-5日           |
| 月額追加コスト           | $15-20         | $30-40               | $15-20          |
| `useradd` サポート       | ○ (privileged) | × (廃止前提)         | ○ (worker side) |
| 長時間タスク上限         | 無制限         | Job 24h              | 無制限          |
| cancel/followup 設計工数 | 0              | 大                   | 中              |
| 既存資産活用             | ◎              | △                    | ○               |
| スケールアウト           | ×(singleton)   | ◎                    | ◎               |
| 運用知識                 | kube中         | Cloud Run中, Pub/Sub | kube + CR       |
| クラウドネイティブ度     | △              | ◎                    | ○               |
| 障害ブラスト半径         | プロセス全体   | Job単位              | Job単位         |

---

## 8. 推奨案と根拠

### 推奨: **案 C (Hybrid: Cloud Run webhook + GKE Job worker)**

### 根拠

1. **`useradd` を捨てる判断は時期尚早**: `tmp/cloudrun-migration.md` は「Cloud Run gVisor が隔離を提供するから per-task user 不要」と主張しているが、これは **agent 同士の隔離**には正しいが、**agent と bot 本体の隔離**にはならない (同一コンテナ内で動く)。GKE Job なら Pod 単位で完全分離 + 各 Pod 内で `useradd` も使える二段隔離。

2. **同一プロセス前提コードを温存**: 案 C では 1 Job = 1 process = 1 task なので、`TaskInputFlows` `TaskAbortControllers` の Map は Job 内で常にサイズ 1。ロジックを書き換える必要がない (cross-process 通信は webhook→worker の **入口**にだけ必要)。これは案 B との **300-1000行差**。

3. **既存 GKE クラスタを使い切る**: 既に課金中の 3-node クラスタ + Artifact Registry に `prbot-ws` も置いてある。worker を GKE に置く限界コストは **node のスペアCPU/RAM 内ならゼロ**。

4. **webhook を Cloud Run にする利点**: GKE Deployment と違いゼロスケール対応、min=1 で常時 200ms 以下で 200 返す。Slack の 3秒制限を心配しなくてよい。caddy/tinyauth を bypass するが、Slack webhook は元々認証不要 (signature verify) なので tinyauth 経由の意味は薄い。

5. **段階的移行が安全**: Phase 1 (webhook 切り出し) は本番影響ゼロで検証可能。Phase 2-3 で worker を切替。各段階で rollback 可。

### 案 A を選ばない理由

- シングルトン Deployment は VM の単一障害点問題を引き継ぐだけ
- privileged container は将来の GKE Autopilot 移行 (= node 運用ゼロ) を阻む
- スケールアウト不可 = 同時タスク数の上限が現状 VM と同じ

### 案 B を選ばない理由

- cancel/followup の Pub/Sub 動的 subscription 設計は **fragile** (subscription 作成遅延 = ユーザ操作の取りこぼし)
- コード変更 800-1500行は実コード編集禁止の現状で Phase 0 すら困難
- 既存 GKE クラスタの sunk cost を捨てる
- privileged 操作 (`useradd`) を完全廃止する設計判断は **タスクスクリプトが root 前提でファイル作成している箇所** (例えば `bot/spawn-as-user.ts` の `/root/.bun/bin/bun` ハードコード) すべての洗い出しが必要 — 工数読みづらい

---

## 9. 即着手すべき cleanup タスク

これは案選択と独立して**すぐやるべき**もの:

| #   | タスク                                                          | コマンド例                                                                                                         | 推定影響                |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| 1   | `default` ns の `ws-{8hex}-svc` 残骸 40件削除                   | `kubectl get svc -n default -o name \| grep '^service/ws-' \| xargs kubectl delete -n default`                     | ゼロ (使用されていない) |
| 2   | `codesearch/postgresql` `ContainerCreating` 25日詰まり調査      | `kubectl describe pod -n codesearch postgresql-0` でボリュームマウント or imagePullBackOff 特定                    | codesearch 機能依存     |
| 3   | `codesearch/redis-master` 同上                                  | 同上                                                                                                               | 同上                    |
| 4   | Artifact Registry の `codepod:latest` (5.7GB) 削除              | `gcloud artifacts docker images delete asia-northeast1-docker.pkg.dev/dreamboothy-dev/prbot-images/codepod:latest` | Storage コスト減        |
| 5   | `prbot-ws:20260315-6648281` 以外の古い tag 整理                 | `gcloud artifacts docker images list ... --filter='UPDATE_TIME<-P30D'`                                             | Storage コスト減        |
| 6   | GKE node pool のサイズ確認 — 案 C なら現状のまま、案 B なら縮小 | `gcloud container clusters describe prbot --region asia-northeast1`                                                | コスト最適化            |
| 7   | `claude-pods` headless Service の現状利用確認 (現役 or 残骸?)   | `kubectl get endpoints claude-pods`                                                                                | 不明、調査要            |

### codesearch の `ContainerCreating` 25日 — 高優先度

PVC 取得待ち or imagePullSecret 不整合の典型。`prbot` クラスタ全体のスケジューラ圧迫要因の可能性あり。bot 移行前に解決推奨 (デバッグ中に worker Job が同じ問題を踏む可能性)。

---

## 10. 未確定事項

調査または意思決定が必要なもの:

1. **Cloud Run Service request timeout 上限の現行値**: 2024年に60分→延長されたが、`asia-northeast1` での実値要確認。webhook は秒単位で完了するので案 C には影響しないが、案 B Phase 1 (lift & shift) の可否に直結。
2. **`stukivx.xyz` の TLS 証明書管理**: cert-manager? 手動? 案 B/C で webhook を Cloud Run に分けると証明書管理経路が分裂する。
3. **MongoDB Atlas の VPC Peering 有無**: GKE / Cloud Run の egress IP allowlist が Atlas に登録済みか。新サービスを足す場合 IP 追加要。
4. **GKE node の OS/runtime**: Container-Optimized OS (COS) なら privileged + `useradd` の挙動要検証。COS は `useradd` 標準で動くが root FS が read-only な点に注意。
5. **`prbot-ws:20260315-6648281` の用途**: workspace pods 用と書かれているが現在 spawn 経路がない。案 C の worker image にこれを再利用できるか、それとも `comfypr-bot:<sha>` を新規ビルドするか。
6. **Slack app の event subscription URL 切替**: 現状 `https://(VM IP or domain)/slack/events`。staging URL に一時切替するための **2つ目の Slack app** 用意が必要か (本番 traffic を staging に流せないので)。
7. **`createTaskUser` の workspace 永続化要件**: PVC ReadWriteOnce で十分か、Job 並列実行で書き込み競合あるか。`workspaceId` が thread単位なので競合は出ない見込みだが要確認。
8. **`tinyauth` の保護対象**: 現状 stukivx.xyz の何を保護しているか。Slack webhook はバイパスされるべきだが、bot dashboard などがあれば tinyauth 経由のままにする。
9. **`RestartManager.ts` の Job モード適合性**: 現状は同一プロセス内 PM2 連携前提。Job 単位の "restart" 概念に置き換えるロジック変更要否。
10. **コスト前提**: GKE クラスタを **解約しない**前提で見積もったが、Comfy-Org として `prbot` cluster を縮小・廃止する計画があれば前提が変わる。

---

## 付録: 案 C 採用時の最初の 1 PR

実コード編集は別タスクだが、PR スコープ目安:

- `Dockerfile.bot` 新規 (worker/webhook 兼用、ENV で分岐)
- `bot/webhook-receiver.ts` 新規 (slack-bot.ts:170-534 を切り出し、`spawnBotOnSlackMessageEvent` を `spawnKubeJob` に置換)
- `bot/worker-entrypoint.ts` 新規 (env から event 受け取って `spawnBotOnSlackMessageEvent` 呼ぶだけ)
- `infra/k8s/worker-job-template.yaml` 新規
- `infra/k8s/webhook-deployment.yaml` 新規 (or Cloud Run の場合 `infra/cloudrun/webhook.yaml`)
- `cloudbuild.yaml` 新規 (image build pipeline)
- `bot/state.ts` に `getPendingFollowup(workspaceId)` / `setPendingFollowup` 追加 (followup poll 用)
- `bot/slack-bot.ts` の `TaskInputFlows`/`TaskAbortControllers` 部分にコメント追記 ("Job 内では size=1 前提、cross-Job 通信は MongoDB poll")
