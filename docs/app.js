// --- Configuration -----------------------------------------------------
// Fill these in once the Supabase project / VAPID keys / Stripe Payment
// Link exist. Safe to keep in client-side code: the Supabase key here must
// be the "anon" key (RLS-protected), never the service_role key, and the
// VAPID key here must be the *public* key.
const SUPABASE_URL = "https://hebnnwypbrdlhxuscjfp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_PMkG7hHV-8RCDTdRD_MVDQ_6Yo4n5Ds";
const VAPID_PUBLIC_KEY = "BPSyum_Fd4i8fxvwQ0u-OAkVI7ralCHqXMUCPQtnHEtqpP9cqwAmcFGssGCL3m6zk9QO8N1-VeL47Pu8hmoFf00";
const STRIPE_PAYMENT_LINK_URL = "https://buy.stripe.com/test_14A9AV5S7bmQ1oX64m14400";
const FREE_TIER_LIMIT = 3;

// Named supabaseClient (not "supabase") because the CDN bundle's UMD build
// declares a top-level `var supabase = ...` itself; a `const supabase = ...`
// here would collide with that global and throw "Identifier 'supabase' has
// already been declared" at parse time.
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// site_type must stay in sync with worker/dispatcher.py's
// _HOST_SUFFIX_TO_SITE_TYPE and the DB check constraint in
// supabase/migrations/0001_init.sql. The worker re-detects this itself at
// check-time, so drift here only affects the stored label, not parsing.
const HOST_SUFFIX_TO_SITE_TYPE = [
  ["amazon.co.jp", "amazon"],
  ["amzn.asia", "amazon"],
  ["item.rakuten.co.jp", "rakuten"],
  ["shopping.yahoo.co.jp", "yahoo_shopping"],
  ["snkrdunk.com", "snkrdunk"],
  ["zozo.jp", "zozotown"],
];

const STATUS_LABEL = {
  in_stock: "在庫あり",
  sold_out: "売り切れ",
  unknown: "確認中",
  error: "取得エラー",
};

// Based on actually running the worker from GitHub Actions (2026-07-20
// investigation, see README "対応サイト" table) — NOT just "has a dedicated
// parser." Amazon has one but is bot-blocked from GitHub Actions' shared
// cloud IPs (returns a robot-check page, not the real product page), while
// Rakuten/Yahoo!/SNKRDUNK have no dedicated parser yet but are confirmed
// reachable. Precision here tracks real-world outcome, not code structure,
// so the UI never overclaims (or underclaims) what actually works today.
// Update these two lists if the self-hosted-runner IP change (see 作業.md)
// changes which sites are reachable.
const SITES_CONFIRMED_WORKING = ["rakuten", "yahoo_shopping", "snkrdunk"];
const SITES_CONFIRMED_BLOCKED = ["amazon", "zozotown"];

let currentUser = null;
let currentDevice = null;

// --- Helpers -------------------------------------------------------------

function detectSiteType(url) {
  const host = new URL(url).hostname.toLowerCase();
  for (const [suffix, siteType] of HOST_SUFFIX_TO_SITE_TYPE) {
    if (host === suffix || host.endsWith("." + suffix)) return siteType;
  }
  return "generic";
}

// Rakuten/Amazon/etc. "share" functions copy product name + other text
// alongside the URL (e.g. "【楽天市場】商品名 https://item.rakuten.co.jp/...").
// Pull just the URL out so users can paste the whole shared text as-is.
function extractUrl(text) {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

function normalizeUrl(url) {
  const u = new URL(url);
  u.hash = "";
  u.search = "";
  let normalized = (u.protocol + "//" + u.hostname.toLowerCase() + u.pathname).replace(/\/+$/, "");
  return normalized;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function formatCheckedAt(iso) {
  if (!iso) return "確認待ち";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "たった今確認";
  if (minutes < 60) return `${minutes}分前に確認`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}時間前に確認`;
  return `${Math.round(hours / 24)}日前に確認`;
}

// --- Auth / device bootstrap ----------------------------------------------

async function ensureSignedIn() {
  const { data: sessionData } = await supabaseClient.auth.getSession();
  let user = sessionData.session?.user ?? null;

  if (!user) {
    const { data, error } = await supabaseClient.auth.signInAnonymously();
    if (error) throw error;
    user = data.user;
  }
  currentUser = user;

  // RLS's devices_insert_own policy requires id = auth.uid(), so it must be
  // passed explicitly rather than relying on the column default.
  const { data: device, error: upsertError } = await supabaseClient
    .from("devices")
    .upsert({ id: user.id }, { onConflict: "id", ignoreDuplicates: true })
    .select()
    .maybeSingle();

  if (upsertError) throw upsertError;

  if (device) {
    currentDevice = device;
  } else {
    const { data: existing, error: fetchError } = await supabaseClient
      .from("devices")
      .select()
      .eq("id", user.id)
      .single();
    if (fetchError) throw fetchError;
    currentDevice = existing;
  }
}

// --- Items -----------------------------------------------------------------

async function fetchItems() {
  const { data, error } = await supabaseClient
    .from("watched_items")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

function renderItems(items) {
  const list = document.getElementById("item-list");
  const emptyState = document.getElementById("empty-state");
  const limitBanner = document.getElementById("limit-banner");
  const limitCount = document.getElementById("limit-count");

  list.innerHTML = "";

  if (items.length === 0) {
    emptyState.hidden = false;
  } else {
    emptyState.hidden = true;
    for (const item of items) {
      list.appendChild(renderItemCard(item));
    }
  }

  if (!currentDevice?.is_premium) {
    limitBanner.hidden = false;
    limitCount.textContent = String(items.length);
  } else {
    limitBanner.hidden = true;
  }

  const highlightId = new URLSearchParams(location.search).get("item");
  if (highlightId) {
    const card = list.querySelector(`[data-item-id="${highlightId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.style.outline = "2px solid var(--accent)";
    }
  }
}

function renderItemCard(item) {
  const card = document.createElement("div");
  card.className = "card item-card";
  card.dataset.itemId = item.id;

  const thumb = document.createElement("img");
  thumb.className = "item-thumb";
  thumb.src = item.product_image_url || "./icons/icon-192.png";
  thumb.alt = "";
  thumb.onerror = () => (thumb.src = "./icons/icon-192.png");

  const body = document.createElement("div");
  body.className = "item-body";

  const name = document.createElement("div");
  name.className = "item-name";
  name.textContent = item.product_name || item.url;

  const url = document.createElement("div");
  url.className = "item-url";
  url.textContent = item.url;

  const meta = document.createElement("div");
  meta.className = "item-meta";

  const badge = document.createElement("span");
  badge.className = `badge ${item.status}`;
  badge.textContent = STATUS_LABEL[item.status] || item.status;

  const checked = document.createElement("span");
  checked.className = "item-checked";
  checked.textContent = formatCheckedAt(item.last_checked_at);

  meta.append(badge, checked);

  const precision = document.createElement("div");
  let precisionClass;
  let precisionText;
  if (SITES_CONFIRMED_BLOCKED.includes(item.site_type)) {
    precisionClass = "blocked";
    precisionText = "⚠️ 現在ブロックされていて取得できません";
  } else if (SITES_CONFIRMED_WORKING.includes(item.site_type)) {
    precisionClass = "working";
    precisionText = "✅ 動作確認済み";
  } else {
    precisionClass = "";
    precisionText = "🔍 ベストエフォート（未検証）";
  }
  precision.className = `site-precision ${precisionClass}`;
  precision.textContent = precisionText;

  body.append(name, url, meta, precision);

  const deleteButton = document.createElement("button");
  deleteButton.className = "link-danger";
  deleteButton.textContent = "削除";
  deleteButton.addEventListener("click", () => deleteItem(item.id));

  card.append(thumb, body, deleteButton);
  return card;
}

async function refreshItems() {
  const items = await fetchItems();
  renderItems(items);
  return items;
}

async function addItem(rawInput) {
  const extracted = extractUrl(rawInput);
  if (!extracted) {
    showToast("URLが見つかりませんでした");
    return;
  }

  let url;
  try {
    url = new URL(extracted);
  } catch {
    showToast("URLの形式が正しくありません");
    return;
  }

  const items = await fetchItems();
  if (!currentDevice?.is_premium && items.length >= FREE_TIER_LIMIT) {
    openPaywall();
    return;
  }

  const { error } = await supabaseClient.from("watched_items").insert({
    device_id: currentUser.id,
    url: url.toString(),
    normalized_url: normalizeUrl(url.toString()),
    site_type: detectSiteType(url.toString()),
  });

  if (error) {
    if (error.message?.includes("FREE_TIER_LIMIT_REACHED")) {
      openPaywall();
    } else if (error.code === "23505") {
      showToast("すでに登録済みの商品です");
    } else {
      showToast("追加に失敗しました");
      console.error(error);
    }
    return;
  }

  showToast("商品を登録しました。まもなく在庫確認が始まります");
  await refreshItems();
}

async function deleteItem(itemId) {
  const { error } = await supabaseClient.from("watched_items").delete().eq("id", itemId);
  if (error) {
    showToast("削除に失敗しました");
    console.error(error);
    return;
  }
  await refreshItems();
}

// --- Paywall -----------------------------------------------------------

function openPaywall() {
  document.getElementById("paywall-modal").hidden = false;
}
function closePaywall() {
  document.getElementById("paywall-modal").hidden = true;
}

function goToUpgrade() {
  const url = new URL(STRIPE_PAYMENT_LINK_URL);
  url.searchParams.set("client_reference_id", currentUser.id);
  window.location.href = url.toString();
}

// --- Push notifications --------------------------------------------------

async function refreshNotifyBanner() {
  const banner = document.getElementById("notify-banner");
  const testBanner = document.getElementById("test-notify-banner");
  const supported =
    "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;

  if (!supported) {
    banner.hidden = true;
    testBanner.hidden = true;
    return;
  }

  const isSubscribed = Notification.permission === "granted" && currentDevice?.web_push_subscription;
  banner.hidden = isSubscribed;
  testBanner.hidden = !isSubscribed;
}

async function sendTestNotification() {
  const button = document.getElementById("test-notify-button");
  button.disabled = true;
  try {
    const { data, error } = await supabaseClient.functions.invoke("send-test-notification");
    if (error || data?.error) {
      showToast("テスト通知の送信に失敗しました");
      console.error(error || data?.error);
      return;
    }
    showToast("テスト通知を送信しました");
  } catch (err) {
    showToast("テスト通知の送信に失敗しました");
    console.error(err);
  } finally {
    button.disabled = false;
  }
}

async function enablePushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    showToast("このブラウザは通知に対応していません");
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showToast("通知が許可されませんでした");
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const { error } = await supabaseClient
    .from("devices")
    .update({
      web_push_subscription: subscription.toJSON(),
      web_push_subscription_updated_at: new Date().toISOString(),
    })
    .eq("id", currentUser.id);

  if (error) {
    showToast("通知の登録に失敗しました");
    console.error(error);
    return;
  }

  currentDevice = { ...currentDevice, web_push_subscription: subscription.toJSON() };
  showToast("通知を有効にしました");
  await refreshNotifyBanner();
}

// --- Notification history --------------------------------------------------

async function fetchNotificationHistory() {
  const { data, error } = await supabaseClient
    .from("notifications")
    .select("*")
    .order("sent_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data;
}

function renderHistory(notifications) {
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");
  list.innerHTML = "";

  if (notifications.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const entry of notifications) {
    const row = document.createElement("div");
    row.className = "history-item";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = entry.product_name || entry.url;

    const time = document.createElement("div");
    time.className = "time";
    time.textContent = new Date(entry.sent_at).toLocaleString("ja-JP");

    row.append(name, time);
    list.appendChild(row);
  }
}

async function toggleHistory() {
  const section = document.getElementById("history-section");
  if (!section.hidden) {
    section.hidden = true;
    return;
  }
  try {
    const notifications = await fetchNotificationHistory();
    renderHistory(notifications);
    section.hidden = false;
    section.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    showToast("通知履歴の取得に失敗しました");
    console.error(err);
  }
}

// --- Post-payment return handling ------------------------------------------

async function handleUpgradeReturn() {
  const params = new URLSearchParams(location.search);
  if (params.get("upgraded") !== "1") return;

  showToast("決済を確認しています…");
  // The Stripe webhook may take a couple seconds to land, so poll briefly.
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const { data } = await supabaseClient.from("devices").select().eq("id", currentUser.id).single();
    if (data?.is_premium) {
      currentDevice = data;
      showToast("プレミアムへのアップグレードが完了しました");
      break;
    }
  }
  history.replaceState({}, "", location.pathname);
  await refreshItems();
}

// --- Wiring ----------------------------------------------------------------

async function main() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("./service-worker.js")
      .then((registration) => registration.update())
      .catch((err) => console.error(err));
  }

  await ensureSignedIn();
  await refreshItems();
  await refreshNotifyBanner();
  await handleUpgradeReturn();

  document.getElementById("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("url-input");
    const button = document.getElementById("add-button");
    const url = input.value.trim();
    if (!url) return;
    button.disabled = true;
    try {
      await addItem(url);
      input.value = "";
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("enable-notify-button").addEventListener("click", enablePushNotifications);
  document.getElementById("test-notify-button").addEventListener("click", sendTestNotification);
  document.getElementById("upgrade-button").addEventListener("click", goToUpgrade);
  document.getElementById("paywall-upgrade-button").addEventListener("click", goToUpgrade);
  document.getElementById("paywall-close-button").addEventListener("click", closePaywall);
  document.getElementById("history-toggle-button").addEventListener("click", toggleHistory);
  document.getElementById("close-history-button").addEventListener("click", toggleHistory);
  document.getElementById("sites-toggle-button").addEventListener("click", toggleSites);
  document.getElementById("close-sites-button").addEventListener("click", toggleSites);
}

function toggleSites() {
  const section = document.getElementById("sites-section");
  section.hidden = !section.hidden;
  if (!section.hidden) {
    section.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

main().catch((err) => {
  console.error(err);
  showToast("読み込みに失敗しました。ページを再読み込みしてください");
});
