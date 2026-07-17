# 在庫レーダー (restock-radar)

売り切れ商品の在庫復活をプッシュ通知でお知らせするWebアプリ。まずはWeb PWA版で公開し、売上が出たらネイティブiOS版へ移行する方針。

## 構成

```
restock-radar/
  worker/        在庫監視バッチ（Python、GitHub Actionsのcronで定期実行）
  web/           PWA本体（素のHTML/CSS/JS、GitHub Pagesで公開）
  supabase/
    migrations/  DBスキーマ
    functions/   Stripe決済Webhook・テスト通知送信（Supabase Edge Functions）
  .github/workflows/monitor.yml   定期監視の自動実行設定
```

技術選定の背景や検討過程は `C:\Users\kazuya.tohara\.claude\plans\woolly-orbiting-wirth.md` を参照。

## 現在の状態

コード本体はローカルで書き終わっている。**VAPID鍵はネットワーク不要で生成済み**（`python worker/generate_vapid_keys.py`、`cryptography`パッケージのみで完結するためWi-Fi不要だった）。公開鍵は`web/app.js`の`VAPID_PUBLIC_KEY`に反映済み。秘密鍵は`worker/private_key.pem`と`worker/vapid_keys.local.txt`に保存済み（どちらも`.gitignore`済み、後述のSecrets設定で使う）。

以下の**ネットワークが必要な作業が未着手**（会社Wi-Fi環境のため保留中）:

1. Gitのインストール
2. Python依存パッケージのインストール（`pip install -r worker/requirements.txt`）
3. Supabaseプロジェクトの作成
4. GitHubリポジトリの作成・公開
5. Stripeの商品・決済リンク設定
6. `send-test-notification` Edge Functionのデプロイ

## セットアップ手順（Wi-Fiが使える環境で）

### 1. Gitをインストール

[git-scm.com](https://git-scm.com/) からWindows版をインストール。

```powershell
cd "restock-radar"
git init
git add -A
git commit -m "Initial commit"
```

GitHubで**public**リポジトリを作成し、`git remote add origin <URL>` → `git push -u origin main`。
（publicにする理由: GitHub ActionsのCI時間が無料枠無制限になるため。ワーカーのコード自体に機密情報は含まれない。秘密情報はすべてGitHub Secretsで管理する。）

### 2. Python依存パッケージのインストール

```powershell
cd worker
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
pytest tests/
```

`test_parsers.py` が全件パスすることを確認する（ネットワーク不要、保存済みHTMLフィクスチャでテスト）。

### 3. VAPID鍵をSecretsに登録（鍵自体はすでに生成済み）

`worker/vapid_keys.local.txt` に3つの値が保存されている:

- `worker/private_key.pem` の中身 → GitHubリポジトリの Settings → Secrets and variables → Actions で `VAPID_PRIVATE_KEY_PEM` として登録
- `VAPID_PRIVATE_KEY_RAW`の値 → Supabase secrets（後述のstep 7で`send-test-notification`用に設定）
- `VAPID_PUBLIC_KEY`の値 → すでに`web/app.js`に反映済み。Supabase secretsにも同じ値を`VAPID_PUBLIC_KEY`として設定する

あわせて `VAPID_SUBJECT`（例: `mailto:kazuyan.no.7@gmail.com`）をGitHub SecretsとSupabase secrets両方に登録する。

### 4. Supabaseプロジェクトを作成

1. [supabase.com](https://supabase.com/) でプロジェクトを新規作成（無料枠）
2. SQL Editorで `supabase/migrations/0001_init.sql` の内容を実行
3. Authentication → Providers → Anonymous Sign-ins を有効化
4. Project Settings → API から以下を控える:
   - Project URL → `web/app.js` の `SUPABASE_URL`
   - `anon` `public` key → `web/app.js` の `SUPABASE_ANON_KEY`
   - `service_role` key → GitHub Secretsの `SUPABASE_SERVICE_ROLE_KEY`（**絶対にブラウザ側コードに書かない**）
5. GitHub Secretsに `SUPABASE_URL` も登録

### 5. GitHub Pagesを有効化

リポジトリの Settings → Pages → Source を「Deploy from a branch」、Branch を `main` / `/web` に設定。ビルド不要なのでこれだけで公開される。

### 6. Stripeを設定（テストモードから）

1. [Stripe Dashboard](https://dashboard.stripe.com/) で商品「プレミアムアップグレード」を作成し、買い切り価格を設定（初期価格は**1,980円**。利用実績が増えたら2,980円→3,980円と段階的値上げを検討）
2. その商品の **Payment Link** を作成し、成功時リダイレクト先を `https://<GitHubユーザー名>.github.io/restock-radar/?upgraded=1` に設定
3. 作成したPayment LinkのURLを `web/app.js` の `STRIPE_PAYMENT_LINK_URL` に設定
4. Supabase CLIで Edge Function をデプロイ:
   ```powershell
   supabase functions deploy stripe-webhook --no-verify-jwt
   supabase secrets set STRIPE_SECRET_KEY=sk_test_...
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   ```
5. Stripe Dashboard → Webhooks で、デプロイ済みEdge FunctionのURL（`https://<project-ref>.supabase.co/functions/v1/stripe-webhook`）を`checkout.session.completed`イベント宛に登録し、そのSigning Secretを上記の`STRIPE_WEBHOOK_SECRET`に設定
6. テストカード `4242 4242 4242 4242` で実際に購入し、`devices.is_premium` が更新されることを確認してから本番キーに切り替える

### 7. send-test-notification Edge Functionをデプロイ

ユーザーが「テスト通知を送る」ボタンで自分の購読が動いているか自己確認できる機能。`stripe-webhook`と違い、こちらはSupabaseにログイン済みのブラウザから呼ばれるので `--no-verify-jwt` は**付けない**（Supabase側で自動的にJWT検証される）。

```powershell
supabase functions deploy send-test-notification
supabase secrets set VAPID_PRIVATE_KEY_RAW=（worker/vapid_keys.local.txtの値）
supabase secrets set VAPID_PUBLIC_KEY=（同上）
supabase secrets set VAPID_SUBJECT=mailto:kazuyan.no.7@gmail.com
```

`SUPABASE_URL`・`SUPABASE_ANON_KEY`はSupabaseが自動注入するので手動設定不要。

### 8. 動作確認の順番

1. `web/`をローカルで配信して通知購読が動くか確認: `cd web; python -m http.server 8000`
2. 購読情報が`devices.web_push_subscription`に保存されたら、まず「テスト通知を送る」ボタンで疎通確認（実際のスクレイピングを待たずにWeb Push配信経路だけ確認できる）
3. 続けて`worker/main.py`をローカルで一度実行し、実際の在庫チェック→プッシュ通知の流れを確認
4. GitHub Actionsで `workflow_dispatch` を手動実行し、Secretsの設定が正しいか確認
5. 問題なければ `monitor.yml` のcronが15分ごとに自動実行される

## 開発者自身の無料利用

Supabase の Table Editor で自分の `devices` 行の `is_premium` を手動で `true` にすれば、Stripeで支払わずにプレミアム機能を使える。
