// EcomModa — Logistics Control Center (v1.0.0)
// skills: worker-builder v1.0.0 · dashboard-builder v2.0.0 · order-lifecycle v1.1.0 · constants v1.2.0 — 30-08-2026
//
// داشبورد مسئول الشحن — إحصائيات وتفاصيل حالات الأوردرات على مدى ٦ شهور.
// قراءة فقط: مفيش أي mutation على شوبيفاي في الملف ده إطلاقًا.
//
// ⚠️ ممنوع Cron — الداشبورد بتتحدّث بضغطة زرار أو تغيير الفترة بس.
// ⚠️ الكاش في KV (بيانات عرض قابلة للرمي) — D1 للسجلات بس.

// ══════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════
const TOOL_NAME      = 'logistics_control_center';   // مسجّلة في ecommoda-constants §7 — types: login · logout
const WORKER_VERSION = 'v1.0.0';

// ⬅️ ارفعه مع أي تغيير في قائمة حقول ORDER_QUERY أو في شكل الصف اللي بيترجع.
//    من غير الرفع، الفترات المتكاشة بترجع صفوف من غير الحقول الجديدة والمربعات تطلع صفر.
const CACHE_VERSION  = 'v1';

const API_VERSION    = '2026-01';        // صريح دايمًا — أبدًا "latest"
// ─── §CONSTANTS::cache-ttl — فرع "state payload" ───
// ecommoda-dashboard-builder v2.0.0 → Step 3-أ ثم Step 3-ج.
//
// صفوف الأداة دي بتوصف **الحالة الحالية** لأوردرات **اتعملت** في الفترة — مش
// أحداث حصلت فيها. يعني الفترة بتحدد **مين** يظهر، مش محتوى الصف: أوردر اتعمل
// في مارس وهو Shipped النهارده هيبقى Delivered الأسبوع الجاي وممكن يترجع في
// سبتمبر. عشان كده **ttlFor عمرها ما ترجّع null هنا** — كاش دائم كان معناه إن
// مارس تفضل تقول "خرج للشحن" للأبد، برقم شكله سليم ومن غير أي خطأ.
const TTL_OPEN    = 900;    // الفترة فيها النهارده — ١٥ دقيقة
const TTL_RECENT  = 21600;  // قفلت من ٤٥ يوم أو أقل — ٦ ساعات (لسه فيها حركة تسليم/إرجاع)
const TTL_SETTLED = 86400;  // أقدم من ٤٥ يوم — ٢٤ ساعة (الحركة نادرة بس مش مستحيلة)
const RECENT_DAYS = 45;

const MAX_CACHE_BYTES = 24 * 1024 * 1024; // حد KV الحقيقي 25 MiB — بنفشل قبله بوضوح
const PAGE_SIZE      = 250;

// ─── §CONSTANTS::status — منسوخة حرفيًا من ecommoda-order-lifecycle Step 2 ───
// الحالة (casing) محمولة للمعنى: WhatsApp-CANCELLED بحروف كبيرة، WhatsApp-Confirmed لأ،
// و "Confirmed + Edit" فيها مسافات حوالين الـ +. حرف واحد غلط = صفر نتائج بدون أي خطأ.
const S1 = {
  NEW_ORDER:      'New Order',
  CONFIRMED:      'Confirmed',
  WA_CONFIRMED:   'WhatsApp-Confirmed',
  WA_CANCELLED:   'WhatsApp-CANCELLED',
  CONFIRMED_EDIT: 'Confirmed + Edit',
  PENDING_EDIT:   'Pending Edit',
  READY:          'Ready',
  SHIPPED:        'Shipped',
  IN_RETURN:      'In-Return',
  DELIVERED:      'Delivered',
  RETURNED:       'Returned',
  CANCELLED:      'Cancelled',
};
const S2 = {
  CONFIRMED_RETURN:   'Confirmed + RETURN',
  CONFIRMED_EXCHANGE: 'Confirmed + EXCHANGE',
  READY:              'Ready',
  SHIPPED:            'Shipped',
  IN_RETURN:          'In-Return',
  RETURNED:           'Returned',
};
const S1_KNOWN = new Set(Object.values(S1));
const S2_KNOWN = new Set(Object.values(S2));

// ─── §CONSTANTS::buckets — الـ ١٤ مربّع المعتمدة ───
// (ecommoda-order-lifecycle → classification-rules.md §9-أ)
// الأسماء العربية بتاعتهم في الـ HTML — الـ Worker بيملك الأكواد بس.
const B = {
  PENDING_CONFIRM:         'PENDING_CONFIRM',
  PREP_CONFIRMED:          'PREP_CONFIRMED',
  PREP_EXCHANGE:           'PREP_EXCHANGE',
  PREP_RETURN:             'PREP_RETURN',
  SHIPPED_CONFIRMED:       'SHIPPED_CONFIRMED',
  SHIPPED_EXCHANGE:        'SHIPPED_EXCHANGE',
  SHIPPED_RETURN:          'SHIPPED_RETURN',
  LOST_CANCELLED:          'LOST_CANCELLED',
  LOST_RTO:                'LOST_RTO',
  LOST_FULL_RETURN:        'LOST_FULL_RETURN',
  DELIVERY_BASIC:          'DELIVERY_BASIC',
  DELIVERY_EXCHANGE:       'DELIVERY_EXCHANGE',
  DELIVERY_PARTIAL_RETURN: 'DELIVERY_PARTIAL_RETURN',
  UNCLASSIFIED:            'UNCLASSIFIED',
};

// ─── §CONSTANTS::reasons — أكواد التشخيص (Rule 10 / Rule 14) ───
// الـ Worker بيملك الأكواد · الـ HTML بيملك الكلام والإجراء (UNCL_REASON_LABELS).
// أي كود جديد هنا لازم يتضاف هناك، وإلا الصف بيتعرض بالكود الخام (وده مقصود، مش فاضي).
const R = {
  S1_RETURNED_NO_CANCEL:   'S1_RETURNED_NO_CANCEL',
  S1_UNKNOWN:              'S1_UNKNOWN',
  S2_UNKNOWN:              'S2_UNKNOWN',
  S2_WITHOUT_CYCLE:        'S2_WITHOUT_CYCLE',
  CYCLE_WITHOUT_S2:        'CYCLE_WITHOUT_S2',
  EXCHANGE_FULLY_RETURNED: 'EXCHANGE_FULLY_RETURNED',
  MULTI_CYCLE:             'MULTI_CYCLE',
  CYCLE_OVERLAP:           'CYCLE_OVERLAP',
  CYCLE_BEFORE_DELIVERY:   'CYCLE_BEFORE_DELIVERY',
  LINEITEMS_TRUNCATED:     'LINEITEMS_TRUNCATED',
  RETURNS_TRUNCATED:       'RETURNS_TRUNCATED',
};

// ══════════════════════════════════════════════════════════════
// §CORS — Option A (wildcard): أداة قراءة فقط
// ══════════════════════════════════════════════════════════════
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function getCORS(_req) { return CORS_HEADERS; }

// ══════════════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════════════
function json(data, status = 200, request = null) {
  const headers = { 'Content-Type': 'application/json' };
  Object.assign(headers, request ? getCORS(request) : { 'Access-Control-Allow-Origin': '*' });
  return new Response(JSON.stringify(data), { status, headers });
}

// ─── §HELPERS::assertEnv ───
// متغيّر ناقص لازم يوقف العملية برسالة باسمه — مش يفشل بصمت جوّه استعلام.
const ENV_REQUIRED = {
  shopify: ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET'],
};
function assertEnv(env, ...groups) {
  const missing = [];
  for (const g of groups) {
    for (const key of (ENV_REQUIRED[g] || [])) {
      if (env[key] === undefined || env[key] === null || String(env[key]).trim() === '') missing.push(key);
    }
  }
  if (!env.DB)      missing.push('DB (D1 binding)');
  if (!env.DASH_KV) missing.push('DASH_KV (KV binding)');
  if (missing.length) {
    throw Object.assign(
      new Error(
        `متغيرات ناقصة في الـ Worker: ${missing.join('، ')} — ضِفها من ` +
        `Dashboard → Settings → Variables ثم Promote النسخة. (شغّل ?action=diag)`
      ),
      { step: 'env' }
    );
  }
}

const ymd = d => d.toISOString().slice(0, 10);
const isValidDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ══════════════════════════════════════════════════════════════
// §SHARED — Auth & Logging (EcomModa D1 Pattern v1.3.0)
// منسوخة حرفيًا من ecommoda-worker-builder — ممنوع أي تعديل عليها
// ══════════════════════════════════════════════════════════════
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();

  if (!row) return null;

  if (!row.is_active) {
    throw new Error('الحساب موقوف — تواصل مع المسؤول');
  }

  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username)
    .run()
    .catch(() => {});

  return row.display_name;
}

async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row) return { exists: false, hasPin: false, isActive: false };
  return {
    exists:   true,
    hasPin:   !!row.pin,
    isActive: !!row.is_active,
  };
}

async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();

  if (!row)           throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin)        throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');

  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?')
    .bind(pin, username)
    .run();

  return true;
}

async function writeLog(db, entry) {
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp    ?? new Date().toISOString(),
    entry.tool,
    entry.type,
    entry.employee     ?? null,
    entry.orderId      ?? null,
    entry.orderName    ?? null,
    entry.sku          ?? null,
    entry.productTitle ?? null,
    entry.delta        ?? null,
    entry.valueBefore  ?? null,
    entry.valueAfter   ?? null,
    entry.notes        ?? null,
    entry.extra ? JSON.stringify(entry.extra) : null
  ).run();
}

async function getLogs(db, {
  tool     = null,
  employee = null,
  type     = null,
  search   = null,
  limit    = 100,
  offset   = 0,
} = {}) {
  let sql = "SELECT * FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];

  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (type)     { sql += ' AND type = ?';     b.push(type); }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  b.push(Math.min(limit, 100), offset);

  return (await db.prepare(sql).bind(...b).all()).results;
}

async function getLogsCount(db, {
  tool     = null,
  employee = null,
  search   = null,
} = {}) {
  let sql = "SELECT COUNT(*) as total FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];

  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }

  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

async function getLogsExport(db, {
  tool     = null,
  employee = null,
  search   = null,
} = {}) {
  let sql = "SELECT * FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];

  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (search) {
    sql += ' AND (order_name LIKE ? OR notes LIKE ?)';
    b.push(`%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY timestamp DESC LIMIT 2000';

  return (await db.prepare(sql).bind(...b).all()).results;
}
// ══════════════════════════════════════════════════════════════
// END SHARED BLOCK
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// §ACCESS-LOG — سجل الدخول/الخروج (خاص بالأداة دي)
// ══════════════════════════════════════════════════════════════
// ⚠️ ليه دوال منفصلة بدل getLogs الموحّدة؟
// الأداة دي **قراءة فقط** — القيم الوحيدة اللي بتكتبها في D1 هي `login` و`logout`،
// و getLogs الموحّدة بتستبعد الاتنين server-side في SQL بشكل مقصود. يعني تاب
// السجل بالشكل القياسي كان هيطلع **فاضي للأبد** في الأداة دي بالذات. الدوال
// دي **إضافة جنب** §SHARED، مش تعديل عليها — §SHARED فوق منسوخة حرفيًا زي
// ما هي، والـ endpoints القياسية (get_logs / get_logs_count / get_logs_export)
// موجودة برضه ومتاحة لو الأداة كتبت أي type تاني في المستقبل.

async function getAccessLogs(db, { employee = null, search = null, limit = 100, offset = 0 } = {}) {
  let sql = "SELECT * FROM logs WHERE tool = ? AND type IN ('login','logout')";
  const b = [TOOL_NAME];
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (search)   { sql += ' AND (employee LIKE ? OR notes LIKE ?)'; b.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  b.push(Math.min(limit, 100), Math.max(offset, 0));
  return (await db.prepare(sql).bind(...b).all()).results;
}

async function getAccessLogsCount(db, { employee = null, search = null } = {}) {
  let sql = "SELECT COUNT(*) as total FROM logs WHERE tool = ? AND type IN ('login','logout')";
  const b = [TOOL_NAME];
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (search)   { sql += ' AND (employee LIKE ? OR notes LIKE ?)'; b.push(`%${search}%`, `%${search}%`); }
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}

async function getAccessLogsExport(db, { employee = null, search = null } = {}) {
  let sql = "SELECT * FROM logs WHERE tool = ? AND type IN ('login','logout')";
  const b = [TOOL_NAME];
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (search)   { sql += ' AND (employee LIKE ? OR notes LIKE ?)'; b.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY timestamp DESC LIMIT 2000';
  return (await db.prepare(sql).bind(...b).all()).results;
}

// ══════════════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════════════
async function getAccessToken(env) {
  let resp;
  try {
    resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        client_id:     env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
        grant_type:    'client_credentials',
      }),
    });
  } catch (e) {
    throw Object.assign(new Error(`تعذّر الاتصال بشوبيفاي للحصول على التوكن — ${e.message}`), { step: 'oauth' });
  }
  if (!resp.ok) throw Object.assign(new Error(`OAuth failed: HTTP ${resp.status}`), { step: 'oauth' });
  const data = await resp.json().catch(() => ({}));
  if (!data.access_token) throw Object.assign(new Error('شوبيفاي ردّت بدون access_token'), { step: 'oauth' });
  return data.access_token;
}

// ─── §SHOPIFY::shopifyGQL — العقد الإلزامي، منسوخة كما هي ───
// ممنوع تختصرها لـ `return resp.json()`. الرد الفاشل لازم يترمي، مش يعدّي:
//   ① فشل شبكة  ② HTTP status  ③ رد مش JSON  ④ data فاضية
// (④ بتحصل لما شوبيفاي ترفض حقل — الرد بيبقى {"errors":[…],"data":null})
// أخطاء GraphQL نفسها بتتعالج في shopifyWithRetry تحت.
async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify') {
  let resp, text;
  try {
    resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body:    JSON.stringify({ query, variables }),
    });
    text = await resp.text();
  } catch (e) {
    throw Object.assign(new Error(`${opName}: فشل الاتصال بشوبيفاي — ${e.message}`), { step: 'shopify' });
  }
  if (!resp.ok) {
    throw Object.assign(
      new Error(`${opName}: شوبيفاي ردّت HTTP ${resp.status} — ${text.slice(0, 180)}`),
      { step: 'shopify' }
    );
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw Object.assign(new Error(`${opName}: رد شوبيفاي مش JSON صالح — ${text.slice(0, 180)}`), { step: 'shopify' }); }
  if (!data.errors && !data.data) {
    throw Object.assign(new Error(`${opName}: رد شوبيفاي بدون data وبدون errors`), { step: 'shopify' });
  }
  return data;
}

// ─── §SHOPIFY::shopifyWithRetry ───
// بتعيد المحاولة على THROTTLED بس. أي خطأ GraphQL تاني بيفشل فورًا —
// إعادة محاولة اسم حقل غلط بتفشل تلات مرات كمان، ببطء.
async function shopifyWithRetry(env, token, query, variables = {}, maxRetries = 3) {
  for (let i = 0; i <= maxRetries; i++) {
    const data = await shopifyGQL(env, token, query, variables, 'GetOrders');
    const throttled = data.errors?.some(e => e.extensions?.code === 'THROTTLED');

    if (data.errors && !throttled) {
      throw new Error('Shopify GraphQL error: ' + JSON.stringify(data.errors).slice(0, 400));
    }
    if (!throttled) return data;
    if (i === maxRetries) throw new Error('Shopify throttled — استُنفدت المحاولات');

    const ts      = data.extensions?.cost?.throttleStatus;
    const restore = ts?.restoreRate;
    const wait    = restore ? Math.ceil(ts.maximumAvailable / restore) * 1000 : 2000 * (i + 1);
    await new Promise(r => setTimeout(r, wait));
  }
}

// ─── §SHOPIFY::ORDER_QUERY ───
// قائمة الحقول اعتُمدت عبر Data Contract بتاريخ 29-08-2026.
// ⚠️ إضافة أي حقل هنا **بتستلزم رفع CACHE_VERSION في نفس التعديل**.
// حقول مطلوب صراحةً إنها مش هنا (لتقليل التكلفة): أي حقل فلوس
// (currentTotalPriceSet)، printing_time_s2 / s2_packing_date_time،
// bosta_tracking_number / bosta_number_of_attempts — قرار أحمد 29-08-2026.
const ORDER_QUERY = `
  query GetOrders($cursor: String, $q: String!) {
    orders(first: ${PAGE_SIZE}, after: $cursor, query: $q, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        legacyResourceId
        name
        createdAt
        note
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress { city province address1 }
        lineItems(first: 20) {
          pageInfo { hasNextPage }
          nodes { currentQuantity }
        }
        returns(first: 10) {
          pageInfo { hasNextPage }
          nodes {
            status
            createdAt
            closedAt
            exchangeLineItems(first: 1) { nodes { id } }
          }
        }
        s1:           metafield(namespace: "custom", key: "manual_status")        { value }
        s2:           metafield(namespace: "custom", key: "status_2_r_e")         { value }
        courier:      metafield(namespace: "custom", key: "courier")              { value }
        zone:         metafield(namespace: "custom", key: "zone")                 { value }
        pickupDate:   metafield(namespace: "custom", key: "pickup_date")          { value }
        printS1:      metafield(namespace: "custom", key: "printing_time_s1")     { value }
        packS1:       metafield(namespace: "custom", key: "s1_packing_date_time") { value }
        cancelReason: metafield(namespace: "custom", key: "cancel_manual_reason") { value }
        returnReason: metafield(namespace: "custom", key: "return_manual_reason") { value }
      }
    }
  }
`;

// ══════════════════════════════════════════════════════════════
// §AGGREGATE
// ══════════════════════════════════════════════════════════════

// ─── §AGGREGATE::stageFromS2 ───
// Rule 12: In-Return ≡ Shipped في الماكينتين، للعدّ وللفلوس.
// القائمة **مكتوبة بالكامل** — مفيش catch-all بيبلع قيمة جديدة في صمت
// (dashboard-ui-patterns §12: ده بالظبط اللي حصل في لوحة الأداء).
function stageFromS2(s2) {
  switch (s2) {
    case S2.CONFIRMED_RETURN:
    case S2.CONFIRMED_EXCHANGE:
    case S2.READY:
      return 'PREP';
    case S2.SHIPPED:
    case S2.IN_RETURN:
    case S2.RETURNED:   // s2=Returned مع دورة لسه مش CLOSED = القطعة اتحركت بس الدورة ما اتقفلتش
      return 'SHIPPED';
    default:
      return null;      // مش معروفة → الصف بيروح UNCLASSIFIED بسبب صريح
  }
}

// ─── §AGGREGATE::prepCycles ───
// دورات الإرجاع/الاستبدال بعد استبعاد الملغاة/المرفوضة، **مرتّبة بـ createdAt**
// (ممنوع الاعتماد على ترتيب المصفوفة — order-lifecycle Rule 15).
function prepCycles(returnNodes) {
  return (returnNodes || [])
    .filter(r => r && !['CANCELED', 'DECLINED'].includes(r.status))
    .map(r => ({
      status:     r.status,
      createdAt:  r.createdAt || '',
      closedAt:   r.closedAt || null,
      isExchange: (r.exchangeLineItems?.nodes?.length || 0) > 0,
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// ─── §AGGREGATE::classifyOrder ───
// تنقيح الـ ١٤ مربّع فوق classifyOrder() الأساسية (order-lifecycle Step 4).
// كل مربّع بيتبع مربّع واحد قانوني: PENDING/PREP/SHIPPED → IN_PROGRESS ·
// LOST_CANCELLED → CANCELLED · LOST_RTO → RTO · LOST_FULL_RETURN → FULL_RETURN ·
// DELIVERY_* → DELIVERED · UNCLASSIFIED = تشخيصي.
//
// قراءة G-11 المستخدمة هنا: **S1 = Returned مع cancelledAt فاضي → UNCLASSIFIED**
// (نفس قراءة Performance-Dashboard — قرار أحمد 29-08-2026). الخسارة لازم تيجي من
// حدث شوبيفاي، مش من ميتافيلد. الإجراء اللي بيقفل الحالة: Cancel + Restock في شوبيفاي.
function classifyOrder(o) {
  const reasons = [];
  const push = (code, detail) => reasons.push({ code, detail: detail == null ? null : String(detail) });

  const s1 = o.s1 || null;
  const s2 = o.s2 || null;

  // Rule 13 — قيمة برّه القائمة تتعلّم، وما تتحركش من مربعها
  if (s1 && !S1_KNOWN.has(s1)) push(R.S1_UNKNOWN, s1);
  if (s2 && !S2_KNOWN.has(s2)) push(R.S2_UNKNOWN, s2);
  if (o.liTruncated)  push(R.LINEITEMS_TRUNCATED, null);
  if (o.retTruncated) push(R.RETURNS_TRUNCATED, null);

  const cycles  = o.cycles;
  const current = cycles.length ? cycles[cycles.length - 1] : null;

  if (cycles.length >= 2) push(R.MULTI_CYCLE, cycles.length);
  for (let i = 1; i < cycles.length; i++) {
    const prev = cycles[i - 1];
    if (!prev.closedAt || String(cycles[i].createdAt) < String(prev.closedAt)) {
      push(R.CYCLE_OVERLAP, null);
      break;
    }
  }

  // ① PRIMARY — أحداث شوبيفاي (مستحيل موظف أو Flow يكتبها غلط)
  if (o.cancelledAt) {
    return {
      bucket: o.fulfillment === 'FULFILLED' ? B.LOST_RTO : B.LOST_CANCELLED,
      reasons,
    };
  }

  // ② SECONDARY — الميتافيلد، وبس لما شوبيفاي ما سجّلتش أي إلغاء
  if (s1 === S1.CANCELLED) return { bucket: B.LOST_CANCELLED, reasons };
  if (s1 === S1.RETURNED) {
    push(R.S1_RETURNED_NO_CANCEL, s1);
    return { bucket: B.UNCLASSIFIED, reasons };
  }

  // ③ فرع التسليم — S1 = Delivered نهائية، وكل نشاط بعدها في S2
  if (s1 === S1.DELIVERED) {
    if (!current) {
      if (s2) { push(R.S2_WITHOUT_CYCLE, s2); return { bucket: B.UNCLASSIFIED, reasons }; }
      return { bucket: B.DELIVERY_BASIC, reasons };
    }

    // التسوية بتتقاس على **أحدث** دورة بس (Rule 7 / Rule 15) —
    // دورة قديمة CLOSED بتفضل مسوّاة مهما كانت قيمة s2 دلوقتي.
    const currentSettled = current.status === 'CLOSED' && (s2 === S2.IN_RETURN || s2 === S2.RETURNED);

    if (!currentSettled) {
      // فرع انتقالي: فيه حاجة بتتحرك دلوقتي → النوع والمرحلة من **أحدث** دورة
      const stage = stageFromS2(s2);
      if (!stage) { push(R.CYCLE_WITHOUT_S2, s2 || '(فارغ)'); return { bucket: B.UNCLASSIFIED, reasons }; }
      if (current.isExchange) {
        return { bucket: stage === 'PREP' ? B.PREP_EXCHANGE : B.SHIPPED_EXCHANGE, reasons };
      }
      return { bucket: stage === 'PREP' ? B.PREP_RETURN : B.SHIPPED_RETURN, reasons };
    }

    // فرع نهائي: المربّع بقى ملخّص — هنا `.some()` هي **الصح**
    // ("هل الأوردر ده شاف استبدال في أي وقت؟" سؤال تاني عن "إيه اللي بيتحرك دلوقتي")
    const hasExchange = cycles.some(c => c.isExchange);

    if (o.remainingQty === 0) {
      if (hasExchange) {
        // استبدال اتعمله إرجاع كامل — مسار موجود في الكود ومش متغطي بأي مربّع
        push(R.EXCHANGE_FULLY_RETURNED, null);
        return { bucket: B.UNCLASSIFIED, reasons };
      }
      return { bucket: B.LOST_FULL_RETURN, reasons };
    }
    return { bucket: hasExchange ? B.DELIVERY_EXCHANGE : B.DELIVERY_PARTIAL_RETURN, reasons };
  }

  // ④ S1 لسه في الطريق — Rule 12: In-Return يتعامل معاملة Shipped
  if (current) push(R.CYCLE_BEFORE_DELIVERY, s1 || '(فارغ)');

  if (s1 === null) return { bucket: B.PENDING_CONFIRM, reasons };
  switch (s1) {
    case S1.NEW_ORDER:
    case S1.WA_CONFIRMED:
    case S1.WA_CANCELLED:
    case S1.PENDING_EDIT:
      return { bucket: B.PENDING_CONFIRM, reasons };
    case S1.CONFIRMED:
    case S1.CONFIRMED_EDIT:
    case S1.READY:
      return { bucket: B.PREP_CONFIRMED, reasons };
    case S1.SHIPPED:
    case S1.IN_RETURN:
      return { bucket: B.SHIPPED_CONFIRMED, reasons };
    default:
      // Rule 13: قيمة مش معروفة — تتعدّ كأنها جارية (صح)، بس **لازم** تحمل السبب
      // (اتضاف فوق كـ S1_UNKNOWN). علّمها، وما تحركهاش.
      return { bucket: B.PENDING_CONFIRM, reasons };
  }
}

// ─── §AGGREGATE::mapOrder ───
function mapOrder(n) {
  const liNodes      = n.lineItems?.nodes || [];
  const remainingQty = liNodes.reduce((s, li) => s + (li.currentQuantity || 0), 0);
  const cycles       = prepCycles(n.returns?.nodes);

  const base = {
    s1:          n.s1?.value || null,
    s2:          n.s2?.value || null,
    cancelledAt: n.cancelledAt || null,
    fulfillment: n.displayFulfillmentStatus || null,
    remainingQty,
    cycles,
    liTruncated:  !!n.lineItems?.pageInfo?.hasNextPage,
    retTruncated: !!n.returns?.pageInfo?.hasNextPage,
  };

  const { bucket, reasons } = classifyOrder(base);
  const addr = n.shippingAddress || {};

  return {
    orderId:      n.legacyResourceId || null,   // إلزامي — الواجهة بتبني بيه لينك شوبيفاي
    orderNumber:  n.name,
    createdAt:    n.createdAt,
    month:        String(n.createdAt || '').slice(0, 7),   // YYYY-MM
    bucket,
    reasons,
    s1:           base.s1,
    s2:           base.s2,
    courier:      n.courier?.value || null,
    zone:         n.zone?.value || null,
    city:         addr.city || null,
    province:     addr.province || null,
    address:      addr.address1 || null,
    note:         (n.note || '').trim() || null,
    pickupDate:   n.pickupDate?.value || null,
    printedAt:    n.printS1?.value || null,
    packedAt:     n.packS1?.value || null,
    cancelReason: n.cancelReason?.value || null,
    returnReason: n.returnReason?.value || null,
    fulfillment:  base.fulfillment,
    financial:    n.displayFinancialStatus || null,
    cancelled:    !!base.cancelledAt,
    units:        remainingQty,
    cycles:       cycles.length,
  };
}

// ─── §AGGREGATE::fetchAllOrders ───
// مفيش MAX_PAGES — الفترة اللي المستخدم اختارها هي الحد.
// حارس الـ cursor العالق هو الحماية الحقيقية الوحيدة من اللوب اللانهائي.
// أي صفحة بتفشل بتسقّط الطلب كله: مفيش نتيجة ناقصة بتخرج من الدالة دي أبدًا.
async function fetchAllOrders(env, token, dateFrom, dateTo) {
  const q = `created_at:>=${dateFrom} created_at:<=${dateTo}T23:59:59`;

  const orders    = [];
  const truncated = [];
  let cursor = null, hasNext = true, page = 0;

  while (hasNext) {
    page++;
    let result;
    try {
      result = await shopifyWithRetry(env, token, ORDER_QUERY, { cursor, q });
    } catch (e) {
      throw Object.assign(
        new Error(`فشل جلب الصفحة ${page} من الأوردرات — ${e.message}`),
        { step: `graphql_page_${page}` }
      );
    }

    const conn = result?.data?.orders;
    if (!conn) {
      throw Object.assign(new Error('شوبيفاي لم ترجّع بيانات أوردرات'), { step: `graphql_page_${page}` });
    }
    if (conn.pageInfo.endCursor && conn.pageInfo.endCursor === cursor) {
      throw Object.assign(new Error('Pagination stuck — الـ cursor لم يتقدم'), { step: `graphql_page_${page}` });
    }

    for (const n of (conn.nodes || [])) {
      const row = mapOrder(n);
      if (row.reasons.some(r => r.code === R.LINEITEMS_TRUNCATED)) truncated.push(row.orderNumber);
      orders.push(row);
    }

    cursor  = conn.pageInfo.endCursor;
    hasNext = conn.pageInfo.hasNextPage;
  }

  return { orders, truncated, pages: page };
}

// ─── §AGGREGATE::summarize ───
// ملخّص خفيف بيتخزّن في مفتاح الـ meta — الواجهة بتحسب كل الـ KPIs من الصفوف
// نفسها عشان الفلاتر تأثّر على المربعات، فده للطزاجة والعدّ السريع بس.
function summarize(orders) {
  const byBucket = {};
  const byMonth  = {};
  const reasonCounts = {};

  for (const o of orders) {
    byBucket[o.bucket] = (byBucket[o.bucket] || 0) + 1;
    if (!byMonth[o.month]) byMonth[o.month] = 0;
    byMonth[o.month]++;
    for (const r of o.reasons) reasonCounts[r.code] = (reasonCounts[r.code] || 0) + 1;
  }
  return { totalOrders: orders.length, byBucket, byMonth, reasonCounts };
}

// ══════════════════════════════════════════════════════════════
// §CACHE
// ══════════════════════════════════════════════════════════════
const dataKey = (f, t) => `dash:${TOOL_NAME}:${CACHE_VERSION}:data:${f}:${t}`;
const metaKey = (f, t) => `dash:${TOOL_NAME}:${CACHE_VERSION}:meta:${f}:${t}`;

// ─── §CACHE::ttlFor ───
// TTL متدرّج بعمر الفترة — **مفيش كاش دائم إطلاقًا**. السبب الكامل في
// §CONSTANTS::cache-ttl فوق: حالة الأوردر بتفضل تتحرك بعد ما فترة إنشائه تقفل.
function ttlFor(dateTo) {
  const today = ymd(new Date());
  if (dateTo >= today) return TTL_OPEN;
  const ageDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dateTo}T00:00:00Z`)) / 86400000);
  return ageDays <= RECENT_DAYS ? TTL_RECENT : TTL_SETTLED;
}

async function readCache(env, dateFrom, dateTo) {
  const raw = await env.DASH_KV.get(dataKey(dateFrom, dateTo));
  return raw ? JSON.parse(raw) : null;
}

// ─── §CACHE::writeCache ───
// بتتنادى **بس** بعد ما كل الصفحات نجحت. مفيش أي مسار بيكتب نتيجة ناقصة.
async function writeCache(env, dateFrom, dateTo, payload) {
  const ttl  = ttlFor(dateTo);
  const opts = ttl ? { expirationTtl: ttl } : {};
  const lastUpdated = new Date().toISOString();

  const body = JSON.stringify({ ...payload, lastUpdated, dateFrom, dateTo });
  if (body.length > MAX_CACHE_BYTES) {
    throw Object.assign(
      new Error(
        `حجم البيانات (${Math.round(body.length / 1048576)} ميجا) تجاوز حد التخزين للفترة ` +
        `${dateFrom} → ${dateTo} — الفترة دي كبيرة جدًا على مفتاح واحد`
      ),
      { step: 'kv_write' }
    );
  }

  await env.DASH_KV.put(dataKey(dateFrom, dateTo), body, opts);
  await env.DASH_KV.put(
    metaKey(dateFrom, dateTo),
    JSON.stringify({ lastUpdated, count: payload.orders.length, summary: payload.summary, ttl }),
    opts
  );
  return lastUpdated;
}

// ══════════════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    // ① CORS preflight — دايمًا الأول
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: getCORS(request) });

    // ② WORKER_SECRET — دايمًا التاني
    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`)
      return json({ error: 'Unauthorized' }, 401, request);

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    try {

      // ─── §AUTH ────────────────────────────────────────────────────
      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return json({ ok: false, error: 'username مطلوب' }, 400, request);
        const result = await checkEmployee(env.DB, username);
        return json({ ok: true, ...result }, 200, request);
      }

      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);
        await registerPin(env.DB, username, pin);
        return json({ ok: true }, 200, request);
      }

      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return json({ ok: false, error: 'username و pin مطلوبان' }, 400, request);

        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);

        // الدخول نجح فعلاً فوق — فشل D1 بعد كده بيرجع logged:false، مش 500 على دخول حصل.
        let logged = true;
        try {
          await writeLog(env.DB, {
            tool:     TOOL_NAME,
            type:     'login',
            employee: username,
            notes:    `دخول: ${displayName}`,
          });
        } catch (e) {
          logged = false;
        }
        return json({ ok: true, displayName, logged }, 200, request);
      }

      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        let logged = true;
        if (username) {
          try {
            await writeLog(env.DB, {
              tool:     TOOL_NAME,
              type:     'logout',
              employee: username,
              notes:    `خروج: ${username.replace(/_/g, ' ')}`,
            });
          } catch (e) {
            logged = false;
          }
        }
        return json({ ok: true, logged }, 200, request);
      }

      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      // ─── §DATA ────────────────────────────────────────────────────
      if (action === 'get_data') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        assertEnv(env, 'shopify');

        let body = {};
        try { body = await request.json(); } catch { /* جسم فاضي مقبول */ }

        const today        = ymd(new Date());
        const firstOfMonth = `${today.slice(0, 8)}01`;
        const dateFrom     = body.dateFrom || firstOfMonth;
        const dateTo       = body.dateTo   || today;
        const forceRefresh = body.forceRefresh === true;

        if (!isValidDate(dateFrom) || !isValidDate(dateTo)) {
          return json({ error: 'صيغة التاريخ لازم تكون YYYY-MM-DD', step: 'validate' }, 400, request);
        }
        if (dateFrom > dateTo) {
          return json({ error: '"من تاريخ" لازم يكون قبل "إلى تاريخ"', step: 'validate' }, 400, request);
        }

        // كاش-أولاً إلا لو زرار التحديث اتضغط
        if (!forceRefresh) {
          const cached = await readCache(env, dateFrom, dateTo);
          if (cached) return json({ ...cached, source: 'kv' }, 200, request);
        }

        const token = await getAccessToken(env);
        const { orders, truncated, pages } = await fetchAllOrders(env, token, dateFrom, dateTo);
        const summary = summarize(orders);

        // الكتابة بتحصل **هنا بس** — بعد ما كل الصفحات نجحت
        const lastUpdated = await writeCache(env, dateFrom, dateTo, { orders, truncated, summary, pages });

        // بنرجّع اللي جبناه لسه مباشرة — ممنوع إعادة قراءة KV بعد الكتابة
        // (KV eventually consistent: القراءة ممكن ترجّع القيمة القديمة لحد ٦٠ ثانية)
        return json(
          { orders, truncated, summary, pages, lastUpdated, dateFrom, dateTo, source: 'shopify' },
          200, request
        );
      }

      // فحص طزاجة خفيف — عمره ما بيشغّل استعلام شوبيفاي
      if (action === 'get_meta') {
        const dateFrom = url.searchParams.get('dateFrom');
        const dateTo   = url.searchParams.get('dateTo');
        if (!dateFrom || !dateTo) return json({ error: 'dateFrom و dateTo مطلوبان' }, 400, request);
        const raw = await env.DASH_KV.get(metaKey(dateFrom, dateTo));
        return json(raw ? JSON.parse(raw) : { lastUpdated: null, count: 0 }, 200, request);
      }

      if (action === 'clear_cache') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        let body = {};
        try { body = await request.json(); } catch { /* ok */ }

        if (body.dateFrom && body.dateTo) {
          await env.DASH_KV.delete(dataKey(body.dateFrom, body.dateTo));
          await env.DASH_KV.delete(metaKey(body.dateFrom, body.dateTo));
          return json({ ok: true, deleted: `${body.dateFrom}:${body.dateTo}` }, 200, request);
        }

        const list = await env.DASH_KV.list({ prefix: `dash:${TOOL_NAME}:` });
        await Promise.all(list.keys.map(k => env.DASH_KV.delete(k.name)));
        return json({ ok: true, deleted: list.keys.length }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      // ─── §LOG-ENDPOINTS ───────────────────────────────────────────
      // القياسية (بتستبعد login/logout server-side) — موجودة للتوافق مع المعيار،
      // وهترجّع فاضية في الأداة دي لأنها ما بتكتبش أي type تاني (شوف §ACCESS-LOG).
      if (action === 'get_logs') {
        const employee = url.searchParams.get('employee') || null;
        const search   = url.searchParams.get('search')   || null;
        const limit    = Math.min(parseInt(url.searchParams.get('limit')  || '100', 10), 100);
        const offset   = Math.max(parseInt(url.searchParams.get('offset') || '0',  10), 0);
        const entries  = await getLogs(env.DB, { tool: TOOL_NAME, employee, search, limit, offset });
        return json({ ok: true, entries }, 200, request);
      }
      if (action === 'get_logs_count') {
        const employee = url.searchParams.get('employee') || null;
        const search   = url.searchParams.get('search')   || null;
        const total    = await getLogsCount(env.DB, { tool: TOOL_NAME, employee, search });
        return json({ ok: true, total }, 200, request);
      }
      if (action === 'get_logs_export') {
        const employee = url.searchParams.get('employee') || null;
        const search   = url.searchParams.get('search')   || null;
        const entries  = await getLogsExport(env.DB, { tool: TOOL_NAME, employee, search });
        return json({ ok: true, entries }, 200, request);
      }

      // سجل الدخول/الخروج — التاب الفعلي في الواجهة بيقرا منها
      if (action === 'get_access_logs') {
        const employee = url.searchParams.get('employee') || null;
        const search   = url.searchParams.get('search')   || null;
        const limit    = Math.min(parseInt(url.searchParams.get('limit')  || '100', 10), 100);
        const offset   = Math.max(parseInt(url.searchParams.get('offset') || '0',  10), 0);
        const entries  = await getAccessLogs(env.DB, { employee, search, limit, offset });
        return json({ ok: true, entries }, 200, request);
      }
      if (action === 'get_access_logs_count') {
        const employee = url.searchParams.get('employee') || null;
        const search   = url.searchParams.get('search')   || null;
        const total    = await getAccessLogsCount(env.DB, { employee, search });
        return json({ ok: true, total }, 200, request);
      }
      if (action === 'get_access_logs_export') {
        const employee = url.searchParams.get('employee') || null;
        const search   = url.searchParams.get('search')   || null;
        const entries  = await getAccessLogsExport(env.DB, { employee, search });
        return json({ ok: true, entries }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      // ─── §DIAG ────────────────────────────────────────────────────
      // ⚠️ ممنوع يعرض قيمة أي سر — الأسماء والأطوال بس.
      if (action === 'diag') {
        const checks = [];
        const secretish = /SECRET|CLIENT_ID|KEY|PIN/i;

        const envKeys = Object.keys(env).filter(k => typeof env[k] === 'string');
        checks.push({
          name: 'المتغيرات والأسرار',
          ok:   true,
          info: envKeys
            .map(k => `${k} (${secretish.test(k) ? `طول ${String(env[k]).length}` : String(env[k])})`)
            .join(' · ') || '(مفيش)',
        });

        checks.push({ name: 'ربط D1 (DB)',       ok: !!env.DB });
        checks.push({ name: 'ربط KV (DASH_KV)',  ok: !!env.DASH_KV });

        try {
          const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM employees WHERE is_active = 1').first();
          checks.push({ name: 'قراءة جدول الموظفين', ok: true, info: `${row?.n ?? 0} موظف نشط` });
        } catch (e) {
          checks.push({ name: 'قراءة جدول الموظفين', ok: false, info: e.message });
        }

        try {
          const token = await getAccessToken(env);
          const d = await shopifyGQL(
            env, token,
            '{ currentAppInstallation { accessScopes { handle } } shop { name ianaTimezone } }',
            {}, 'diag'
          );
          const scopes = d.data?.currentAppInstallation?.accessScopes?.map(s => s.handle) || [];
          checks.push({ name: 'اتصال شوبيفاي', ok: true, info: `${d.data?.shop?.name || '?'} · ${d.data?.shop?.ianaTimezone || '?'}` });
          checks.push({
            name: 'صلاحية read_orders',
            ok:   scopes.includes('read_orders') || scopes.includes('read_all_orders'),
            info: scopes.join(', ') || '(مفيش صلاحيات ظاهرة)',
          });
          checks.push({
            name: 'صلاحية read_returns (لازمة لتصنيف الاستبدال/المرتجع)',
            ok:   scopes.includes('read_returns'),
            info: scopes.includes('read_returns') ? 'موجودة' : 'ناقصة — دورات الإرجاع هترجع فاضية وكل مرتجع هيتصنّف تسليم أساسي',
          });
        } catch (e) {
          checks.push({ name: 'اتصال شوبيفاي', ok: false, info: e.message });
        }

        return json({
          ok: checks.every(c => c.ok),
          version: WORKER_VERSION,
          tool: TOOL_NAME,
          cacheVersion: CACHE_VERSION,
          origin: request.headers.get('Origin') || '(بدون)',
          checks,
        }, 200, request);
      }

      if (action === 'get_config') {
        return json({
          ok: true,
          version: WORKER_VERSION,
          tool: TOOL_NAME,
          cacheVersion: CACHE_VERSION,
          apiVersion: API_VERSION,
        }, 200, request);
      }
      // ──────────────────────────────────────────────────────────────

      return json({ error: `Unknown action: ${action}` }, 400, request);

    } catch (e) {
      console.error(e);
      return json({ error: e.message, step: e.step || 'unknown', technical: e.stack || null }, 500, request);
    }
  },
};
