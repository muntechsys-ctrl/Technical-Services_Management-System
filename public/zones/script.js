"use strict";

/* =====================================================
   نظام إدارة نطاقات المفتشين
   بلدية مدينة الذيد - الإدارة الهندسية
   ===================================================== */

/* ================= الإعدادات ================= */

const $ = id => document.getElementById(id);

const DATA_KEY = "inspection_zones_v1";
const DIRECTIVES_KEY = "inspection_directives_v1";
const USERS_KEY = "inspection_users_demo_v1";
const REPORTS_KEY = "weeklyReports";
const ALERTS_KEY = "inspection_report_alerts_v1";
const DRAFTS_KEY = "inspection_weekly_drafts_v1";

const ADMIN_ROLES = [
  "super_admin",
  "manager",
  "department_head"
];

const PAGE_IDS = [
  "zonesPage",
  "inspectorsPage",
  "approvalsPage",
  "supervisorReportsPage",
  "historyPage",
  "usersPage",
  "inspectorDashboardPage",
  "inspectorRequestPage",
  "weeklyReportsPage"
];

/* ================= قاعدة البيانات المشتركة (Firebase) ================= */

// كل مفتاح من هذه المفاتيح يحفظ كمستند في مجموعة system
const SHARED_KEYS = [
  DATA_KEY,
  USERS_KEY,
  DIRECTIVES_KEY,
  REPORTS_KEY,
  ALERTS_KEY
];

// المسودات تحفظ كمستند مستقل لكل مفتش وأسبوع في مجموعة drafts
const SYSTEM_COLLECTION = "system";
const DRAFTS_COLLECTION = "drafts";

// قائمة المستخدمين (الأسماء والصلاحيات فقط، بدون كلمات مرور) تُقرأ قبل الدخول
// لعرض الأسماء في شاشة الدخول. كلمات المرور تحفظها خدمة الدخول في Firebase.
const DIRECTORY_COLLECTION = "zones_directory";
const ACCOUNTS_COLLECTION = "zones_accounts";
const USER_PUBLIC_FIELDS = ["id", "name", "fullName", "role", "authUid", "loginEmail", "createdAt"];

function publicUsers(list) {
  return (Array.isArray(list) ? list : []).map(user =>
    Object.fromEntries(
      USER_PUBLIC_FIELDS
        .filter(key => user?.[key] != null)
        .map(key => [key, user[key]])
    )
  );
}

let cloudStore = null;
let zonesAuth = null;
const cloudCache = {};
let cloudErrorShown = false;

const clone = value => JSON.parse(JSON.stringify(value));

function reportCloudError(error) {
  console.error(error);

  if (cloudErrorShown) return;
  cloudErrorShown = true;

  alert(
    "تعذر حفظ البيانات في قاعدة البيانات. تأكدي من الاتصال بالإنترنت ثم أعيدي المحاولة."
  );

  setTimeout(() => { cloudErrorShown = false; }, 10000);
}

function draftDocId(key) {
  return encodeURIComponent(key);
}

function syncDrafts(value) {
  const before = cloudCache[DRAFTS_KEY] || {};
  const collection = cloudStore.collection(DRAFTS_COLLECTION);

  Object.keys(value).forEach(key => {
    const json = JSON.stringify(value[key]);

    if (JSON.stringify(before[key]) !== json) {
      collection
        .doc(draftDocId(key))
        .set({ key, value: json })
        .catch(reportCloudError);
    }
  });

  Object.keys(before).forEach(key => {
    if (!(key in value)) {
      collection
        .doc(draftDocId(key))
        .delete()
        .catch(reportCloudError);
    }
  });

  cloudCache[DRAFTS_KEY] = clone(value);
}

/* ================= التخزين ================= */

function readData(key, fallback) {
  if (SHARED_KEYS.includes(key) || key === DRAFTS_KEY) {
    return key in cloudCache ? clone(cloudCache[key]) : fallback;
  }

  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

function storeData(key, value) {
  if (key === DRAFTS_KEY) {
    syncDrafts(value);
    return true;
  }

  if (key === USERS_KEY) {
    const list = publicUsers(value);
    cloudCache[key] = list;

    cloudStore
      .collection(DIRECTORY_COLLECTION)
      .doc("users")
      .set({
        value: JSON.stringify(list),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      })
      .catch(reportCloudError);

    return true;
  }

  if (SHARED_KEYS.includes(key)) {
    cloudCache[key] = clone(value);

    cloudStore
      .collection(SYSTEM_COLLECTION)
      .doc(key)
      .set({
        value: JSON.stringify(value),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      })
      .catch(reportCloudError);

    return true;
  }

  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(error);
    alert("تعذر حفظ البيانات في المتصفح.");
    return false;
  }
}

let db;
let users;
let directives;
let reports;
let reportAlerts;
let weeklyDrafts;

function loadState() {
  db = readData(DATA_KEY, {
    inspectors: [],
    zones: [],
    history: [],
    replacementRequests: []
  });

  if (!db || typeof db !== "object") db = {};

  [
    "inspectors",
    "zones",
    "history",
    "replacementRequests",
    "generalNotes"
  ].forEach(key => {
    if (!Array.isArray(db[key])) db[key] = [];
  });

  ensureFieldSupervisors();

  users = readData(USERS_KEY, []);
  directives = readData(DIRECTIVES_KEY, []);

  if (!Array.isArray(directives)) directives = [];

  reports = readData(REPORTS_KEY, []);
  reportAlerts = readData(ALERTS_KEY, []);
  weeklyDrafts = readData(DRAFTS_KEY, {});

  if (!Array.isArray(users)) users = [];
  if (!Array.isArray(reports)) reports = [];
  if (!Array.isArray(reportAlerts)) reportAlerts = [];

  if (
    !weeklyDrafts ||
    typeof weeklyDrafts !== "object" ||
    Array.isArray(weeklyDrafts)
  ) {
    weeklyDrafts = {};
  }
}

let currentUser = null;
let selectedPortal = "admin";
let draftSaveTimer = null;

const save = () => storeData(DATA_KEY, db);
const saveUsers = () => storeData(USERS_KEY, users);
const saveDirectives = () =>
  storeData(DIRECTIVES_KEY, directives);
const saveReports = () => storeData(REPORTS_KEY, reports);
const saveAlerts = () => storeData(ALERTS_KEY, reportAlerts);
const saveDrafts = () => storeData(DRAFTS_KEY, weeklyDrafts);

/* ================= دوال مساعدة ================= */

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) +
      Math.random().toString(36).slice(2);
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function sameName(a, b) {
  return normalizeName(a).toLowerCase() ===
    normalizeName(b).toLowerCase();
}

function inspectorNameOf(item) {
  return typeof item === "string"
    ? item
    : item?.name || item?.fullName || "";
}

function getInspectorNames() {
  const names = db.inspectors
    .map(inspectorNameOf)
    .filter(Boolean);

  users
    .filter(user => user.role === "inspector")
    .forEach(user => {
      names.push(user.name || user.fullName || "");
    });

  return names
    .filter((name, index, array) =>
      name &&
      array.findIndex(n => sameName(n, name)) === index
    )
    .sort((a, b) => a.localeCompare(b, "ar"));
}

function isAdmin() {
  return !!currentUser &&
    ADMIN_ROLES.includes(currentUser.role);
}

function isSuperAdmin() {
  return currentUser?.role === "super_admin";
}

function isInspector() {
  return currentUser?.role === "inspector";
}

function requireAdmin() {
  if (isAdmin()) return true;
  alert("هذا الإجراء مخصص للإدارة.");
  return false;
}

function requireSuperAdmin() {
  if (isSuperAdmin()) return true;
  alert("هذا الإجراء مخصص للمسؤول الرئيسي.");
  return false;
}

function roleLabel(role) {
  return {
    super_admin: "المسؤول الرئيسي",
    manager: "مدير الإدارة",
    department_head: "رئيس القسم",
    inspector: "مفتش"
  }[role] || role || "";
}

function dateISO(value = new Date()) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
}

function formatDate(value) {
  if (!value) return "—";

  const d = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(String(value))
      ? value + "T12:00:00"
      : value
  );

  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleDateString("en-GB");
}

function formatDateTime(value) {
  if (!value) return "—";

  const d = new Date(value);

  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleString("ar-AE", {
        dateStyle: "medium",
        timeStyle: "short"
      });
}

function addDays(value, days) {
  const d = new Date(value);
  d.setDate(d.getDate() + days);
  return d;
}

function weekStart(value = new Date()) {
  const d = new Date(value);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function currentWeekKey() {
  return dateISO(weekStart());
}

function formatWeekRange(week = currentWeekKey()) {
  const monday = new Date(week + "T12:00:00");
  const thursday = addDays(monday, 3);

  return "من " + formatDate(dateISO(monday)) +
    " إلى " + formatDate(dateISO(thursday));
}

function el(tag, content = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = String(content ?? "");

  if (className) node.className = className;
  return node;
}

function button(label, action, className = "") {
  const node = el("button", label, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function clear(id) {
  const node = $(id);
  if (node) node.replaceChildren();
  return node;
}

function detail(parent, label, value) {
  const p = el("p");

  p.append(
    el("strong", label + ": "),
    document.createTextNode(String(value ?? "—"))
  );

  parent.appendChild(p);
}

function makeCard(title) {
  const card = el("div", "", "card");
  card.appendChild(el("h3", title));
  return card;
}

function fillSelect(id, values, placeholder = "اختاري") {
  const select = $(id);
  if (!select) return;

  const previous = select.value;
  select.replaceChildren();

  const first = el("option", placeholder);
  first.value = "";
  select.appendChild(first);

  values.forEach(value => {
    const option = el("option", value);
    option.value = value;
    select.appendChild(option);
  });

  if (values.includes(previous)) select.value = previous;
}

function logChange(zone, action, details = "") {
  db.history.unshift({
    id: uid(),
    date: new Date().toISOString(),
    user: currentUser?.name ||
      currentUser?.fullName || "النظام",
    zone: typeof zone === "string"
      ? zone
      : zone?.name || "",
    action,
    details
  });

  save();
}
/* ================= تسجيل الدخول ================= */

/* حسابات الدخول في Firebase بإيميلات داخلية لا يراها المستخدم */

function newLoginEmail() {
  return `z${uid().replace(/-/g, "").slice(0, 20)}@zones.${FIREBASE_CONFIG.authDomain}`;
}

function authErrorText(error) {
  return {
    "auth/invalid-credential": "اسم المستخدم أو كلمة المرور غير صحيحة.",
    "auth/invalid-login-credentials": "اسم المستخدم أو كلمة المرور غير صحيحة.",
    "auth/wrong-password": "اسم المستخدم أو كلمة المرور غير صحيحة.",
    "auth/user-not-found": "اسم المستخدم أو كلمة المرور غير صحيحة.",
    "auth/too-many-requests": "محاولات كثيرة. انتظري قليلاً ثم حاولي مرة أخرى.",
    "auth/network-request-failed": "تعذّر الاتصال بالإنترنت.",
    "auth/weak-password": "كلمة المرور ضعيفة.",
    "auth/requires-recent-login": "لتغيير كلمة مرورك سجّلي الخروج ثم الدخول مرة أخرى وأعيدي المحاولة."
  }[error?.code] || "حدث خطأ: " + (error?.message || error);
}

// تطبيق Firebase ثانوي لإنشاء حسابات الموظفين دون خروج المسؤول الحالي
let creatorAuth = null;

async function createLoginAccount(password) {
  if (!creatorAuth) {
    creatorAuth = firebase.initializeApp(FIREBASE_CONFIG, "zonesCreator").auth();
    await creatorAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);
  }

  const email = newLoginEmail();
  const cred = await creatorAuth.createUserWithEmailAndPassword(email, password);
  await creatorAuth.signOut();

  return { email, authUid: cred.user.uid };
}

// تعيين كلمة مرور للمستخدم: لنفسه تتغير مباشرة، ولغيره يُنشأ حساب دخول جديد
// (Firebase لا يسمح بتغيير كلمة مرور مستخدم آخر من المتصفح)
async function setLoginPassword(user, role, password) {
  if (user.authUid && user.authUid === zonesAuth.currentUser?.uid) {
    await zonesAuth.currentUser.updatePassword(password);
    return;
  }

  const account = await createLoginAccount(password);
  const batch = cloudStore.batch();

  if (user.authUid) {
    batch.delete(cloudStore.collection(ACCOUNTS_COLLECTION).doc(user.authUid));
  }

  batch.set(
    cloudStore.collection(ACCOUNTS_COLLECTION).doc(account.authUid),
    { userId: user.id, role }
  );

  await batch.commit();

  user.authUid = account.authUid;
  user.loginEmail = account.email;
}

let setupBusy = false;

async function setupFirstAdmin() {
  if (users.length) return false;

  const name = normalizeName(
    prompt("أدخلي الاسم الثلاثي للمسؤول الرئيسي:")
  );

  if (!name) return false;

  const password = prompt(
    "أنشئي كلمة مرور من 8 أحرف على الأقل:"
  );

  if (password === null) return false;

  if (password.length < 8) {
    alert("كلمة المرور يجب ألا تقل عن 8 أحرف.");
    return false;
  }

  setupBusy = true;
  let cred = null;

  try {
    const email = newLoginEmail();
    cred = await zonesAuth.createUserWithEmailAndPassword(email, password);

    const user = {
      id: uid(),
      name,
      fullName: name,
      role: "super_admin",
      authUid: cred.user.uid,
      loginEmail: email,
      createdAt: new Date().toISOString()
    };

    const batch = cloudStore.batch();

    batch.set(cloudStore.collection("zones_meta").doc("setup"), {
      by: user.id,
      at: new Date().toISOString()
    });
    batch.set(
      cloudStore.collection(ACCOUNTS_COLLECTION).doc(cred.user.uid),
      { userId: user.id, role: user.role }
    );
    batch.set(cloudStore.collection(DIRECTORY_COLLECTION).doc("users"), {
      value: JSON.stringify([user]),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    cloudCache[USERS_KEY] = [user];
    users = [user];

    setupBusy = false;
    alert("تم إنشاء حساب المسؤول الرئيسي.");
    await handleAuthState(cred.user);
    return true;
  } catch (error) {
    console.error(error);
    alert(authErrorText(error));
    if (cred) await cred.user.delete().catch(() => {});
    return false;
  } finally {
    setupBusy = false;
  }
}

async function openPortal(portal) {
  selectedPortal =
    portal === "inspector" ? "inspector" : "admin";

  $("entryPage")?.classList.add("hidden");
  $("systemMain")?.classList.add("hidden");
  $("loginPage")?.classList.remove("hidden");

  if ($("loginTitle")) {
    $("loginTitle").textContent =
      selectedPortal === "admin"
        ? "تسجيل دخول الإدارة"
        : "تسجيل دخول المفتشين";
  }

  $("loginForm")?.reset();
  $("loginError")?.classList.add("hidden");

  if (selectedPortal === "admin" && !users.length) {
    if (await setupFirstAdmin()) return;
  }

  fillLoginNames();
}

function fillLoginNames() {
  const select = $("loginName");
  if (!select) return;

  select.replaceChildren();

  const first = el("option", "اختاري اسم المستخدم");
  first.value = "";
  select.appendChild(first);

  users
    .filter(user =>
      selectedPortal === "admin"
        ? ADMIN_ROLES.includes(user.role)
        : user.role === "inspector"
    )
    .sort((a, b) =>
      inspectorNameOf(a).localeCompare(
        inspectorNameOf(b), "ar"
      )
    )
    .forEach(user => {
      const option = el(
        "option",
        user.name || user.fullName
      );

      option.value = String(user.id);
      select.appendChild(option);
    });
}

function backToEntry() {
  $("loginPage")?.classList.add("hidden");
  $("systemMain")?.classList.add("hidden");
  $("entryPage")?.classList.remove("hidden");
}

function showLoginError(message) {
  $("loginError").textContent = message;
  $("loginError").classList.remove("hidden");
}

async function handleLogin(event) {
  event.preventDefault();

  const id = $("loginName")?.value;
  const password = $("loginPassword")?.value;

  const user = users.find(
    u => String(u.id) === String(id)
  );

  if (!user) {
    showLoginError("اختاري اسم المستخدم.");
    return;
  }

  const allowed = selectedPortal === "admin"
    ? ADMIN_ROLES.includes(user.role)
    : user.role === "inspector";

  if (!allowed) {
    showLoginError("يرجى استخدام البوابة المناسبة.");
    return;
  }

  if (!user.loginEmail) {
    showLoginError("لم يتم تفعيل حساب الدخول لهذا المستخدم بعد. تواصلي مع المسؤول الرئيسي لتحديد كلمة مرور.");
    return;
  }

  const submit = event.target.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;

  try {
    // بعد نجاح الدخول تتولى handleAuthState فتح النظام
    await zonesAuth.signInWithEmailAndPassword(user.loginEmail, password);
    $("loginPassword").value = "";
  } catch (error) {
    showLoginError(authErrorText(error));
  } finally {
    if (submit) submit.disabled = false;
  }
}

function openUserSession(user) {
  currentUser = user;

  $("entryPage")?.classList.add("hidden");
  $("loginPage")?.classList.add("hidden");
  $("systemMain")?.classList.remove("hidden");

  $("supervisorNav")?.classList.toggle(
    "hidden", !isAdmin()
  );

  $("inspectorNav")?.classList.toggle(
    "hidden", !isInspector()
  );

  $("usersManagementNav")?.classList.toggle(
    "hidden", !isSuperAdmin()
  );

  // سجل التغييرات يظهر لمدير النظام الرئيسي فقط
  $("historyNav")?.classList.toggle(
    "hidden", !isSuperAdmin()
  );

  $("historyDeleteHeader")?.classList.toggle(
    "hidden", !isSuperAdmin()
  );

  if ($("currentUserName")) {
    $("currentUserName").textContent =
      user.name || user.fullName || "";
  }

  if ($("currentUserRole")) {
    $("currentUserRole").textContent =
      roleLabel(user.role);
  }

  showPage(
    isAdmin()
      ? "zonesPage"
      : "inspectorDashboardPage"
  );
}

function logoutPortal() {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }

  if (isInspector()) saveWeeklyDraft(false);

  // الخروج بعد إرسال آخر حفظ (مثل المسودة)، ثم handleAuthState تُغلق النظام
  cloudStore.waitForPendingWrites()
    .catch(() => {})
    .finally(() => zonesAuth.signOut());
}

function showPage(id) {
  if (!currentUser || !PAGE_IDS.includes(id)) return;

  if (
    isInspector() &&
    ![
      "inspectorDashboardPage",
      "weeklyReportsPage",
      "inspectorRequestPage"
    ].includes(id)
  ) {
    return;
  }

if (
    (id === "usersPage" || id === "historyPage") &&
    !isSuperAdmin()
) {
    return;
}


  PAGE_IDS.forEach(pageId => {
    $(pageId)?.classList.toggle(
      "hidden",
      pageId !== id
    );
  });

  renderAll();
}

/* ================= إدارة المفتشين ================= */

function addInspector() {
  if (!requireAdmin()) return;

  const name = normalizeName(
    $("newInspector")?.value
  );

  if (!name) {
    alert("أدخلي اسم المفتش.");
    return;
  }

  if (getInspectorNames().some(n => sameName(n, name))) {
    alert("اسم المفتش موجود مسبقاً.");
    return;
  }

  db.inspectors.push(name);

  if (!save()) {
    db.inspectors.pop();
    return;
  }

  $("newInspector").value = "";

  logChange("", "إضافة مفتش", name);
  renderAll();
}

function renameInspector(oldName) {
  if (!requireAdmin()) return;

  const answer = prompt("الاسم الجديد:", oldName);
  if (answer === null) return;

  const name = normalizeName(answer);
  if (!name) return;

  if (
    getInspectorNames().some(n =>
      !sameName(n, oldName) && sameName(n, name)
    )
  ) {
    alert("الاسم موجود مسبقاً.");
    return;
  }

  db.inspectors = db.inspectors.map(item => {
    if (!sameName(inspectorNameOf(item), oldName)) {
      return item;
    }

    return typeof item === "string"
      ? name
      : { ...item, name, fullName: name };
  });

  db.zones.forEach(zone => {
    [
      "inspector",
      "primaryInspector",
      "inspectorName"
    ].forEach(key => {
      if (sameName(zone[key], oldName)) {
        zone[key] = name;
      }
    });

    (zone.assignments || []).forEach(a => {
      [
        "inspector",
        "replacement",
        "replacementInspector",
        "acknowledgedBy"
      ].forEach(key => {
        if (sameName(a[key], oldName)) {
          a[key] = name;
        }
      });
    });
  });

  db.replacementRequests.forEach(request => {
    ["inspector", "owner", "replacement"].forEach(key => {
      if (sameName(request[key], oldName)) {
        request[key] = name;
      }
    });
  });

  users.forEach(user => {
    if (
      user.role === "inspector" &&
      sameName(user.name || user.fullName, oldName)
    ) {
      user.name = name;
      if (user.fullName) user.fullName = name;
    }
  });

  reports.forEach(report => {
    if (sameName(getReportInspectorName(report), oldName)) {
      report.inspector = name;
      report.inspectorName = name;
    }
  });

  reportAlerts.forEach(reminder => {
    if (Array.isArray(reminder.inspectors)) {
      reminder.inspectors = reminder.inspectors.map(n =>
        sameName(n, oldName) ? name : n
      );
    }
  });
    Object.keys(weeklyDrafts).forEach(key => {
    const draft = weeklyDrafts[key];

    if (sameName(draft?.inspector, oldName)) {
      draft.inspector = name;

      const newKey = getDraftKey(name, draft.weekStart);

      weeklyDrafts[newKey] = draft;

      if (newKey !== key) delete weeklyDrafts[key];
    }
  });

  /* تحديث اسم المفتش في التوجيهات */

  directives.forEach(directive => {
    if (sameName(directive.inspector, oldName)) {
      directive.inspector = name;
    }

    if (sameName(directive.acknowledgedBy, oldName)) {
      directive.acknowledgedBy = name;
    }

    if (sameName(directive.completedBy, oldName)) {
      directive.completedBy = name;
    }
  });

  save();
  saveUsers();
  saveReports();
  saveAlerts();
  saveDrafts();
  saveDirectives();

  logChange("", "تعديل اسم مفتش", `${oldName} ← ${name}`);
  renderAll();
}

function deleteInspector(name) {
  if (!requireAdmin()) return;

  const ownZones = db.zones.filter(zone =>
    sameName(zoneInspector(zone), name)
  );

  if (ownZones.length) {
    alert(
      `لا يمكن حذف المفتش لأنه المفتش الأساسي في: ${
        ownZones.map(zone => zone.name).join("، ")
      }.\nغيّري المفتش الأساسي لهذه النطاقات من صفحة النطاقات أولاً.`
    );
    return;
  }

  // حساب الدخول يحذف مع المفتش في نفس الخطوة
  const accounts = users.filter(user =>
    user.role === "inspector" &&
    sameName(user.name || user.fullName, name)
  );

  if (accounts.length && !isSuperAdmin()) {
    alert("لهذا المفتش حساب دخول، وحذفه يحتاج إلى المسؤول الرئيسي.");
    return;
  }

  if (
    !confirm(
      `هل تريدين حذف المفتش ${name}؟` +
      (accounts.length ? "\nسيتم حذف حساب الدخول الخاص به أيضاً." : "")
    )
  ) {
    return;
  }

  db.inspectors = db.inspectors.filter(item =>
    !sameName(inspectorNameOf(item), name)
  );

  if (accounts.length) {
    users = users.filter(user => !accounts.includes(user));
    saveUsers();
    accounts.forEach(removeLoginAccount);
  }

  save();
  logChange("", "حذف مفتش", name);
  renderAll();
}

function renderInspectors() {
  const container = clear("inspectorsList");
  if (!container) return;

  const names = getInspectorNames();

  if (!names.length) {
    container.appendChild(
      el("p", "لا يوجد مفتشون مسجلون.")
    );
    return;
  }

  names.forEach(name => {
    const card = makeCard(name);
    const actions = el("div", "", "actions");

    const inspectorDirectives = directives.filter(
      directive => sameName(directive.inspector, name)
    );

    const pendingCount = inspectorDirectives.filter(
      directive => !directive.completedAt &&
        directive.status !== "completed"
    ).length;

    const overdueCount = inspectorDirectives.filter(
      directive =>
        !directive.completedAt &&
        directive.status !== "completed" &&
        directive.dueDate &&
        new Date(directive.dueDate).getTime() < Date.now()
    ).length;

    const signalCount = color => inspectorDirectives.filter(
      directive => directiveAdminSignal(directive)?.color === color
    ).length;

    const acknowledgedCount = signalCount("#ea580c");
    const newRepliesCount = signalCount("#2563eb");

    if (pendingCount) {
      detail(card, "التوجيهات غير المنجزة", pendingCount);
    }

    if (overdueCount) {
      const warning = el(
        "p",
        `تنبيه: يوجد ${overdueCount} توجيه متأخر`
      );

      warning.style.color = "#b42318";
      warning.style.fontWeight = "bold";

      card.appendChild(warning);
    }

    [
      [acknowledgedCount, "#ea580c", `● ${acknowledgedCount} توجيه أقر المفتش باستلامه`],
      [newRepliesCount, "#2563eb", `● يوجد ${newRepliesCount} رد جديد على التوجيهات`]
    ].forEach(([count, color, text]) => {
      if (!count) return;

      const notification = el("p", text, "directive-notification");

      notification.style.color = color;
      notification.style.fontWeight = "bold";

      card.appendChild(notification);
    });

    actions.append(
      button(
        "إرسال توجيه",
        () => openDirective(name)
      ),
      button(
        "عرض التوجيهات",
        () => showInspectorDirectives(name),
        "secondary"
      ),
      button(
        "تعديل الاسم",
        () => renameInspector(name),
        "secondary"
      ),
      button(
        "حذف",
        () => deleteInspector(name),
        "danger"
      )
    );

    card.appendChild(actions);
    container.appendChild(card);
  });
}

/* ================= فتح نافذة التوجيهات ================= */

function openDirective(inspectorName) {
  if (!requireAdmin()) return;

  const dialog = $("directiveDialog");

  if (
    !dialog ||
    !$("directiveInspector") ||
    !$("directiveInspectorName") ||
    !$("directiveText") ||
    !$("directiveDueDate")
  ) {
    alert("نافذة التوجيهات غير موجودة في صفحة HTML.");
    return;
  }

  $("directiveInspector").value = inspectorName;
  $("directiveInspectorName").value = inspectorName;
  $("directiveText").value = "";
  $("directiveDueDate").value = "";

  dialog.showModal();
}

/* ================= حفظ التوجيهات ================= */

function saveDirective(event) {
  event.preventDefault();

  if (!requireAdmin()) return;

  const inspector = normalizeName(
    $("directiveInspector")?.value
  );

  const text = $("directiveText")?.value.trim() || "";
  const dueDate = $("directiveDueDate")?.value || "";

  if (!inspector || !text || !dueDate) {
    alert("يرجى إدخال نص التوجيه وتاريخ ووقت الإنجاز.");
    return;
  }

  if (new Date(dueDate).getTime() <= Date.now()) {
    alert("يجب أن يكون موعد الإنجاز في المستقبل.");
    return;
  }

  const directive = {
    id: uid(),
    inspector,
    text,
    dueDate,
    createdAt: new Date().toISOString(),
    createdBy: getCurrentInspectorName(),
    status: "pending",
    acknowledgedAt: null,
    acknowledgedBy: "",
    adminViewedAcknowledgmentAt: null,
    completedAt: null,
    completedBy: "",
    reply: "",
    deliveryMethod: ""
  };

  directives.unshift(directive);

  if (!saveDirectives()) {
    directives.shift();
    return;
  }

  $("directiveDialog")?.close();

  renderAll();

  alert("تم حفظ التوجيه بنجاح.");
}

/* ================= حالات التوجيهات ================= */
function directiveStatusLabel(directive) {
  if (directive.status === "completed") {
    return "منجز";
  }

  if (
    directive.dueDate &&
    new Date(directive.dueDate).getTime() < Date.now()
  ) {
    return "متأخر عن الموعد";
  }

  if (directive.acknowledgedAt) {
    return "تم الاستلام - قيد الإنجاز";
  }

  return "بانتظار إقرار الاستلام";
}

function getInspectorDirectives(name) {
  return directives.filter(
    directive => sameName(directive.inspector, name)
  );
}

/* ================= ألوان متابعة التوجيهات للإدارة ================= */

// برتقالي: أقر المفتش بالاستلام ولم يرد بعد
// أزرق: رد جديد من المفتش لم تطلع عليه الإدارة
function directiveAdminSignal(directive) {
  if (directive.completedAt) {
    return directive.adminViewedCompletionAt
      ? null
      : { color: "#2563eb", text: "● رد جديد من المفتش" };
  }

  if (directive.acknowledgedAt) {
    return { color: "#ea580c", text: "● أقر المفتش بالاستلام" };
  }

  return null;
}

function applyDirectiveSignal(card, directive) {
  const signal = directiveAdminSignal(directive);
  if (!signal) return null;

  const notice = el("p", signal.text, "directive-admin-notice");

  notice.style.color = signal.color;
  notice.style.borderColor = signal.color;
  notice.style.background = signal.color + "14";
  notice.style.fontWeight = "bold";

  card.style.borderInlineStart = `5px solid ${signal.color}`;
  card.appendChild(notice);

  return signal;
}

/* ================= عرض توجيهات مفتش للإدارة ================= */

function showInspectorDirectives(name) {
  if (!requireAdmin()) return;

  const list = getInspectorDirectives(name);

  let dialog = $("inspectorDirectivesDialog");

  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "inspectorDirectivesDialog";
    dialog.style.width = "min(700px, 95vw)";
    dialog.style.maxHeight = "85vh";
    dialog.style.overflowY = "auto";
    dialog.style.borderRadius = "14px";
    dialog.style.border = "1px solid #d9e2dc";
    dialog.style.padding = "24px";

    document.body.appendChild(dialog);
  }

  dialog.replaceChildren();

  // لإعادة رسم النافذة تلقائياً عند وصول تحديث من المفتش
  dialog.dataset.inspector = name;

  dialog.appendChild(
    el("h2", `سجل التوجيهات - ${name}`)
  );

  if (!list.length) {
    dialog.appendChild(
      el("p", "لا توجد توجيهات مسجلة لهذا المفتش.")
    );
  }

  list.forEach(directive => {
    const card = makeCard("توجيه");

    detail(card, "التوجيه", directive.text);
    detail(
      card,
      "تاريخ الإرسال",
      formatDateTime(directive.createdAt)
    );
    detail(
      card,
      "موعد الإنجاز",
      formatDateTime(directive.dueDate)
    );
    detail(
      card,
      "الحالة",
      directiveStatusLabel(directive)
    );

    if (directive.acknowledgedAt) {
      detail(
        card,
        "تاريخ ووقت الاستلام",
        formatDateTime(directive.acknowledgedAt)
      );
    }

    if (directive.completedAt) {
      detail(
        card,
        "تاريخ ووقت الإنجاز",
        formatDateTime(directive.completedAt)
      );
      detail(
        card,
        "رد المفتش",
        directive.reply || "—"
      );
      detail(
        card,
        "طريقة تسليم الرد",
        directive.deliveryMethod || "—"
      );
    }

    applyDirectiveSignal(card, directive);

    const actions = el("div", "", "actions");

    actions.appendChild(
      button(
        "حذف التوجيه",
        () => deleteDirective(directive.id),
        "danger"
      )
    );

    card.appendChild(actions);

    dialog.appendChild(card);
  });

  const closeButton = button(
    "إغلاق",
    () => dialog.close(),
    "secondary"
  );

  closeButton.style.marginTop = "15px";
  dialog.appendChild(closeButton);

  if (!dialog.open) {
    dialog.showModal();
  }
}

/* ================= إدارة النطاقات ================= */

function zoneId(zone) {
  return String(zone.id || zone.zoneId || "");
}

function findZone(id) {
  return db.zones.find(
    zone => zoneId(zone) === String(id)
  );
}

function zoneInspector(zone) {
  return zone.inspector ||
    zone.primaryInspector ||
    zone.inspectorName ||
    "";
}

function zoneAreasText(zone) {
  const areas = zone.areas || zone.areaNames || [];

  return Array.isArray(areas)
    ? areas.join("\n")
    : String(areas);
}

/* التكليف لا يصبح نشطاً إلا بعد اعتماده
   وبدء فترته، وينتهي تلقائياً بالتاريخ. */

function getActiveAssignment(zone) {
  const today = dateISO();

  return [...(zone.assignments || [])]
    .reverse()
    .find(a => {
      const start = a.startDate || a.start || "";
      const end = a.endDate || a.end || "";

      const approved =
        a.status === "approved" ||
        a.status === "active" ||
        a.status == null;

      return approved &&
        (!start || start <= today) &&
        (!end || end >= today);
    }) || null;
}

function getActiveZoneInspector(zone) {
  const assignment = getActiveAssignment(zone);

  return assignment?.replacement ||
    assignment?.replacementInspector ||
    assignment?.inspector ||
    zoneInspector(zone);
}

function getCurrentInspectorName() {
  return currentUser?.name ||
    currentUser?.fullName ||
    "";
}
function openZone(id = null) {
  if (!requireAdmin()) return;

  const zone = id ? findZone(id) : null;

  fillSelect(
    "zoneInspector",
    getInspectorNames(),
    "اختاري المفتش الأساسي"
  );

  $("zoneId").value = zone ? zoneId(zone) : "";
  $("zoneName").value = zone?.name || "";
  $("zoneInspector").value =
    zone ? zoneInspector(zone) : "";

  const areas = zone?.areas || zone?.areaNames || [];

  $("zoneAreas").value = Array.isArray(areas)
    ? areas.join("\n")
    : String(areas);

  $("zoneTitle").textContent =
    zone ? "تعديل نطاق" : "إضافة نطاق";

  $("zoneDialog").showModal();
}

function saveZone(event) {
  event.preventDefault();
  if (!requireAdmin()) return;

  const id = $("zoneId").value;
  const name = normalizeName($("zoneName").value);
  const inspector = $("zoneInspector").value;

  const areas = $("zoneAreas").value
    .split(/\n|،|,/)
    .map(value => value.trim())
    .filter(Boolean);

  if (!name || !inspector) {
    alert("أدخلي اسم النطاق والمفتش.");
    return;
  }

  let zone = id ? findZone(id) : null;

  if (zone) {
    zone.name = name;
    zone.inspector = inspector;
    zone.primaryInspector = inspector;
    zone.areas = areas;
  } else {
    zone = {
      id: uid(),
      name,
      inspector,
      primaryInspector: inspector,
      areas,
      assignments: []
    };

    db.zones.push(zone);
  }

  if (!save()) return;

  logChange(
    zone,
    id ? "تعديل نطاق" : "إضافة نطاق",
    name
  );

  $("zoneDialog").close();
  renderAll();
}

function deleteZone(id) {
  if (!requireAdmin()) return;

  const zone = findZone(id);

  if (!zone || !confirm(`حذف نطاق ${zone.name}؟`)) {
    return;
  }

  db.zones = db.zones.filter(
    item => zoneId(item) !== String(id)
  );

  if (!save()) return;

  logChange(zone, "حذف نطاق", zone.name);
  renderAll();
}

/* ================= بطاقات النطاقات ================= */

function createZoneCard(zone, inspectorView = false) {
  const card = el("div", "", "zone-card");

  const primary = zoneInspector(zone);
  const assignment = getActiveAssignment(zone);
  const active = getActiveZoneInspector(zone);

  const name = getCurrentInspectorName();

  const isPrimary =
    inspectorView &&
    sameName(primary, name);

  const isAdditional =
    inspectorView &&
    !!assignment &&
    sameName(active, name) &&
    !sameName(primary, name);

  if (isPrimary) {
    card.classList.add("my-zone");
    card.style.borderColor = "#39845b";
    card.style.borderWidth = "2px";
    card.style.borderStyle = "solid";
    card.style.background = "#f0f8f2";
  }

  if (isAdditional) {
    card.classList.add("assigned-zone");
    card.style.borderColor = "#8654b8";
    card.style.borderWidth = "2px";
    card.style.borderStyle = "solid";
    card.style.background = "#f6efff";
  }

  card.appendChild(
    el("h3", zone.name || "نطاق", "zone-card-title")
  );

  const info = el("div", "", "zone-card-info");

  detail(info, "المفتش الأساسي", primary);

  if (inspectorView) {
    detail(info, "المفتش المكلف حالياً", active);
  }

  detail(
    info,
    "المناطق",
    zoneAreasText(zone) || "غير محددة"
  );

  card.appendChild(info);

  let status;

  if (inspectorView) {
    status = isAdditional
      ? "تكليف إضافي مؤقت"
      : "نطاقك الأساسي";
  } else {
    status =
      assignment && !sameName(active, primary)
        ? "الحالة: مفتش بديل مكلف"
        : "الحالة: المفتش الأساسي";
  }

  const statusNode = el(
    "div",
    status,
    "zone-status"
  );

  if (isAdditional) {
    statusNode.style.color = "#7039a7";
    statusNode.style.fontWeight = "bold";
  }

  if (isPrimary) {
    statusNode.style.color = "#26754a";
    statusNode.style.fontWeight = "bold";
  }

  card.appendChild(statusNode);

  if (assignment && !sameName(active, primary)) {
    if (!inspectorView) {
      card.appendChild(
        el(
          "div",
          "المفتش البديل: " + active,
          "zone-replacement"
        )
      );
    }

    detail(
      card,
      "فترة التكليف",
      formatDate(assignment.startDate || assignment.start) +
      " إلى " +
      formatDate(assignment.endDate || assignment.end)
    );

    if (assignment.acknowledgedAt) {
      detail(card, "حالة الاستلام", "تم الاستلام");

      detail(
        card,
        "تاريخ ووقت الاستلام",
        formatDateTime(assignment.acknowledgedAt)
      );

      detail(
        card,
        "المفتش المستلم",
        assignment.acknowledgedBy || active
      );
    } else {
      detail(
        card,
        "حالة الاستلام",
        "بانتظار الاستلام"
      );

      if (isAdditional) {
        const acknowledgeButton = button(
          "اطلعت على التكليف وأقرّ بالاستلام",
          () => acknowledgeAssignment(
            zoneId(zone),
            assignment.id
          ),
          "acknowledge-btn"
        );

        acknowledgeButton.style.background = "#7642aa";
        acknowledgeButton.style.color = "#fff";

        card.appendChild(acknowledgeButton);
      }
    }
  }

  if (!inspectorView) {
    const actions = el(
      "div",
      "",
      "zone-card-actions"
    );

    actions.append(
      button(
        "تعديل",
        () => openZone(zoneId(zone)),
        "zone-edit-btn"
      ),
      button(
        "إدارة التكليف",
        () => openAssignment(zoneId(zone)),
        "zone-assignment-btn"
      ),
      button(
        "حذف",
        () => deleteZone(zoneId(zone)),
        "zone-delete-btn"
      )
    );

    card.appendChild(actions);
  }

  return card;
}

/* ================= إقرار استلام التكليف ================= */

function acknowledgeAssignment(zoneIdValue, assignmentId) {
  if (!isInspector()) {
    alert("هذا الإجراء مخصص للمفتش المكلف.");
    return;
  }

  const zone = findZone(zoneIdValue);
  if (!zone) return;

  const assignment = getActiveAssignment(zone);

  if (
    !assignment ||
    String(assignment.id) !== String(assignmentId) ||
    !sameName(
      getActiveZoneInspector(zone),
      getCurrentInspectorName()
    ) ||
    sameName(
      zoneInspector(zone),
      getCurrentInspectorName()
    )
  ) {
    alert("هذا التكليف غير متاح للاستلام حالياً.");
    return;
  }

  if (assignment.acknowledgedAt) {
    alert("سبق إقرارك باستلام هذا التكليف.");
    return;
  }

  if (
    !confirm("هل تؤكد اطلاعك على التكليف واستلامه؟")
  ) {
    return;
  }

  assignment.acknowledgedAt =
    new Date().toISOString();

  assignment.acknowledgedBy =
    getCurrentInspectorName();

  if (!save()) {
    delete assignment.acknowledgedAt;
    delete assignment.acknowledgedBy;
    return;
  }

  logChange(
    zone,
    "إقرار باستلام التكليف",
    assignment.acknowledgedBy +
      " - " +
      assignment.acknowledgedAt
  );

  renderAll();

  alert("تم تسجيل إقرارك باستلام التكليف بنجاح.");
}

/* ================= عرض نطاقات الإدارة ================= */

function renderZones() {
  const container = clear("zones");
  if (!container) return;

  const search = normalizeName(
    $("search")?.value
  ).toLowerCase();

  const filtered = db.zones.filter(zone =>
    [
      zone.name,
      zoneInspector(zone),
      getActiveZoneInspector(zone),
      zoneAreasText(zone)
    ].join(" ").toLowerCase().includes(search)
  );

  if (!filtered.length) {
    container.appendChild(
      el("p", "لا توجد نطاقات مطابقة.")
    );
    return;
  }

  // تظليل نطاقات مسؤول النطاق الميداني المختار
  const supervisor = activeFieldSupervisorId
    ? findFieldSupervisor(activeFieldSupervisorId)
    : null;

  // بدون اختيار: تظليل النطاقات التي يشرف عليها المستخدم الحالي
  const mine = mySupervisedZoneIds();

  filtered.forEach(zone => {
    const card = createZoneCard(zone);

    if (supervisor) {
      card.classList.add(
        supervisor.zoneIds.includes(zoneId(zone))
          ? "zone-highlight"
          : "zone-dimmed"
      );
    } else if (mine.has(zoneId(zone))) {
      card.classList.add("zone-highlight");
    }

    addFieldSupervisorTag(card, zone);
    container.appendChild(card);
  });
}

/* ================= تنبيهات انتهاء التكليف ================= */

function renderAlerts() {
  const container = clear("alerts");
  if (!container) return;

  db.zones.forEach(zone => {
    const assignment = getActiveAssignment(zone);
    const end = assignment?.endDate || assignment?.end;

    if (!end) return;

    const remaining = Math.round(
      (
        new Date(end + "T12:00:00") -
        new Date(dateISO() + "T12:00:00")
      ) / 86400000
    );

    if (remaining >= 0 && remaining <= 3) {
      container.appendChild(
        el(
          "p",
          `تنبيه: تكليف نطاق ${zone.name} ينتهي خلال ${remaining} يوم.`
        )
      );
    }
  });
}

/* ================= الملاحظات العامة ================= */

// الإدارة تكتب الملاحظات، والجميع يشاهدها
function renderGeneralNotes(containerId) {
  const box = $(containerId);
  if (!box) return;

  if (!Array.isArray(db.generalNotes)) db.generalNotes = [];

  const canEdit = isAdmin();

  // الحفاظ على ما يكتب حالياً عند وصول تحديث من مستخدم آخر
  const draft = box.querySelector("textarea")?.value || "";

  box.replaceChildren(el("h2", "الملاحظات العامة"));

  if (canEdit) {
    const textarea = el("textarea");
    textarea.rows = 3;
    textarea.placeholder = "اكتبي ملاحظة تظهر لجميع المفتشين والإدارة...";
    textarea.value = draft;

    box.append(
      textarea,
      button("نشر الملاحظة", () => addGeneralNote(textarea.value))
    );
  }

  if (!db.generalNotes.length) {
    box.appendChild(el("p", "لا توجد ملاحظات حالياً."));
    return;
  }

  [...db.generalNotes]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .forEach(note => {
      const item = el("div", "", "general-note");

      item.append(
        el("p", note.text, "general-note-text"),
        el(
          "small",
          `${note.author || "الإدارة"} - ${formatDateTime(note.createdAt)}`
        )
      );

      if (canEdit) {
        item.appendChild(
          button("حذف", () => deleteGeneralNote(note.id), "danger")
        );
      }

      box.appendChild(item);
    });
}

function addGeneralNote(text) {
  if (!requireAdmin()) return;

  const value = String(text || "").trim();

  if (!value) {
    alert("يرجى كتابة الملاحظة.");
    return;
  }

  db.generalNotes.push({
    id: uid(),
    text: value,
    author: getCurrentInspectorName(),
    createdAt: new Date().toISOString()
  });

  save();

  // تفريغ خانة الكتابة بعد النشر
  const textarea = $("adminGeneralNotes")?.querySelector("textarea");
  if (textarea) textarea.value = "";

  renderAll();
}

function deleteGeneralNote(id) {
  if (!requireAdmin()) return;

  if (!confirm("هل تريدين حذف هذه الملاحظة؟")) return;

  db.generalNotes = db.generalNotes.filter(note => note.id !== id);
  save();
  renderAll();
}

/* ================= مسؤولو النطاقات الميدانية ================= */

const FIELD_SUPERVISOR_TITLES = [
  "مسؤول نطاق ميداني 1",
  "مسؤول نطاق ميداني 2"
];

let activeFieldSupervisorId = null;

// المسؤولان الافتراضيان يضافان مرة واحدة فقط، ويمكن حذفهما بعد ذلك
function ensureFieldSupervisors() {
  if (Array.isArray(db.fieldSupervisors)) return;

  db.fieldSupervisors = FIELD_SUPERVISOR_TITLES.map((title, index) => ({
    id: "fs" + (index + 1),
    title,
    person: "",
    zoneIds: [],
    temp: null
  }));
}

function addFieldSupervisor() {
  if (!requireAdmin()) return;

  let number = db.fieldSupervisors.length + 1;

  while (
    db.fieldSupervisors.some(item =>
      item.title === "مسؤول نطاق ميداني " + number
    )
  ) {
    number++;
  }

  const supervisor = {
    id: uid(),
    title: "مسؤول نطاق ميداني " + number,
    person: "",
    zoneIds: [],
    temp: null
  };

  db.fieldSupervisors.push(supervisor);
  save();
  logChange("", "إضافة " + supervisor.title);

  renderAll();
  openFieldSupervisor(supervisor.id);
}

function deleteFieldSupervisor(id) {
  if (!requireAdmin()) return;

  const supervisor = findFieldSupervisor(id);
  if (!supervisor) return;

  if (!confirm(`هل تريدين حذف ${supervisor.title}؟`)) return;

  db.fieldSupervisors = db.fieldSupervisors.filter(item => item !== supervisor);

  if (activeFieldSupervisorId === id) activeFieldSupervisorId = null;

  save();
  logChange("", "حذف " + supervisor.title, supervisor.person);
  renderAll();
}

function findFieldSupervisor(id) {
  return db.fieldSupervisors.find(item => item.id === id);
}

// التكليف المؤقت فعال فقط خلال فترته
function activeFieldSupervisorTemp(supervisor) {
  const temp = supervisor.temp;
  const today = dateISO();

  return temp?.person &&
    (!temp.start || temp.start <= today) &&
    (!temp.end || temp.end >= today)
    ? temp
    : null;
}

// الشخص المسؤول فعلياً الآن: المكلف خلال فترة التكليف، وإلا الأساسي
function fieldSupervisorPerson(supervisor) {
  return activeFieldSupervisorTemp(supervisor)?.person ||
    supervisor.person ||
    "";
}

// النطاقات التي يشرف عليها المستخدم الحالي ميدانياً
function mySupervisedZoneIds() {
  const name = getCurrentInspectorName();
  const ids = new Set();

  if (!name) return ids;

  db.fieldSupervisors.forEach(supervisor => {
    if (sameName(fieldSupervisorPerson(supervisor), name)) {
      supervisor.zoneIds.forEach(id => ids.add(id));
    }
  });

  return ids;
}

function zoneFieldSupervisors(zone) {
  return db.fieldSupervisors.filter(supervisor =>
    supervisor.zoneIds.includes(zoneId(zone)) &&
    fieldSupervisorPerson(supervisor)
  );
}

function addFieldSupervisorTag(card, zone) {
  const names = zoneFieldSupervisors(zone)
    .map(fieldSupervisorPerson)
    .filter((name, index, array) =>
      array.findIndex(n => sameName(n, name)) === index
    );

  if (!names.length) return;

  card.appendChild(
    el("p", "المسؤول الميداني: " + names.join("، "), "field-supervisor-tag")
  );
}

// المسؤولون الميدانيون المباشرون للمفتش بحسب النطاقات المكلف بها حالياً
function renderInspectorFieldSupervisor() {
  const box = clear("inspectorFieldSupervisor");
  if (!box) return;

  const name = getCurrentInspectorName();

  const myZones = db.zones.filter(zone =>
    sameName(getActiveZoneInspector(zone), name) ||
    sameName(zoneInspector(zone), name)
  );

  const supervisors = [];

  myZones.forEach(zone => {
    zoneFieldSupervisors(zone).forEach(supervisor => {
      const person = fieldSupervisorPerson(supervisor);

      if (
        !sameName(person, name) &&
        !supervisors.some(item => sameName(item.person, person))
      ) {
        supervisors.push({ person, title: supervisor.title });
      }
    });
  });

  box.hidden = !supervisors.length;
  if (!supervisors.length) return;

  box.appendChild(el("h3", "مسؤولك الميداني المباشر"));

  supervisors.forEach(item => {
    detail(box, item.title, item.person);
  });
}

function toggleFieldSupervisor(id) {
  activeFieldSupervisorId =
    activeFieldSupervisorId === id ? null : id;

  renderFieldSupervisors();
  renderZones();
}

function renderFieldSupervisors() {
  const container = clear("fieldSupervisors");
  if (!container) return;

  // قد تفتقد البيانات المستعادة من نسخة احتياطية قديمة هذا القسم
  ensureFieldSupervisors();

  db.fieldSupervisors.forEach(supervisor => {
    const card = el("div", "", "field-supervisor-card");

    const toggle = button(
      supervisor.title,
      () => toggleFieldSupervisor(supervisor.id),
      "field-supervisor-toggle"
    );

    if (activeFieldSupervisorId === supervisor.id) {
      card.classList.add("active");
    }

    card.appendChild(toggle);

    const temp = activeFieldSupervisorTemp(supervisor);

    if (temp) {
      detail(card, "المكلف حالياً", temp.person);
      detail(
        card,
        "فترة التكليف",
        `${formatDate(temp.start)} - ${formatDate(temp.end)}`
      );
      detail(card, "المسؤول الأساسي", supervisor.person || "—");
    } else {
      detail(card, "المسؤول", supervisor.person || "لم يحدد بعد");
    }

    const zoneCount = supervisor.zoneIds.filter(findZone).length;
    detail(card, "عدد النطاقات", zoneCount);

    const actions = el("div", "", "actions");

    actions.append(
      button(
        "تعديل المسؤول والنطاقات",
        () => openFieldSupervisor(supervisor.id),
        "secondary"
      ),
      button(
        "حذف",
        () => deleteFieldSupervisor(supervisor.id),
        "danger"
      )
    );

    card.appendChild(actions);
    container.appendChild(card);
  });

  const addButton = button(
    "+ إضافة مسؤول ميداني",
    addFieldSupervisor,
    "secondary add-field-supervisor"
  );

  container.appendChild(addButton);
}

function openFieldSupervisor(id) {
  if (!requireAdmin()) return;

  const supervisor = findFieldSupervisor(id);
  if (!supervisor) return;

  $("fieldSupervisorId").value = id;
  $("fieldSupervisorTitle").textContent = supervisor.title;
  $("fieldSupervisorName").value = supervisor.title;
  $("fieldSupervisorPerson").value = supervisor.person || "";

  const datalist = clear("peopleNames");

  [
    ...getInspectorNames(),
    ...users.map(user => user.name || user.fullName || "")
  ]
    .filter((name, index, array) =>
      name && array.findIndex(n => sameName(n, name)) === index
    )
    .forEach(name => {
      const option = el("option");
      option.value = name;
      datalist.appendChild(option);
    });

  const zonesBox = clear("fieldSupervisorZones");

  if (!db.zones.length) {
    zonesBox.appendChild(el("p", "لا توجد نطاقات مسجلة بعد."));
  }

  db.zones.forEach(zone => {
    const label = el("label", "", "zone-checkbox");
    const checkbox = el("input");

    checkbox.type = "checkbox";
    checkbox.value = zoneId(zone);
    checkbox.checked = supervisor.zoneIds.includes(zoneId(zone));

    const other = db.fieldSupervisors.find(item =>
      item.id !== id && item.zoneIds.includes(zoneId(zone))
    );

    label.append(
      checkbox,
      document.createTextNode(
        " " + zone.name + (other ? ` (تابع أيضاً لـ ${other.title})` : "")
      )
    );

    zonesBox.appendChild(label);
  });

  $("fieldSupervisorTempPerson").value = supervisor.temp?.person || "";
  $("fieldSupervisorTempStart").value = supervisor.temp?.start || "";
  $("fieldSupervisorTempEnd").value = supervisor.temp?.end || "";

  $("fieldSupervisorDialog").showModal();
}

function saveFieldSupervisor(event) {
  event.preventDefault();
  if (!requireAdmin()) return;

  const supervisor = findFieldSupervisor($("fieldSupervisorId").value);
  if (!supervisor) return;

  const person = normalizeName($("fieldSupervisorPerson").value);
  const tempPerson = normalizeName($("fieldSupervisorTempPerson").value);
  const start = $("fieldSupervisorTempStart").value;
  const end = $("fieldSupervisorTempEnd").value;

  if (tempPerson && (!start || !end || end < start)) {
    alert("يرجى إدخال فترة تكليف صحيحة للشخص المكلف.");
    return;
  }

  const title = normalizeName($("fieldSupervisorName").value);

  if (!title) {
    alert("يرجى إدخال اسم الزر.");
    return;
  }

  const oldPerson = supervisor.person;

  supervisor.title = title;
  supervisor.person = person;
  supervisor.zoneIds = [
    ...document.querySelectorAll("#fieldSupervisorZones input:checked")
  ].map(input => input.value);
  supervisor.temp = tempPerson
    ? { person: tempPerson, start, end }
    : null;

  save();

  logChange(
    "",
    "تعديل " + supervisor.title,
    [
      !sameName(oldPerson, person) && `المسؤول: ${person || "—"}`,
      tempPerson && `تكليف ${tempPerson} من ${formatDate(start)} إلى ${formatDate(end)}`
    ].filter(Boolean).join(" | ")
  );

  $("fieldSupervisorDialog").close();
  renderAll();
}

/* ================= إدارة التكليفات ================= */

function openAssignment(id) {
  if (!requireAdmin()) return;

  const zone = findZone(id);
  if (!zone) return;

  $("assignmentZoneId").value = id;

  fillSelect(
    "replacementInspector",
    getInspectorNames().filter(name =>
      !sameName(name, zoneInspector(zone))
    ),
    "اختاري المفتش البديل"
  );

  $("assignmentAction").value = "replace";
  $("startDate").value = dateISO();
  $("endDate").value = "";
  $("assignmentNotes").value = "";

  toggleAssignmentFields();
  $("assignmentDialog").showModal();
}

function toggleAssignmentFields() {
  const action = $("assignmentAction")?.value;

  $("replacementField")?.classList.toggle(
    "hidden",
    action !== "replace"
  );

  $("assignmentFields")?.classList.toggle(
    "hidden",
    action === "return"
  );
}

function saveAssignment(event) {
  event.preventDefault();
  if (!requireAdmin()) return;

  const zone = findZone(
    $("assignmentZoneId").value
  );

  if (!zone) return;

  const action = $("assignmentAction").value;
  const startDate = $("startDate").value;
  const endDate = $("endDate").value;
  const notes = $("assignmentNotes").value.trim();

  if (!Array.isArray(zone.assignments)) {
    zone.assignments = [];
  }

  if (action === "return") {
    if (
      !confirm("هل تريدين إنهاء التكليفات وإعادة المفتش الأساسي؟")
    ) {
      return;
    }

    zone.assignments.forEach(a => {
      if (
        a.status === "approved" ||
        a.status === "active" ||
        a.status == null
      ) {
                a.status = "cancelled";
      }
    });

    logChange(
      zone,
      "إعادة المفتش الأساسي",
      notes
    );
  } else {
    const previous = getActiveAssignment(zone);

    const replacement = action === "extend"
      ? previous?.replacement ||
        previous?.replacementInspector ||
        previous?.inspector
      : $("replacementInspector").value;

    if (!replacement) {
      alert(
        "اختاري المفتش البديل أو تأكدي من وجود تكليف لتمديده."
      );
      return;
    }

    if (
      !startDate ||
      !endDate ||
      endDate < startDate
    ) {
      alert("يرجى إدخال فترة تكليف صحيحة.");
      return;
    }

    if (action === "replace") {
      zone.assignments.forEach(a => {
        if (
          a.status === "approved" ||
          a.status === "active" ||
          a.status == null
        ) {
          a.status = "cancelled";
        }
      });
    } else if (previous) {
      previous.status = "cancelled";
    }

    zone.assignments.push({
      id: uid(),
      inspector: replacement,
      replacement,
      startDate,
      endDate,
      notes,
      status: "approved",
      createdAt: new Date().toISOString()
    });

    logChange(
      zone,
      action === "extend"
        ? "تمديد تكليف"
        : "تعيين مفتش بديل",
      `${replacement} - ${startDate} إلى ${endDate}`
    );
  }

  if (!save()) return;

  $("assignmentDialog").close();
  renderAll();
}

/* ================= لوحة المفتش ================= */

function renderInspectorDashboard() {
  const name = getCurrentInspectorName();

  if ($("inspectorWelcome")) {
    $("inspectorWelcome").textContent =
      `مرحباً ${name}`;
  }

  ensureFieldSupervisors();
  renderInspectorFieldSupervisor();
  renderGeneralNotes("inspectorGeneralNotes");

  const container = clear("inspectorZones");
  if (!container) return;

  // عرض جميع النطاقات لجميع المفتشين
  const visibleZones = db.zones;

  if (!visibleZones.length) {
    container.appendChild(
      el("p", "لا توجد نطاقات مسجلة حالياً.")
    );
    return;
  }

  // إذا كان المفتش مسؤولاً ميدانياً تظلل نطاقاته بنفس لون الإدارة
  const mine = mySupervisedZoneIds();

  visibleZones.forEach(zone => {
    const card = createZoneCard(zone, true);

    if (mine.has(zoneId(zone))) {
      card.classList.add("zone-highlight");
    }

    addFieldSupervisorTag(card, zone);
    container.appendChild(card);
  });
}

/* =====================================================
   التقارير الأسبوعية
   الحفظ اليومي والمسودات والإرسال النهائي
   ===================================================== */

function getReportInspectorName(report) {
  return report.inspector ||
    report.inspectorName ||
    report.name ||
    "";
}

function getReportWeek(report) {
  return report.weekStart ||
    report.week ||
    report.weekKey ||
    "";
}

function hasSubmittedWeeklyReport(
  name,
  week = currentWeekKey()
) {
  return reports.some(report =>
    sameName(getReportInspectorName(report), name) &&
    getReportWeek(report) === week &&
    report.status !== "draft"
  );
}

/* مفتاح مستقل لكل مفتش ولكل أسبوع */

function getDraftKey(name, week) {
  return normalizeName(name).toLowerCase() +
    "::" + week;
}

function getCurrentDraftKey() {
  return getDraftKey(
    getCurrentInspectorName(),
    currentWeekKey()
  );
}

/* جدول المعاملات المنجزة */

function renumberTransactionRows() {
  $("transactionsBody")
    ?.querySelectorAll("tr")
    .forEach((row, index) => {
      row.firstElementChild.textContent = index + 1;
    });
}

function makeTransactionRow(value = "") {
  const row = el("tr");
  const numberCell = el("td");
  const inputCell = el("td");
  const actionCell = el("td");

  // خانة نص يلصق فيها المفتش المعاملة كما هي
  const input = el("textarea", "", "transaction-input");
  input.rows = 2;
  input.value = value;
  input.placeholder = "الصقي المعاملة هنا";
  input.addEventListener("input", scheduleWeeklyDraftSave);

  inputCell.appendChild(input);

  actionCell.appendChild(
    button("حذف", () => {
      row.remove();

      if (!$("transactionsBody").children.length) {
        $("transactionsBody").appendChild(makeTransactionRow());
      }

      renumberTransactionRows();
      scheduleWeeklyDraftSave();
    }, "danger")
  );

  row.append(numberCell, inputCell, actionCell);
  return row;
}

function renderTransactionRows(list = []) {
  const body = clear("transactionsBody");
  if (!body) return;

  (list.length ? list : [""]).forEach(value => {
    body.appendChild(makeTransactionRow(value));
  });

  renumberTransactionRows();
}

function addTransactionRow() {
  const body = $("transactionsBody");
  if (!body) return;

  const row = makeTransactionRow();
  body.appendChild(row);

  renumberTransactionRows();
  row.querySelector("textarea").focus();
}

function getReportTransactions(report) {
  return Array.isArray(report?.transactions)
    ? report.transactions
    : [];
}

/* قراءة بيانات التقرير الأسبوعي */

function getWeeklyReportValues() {

  const getNumber = (id) => {
    const value = Number($(id)?.value || 0);

    return Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : 0;
  };

  const values = {
    monday: $("reportMonday")?.value.trim() || "",
    tuesday: $("reportTuesday")?.value.trim() || "",
    wednesday: $("reportWednesday")?.value.trim() || "",
    thursday: $("reportThursday")?.value.trim() || "",

    mondayViolations: getNumber("mondayViolations"),
    tuesdayViolations: getNumber("tuesdayViolations"),
    wednesdayViolations: getNumber("wednesdayViolations"),
    thursdayViolations: getNumber("thursdayViolations"),

    mondayReports: getNumber("mondayReports"),
    tuesdayReports: getNumber("tuesdayReports"),
    wednesdayReports: getNumber("wednesdayReports"),
    thursdayReports: getNumber("thursdayReports"),

    transactions: [
      ...document.querySelectorAll("#transactionsBody .transaction-input")
    ]
      .map(input => input.value.trim())
      .filter(Boolean)
  };

  values.totalViolations =
    values.mondayViolations +
    values.tuesdayViolations +
    values.wednesdayViolations +
    values.thursdayViolations;

  values.totalReports =
    values.mondayReports +
    values.tuesdayReports +
    values.wednesdayReports +
    values.thursdayReports;

  return values;
}

/* استرجاع بيانات التقرير والمسودة */

function setWeeklyReportValues(values = {}) {

  const fields = {
    reportMonday: "monday",
    reportTuesday: "tuesday",
    reportWednesday: "wednesday",
    reportThursday: "thursday"
  };

  Object.entries(fields).forEach(([id, key]) => {
    if ($(id)) {
      $(id).value =
        values[key] ??
        values[
          "report" +
          key[0].toUpperCase() +
          key.slice(1)
        ] ??
        "";
    }
  });

  const numberFields = [
    "mondayViolations",
    "tuesdayViolations",
    "wednesdayViolations",
    "thursdayViolations",

    "mondayReports",
    "tuesdayReports",
    "wednesdayReports",
    "thursdayReports"
  ];

  numberFields.forEach(id => {
    if ($(id)) {
      $(id).value = values[id] ?? 0;
    }
  });

  renderTransactionRows(getReportTransactions(values));
}

/* إظهار حالة المسودة للمفتش */

function getDraftStatusElement() {
  const form = $("weeklyReportForm");
  if (!form) return null;

  let status = $("weeklyDraftStatus");

  if (!status) {
    status = el(
      "p",
      "",
      "weekly-draft-status"
    );

    status.id = "weeklyDraftStatus";
    status.style.color = "#52725d";
    status.style.fontSize = "13px";
    status.style.marginTop = "10px";

    form.appendChild(status);
  }

  return status;
}
function showDraftStatus(message) {
  const status = getDraftStatusElement();

  if (status) {
    status.textContent = message;
  }
}

/* إنشاء زر حفظ المسودة تلقائياً */

function ensureDraftSaveButton() {
  const form = $("weeklyReportForm");
  if (!form || $("saveWeeklyDraftButton")) return;

  const saveButton = button(
    "حفظ المسودة بدون إرسال",
    () => saveWeeklyDraft(true),
    "secondary"
  );

  saveButton.id = "saveWeeklyDraftButton";
  saveButton.style.margin = "10px 0";
  saveButton.style.background = "#e8f1ea";
  saveButton.style.color = "#285a3a";
  saveButton.style.border = "1px solid #a7c5ae";

  const submitButton = form.querySelector(
    'button[type="submit"], input[type="submit"]'
  );

  if (submitButton) {
    submitButton.before(saveButton);
  } else {
    form.appendChild(saveButton);
  }

  getDraftStatusElement();
}

/* حفظ المسودة محلياً دون إرسالها للإدارة */

function saveWeeklyDraft(showMessage = true) {
  if (!isInspector()) return false;

  const form = $("weeklyReportForm");
  if (!form) return false;

  const inspector = getCurrentInspectorName();
  const week = currentWeekKey();

  const values = getWeeklyReportValues();
  const key = getDraftKey(inspector, week);

  const previous = weeklyDrafts[key];

  weeklyDrafts[key] = {
    id: previous?.id || uid(),
    inspector,
    weekStart: week,
    ...values,
    status: "draft",
    updatedAt: new Date().toISOString()
  };

  if (!saveDrafts()) {
    if (previous) {
      weeklyDrafts[key] = previous;
    } else {
      delete weeklyDrafts[key];
    }

    return false;
  }

  showDraftStatus(
    "تم حفظ المسودة: " +
    formatDateTime(weeklyDrafts[key].updatedAt)
  );

  if (showMessage) {
    alert(
      "تم حفظ المسودة بنجاح. يمكنك الرجوع إليها وإكمال التقرير لاحقاً."
    );
  }

  return true;
}

/* حفظ تلقائي بعد توقف المفتش عن الكتابة */

function scheduleWeeklyDraftSave() {
  if (!isInspector()) return;

  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
  }

  showDraftStatus("جارٍ تجهيز الحفظ التلقائي...");

  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    saveWeeklyDraft(false);
  }, 700);
}

/* تحميل مسودة الأسبوع أو التقرير السابق */

function renderInspectorWeeklyReportForm() {
  if (!isInspector()) return;

  const monday = weekStart();
  const week = currentWeekKey();
  const name = getCurrentInspectorName();

  if ($("inspectorWeekTitle")) {
    $("inspectorWeekTitle").textContent =
      "التقرير الأسبوعي";
  }

  if ($("inspectorWeekDates")) {
    $("inspectorWeekDates").textContent =
      formatWeekRange(week);
  }

  [
    ["mondayDate", 0],
    ["tuesdayDate", 1],
    ["wednesdayDate", 2],
    ["thursdayDate", 3]
  ].forEach(([id, offset]) => {
    if ($(id)) {
      $(id).textContent = formatDate(
        dateISO(addDays(monday, offset))
      );
    }
  });

  fillSelect(
    "weeklyInspector",
    [name],
    "اسم المفتش"
  );

  if ($("weeklyInspector")) {
    $("weeklyInspector").value = name;
  }

  const existing = reports.find(report =>
    sameName(getReportInspectorName(report), name) &&
    getReportWeek(report) === week
  );

  const draft = weeklyDrafts[
    getDraftKey(name, week)
  ];

  /* لا نعيد تعبئة الحقول أثناء الكتابة
     إلا عند تغيير الأسبوع أو المستخدم. */

  const form = $("weeklyReportForm");

  if (form) {
    const identity = getDraftKey(name, week);

    if (form.dataset.loadedDraft !== identity) {
      setWeeklyReportValues(existing || draft || {});

      form.dataset.loadedDraft = identity;
    }
  }

  ensureDraftSaveButton();

  if (existing) {
    showDraftStatus(
      existing.status === "returned"
        ? "التقرير مُعاد للتعديل. يمكنك حفظ التعديلات ثم إعادة إرساله."
        : "سبق إرسال تقرير هذا الأسبوع. يمكنك تعديله وإعادة إرساله."
    );
  } else if (draft) {
    showDraftStatus(
      "مسودة محفوظة بتاريخ " +
      formatDateTime(draft.updatedAt)
    );
  } else {
    showDraftStatus(
      "يمكنك كتابة أعمال كل يوم وحفظها دون إرسال التقرير."
    );
  }

  renderInspectorWeeklyReminder();
}

/* الإرسال النهائي */

function submitWeeklyReport(event) {
  event.preventDefault();
  if (!isInspector()) return;

  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }

  const inspector = getCurrentInspectorName();
  const week = currentWeekKey();
  const values = getWeeklyReportValues();

  const hasContent = Object.values(values).some(value =>
    Array.isArray(value) ? value.length : Boolean(value)
  );

  if (!hasContent) {
    alert("يرجى إدخال الأعمال المنجزة.");
    return;
  }

  const existing = reports.find(report =>
    sameName(getReportInspectorName(report), inspector) &&
    getReportWeek(report) === week
  );

  if (existing) {
    if (
      !confirm(
        "هل تريدين حفظ التعديلات وإعادة إرسال التقرير؟"
      )
    ) {
      return;
    }

    const old = { ...existing };

    Object.assign(existing, values, {
      inspector,
      inspectorName: inspector,
      weekStart: week,
      status: existing.status === "returned"
        ? "resubmitted"
        : "submitted",
      returnNote: "",
      updatedAt: new Date().toISOString()
    });

    if (!saveReports()) {
      Object.assign(existing, old);
      return;
    }
  } else {
    if (
      !confirm(
        "هل تريد إرسال التقرير الأسبوعي النهائي للإدارة؟"
      )
    ) {
      return;
    }

    const report = {
            id: uid(),
      inspector,
      inspectorName: inspector,
      weekStart: week,
      ...values,
      status: "submitted",
      submittedAt: new Date().toISOString()
    };

    reports.push(report);

    if (!saveReports()) {
      reports.pop();
      return;
    }
  }

  /* إزالة المسودة بعد نجاح الإرسال فقط */

  const draftKey = getDraftKey(inspector, week);

  delete weeklyDrafts[draftKey];
  saveDrafts();

  showDraftStatus("تم إرسال التقرير للإدارة.");

  alert("تم إرسال التقرير الأسبوعي بنجاح.");
  renderAll();
}

/* ================= تقارير الإدارة ================= */

function createWeeklyReportCard(report) {
  const card = makeCard(
    getReportInspectorName(report) || "تقرير"
  );

  const status = report.status === "returned"
    ? "مُعاد للمفتش للتعديل"
    : report.status === "resubmitted"
      ? "أُعيد إرساله بعد التعديل"
      : "مستلم";

  detail(
    card,
    "فترة التقرير",
    formatWeekRange(getReportWeek(report))
  );

  detail(card, "الحالة", status);

  if (report.returnNote) {
    detail(
      card,
      "ملاحظة الإدارة",
      report.returnNote
    );
  }

  detail(
    card,
    "الاثنين",
    report.monday || report.reportMonday || "—"
  );

  detail(
    card,
    "الثلاثاء",
    report.tuesday || report.reportTuesday || "—"
  );

  detail(
    card,
    "الأربعاء",
    report.wednesday || report.reportWednesday || "—"
  );

  detail(
    card,
    "الخميس",
    report.thursday || report.reportThursday || "—"
  );

  const transactions = getReportTransactions(report);

  if (transactions.length) {
    card.appendChild(
      el("strong", `المعاملات المنجزة (${transactions.length}):`)
    );

    const list = el("ol", "", "transactions-list");

    transactions.forEach(text => {
      list.appendChild(el("li", text));
    });

    card.appendChild(list);
  } else {
    detail(card, "المعاملات المنجزة", "—");
  }

  const actions = el("div", "", "actions");

  actions.appendChild(
    button(
      "تحميل التقرير PDF",
      () => printWeeklyReport(report)
    )
  );

  if (report.status !== "returned") {
    actions.appendChild(
      button(
        "إعادة للتعديل",
        () => returnWeeklyReport(report.id),
        "secondary"
      )
    );
  }

  actions.appendChild(
    button(
      "حذف التقرير",
      () => deleteWeeklyReport(report.id),
      "danger"
    )
  );

  card.appendChild(actions);

  return card;
}

function renderWeeklyReports() {
  const container = clear("weeklyReportsList");
  if (!container) return;

  if (!reports.length) {
    container.appendChild(
      el("p", "لم يتم استلام تقارير بعد.")
    );
  }

  [...reports].reverse().forEach(report => {
    container.appendChild(
      createWeeklyReportCard(report)
    );
  });

  if ($("weeklyReportCount")) {
    $("weeklyReportCount").textContent =
      String(reports.length);

    $("weeklyReportCount").hidden =
      reports.length === 0;
  }
}

function deleteWeeklyReport(id) {
  if (!requireAdmin()) return;

  const report = reports.find(
    item => String(item.id) === String(id)
  );

  if (!report) return;

  const name = getReportInspectorName(report);

  if (
    !confirm(`هل تريدين حذف تقرير ${name} نهائياً؟`)
  ) {
    return;
  }

  const updated = reports.filter(
    item => String(item.id) !== String(id)
  );

  if (!storeData(REPORTS_KEY, updated)) return;

  reports = updated;
  renderAll();

  alert("تم حذف التقرير بنجاح.");
}

function returnWeeklyReport(id) {
  if (!requireAdmin()) return;

  const report = reports.find(
    item => String(item.id) === String(id)
  );

  if (!report) return;

  const note = prompt(
    "اكتبي ملاحظة للمفتش توضح التعديلات المطلوبة:"
  );

  if (note === null) return;

  if (!note.trim()) {
    alert("يرجى كتابة ملاحظة قبل إعادة التقرير.");
    return;
  }

  report.status = "returned";
  report.returnNote = note.trim();
  report.returnedAt = new Date().toISOString();
  report.returnedBy = currentUser?.name || "";

  if (!saveReports()) return;

  renderAll();
  alert("تمت إعادة التقرير للمفتش للتعديل.");
}

/* ================= طباعة التقرير PDF ================= */
function printWeeklyReport(report) {
  const popup = window.open("", "_blank");

  if (!popup) {
    alert("يرجى السماح بفتح نافذة جديدة للتقرير.");
    return;
  }

  const doc = popup.document;

  doc.open();

  doc.write(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>التقرير الأسبوعي شعبة التفتيش</title>
<style>
@page {
  size: A4;
  margin: 14mm;
}

* {
  box-sizing: border-box;
}

body {
  font-family: Tahoma, Arial, sans-serif;
  color: #24382c;
  margin: 0;
  direction: rtl;
  background: white;
}

.report-header {
  display: flex;
  justify-content: flex-start;
  align-items: flex-start;
  min-height: 110px;
  border-bottom: 2px solid #304b3a;
  padding-bottom: 16px;
}

.report-logo {
  width: 250px;
  max-width: 60%;
  height: auto;
  object-fit: contain;
  object-position: right top;
}

h1 {
  text-align: center;
  font-size: 21px;
  margin: 25px 0 20px;
}

.meta {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  padding: 17px;
  border: 1px solid #dce5dd;
  background: #f7faf7;
  margin-bottom: 24px;
  font-size: 14px;
}

table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

th, td {
  border: 1px solid #9eaea2;
  padding: 14px;
  text-align: right;
  vertical-align: top;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.9;
}

th {
  background: #eaf1eb;
  font-weight: bold;
}

th:first-child,
td:first-child {
  width: 26%;
}

.section-title {
  font-size: 16px;
  margin: 24px 0 10px;
}

.transactions th:first-child,
.transactions td:first-child {
  width: 10%;
  text-align: center;
}

#reportStatistics {
  margin-top: 24px;
}

tr {
  break-inside: avoid;
}

.footer {
  margin-top: 35px;
  padding-top: 12px;
  border-top: 1px solid #ddd;
  text-align: center;
  color: #66746b;
  font-size: 11px;
}

@media print {
  body {
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
}
</style>
</head>
<body>

<div class="report-header">
  <img
    class="report-logo"
    alt="شعار حكومة الشارقة وبلدية مدينة الذيد"
  >
</div>

<h1>التقرير الأسبوعي لأعمال التفتيش</h1>

<div class="meta" id="reportMeta"></div>

<table>
  <thead>
    <tr>
      <th>اليوم والتاريخ</th>
      <th>الأعمال المنجزة</th>
    </tr>
  </thead>
  <tbody id="reportRows"></tbody>
</table>

<h2 class="section-title">المعاملات المنجزة</h2>

<table class="transactions">
  <thead>
    <tr>
      <th>م</th>
      <th>المعاملة</th>
    </tr>
  </thead>
  <tbody id="transactionRows"></tbody>
</table>

<div class="meta" id="reportStatistics">
  <h3>ملخص المخالفات الأسبوعية</h3>
  <p id="totalViolationsPrint"></p>
  <p id="totalReportsPrint"></p>
</div>

<div class="footer">
  بلدية مدينة الذيد – إدارة الخدمات الفنية
</div>

</body>
</html>`);

  doc.close();

  const meta = doc.getElementById("reportMeta");

  const addPrintDetail = (parent, label, value) => {
    const p = doc.createElement("p");
    const strong = doc.createElement("strong");

    strong.textContent = label + ": ";

    p.append(
      strong,
      doc.createTextNode(String(value ?? "—"))
    );

    parent.appendChild(p);
  };

  addPrintDetail(
    meta,
    "اسم المفتش",
    getReportInspectorName(report)
  );

  addPrintDetail(
    meta,
    "فترة التقرير",
    formatWeekRange(getReportWeek(report))
  );

  const monday = new Date(
    getReportWeek(report) + "T12:00:00"
  );

  const days = [
    ["الاثنين", "monday", 0],
    ["الثلاثاء", "tuesday", 1],
    ["الأربعاء", "wednesday", 2],
    ["الخميس", "thursday", 3]
  ];

  const tbody = doc.getElementById("reportRows");

  days.forEach(([label, key, offset]) => {
    const tr = doc.createElement("tr");

    const date = formatDate(
      dateISO(addDays(monday, offset))
    );

    const dayCell = doc.createElement("td");
    dayCell.textContent = label + " - " + date;

    const workCell = doc.createElement("td");

    workCell.textContent =
      report[key] ||
      report[
        "report" +
        key[0].toUpperCase() +
        key.slice(1)
      ] ||
      "لا توجد أعمال مدخلة";

    tr.append(dayCell, workCell);
    tbody.appendChild(tr);
  });

  const transactionRows = doc.getElementById("transactionRows");
  const transactions = getReportTransactions(report);

  (transactions.length ? transactions : ["لا توجد معاملات مدخلة"])
    .forEach((text, index) => {
      const tr = doc.createElement("tr");
      const numberCell = doc.createElement("td");
      const textCell = doc.createElement("td");

      numberCell.textContent = transactions.length ? index + 1 : "—";
      textCell.textContent = text;

      tr.append(numberCell, textCell);
      transactionRows.appendChild(tr);
    });

  // حساب إجمالي المخالفات ومحاضر ضبط المخالفات

  const weekDays = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday"
  ];

  const totalViolations = weekDays.reduce(
    (sum, day) =>
      sum + (Number(report[day + "Violations"]) || 0),
    0
  );

  const totalReports = weekDays.reduce(
    (sum, day) =>
      sum + (Number(report[day + "Reports"]) || 0),
    0
  );

  doc.getElementById("totalViolationsPrint").textContent =
    "إجمالي المخالفات المرصودة: " + totalViolations;

  doc.getElementById("totalReportsPrint").textContent =
    "إجمالي محاضر ضبط المخالفات: " + totalReports;

  const logo = doc.querySelector(".report-logo");

  const openPrint = () => {
    popup.focus();
    popup.print();
  };

  logo.addEventListener(
    "load",
    () => setTimeout(openPrint, 300),
    { once: true }
  );

  logo.addEventListener(
    "error",
    () => {
      alert(
        "تعذر تحميل شعار التقرير. تأكدي من رفع ملف logo.png"
      );
      openPrint();
    },
    { once: true }
  );

  // اسم الملف حساس لحالة الأحرف على GitHub Pages
  logo.src = new URL(
    "logo.png",
    document.baseURI
  ).href;
}

/* ================= التذكيرات الأسبوعية ================= */
function renderReminderInspectors() {
  const container = $("reminderInspectors");
  if (!container) return;

  const selected = new Set(
    [
      ...container.querySelectorAll("input:checked")
    ].map(input => input.value)
  );

  container.replaceChildren();

  const missing = getInspectorNames().filter(name =>
    !hasSubmittedWeeklyReport(
      name,
      currentWeekKey()
    )
  );

  if (!missing.length) {
    container.appendChild(
      el("p", "جميع المفتشين أرسلوا تقاريرهم.")
    );
    return;
  }

  missing.forEach(name => {
    const label = el(
      "label",
      "",
      "reminder-inspector"
    );

    const checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.value = name;
    checkbox.checked = selected.has(name);

    label.append(
      checkbox,
      el("span", name)
    );

    container.appendChild(label);
  });
}

function sendWeeklyReminder() {
  if (!requireAdmin()) return;

  const selected = [
    ...document.querySelectorAll(
      "#reminderInspectors input:checked"
    )
  ].map(input => input.value);

  const note = $("reminderNote")?.value.trim() || "";

  if (!selected.length) {
    alert("اختاري مفتشاً واحداً على الأقل.");
    return;
  }

  if (!note) {
    alert("اكتبي ملاحظة التذكير.");
    return;
  }

  const reminder = {
    id: uid(),
    type: "weekly_reminder",
    inspectors: selected,
    note,
    weekStart: currentWeekKey(),
    createdAt: new Date().toISOString(),
    createdBy: currentUser?.name ||
      currentUser?.fullName || ""
  };

  reportAlerts.push(reminder);

  if (!saveAlerts()) {
    reportAlerts.pop();
    return;
  }

  $("reminderNote").value = "";

  const result = $("reminderResult");

  if (result) {
    result.textContent =
      "تم حفظ التذكير للمفتشين: " +
      selected.join("، ");

    result.classList.remove("hidden");
  }

  renderReminderInspectors();
}

function renderInspectorWeeklyReminder() {
  const container = clear("inspectorWeeklyReminder");

  if (!container || !isInspector()) return;

  const inspector = getCurrentInspectorName();
  const week = currentWeekKey();

  const returned = reports.find(report =>
    sameName(
      getReportInspectorName(report),
      inspector
    ) &&
    getReportWeek(report) === week &&
    report.status === "returned"
  );

  if (returned) {
    const box = el(
      "div",
      "",
      "inspector-reminder"
    );

    box.appendChild(
      el(
        "strong",
        "↩ تم إعادة التقرير الأسبوعي للتعديل"
      )
    );

    box.appendChild(
      el(
        "p",
        "فترة التقرير: " +
        formatWeekRange(week)
      )
    );

    box.appendChild(
      el(
        "p",
        "ملاحظة الإدارة: " +
        (returned.returnNote || "")
      )
    );

    box.appendChild(
      el(
        "p",
        "يرجى تعديل التقرير وإعادة إرساله."
      )
    );

    container.appendChild(box);
    return;
  }

  if (hasSubmittedWeeklyReport(inspector, week)) {
    return;
  }

  const reminders = reportAlerts.filter(item =>
    item.type === "weekly_reminder" &&
    item.weekStart === week &&
    Array.isArray(item.inspectors) &&
    item.inspectors.some(name =>
      sameName(name, inspector)
    )
  );

  if (!reminders.length) return;

  const latest = reminders[reminders.length - 1];

  const box = el(
    "div",
    "",
    "inspector-reminder"
  );

  box.appendChild(
    el(
      "strong",
      "🔔 تذكير بإرسال التقرير الأسبوعي"
    )
  );

  box.appendChild(
    el(
      "p",
      "فترة التقرير: " +
      formatWeekRange(week)
    )
  );

  box.appendChild(
    el("p", latest.note || "")
  );

  container.appendChild(box);
}

/* عرض المفتشين الذين لم يرسلوا التقرير */

function renderMissingWeeklyReports() {
  const container = $("missingReportsList");

  if (!container || !isAdmin()) return;

  container.replaceChildren();

  if ($("missingReportsWeek")) {
    $("missingReportsWeek").textContent = formatWeekRange();
  }

  const missing = getInspectorNames().filter(name =>
    !hasSubmittedWeeklyReport(
      name,
      currentWeekKey()
    )
  );

  if (!missing.length) {
    container.appendChild(
      el("p", "تم استلام تقارير جميع المفتشين.")
    );
    return;
  }

  missing.forEach(name => {
    const p = el(
      "p",
      name + " — لم يرسل التقرير بعد"
    );

    container.appendChild(p);
  });
}

/* ================= طلبات المفتش البديل ================= */

function renderRequestForm() {
  if (!isInspector()) return;

  const name = getCurrentInspectorName();

  fillSelect(
    "requestOwner",
    [name],
    "اسم المفتش"
  );

  if ($("requestOwner")) {
    $("requestOwner").value = name;
  }

  const zoneSelect = $("requestZone");

  if (zoneSelect) {
    const old = zoneSelect.value;

    zoneSelect.replaceChildren();

    const first = el(
      "option",
      "اختاري النطاق"
    );

    first.value = "";
    zoneSelect.appendChild(first);

    db.zones
      .filter(zone =>
        sameName(zoneInspector(zone), name)
      )
      .forEach(zone => {
        const option = el(
          "option",
          zone.name
        );

        option.value = zoneId(zone);
        zoneSelect.appendChild(option);
      });

    if (
      [...zoneSelect.options].some(
        option => option.value === old
      )
    ) {
      zoneSelect.value = old;
    }
  }

  fillSelect(
    "requestReplacement",
    getInspectorNames().filter(n =>
      !sameName(n, name)
    ),
    "اختاري المفتش البديل أو اتركيه للإدارة"
  );

  if ($("requestReplacement")) {
    $("requestReplacement").required = false;
  }
}

function submitReplacementRequest(event) {
  event.preventDefault();
  if (!isInspector()) return;

  const zone = findZone(
    $("requestZone")?.value
  );

  const replacement =
    $("requestReplacement")?.value || "";

  const startDate =
    $("requestStart")?.value || "";

  const endDate =
    $("requestEnd")?.value || "";

  const reason =
    $("requestReason")?.value.trim() || "";

  if (
    !zone ||
    !startDate ||
    !endDate ||
    !reason
  ) {
    alert(
      "يرجى تحديد النطاق والفترة والسبب."
    );
    return;
  }

  if (
    !sameName(
      zoneInspector(zone),
      getCurrentInspectorName()
    )
  ) {
    alert("لا يمكنك تقديم طلب لهذا النطاق.");
    return;
  }

  if (endDate < startDate) {
    alert(
      "تاريخ النهاية يجب ألا يسبق تاريخ البداية."
    );
    return;
  }

  const request = {
    id: uid(),
    inspector: getCurrentInspectorName(),
    owner: getCurrentInspectorName(),
    zoneId: zoneId(zone),
    zoneName: zone.name,
    replacement,
    startDate,
    endDate,
        reason,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  db.replacementRequests.push(request);

  if (!save()) {
    db.replacementRequests.pop();
    return;
  }

  $("inspectorRequestForm")?.reset();

  alert("تم إرسال طلب البديل للإدارة.");
  renderAll();
}

/* ================= اعتماد طلبات البديل ================= */

function deleteReplacementRequest(id) {
  if (!requireAdmin()) return;

  const request = db.replacementRequests.find(
    item => String(item.id) === String(id)
  );

  if (!request) return;

  if (!confirm("هل تريدين حذف طلب تعيين البديل؟")) {
    return;
  }

  db.replacementRequests =
    db.replacementRequests.filter(
      item => String(item.id) !== String(id)
    );

  if (!save()) return;

  logChange(
    request.zoneName || "",
    "حذف طلب تعيين بديل",
    request.inspector || request.owner || ""
  );

  renderAll();

  alert("تم حذف الطلب بنجاح.");
}

function renderReplacementRequests() {
  const container = clear("replacementApprovals");
  if (!container) return;

  if (!db.replacementRequests.length) {
    container.appendChild(
      el("p", "لا توجد طلبات حالياً.")
    );
  }

  db.replacementRequests.forEach(request => {
    const card = makeCard(
      request.zoneName || "طلب مفتش بديل"
    );

    detail(
      card,
      "المفتش",
      request.inspector || request.owner
    );

    detail(
      card,
      "البديل المقترح",
      request.replacement || "تحدده الإدارة"
    );

    detail(
      card,
      "من تاريخ",
      formatDate(request.startDate)
    );

    detail(
      card,
      "إلى تاريخ",
      formatDate(request.endDate)
    );

    detail(card, "السبب", request.reason);

    detail(
      card,
      "الحالة",
      {
        pending: "قيد الاعتماد",
        approved: "معتمد",
        rejected: "مرفوض"
      }[request.status] || request.status
    );

    if (request.status === "pending") {
      const label = el(
        "label",
        "اختيار المفتش البديل:"
      );

      const select = document.createElement("select");

      select.className = "replacement-approval-select";

      const first = el(
        "option",
        "اختاري المفتش البديل"
      );

      first.value = "";
      select.appendChild(first);

      getInspectorNames()
        .filter(name =>
          !sameName(
            name,
            request.inspector || request.owner
          )
        )
        .forEach(name => {
          const option = el("option", name);
          option.value = name;
          select.appendChild(option);
        });

      if (request.replacement) {
        select.value = request.replacement;
      }

      card.appendChild(label);
      card.appendChild(select);

      const actions = el(
        "div",
        "",
        "actions"
      );

      actions.append(
        button(
          "اعتماد",
          () => reviewReplacementRequest(
            request.id,
            "approved",
            select.value
          )
        ),
        button(
          "رفض",
          () => reviewReplacementRequest(
            request.id,
            "rejected"
          ),
          "danger"
        )
      );

      card.appendChild(actions);
    }

    if (request.status === "approved") {
      const zone = findZone(request.zoneId);

      const assignment = (
        zone?.assignments || []
      ).find(a =>
        String(a.requestId) === String(request.id)
      );

      if (assignment) {
        detail(
          card,
          "حالة الاستلام",
          assignment.acknowledgedAt
            ? "تم الاستلام"
            : "بانتظار الاستلام"
        );

        if (assignment.acknowledgedAt) {
          detail(
            card,
            "تاريخ الاستلام",
            formatDateTime(
              assignment.acknowledgedAt
            )
          );
        }
      }
    }

    const deleteButton = button(
      "حذف الطلب",
      () => deleteReplacementRequest(request.id),
      "danger"
    );

    deleteButton.style.marginTop = "15px";

    card.appendChild(deleteButton);

    container.appendChild(card);
  });

  const pending = db.replacementRequests.filter(
    request => request.status === "pending"
  ).length;

  if ($("approvalCount")) {
    $("approvalCount").textContent = String(pending);
    $("approvalCount").hidden = pending === 0;
  }
}

function reviewReplacementRequest(
  id,
  decision,
  selectedReplacement = ""
) {
  if (!requireAdmin()) return;

  const request = db.replacementRequests.find(
    item => String(item.id) === String(id)
  );

  if (!request || request.status !== "pending") {
    return;
  }

  const zone = findZone(request.zoneId);

  if (decision === "approved" && !zone) {
    alert("النطاق المرتبط بالطلب غير موجود.");
    return;
  }

  const replacement =
    selectedReplacement ||
    request.replacement ||
    "";

  if (decision === "approved") {
    if (!replacement) {
      alert("يرجى اختيار المفتش البديل قبل الاعتماد.");
      return;
    }

    if (
      sameName(
        replacement,
        request.inspector || request.owner
      )
    ) {
      alert("لا يمكن تكليف المفتش نفسه بديلاً عن نفسه.");
      return;
    }

    if (
      !getInspectorNames().some(name =>
        sameName(name, replacement)
      )
    ) {
      alert("المفتش البديل غير موجود في النظام.");
      return;
    }

    if (
      !request.startDate ||
      !request.endDate ||
      request.endDate < request.startDate
    ) {
      alert("فترة التكليف غير صحيحة.");
      return;
    }
  }

  if (
    !confirm(
      decision === "approved"
        ? "هل تريدين اعتماد الطلب وتكليف المفتش المحدد؟"
        : "هل تريدين رفض الطلب؟"
    )
  ) {
    return;
  }

  const oldRequest = { ...request };

  request.status = decision;
  request.reviewedAt = new Date().toISOString();
  request.reviewedBy =
    currentUser?.name || currentUser?.fullName || "";

  if (decision === "approved") {
    request.replacement = replacement;

    if (!Array.isArray(zone.assignments)) {
      zone.assignments = [];
    }

    zone.assignments.push({
      id: uid(),
      inspector: replacement,
      replacement,
      startDate: request.startDate,
      endDate: request.endDate,
      notes: request.reason,
      status: "approved",
      requestId: request.id,
      createdAt: new Date().toISOString()
    });
  }

  if (!save()) {
    Object.assign(request, oldRequest);

    if (decision === "approved") {
      zone.assignments.pop();
    }

    return;
  }

  logChange(
    zone || request.zoneName,
    decision === "approved"
      ? "اعتماد طلب بديل"
      : "رفض طلب بديل",
    replacement
  );

  renderAll();
}

/* ================= إدارة المستخدمين ================= */

function findUser(id) {
  return users.find(
    user => String(user.id) === String(id)
  );
}

function resetUserForm() {
  $("userForm")?.reset();

  if ($("editUserId")) {
    $("editUserId").value = "";
  }

  if ($("userPassword")) {
    $("userPassword").placeholder =
      "كلمة مرور المستخدم";
  }
}
async function saveUser(event) {
  event.preventDefault();

  if (!requireSuperAdmin()) return;

  const editId = $("editUserId")?.value || "";
  const name = normalizeName($("userName")?.value);
  const role = $("userRole")?.value || "";
  const password = $("userPassword")?.value || "";

  if (!name || !role) {
    alert("يرجى إدخال اسم المستخدم والصلاحية.");
    return;
  }

  if (
    ![
      "super_admin",
      "manager",
      "department_head",
      "inspector"
    ].includes(role)
  ) {
    alert("الصلاحية المختارة غير صحيحة.");
    return;
  }

  const duplicate = users.some(user =>
    String(user.id) !== String(editId) &&
    sameName(
      user.name || user.fullName,
      name
    )
  );

  if (duplicate) {
    alert("اسم المستخدم موجود مسبقاً.");
    return;
  }

  if (password && password.length < 8) {
    alert("كلمة المرور يجب ألا تقل عن 8 أحرف.");
    return;
  }

  if (editId) {
    const user = findUser(editId);

    if (!user) {
      alert("المستخدم غير موجود.");
      return;
    }

    if (
      user.role === "super_admin" &&
      role !== "super_admin"
    ) {
      const superAdmins = users.filter(
        item => item.role === "super_admin"
      );

      if (superAdmins.length <= 1) {
        alert(
          "لا يمكن تغيير صلاحية المسؤول الرئيسي الوحيد."
        );
        return;
      }
    }

    // كلمة المرور والصلاحية تُحفظان في حساب الدخول قبل تعديل البيانات
    try {
      if (password) {
        await setLoginPassword(user, role, password);
      } else if (user.authUid && user.role !== role) {
        await cloudStore.collection(ACCOUNTS_COLLECTION).doc(user.authUid)
          .set({ userId: user.id, role });
      }
    } catch (error) {
      console.error(error);
      alert(authErrorText(error));
      return;
    }

    const oldName =
      user.name || user.fullName || "";

    user.name = name;
    user.fullName = name;
    user.role = role;

    if (
      user.role === "inspector" &&
      !getInspectorNames().some(
        inspector => sameName(inspector, name)
      )
    ) {
      db.inspectors.push(name);
    }

    if (
      oldName &&
      !sameName(oldName, name)
    ) {
      db.inspectors = db.inspectors.map(item => {
        if (
          !sameName(
            inspectorNameOf(item),
            oldName
          )
        ) {
          return item;
        }

        return typeof item === "string"
          ? name
          : {
              ...item,
              name,
              fullName: name
            };
      });

      db.zones.forEach(zone => {
        [
          "inspector",
          "primaryInspector",
          "inspectorName"
        ].forEach(key => {
          if (sameName(zone[key], oldName)) {
            zone[key] = name;
          }
        });

        (zone.assignments || []).forEach(
          assignment => {
            [
              "inspector",
              "replacement",
              "replacementInspector",
              "acknowledgedBy"
            ].forEach(key => {
              if (
                sameName(
                  assignment[key],
                  oldName
                )
              ) {
                assignment[key] = name;
              }
            });
          }
        );
      });

      db.replacementRequests.forEach(
        request => {
          [
            "inspector",
            "owner",
            "replacement"
          ].forEach(key => {
            if (
              sameName(
                request[key],
                oldName
              )
            ) {
              request[key] = name;
            }
          });
        }
      );

      reports.forEach(report => {
        if (
          sameName(
            getReportInspectorName(report),
            oldName
          )
        ) {
          report.inspector = name;
          report.inspectorName = name;
        }
      });

      directives.forEach(directive => {
        if (
          sameName(
            directive.inspector,
            oldName
          )
        ) {
          directive.inspector = name;
        }

        if (
          sameName(
            directive.acknowledgedBy,
            oldName
          )
        ) {
          directive.acknowledgedBy = name;
        }

        if (
          sameName(
            directive.completedBy,
            oldName
          )
        ) {
          directive.completedBy = name;
        }
      });
    }
  } else {
    if (!password || password.length < 8) {
      alert(
        "كلمة المرور يجب ألا تقل عن 8 أحرف."
      );
      return;
    }

    const user = {
      id: uid(),
      name,
      fullName: name,
      role,
      createdAt: new Date().toISOString()
    };

    try {
      await setLoginPassword(user, role, password);
    } catch (error) {
      console.error(error);
      alert(authErrorText(error));
      return;
    }

    users.push(user);

    if (
      role === "inspector" &&
      !db.inspectors.some(item =>
        sameName(
          inspectorNameOf(item),
          name
        )
      )
    ) {
      db.inspectors.push(name);
    }
  }

  saveUsers();
  save();
  saveReports();
  saveDirectives();

  resetUserForm();
  renderAll();

  // تحديث الاسم في أعلى الصفحة عند تعديل الحساب الحالي
  if (currentUser && String(currentUser.id) === String(editId)) {
    $("currentUserName").textContent = name;
    $("currentUserRole").textContent = roleLabel(role);
  }

  alert(
    editId
      ? "تم تعديل المستخدم بنجاح."
      : "تم إضافة المستخدم بنجاح."
  );
}

function editUser(id) {
  if (!requireSuperAdmin()) return;

  const user = findUser(id);
  if (!user) return;

  if ($("editUserId")) {
    $("editUserId").value = user.id;
  }

  if ($("userName")) {
    $("userName").value =
      user.name || user.fullName || "";
  }

  const roleSelect = $("userRole");

  if (roleSelect) {
    // احتياط في حال كانت صفحة HTML قديمة بدون خيار المسؤول الرئيسي
    if (
      user.role &&
      ![...roleSelect.options].some(option => option.value === user.role)
    ) {
      const option = el("option", roleLabel(user.role));
      option.value = user.role;
      roleSelect.prepend(option);
    }

    roleSelect.value = user.role || "";
  }

  if ($("userPassword")) {
    $("userPassword").value = "";

    $("userPassword").placeholder = user.authUid
      ? "اتركيها فارغة للإبقاء على كلمة المرور الحالية"
      : "حددي كلمة مرور (8 أحرف على الأقل) لتفعيل دخول هذا المستخدم";
  }
}

// إلغاء ربط حساب الدخول حتى لا يدخل المستخدم المحذوف
function removeLoginAccount(user) {
  if (!user?.authUid) return Promise.resolve();

  return cloudStore.collection(ACCOUNTS_COLLECTION).doc(user.authUid)
    .delete()
    .catch(error => console.error(error));
}

function deleteUser(id) {
  if (!requireSuperAdmin()) return;

  const user = findUser(id);
  if (!user) return;

  if (
    currentUser &&
    String(currentUser.id) === String(user.id)
  ) {
    alert(
      "لا يمكنك حذف الحساب المستخدم حالياً."
    );
    return;
  }

  if (user.role === "super_admin") {
    const superAdmins = users.filter(
      item => item.role === "super_admin"
    );

    if (superAdmins.length <= 1) {
      alert(
        "لا يمكن حذف المسؤول الرئيسي الوحيد."
      );
      return;
    }
  }

  if (
    !confirm(
      `هل تريدين حذف المستخدم ${
        user.name || user.fullName || ""
      }؟`
    )
  ) {
    return;
  }

  const previous = [...users];

  users = users.filter(
    item =>
      String(item.id) !== String(id)
  );

  if (!saveUsers()) {
    users = previous;
    return;
  }

  removeLoginAccount(user);
  renderAll();

  alert("تم حذف المستخدم بنجاح.");
}

function renderUsers() {
  const container = clear("usersList");

  if (!container) return;

  if (!isSuperAdmin()) {
    container.appendChild(
      el(
        "p",
        "إدارة المستخدمين متاحة للمسؤول الرئيسي فقط."
      )
    );

    return;
  }

  if (!users.length) {
    container.appendChild(
      el("p", "لا يوجد مستخدمون.")
    );

    return;
  }

  users
    .slice()
    .sort((a, b) =>
      String(
        a.name || a.fullName || ""
      ).localeCompare(
        String(
          b.name || b.fullName || ""
        ),
        "ar"
      )
    )
    .forEach(user => {
      const card = makeCard(
        user.name ||
        user.fullName ||
        "مستخدم"
      );

      detail(
        card,
        "الصلاحية",
        roleLabel(user.role)
      );

      if (!user.authUid) {
        const warning = el(
          "p",
          "⚠ لم يتم تفعيل الدخول — اضغطي «تعديل» وحددي كلمة مرور."
        );
        warning.style.color = "#b45309";
        warning.style.fontWeight = "bold";
        card.appendChild(warning);
      }

      const actions = el(
        "div",
        "",
        "actions"
      );

      actions.append(
        button(
          "تعديل",
          () => editUser(user.id),
          "secondary"
        ),
        button(
          "حذف",
          () => deleteUser(user.id),
          "danger"
        )
      );

      card.appendChild(actions);
      container.appendChild(card);
    });
}

/* ================= سجل التغييرات ================= */

function renderHistory() {
  const container = clear("historyList");

  if (!container) return;

  if (!db.history.length) {
    container.appendChild(
      el(
        "p",
        "لا توجد عمليات مسجلة في السجل."
      )
    );

    return;
  }

  db.history.forEach(item => {
    const card = makeCard(
      item.action || "عملية"
    );

    detail(
      card,
      "التاريخ والوقت",
      formatDateTime(item.date)
    );

    detail(
      card,
      "المستخدم",
      item.user || "النظام"
    );

    if (item.zone) {
      detail(
        card,
        "النطاق",
        item.zone
      );
    }

    if (item.details) {
      detail(
        card,
        "التفاصيل",
        item.details
      );
    }

    if (isSuperAdmin()) {
      const actions = el(
        "div",
        "",
        "actions"
      );

      actions.appendChild(
        button(
          "حذف",
          () => deleteHistoryItem(item.id),
          "danger"
        )
      );

      card.appendChild(actions);
    }

    container.appendChild(card);
  });
}

function deleteHistoryItem(id) {
  if (!requireSuperAdmin()) return;

  if (
    !confirm(
      "هل تريدين حذف هذا السجل؟"
    )
  ) {
    return;
  }

  const previous = [...db.history];

  db.history = db.history.filter(
    item =>
      String(item.id) !== String(id)
  );

  if (!save()) {
    db.history = previous;
    return;
  }

  renderHistory();
}

function clearHistory() {
  if (!requireSuperAdmin()) return;

  if (!db.history.length) {
    alert("السجل فارغ.");
    return;
  }

  if (
    !confirm(
      "هل تريدين حذف سجل التغييرات بالكامل؟"
    )
  ) {
    return;
  }

  const previous = [...db.history];

  db.history = [];

  if (!save()) {
    db.history = previous;
    return;
  }

  renderHistory();

  alert("تم حذف سجل التغييرات.");
}

/* ================= النسخ الاحتياطي ================= */

function downloadBackup() {
  if (!requireAdmin()) return;

  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    db,
    users,
    reports,
    reportAlerts,
    weeklyDrafts,
    directives
  };

  const blob = new Blob(
    [
      JSON.stringify(
        backup,
        null,
        2
      )
    ],
    {
      type: "application/json;charset=utf-8"
    }
  );

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");

  link.href = url;

  link.download =
    "inspection-backup-" +
    dateISO() +
    ".json";

  document.body.appendChild(link);

  link.click();
  link.remove();

  URL.revokeObjectURL(url);
}

function importBackupFile(event) {
  if (!requireSuperAdmin()) return;

  const file =
    event.target.files?.[0];

  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const backup =
        JSON.parse(reader.result);

      if (
        !backup ||
        typeof backup !== "object"
      ) {
        throw new Error(
          "Invalid backup"
        );
      }

      if (
        !confirm(
          "استعادة النسخة الاحتياطية ستستبدل البيانات الحالية. هل تريدين المتابعة؟"
        )
      ) {
        event.target.value = "";
        return;
      }

      if (
        backup.db &&
        typeof backup.db === "object"
      ) {
        db = backup.db;
      }

      if (
        Array.isArray(backup.users)
      ) {
        // من له حساب دخول هنا يبقى كما هو، والباقون يُضافون بدون كلمات مرور
        // (كلمات المرور القديمة لا تُنقل، ويحدد المسؤول كلمات جديدة)
        const merged = publicUsers(users);

        publicUsers(backup.users).forEach(item => {
          const name = item.name || item.fullName;
          if (!merged.some(u => sameName(u.name || u.fullName, name))) {
            delete item.authUid;
            delete item.loginEmail;
            merged.push(item);
          }
        });

        users = merged;
      }

      if (
        Array.isArray(backup.reports)
      ) {
        reports = backup.reports;
      }

      if (
        Array.isArray(
          backup.reportAlerts
        )
      ) {
        reportAlerts =
          backup.reportAlerts;
      }

      if (
        backup.weeklyDrafts &&
        typeof backup.weeklyDrafts ===
          "object" &&
        !Array.isArray(
          backup.weeklyDrafts
        )
      ) {
        weeklyDrafts =
          backup.weeklyDrafts;
      }

      if (
        Array.isArray(
          backup.directives
        )
      ) {
        directives =
          backup.directives;
      }

      [
        "inspectors",
        "zones",
        "history",
        "replacementRequests"
      ].forEach(key => {
        if (!Array.isArray(db[key])) {
          db[key] = [];
        }
      });

      save();
      saveUsers();
      saveReports();
      saveAlerts();
      saveDrafts();
      saveDirectives();

      event.target.value = "";

      renderAll();

      alert(
        "تمت استعادة النسخة الاحتياطية بنجاح."
      );
    } catch (error) {
      console.error(error);

      event.target.value = "";

      alert(
        "تعذر قراءة ملف النسخة الاحتياطية."
      );
    }
  };

  reader.readAsText(file);
}

/* ================= توجيهات المفتش ================= */
/* ================= دوال مساعدة للتوجيهات ================= */

function getDirectiveStatus(item) {
  if (item.completedAt) return "مُنجز";
  if (item.acknowledgedAt) return "تم الاطلاع";
  return "بانتظار الاطلاع";
}

function isDirectiveOverdue(item) {
  if (!item.dueDate || item.completedAt) {
    return false;
  }

  return new Date(item.dueDate).getTime() <
    Date.now();
}

/* ================= عرض التوجيهات للمفتش ================= */

function renderInspectorDirectives() {
  if (!isInspector()) return;

  const page = $("inspectorDashboardPage");

  if (!page) return;

  let container = $("inspectorDirectivesSection");

  if (!container) {
    container = document.createElement("section");
    container.id = "inspectorDirectivesSection";
    container.className = "directives-section";

    const heading = document.createElement("h2");
    heading.textContent = "التوجيهات الواردة";

    container.appendChild(heading);

    page.prepend(container);
  }

  container.replaceChildren();

  container.appendChild(
    el("h2", "التوجيهات الواردة")
  );

  const name = getCurrentInspectorName();

  const items = getInspectorDirectives(name)
    .sort((a, b) =>
      new Date(b.createdAt) -
      new Date(a.createdAt)
    );

  if (!items.length) {
    container.appendChild(
      el("p", "لا توجد توجيهات واردة حالياً.")
    );
    return;
  }

  items.forEach(item => {
    const card = makeCard("توجيه إداري");

    // أحمر للمفتش: توجيه لم يرد عليه بعد
    if (!item.completedAt) {
      const notification = el(
        "p",
        "● توجيه بانتظار ردك",
        "directive-notification"
      );

      notification.style.color = "#dc2626";
      notification.style.fontWeight = "bold";

      card.style.borderInlineStart = "5px solid #dc2626";
      card.appendChild(notification);
    }

    detail(card, "التوجيه", item.text);

    detail(
      card,
      "تاريخ الإصدار",
      formatDateTime(item.createdAt)
    );

    detail(
      card,
      "الموعد النهائي",
      formatDateTime(item.dueDate)
    );

    detail(
      card,
      "الحالة",
      getDirectiveStatus(item)
    );

    if (isDirectiveOverdue(item)) {
      const warning = el(
        "p",
        "تنبيه: تجاوز التوجيه الموعد المحدد."
      );

      warning.style.color = "#b42318";
      warning.style.fontWeight = "bold";

      card.appendChild(warning);
    }

    if (!item.acknowledgedAt) {
      card.appendChild(
        button(
          "تأكيد الاطلاع على التوجيه",
          () => acknowledgeDirective(item.id)
        )
      );
    } else {
      detail(
        card,
        "تاريخ الاطلاع",
        formatDateTime(item.acknowledgedAt)
      );
    }

    if (item.acknowledgedAt && !item.completedAt) {
      card.appendChild(
        button(
          "إنجاز التوجيه وإرسال الرد",
          () => completeDirective(item.id)
        )
      );
    }

    if (item.completedAt) {
      detail(
        card,
        "تاريخ الإنجاز",
        formatDateTime(item.completedAt)
      );

      detail(
        card,
        "رد المفتش",
        item.completionReply || "—"
      );

      detail(
        card,
        "طريقة تسليم الرد",
        item.deliveryMethod || "—"
      );
    }

    container.appendChild(card);
  });
}

/* ================= تأكيد اطلاع المفتش ================= */

function acknowledgeDirective(id) {
  if (!isInspector()) return;

  const item = directives.find(directive =>
    String(directive.id) === String(id)
  );

  if (
    !item ||
    !sameName(
      item.inspector,
      getCurrentInspectorName()
    ) ||
    item.acknowledgedAt
  ) {
    return;
  }

  if (!confirm("هل تؤكدين الاطلاع على التوجيه؟")) {
    return;
  }

  item.acknowledgedAt = new Date().toISOString();

  if (!saveDirectives()) return;

  renderInspectorDirectives();

  alert("تم تأكيد الاطلاع على التوجيه.");
}

/* ================= إنجاز التوجيه ================= */

function completeDirective(id) {
  if (!isInspector()) return;

  const item = directives.find(directive =>
    String(directive.id) === String(id)
  );

  if (
    !item ||
    !sameName(
      item.inspector,
      getCurrentInspectorName()
    ) ||
    !item.acknowledgedAt ||
    item.completedAt
  ) {
    return;
  }

  const reply = prompt(
    "اكتبي الرد على التوجيه والأعمال التي تم إنجازها:"
  );

  if (reply === null) return;

  if (!reply.trim()) {
    alert("يرجى كتابة الرد قبل تسجيل الإنجاز.");
    return;
  }

  const method = prompt(
    "طريقة تسليم الرد: البريد الإلكتروني / النظام / باليد"
  );

  if (method === null) return;

  if (!method.trim()) {
    alert("يرجى تحديد طريقة تسليم الرد.");
    return;
  }

  item.completionReply = reply.trim();
  item.reply = reply.trim();
  item.deliveryMethod = method.trim();
  item.status = "completed";
  item.completedBy = getCurrentInspectorName();
  item.completedAt = new Date().toISOString();
  item.adminViewedCompletionAt = null;

  if (!saveDirectives()) return;

  renderInspectorDirectives();

  alert("تم تسجيل إنجاز التوجيه وإرسال الرد.");
}
/* ================= متابعة الإدارة ================= */

function renderAdminDirectives() {
  if (!isAdmin()) return;

  const page = $("inspectorsPage");

  if (!page) return;

  let container = $("adminDirectivesSection");

  if (!container) {
    container = document.createElement("section");
    container.id = "adminDirectivesSection";

    page.appendChild(container);
  }

  container.replaceChildren();

  container.appendChild(
    el("h2", "متابعة التوجيهات")
  );

  if (!directives.length) {
    container.appendChild(
      el("p", "لا توجد توجيهات مسجلة.")
    );
    return;
  }

  [...directives].reverse().forEach(item => {
    const card = makeCard(item.inspector);

    detail(card, "التوجيه", item.text);

    detail(
      card,
      "الموعد النهائي",
      formatDateTime(item.dueDate)
    );

    detail(
      card,
      "الحالة",
      getDirectiveStatus(item)
    );

    if (item.acknowledgedAt) {
      detail(
        card,
        "تاريخ اطلاع المفتش",
        formatDateTime(item.acknowledgedAt)
      );
    }

    if (item.completedAt) {
      detail(
        card,
        "تاريخ الإنجاز",
        formatDateTime(item.completedAt)
      );

      detail(
        card,
        "رد المفتش",
        item.completionReply || item.reply || "—"
      );

      detail(
        card,
        "طريقة التسليم",
        item.deliveryMethod
      );
    }

    if (isDirectiveOverdue(item)) {
      const warning = el(
        "p",
        "● التوجيه متأخر عن الموعد النهائي"
      );

      warning.style.color = "#b42318";
      card.appendChild(warning);
    }

    applyDirectiveSignal(card, item);

    const actions = el("div", "", "actions");

    // الأزرق يبقى حتى تضغط الإدارة "تم الاطلاع على الرد"
    if (item.completedAt && !item.adminViewedCompletionAt) {
      actions.appendChild(
        button(
          "تم الاطلاع على الرد",
          () => {
            item.adminViewedCompletionAt =
              new Date().toISOString();

            if (saveDirectives()) {
              renderAll();
            }
          },
          "secondary"
        )
      );
    }

    actions.appendChild(
      button(
        "حذف",
        () => deleteDirective(item.id),
        "danger"
      )
    );

    card.appendChild(actions);

    container.appendChild(card);
  });
}

/* ================= حذف التوجيه ================= */

function deleteDirective(id) {
  if (!requireAdmin()) return;

  const item = directives.find(directive =>
    String(directive.id) === String(id)
  );

  if (!item) return;

  if (
    !confirm(
      `هل تريدين حذف التوجيه "${item.text}" الخاص بالمفتش ${item.inspector}؟`
    )
  ) {
    return;
  }

  directives = directives.filter(directive => directive !== item);

  if (!saveDirectives()) return;

  logChange("", "حذف توجيه", `${item.inspector}: ${item.text}`);
  renderAll();
}

/* ================= ربط نموذج التوجيهات ================= */

function initializeDirectives() {
  const form = $("directiveForm");

  if (form && !form.dataset.directivesBound) {
    form.addEventListener(
      "submit",
      saveDirective
    );

    form.dataset.directivesBound = "true";
  }

  if (currentUser) {
    if (isAdmin()) {
      renderAdminDirectives();
    }

    if (isInspector()) {
      renderInspectorDirectives();
    }
  }
}
/* ================= تحديث جميع الواجهات ================= */

// fromRemote: تحديث قادم من مستخدم آخر، فلا نعيد رسم النماذج
// حتى لا يضيع ما يكتبه المستخدم الحالي
function renderAll(fromRemote = false) {
  if (!currentUser) return;

  if (isAdmin()) {
    renderGeneralNotes("adminGeneralNotes");
    renderFieldSupervisors();
    renderZones();
    renderAlerts();
    renderInspectors();
    renderReplacementRequests();
    renderWeeklyReports();
    renderMissingWeeklyReports();
    if (!fromRemote) renderReminderInspectors();
    renderHistory();
    renderAdminDirectives();

    if (isSuperAdmin()) {
      renderUsers();
    }

    const directivesDialog = $("inspectorDirectivesDialog");

    if (directivesDialog?.open) {
      showInspectorDirectives(directivesDialog.dataset.inspector);
    }
  }

  if (isInspector()) {
    renderInspectorDashboard();

    if (!fromRemote) {
      renderInspectorWeeklyReportForm();
      renderRequestForm();
    }

    renderInspectorDirectives();
  }
}

/* ================= ربط النماذج ================= */

function bindForm(id, handler) {
  const form = $(id);

  if (!form || form.dataset.systemBound === "true") {
    return;
  }

  form.addEventListener("submit", handler);
  form.dataset.systemBound = "true";
}

/* ================= تشغيل النظام ================= */

function initializeSystem() {
  bindForm("loginForm", handleLogin);
  bindForm("zoneForm", saveZone);
  bindForm("assignmentForm", saveAssignment);
  bindForm("weeklyReportForm", submitWeeklyReport);
  bindForm("inspectorRequestForm", submitReplacementRequest);
  bindForm("userForm", saveUser);
  bindForm("fieldSupervisorForm", saveFieldSupervisor);

  const reportFields = [
    "reportMonday",
    "reportTuesday",
    "reportWednesday",
    "reportThursday",
    "mondayViolations",
    "tuesdayViolations",
    "wednesdayViolations",
    "thursdayViolations",
    "mondayReports",
    "tuesdayReports",
    "wednesdayReports",
    "thursdayReports"
  ];

  reportFields.forEach(id => {
    const field = $(id);

    if (!field || field.dataset.draftBound === "true") {
      return;
    }

    field.addEventListener(
      "input",
      scheduleWeeklyDraftSave
    );

    field.dataset.draftBound = "true";
  });

  $("search")?.addEventListener("input", renderZones);

  initializeDirectives();

  backToEntry();
}

/* ================= الاتصال بقاعدة البيانات ================= */

function showStartupMessage(message) {
  if ($("loadingMessage")) $("loadingMessage").textContent = message;
}

function readLocalBackup() {
  const local = {};

  [...SHARED_KEYS, DRAFTS_KEY].forEach(key => {
    try {
      const value = localStorage.getItem(key);
      if (value !== null) local[key] = JSON.parse(value);
    } catch (error) {
      console.error(error);
    }
  });

  return local;
}

// عند أول تشغيل: نقل البيانات المحفوظة سابقاً في هذا المتصفح إلى قاعدة البيانات
function migrateLocalData() {
  const local = readLocalBackup();
  if (!Object.keys(local).length) return;

  if (
    !confirm(
      "قاعدة البيانات فارغة، وتوجد بيانات محفوظة سابقاً في هذا المتصفح. هل تريدين رفعها إلى قاعدة البيانات المشتركة؟"
    )
  ) {
    return;
  }

  Object.entries(local).forEach(([key, value]) => {
    storeData(key, value);
  });
}

async function connectCloud() {
  if (
    typeof firebase === "undefined" ||
    typeof FIREBASE_CONFIG === "undefined" ||
    !FIREBASE_CONFIG.apiKey
  ) {
    throw new Error("missing-config");
  }

  // اسم مستقل حتى لا يختلط دخول هذه المنصة بدخول المنصات الأخرى على نفس الموقع
  const app = firebase.initializeApp(FIREBASE_CONFIG, "zones");

  zonesAuth = app.auth();
  cloudStore = app.firestore();

  // قبل الدخول تُقرأ قائمة الأسماء فقط (بدون كلمات مرور)
  const directory = await cloudStore
    .collection(DIRECTORY_COLLECTION).doc("users").get();

  cloudCache[USERS_KEY] = directory.exists
    ? publicUsers(JSON.parse(directory.data().value))
    : [];
}

// بيانات النطاقات والتقارير لا تُقرأ إلا بعد تسجيل الدخول
async function loadMemberData() {
  const [systemSnap, draftsSnap] = await Promise.all([
    cloudStore.collection(SYSTEM_COLLECTION).get(),
    cloudStore.collection(DRAFTS_COLLECTION).get()
  ]);

  systemSnap.forEach(doc => {
    // المستخدمون في النسخة القديمة كانوا هنا مع كلمات المرور، فيُحذف المستند
    if (doc.id === USERS_KEY) {
      doc.ref.delete().catch(error => console.error(error));
      return;
    }

    cloudCache[doc.id] = JSON.parse(doc.data().value);
  });

  const drafts = {};

  draftsSnap.forEach(doc => {
    const data = doc.data();
    drafts[data.key] = JSON.parse(data.value);
  });

  cloudCache[DRAFTS_KEY] = drafts;

  if (systemSnap.empty) migrateLocalData();
}

function clearMemberData() {
  Object.keys(cloudCache).forEach(key => {
    if (key !== USERS_KEY) delete cloudCache[key];
  });
}

function applyRemoteState() {
  loadState();

  if (currentUser) {
    const fresh = users.find(
      u => String(u.id) === String(currentUser.id)
    );

    if (!fresh) {
      logoutPortal();
      return;
    }

    currentUser = fresh;
    renderAll(true);
    return;
  }

  if (!$("loginPage")?.classList.contains("hidden")) {
    const selected = $("loginName")?.value;
    fillLoginNames();
    if (selected) $("loginName").value = selected;
  }
}

// قائمة الأسماء تتحدث دائماً (لشاشة الدخول ولإضافة المستخدمين)
function listenToDirectory() {
  cloudStore
    .collection(DIRECTORY_COLLECTION).doc("users")
    .onSnapshot(doc => {
      cloudCache[USERS_KEY] = doc.exists
        ? publicUsers(JSON.parse(doc.data().value))
        : [];

      if (cloudStore) applyRemoteState();
    }, error => console.error(error));
}

let memberListeners = [];

function stopMemberListeners() {
  memberListeners.forEach(stop => stop());
  memberListeners = [];
}

function listenForChanges() {
  stopMemberListeners();

  memberListeners.push(cloudStore
    .collection(SYSTEM_COLLECTION)
    .onSnapshot(snapshot => {
      let changed = false;

      snapshot.docChanges().forEach(change => {
        if (change.doc.id === USERS_KEY) return;

        if (change.type === "removed") {
          delete cloudCache[change.doc.id];
        } else {
          cloudCache[change.doc.id] =
            JSON.parse(change.doc.data().value);
        }

        changed = true;
      });

      if (changed) applyRemoteState();
    }, error => console.error(error)));

  memberListeners.push(cloudStore
    .collection(DRAFTS_COLLECTION)
    .onSnapshot(snapshot => {
      const drafts = {};

      snapshot.forEach(doc => {
        const data = doc.data();
        drafts[data.key] = JSON.parse(data.value);
      });

      cloudCache[DRAFTS_KEY] = drafts;
      weeklyDrafts = clone(drafts);
    }, error => console.error(error)));
}

// الدخول محفوظ على الجهاز: عند فتح الصفحة يدخل المستخدم مباشرة
async function handleAuthState(fbUser) {
  if (setupBusy) return;

  if (!fbUser) {
    stopMemberListeners();
    clearMemberData();
    currentUser = null;
    loadState();
    backToEntry();
    return;
  }

  try {
    const account = await cloudStore
      .collection(ACCOUNTS_COLLECTION).doc(fbUser.uid).get();

    if (!account.exists) throw new Error("no-account");

    await loadMemberData();
    loadState();

    const user = users.find(
      u => String(u.id) === String(account.data().userId)
    );

    if (!user) throw new Error("no-account");

    listenForChanges();
    openUserSession(user);
  } catch (error) {
    console.error(error);
    await zonesAuth.signOut();

    if (error.message === "no-account") {
      alert("هذا الحساب لم يعد مفعّلاً. تواصلي مع المسؤول الرئيسي.");
    }
  }
}

/* ================= بدء التشغيل ================= */

async function startSystem() {
  try {
    await connectCloud();
  } catch (error) {
    console.error(error);

    showStartupMessage(
      error.message === "missing-config"
        ? "لم يتم إعداد قاعدة البيانات بعد. يرجى إضافة إعدادات Firebase في ملف firebase-config.js."
        : "تعذر الاتصال بقاعدة البيانات. تأكدي من الاتصال بالإنترنت ثم حدّثي الصفحة."
    );
    return;
  }

  loadState();

  $("loadingPage")?.classList.add("hidden");

  initializeSystem();
  listenToDirectory();
  zonesAuth.onAuthStateChanged(handleAuthState);
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    startSystem
  );
} else {
  startSystem();
}

/* ================= وظائف أزرار HTML ================= */

Object.assign(window, {
  openPortal,
  backToEntry,
  logoutPortal,
  showPage,
  openZone,
  addInspector,
  openAssignment,
  toggleAssignmentFields,
  sendWeeklyReminder,
  downloadBackup,
  importBackupFile,
  clearHistory,
  addTransactionRow
});