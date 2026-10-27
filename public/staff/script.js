
"use strict";

/* =========================
   الإعدادات وحفظ البيانات
========================= */

// مفتاح البيانات القديمة المحفوظة في المتصفح (للاستيراد فقط)
const LEGACY_KEY = "training_system_v3";

// profiles: تاريخ التعيين ورصيد الإجازات (لصاحبه فقط، لا يراها أحد غيره)
// contacts: الوصف وبيانات التواصل (يراها الجميع، ويعدّلها صاحبها فقط)
// absences: ملخص الغيابات (التواريخ فقط) لفحص التعارض دون كشف تفاصيل الطلبات
const COLLECTIONS = [
  "departments","units","users","requests","inquiries",
  "assignments","instructions","notes","leaves","profiles","contacts","absences"
];

// نطاق حسابات الدخول الداخلية (الموظف لا يراها)
const LOGIN_DOMAIN = "staff.tech-services-dep-staff.firebaseapp.com";

// نفس اسم تطبيق الصفحة الرئيسية: من دخل منها يدخل هنا مباشرة بنفس الحساب
const fbApp = firebase.initializeApp(firebaseConfig, "portal");
const auth = fbApp.auth();
const fs = fbApp.firestore();

const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID
  ? crypto.randomUUID()
  : String(Date.now()) + Math.random().toString(36).slice(2);

const now = () => new Date().toISOString();
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",
    '"':"&quot;","'":"&#39;"
  })[c]);
}

function emptyDB() {
  return Object.fromEntries(COLLECTIONS.map(k => [k,[]]));
}

let db = emptyDB();
// آخر نسخة معروفة من كل مستند في Firestore، لمعرفة ما تغيّر
let synced = Object.fromEntries(COLLECTIONS.map(k => [k,new Map()]));
let currentUserId = null;
let currentTab = "dashboard";

const sortKey = x => x.createdAt || x._createdAt || "";

// ملخص الغياب المشتق من طلب إجازة أو دورة
function absenceOf(k,item) {
  return {
    id:item.id,
    source:k,
    employeeId:item.employeeId,
    departmentId:item.departmentId || "",
    type:k === "leaves" ? item.type : "course",
    startDate:item.startDate,
    endDate:item.endDate,
    status:item.status,
    coverId:item.coverId || "",
    days:item.days || 0,
    workDays:item.workDays || 0
  };
}

function sameAbsence(a,b) {
  return !!b && Object.keys(a).every(key => a[key] === b[key]);
}

// تحديث ملخص الغياب محلياً وإرجاع عملية الحفظ إن تغيّر
function absenceOp(k,item) {
  const next = absenceOf(k,item);
  const existing = db.absences.find(a => a.id === item.id);
  if (sameAbsence(next,existing)) return null;

  if (existing) Object.assign(existing,next);
  else db.absences.push(next);

  synced.absences.set(next.id,JSON.stringify(existing || next));
  return { type:"set", k:"absences", id:next.id, data:next };
}

// يرسل إلى Firestore المستندات التي أُضيفت أو عُدّلت أو حُذفت فقط
function save() {
  const ops = [];

  for (const k of COLLECTIONS) {
    const seen = new Set();

    for (const item of db[k]) {
      if (!item.createdAt && !item._createdAt && !synced[k].has(item.id)) {
        item._createdAt = now();
      }
      seen.add(item.id);

      const json = JSON.stringify(item);
      if (synced[k].get(item.id) !== json) {
        ops.push({ type:"set", k, id:item.id, data:JSON.parse(json) });
        synced[k].set(item.id,json);

        if (k === "leaves" || k === "requests") {
          const op = absenceOp(k,item);
          if (op) ops.push(op);
        }
      }
    }

    for (const id of [...synced[k].keys()]) {
      if (!seen.has(id)) {
        ops.push({ type:"delete", k, id });
        synced[k].delete(id);

        // حذف ملخص الغياب يتم لاحقاً عند مرور مجموعة absences
        if (k === "leaves" || k === "requests") {
          db.absences = db.absences.filter(a => a.id !== id);
        }
      }
    }
  }

  return commitOps(ops);
}

async function commitOps(ops) {
  for (let i = 0; i < ops.length; i += 200) {
    const batch = fs.batch();

    for (const op of ops.slice(i,i+200)) {
      const ref = fs.collection(op.k).doc(op.id);
      if (op.type === "set") batch.set(ref,op.data);
      else batch.delete(ref);
    }

    try {
      await batch.commit();
    } catch (err) {
      console.error(err);
      notify("تعذّر حفظ التغييرات في قاعدة البيانات. حدّث الصفحة وحاول مرة أخرى.");
      return false;
    }
  }
  return true;
}

// دمج التحديثات في نفس الكائنات حتى تبقى النوافذ المفتوحة مرتبطة بها
function applySnapshot(k,docs) {
  const old = new Map(db[k].map(x => [x.id,x]));
  const unique = [...new Map(docs.map(d => [d.id,d])).values()];

  db[k] = unique.map(d => {
    const data = { ...d.data(), id:d.id };
    const obj = old.get(d.id);
    if (!obj) return data;
    for (const key of Object.keys(obj)) {
      if (!(key in data)) delete obj[key];
    }
    return Object.assign(obj,data);
  }).sort((a,b) => sortKey(a).localeCompare(sortKey(b)));

  synced[k] = new Map(db[k].map(x => [x.id,JSON.stringify(x)]));
}

let unsubscribers = [];
let renderPending = false;

function stopSync() {
  unsubscribers.forEach(fn => fn());
  unsubscribers = [];
  db = emptyDB();
  synced = Object.fromEntries(COLLECTIONS.map(k => [k,new Map()]));
}

// ما يحمّله كل مستخدم: المديرة كل شيء، والباقي ما يخصهم فقط
// (يجب أن تطابق قواعد firestore.rules)
function syncQueries(me) {
  const all = k => [fs.collection(k)];
  const mine = (k,...fields) =>
    fields.map(f => fs.collection(k).where(f,"==",me.id));
  const admin = me.role === "admin";

  return {
    departments:all("departments"),
    units:all("units"),
    users:all("users"),
    instructions:all("instructions"),
    notes:mine("notes","userId"),
    profiles:mine("profiles","userId"),
    contacts:all("contacts"),
    leaves:admin ? all("leaves")
      : mine("leaves","employeeId","managerId","coManagerId","finalApproverId","coverId"),
    requests:admin ? all("requests")
      : mine("requests","employeeId","managerId","currentReviewerId",
          "forwardedBy","coverId","proposedCoverId"),
    inquiries:admin ? all("inquiries")
      : mine("inquiries","employeeId","managerId"),
    assignments:admin ? all("assignments")
      : mine("assignments","employeeId","managerId"),
    absences:admin ? all("absences") : [
      fs.collection("absences").where("departmentId","==",me.departmentId || ""),
      ...mine("absences","employeeId","coverId")
    ]
  };
}

// الاستماع لكل الاستعلامات، ويكتمل بعد وصول أول نسخة منها جميعاً
async function startSync(userId) {
  stopSync();

  const meDoc = await fs.collection("users").doc(userId).get();
  if (!meDoc.exists) throw { code:"no-account" };

  const queries = syncQueries({ ...meDoc.data(), id:userId });

  return new Promise((resolve,reject) => {
    let waiting = 0;

    for (const k of COLLECTIONS) {
      const parts = queries[k].map(() => []);

      queries[k].forEach((query,i) => {
        let first = true;
        waiting++;

        unsubscribers.push(query.onSnapshot(snap => {
          parts[i] = snap.docs;
          applySnapshot(k,parts.flat());

          if (first) {
            first = false;
            if (--waiting === 0) resolve();
          } else if (waiting === 0) {
            scheduleRender();
          }
        }, err => {
          console.error(k,i,err);
          if (first) reject(err);
        }));
      });
    }
  });
}

// المديرة تُكمل ملخصات الغياب الناقصة (للبيانات القديمة)
function ensureAbsences() {
  if (!isAdmin()) return;

  // إعادة حساب أيام العمل إذا تغيّرت العطلة الأسبوعية
  const stale = db.leaves.filter(l =>
    l.startDate && l.endDate &&
    l.workDays !== workingDays(l.startDate,l.endDate));
  if (stale.length) {
    stale.forEach(l => { l.workDays = workingDays(l.startDate,l.endDate); });
    save();
  }

  const ops = [];
  for (const k of ["leaves","requests"]) {
    for (const item of db[k]) {
      const op = absenceOp(k,item);
      if (op) ops.push(op);
    }
  }
  if (ops.length) commitOps(ops);
}

// تأجيل إعادة العرض أثناء الكتابة داخل حقل حتى لا يضيع ما يُكتب
function scheduleRender() {
  if ($("appPage").classList.contains("hidden")) return;

  if (!current() || current().active === false) {
    auth.signOut();
    return;
  }

  const el = document.activeElement;
  if (el && $("appPage").contains(el) &&
      ["INPUT","TEXTAREA","SELECT"].includes(el.tagName)) {
    renderPending = true;
    return;
  }

  renderAll();
}

document.addEventListener("focusout",() => {
  if (!renderPending) return;
  setTimeout(() => {
    if (renderPending) {
      renderPending = false;
      scheduleRender();
    }
  },150);
});

// توحيد كتابة الاسم حتى لا يفشل الدخول بسبب الهمزات أو المسافات
function loginKey(name) {
  return String(name ?? "")
    .replace(/[ً-ْـ]/g,"")
    .replace(/[أإآ]/g,"ا")
    .replace(/ى/g,"ي")
    .replace(/ة/g,"ه")
    .replace(/\//g,"-")
    .replace(/\s+/g," ")
    .trim();
}

function newLoginEmail() {
  return `u${uid().replace(/-/g,"").slice(0,20)}@${LOGIN_DOMAIN}`;
}

// تطبيق Firebase ثانوي لإنشاء حسابات الموظفين دون تسجيل خروج المديرة
let secondaryAuth = null;

async function createLoginAccount(password) {
  if (!secondaryAuth) {
    secondaryAuth = firebase.initializeApp(firebaseConfig,"secondary").auth();
    await secondaryAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);
  }

  const email = newLoginEmail();
  const cred = await secondaryAuth.createUserWithEmailAndPassword(email,password);
  await secondaryAuth.signOut();
  return { email, authUid:cred.user.uid };
}

function authErrorText(err) {
  const messages = {
    "auth/invalid-credential":"الاسم أو كلمة المرور غير صحيحة.",
    "auth/invalid-login-credentials":"الاسم أو كلمة المرور غير صحيحة.",
    "auth/wrong-password":"كلمة المرور غير صحيحة.",
    "auth/user-not-found":"الاسم أو كلمة المرور غير صحيحة.",
    "auth/weak-password":"كلمة المرور يجب أن تكون 6 أحرف على الأقل.",
    "auth/too-many-requests":"محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.",
    "auth/network-request-failed":"تعذّر الاتصال بالإنترنت.",
    "auth/requires-recent-login":"سجّل الخروج ثم الدخول مرة أخرى وأعد المحاولة.",
    "auth/operation-not-allowed":"تسجيل الدخول بالبريد وكلمة المرور غير مفعّل في Firebase.",
    "permission-denied":"لا توجد صلاحية. تأكد من نشر قواعد الحماية في Firestore."
  };
  return messages[err?.code] || `حدث خطأ: ${err?.message || err}`;
}

function user(id) {
  return db.users.find(x => x.id === id);
}

function current() {
  return user(currentUserId);
}

function username(id) {
  return user(id)?.name || "غير محدد";
}

function department(id) {
  return db.departments.find(x => x.id === id);
}

function unit(id) {
  return db.units.find(x => x.id === id);
}

function departmentName(id) {
  return department(id)?.name || "بدون قسم";
}

function unitName(id) {
  return unit(id)?.name || "بدون شعبة";
}

function activeUsers() {
  return db.users.filter(x => x.active !== false);
}

function isAdmin() {
  return current()?.role === "admin";
}

function managesAnyone(id = currentUserId) {
  return db.departments.some(d => d.managerId === id) ||
    db.units.some(u => u.managerId === id);
}

function getManagerId(u) {
  if (!u) return null;
  const selectedUnit = unit(u.unitId);
  const selectedDepartment = department(u.departmentId);

  const candidates = [
    selectedUnit?.managerId,
    selectedDepartment?.managerId
  ];

  return candidates.find(id => id && id !== u.id && user(id)) || null;
}

function teamMembers(managerId = currentUserId) {
  return activeUsers().filter(u => getManagerId(u) === managerId);
}

function isHead(id) {
  return db.departments.some(d => d.managerId === id) ||
    db.units.some(u => u.managerId === id);
}

function log(item, action, notes = "") {
  if (!Array.isArray(item.history)) item.history = [];
  item.history.push({
    action, by:currentUserId, at:now(), notes
  });
}

function formatDate(s) {
  if (!s) return "غير محدد";
  return new Date(s + "T12:00:00").toLocaleDateString("ar-AE");
}

function daysBetween(start,end) {
  if (!start || !end) return "";
  const a = Date.parse(start + "T00:00:00Z");
  const b = Date.parse(end + "T00:00:00Z");
  return Math.round((b-a)/86400000)+1;
}

function notify(message) {
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  setTimeout(() => $("toast").classList.add("hidden"), 3200);
}

function empty(container, message = "لا توجد بيانات حالياً") {
  container.innerHTML = `<div class="empty">${esc(message)}</div>`;
}

function badge(status) {
  const labels = {
    pending:"قيد المراجعة",
    approved:"معتمد",
    rejected:"مرفوض",
    withdrawn:"مسحوب",
    new:"جديد",
    in_progress:"قيد التنفيذ",
    completed:"تم الإنجاز",
    returned:"مرتجع للمسؤول",
    closed:"مغلق",
    open:"مفتوح",
    not_started:"لم تبدأ"
  };

  const colors = {
    pending:"pending", approved:"approved",
    rejected:"rejected", withdrawn:"withdrawn",
    new:"new", in_progress:"progress",
    completed:"done", returned:"returned",
    closed:"closed", open:"new",
    not_started:"new"
  };

  return `<span class="badge ${colors[status] || "new"}">
    ${esc(labels[status] || status)}
  </span>`;
}

function option(value,text,selected=false) {
  return `<option value="${esc(value)}" ${selected?"selected":""}>
    ${esc(text)}
  </option>`;
}

function openModal(title,html) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  $("modal").classList.remove("hidden");
}

function closeModal() {
  $("modal").classList.add("hidden");
  $("modalBody").innerHTML = "";
}

$("modalClose").onclick = closeModal;
$("modal").addEventListener("click", e => {
  if (e.target === $("modal")) closeModal();
});

/* =========================
   الدخول والحساب الأول
========================= */

function showPage(id) {
  ["loadingPage","setupPage","loginPage","appPage"].forEach(p =>
    $(p).classList.toggle("hidden",p !== id)
  );
}

function legacyData() {
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_KEY) || "{}");
    return Array.isArray(old.users) && old.users.length ? old : null;
  } catch { return null; }
}

async function showAuth() {
  showPage("loadingPage");
  $("loadingText").textContent = "جاري الاتصال بقاعدة البيانات...";

  try {
    // الحسابات تُنشأ من الصفحة الرئيسية، فلا توجد هنا صفحة إعداد أول مرة
    await fs.collection("meta").doc("setup").get();
    showPage("loginPage");
  } catch (err) {
    console.error(err);
    $("loadingText").textContent = err?.code === "permission-denied"
      ? "قواعد الحماية غير منشورة في Firestore بعد."
      : "تعذّر الاتصال بقاعدة البيانات. تأكد من الإنترنت ومن إنشاء Firestore.";
  }
}

// يمنع معالج الدخول من التدخل أثناء إنشاء الحساب الأول
let setupBusy = false;

$("setupForm").onsubmit = async e => {
  e.preventDefault();

  const name = $("setupName").value.trim();
  const password = $("setupPassword").value;
  $("setupError").textContent = "";

  if (name.split(/\s+/).length < 3) {
    $("setupError").textContent = "يرجى كتابة الاسم الثلاثي.";
    return;
  }

  if (password !== $("setupConfirm").value) {
    $("setupError").textContent = "كلمتا المرور غير متطابقتين.";
    return;
  }

  if (password.length < 6) {
    $("setupError").textContent = "كلمة المرور يجب أن تكون 6 أحرف على الأقل.";
    return;
  }

  const old = !$("importLocalRow").classList.contains("hidden") &&
    $("importLocal").checked ? legacyData() : null;

  // إذا كان اسم المديرة موجوداً في البيانات القديمة نحتفظ بنفس المعرّف
  const oldMe = old?.users.find(u => loginKey(u.name) === loginKey(name));

  const button = e.target.querySelector("button");
  button.disabled = true;
  setupBusy = true;
  let cred = null;

  try {
    const email = newLoginEmail();
    cred = await auth.createUserWithEmailAndPassword(email,password);

    const admin = {
      ...(oldMe || {}),
      id:oldMe?.id || uid(),
      name,
      role:"admin",
      departmentId:oldMe?.departmentId || "",
      unitId:oldMe?.unitId || "",
      active:true,
      authUid:cred.user.uid,
      loginEmail:email,
      _createdAt:now()
    };
    delete admin.password;

    const batch = fs.batch();
    batch.set(fs.collection("meta").doc("setup"),{ by:admin.id, at:now() });
    batch.set(fs.collection("accounts").doc(cred.user.uid),{ userId:admin.id });
    batch.set(fs.collection("users").doc(admin.id),admin);
    batch.set(fs.collection("logins").doc(loginKey(name)),{ email });
    await batch.commit();

    setupBusy = false;
    await handleSignedIn(cred.user);

    if (old) await importLegacyData(old,admin.id);
  } catch (err) {
    console.error(err);
    $("setupError").textContent = authErrorText(err);
    if (cred && $("appPage").classList.contains("hidden")) {
      await cred.user.delete().catch(() => {});
    }
  } finally {
    setupBusy = false;
    button.disabled = false;
  }
};

// نقل بيانات المتصفح القديمة إلى Firestore وإنشاء حسابات الموظفين
async function importLegacyData(old,adminId) {
  openModal("استيراد البيانات",
    `<p id="importProgress">جاري الاستيراد، لا تغلق الصفحة...</p>`);

  const tempPasswords = [];
  const failed = [];
  const users = old.users.filter(u => u.id !== adminId);

  for (const [i,u] of users.entries()) {
    $("importProgress").textContent =
      `جاري إنشاء حسابات الموظفين (${i+1} من ${users.length})...`;

    let password = String(u.password || "");
    if (password.length < 6) {
      password = Math.random().toString(36).slice(2,10);
      tempPasswords.push([u.name,password]);
    }

    try {
      const account = await createLoginAccount(password);
      const record = {
        ...u,
        authUid:account.authUid,
        loginEmail:account.email,
        _createdAt:new Date(Date.now() + i).toISOString()
      };
      delete record.password;

      const batch = fs.batch();
      batch.set(fs.collection("accounts").doc(account.authUid),{ userId:u.id });
      batch.set(fs.collection("users").doc(u.id),record);
      batch.set(fs.collection("logins").doc(loginKey(u.name)),{ email:account.email });
      await batch.commit();
    } catch (err) {
      console.error(err);
      failed.push(u.name);
    }
  }

  $("importProgress").textContent = "جاري نقل الطلبات والسجلات...";

  const ops = [];
  for (const k of COLLECTIONS) {
    if (k === "users" || k === "absences" || !Array.isArray(old[k])) continue;
    old[k].forEach((item,i) => {
      if (!item?.id) return;
      const data = JSON.parse(JSON.stringify(item));
      if (!data.createdAt) data._createdAt = new Date(Date.now() + i).toISOString();
      ops.push({ type:"set", k, id:item.id, data });
      if (k === "leaves" || k === "requests") {
        ops.push({ type:"set", k:"absences", id:item.id, data:absenceOf(k,data) });
      }
    });
  }
  await commitOps(ops);

  $("modalBody").innerHTML = `
    <p>تم استيراد البيانات بنجاح.</p>
    ${tempPasswords.length ? `
      <div class="alert warn">
        <b>هؤلاء أُعطوا كلمات مرور مؤقتة (يدخل بها الموظف ثم يغيّرها من «تغيير كلمة المرور»):</b>
        <div id="tempPasswordList">${tempPasswords.map(([n,p]) =>
          `<p>• ${esc(n)}: <b dir="ltr">${esc(p)}</b></p>`).join("")}</div>
        <button class="btn outline small" id="copyTempPasswords">نسخ القائمة</button>
        <p>احفظي هذه القائمة الآن، فلن تظهر مرة أخرى.</p>
      </div>` : ""}
    ${failed.length ? alertBox("danger",
      `<b>تعذّر إنشاء حسابات:</b> ${failed.map(esc).join("، ")}
       — أضيفيهم يدوياً من إدارة النظام.`) : ""}
    <p class="meta">يمكنك حذف البيانات القديمة من هذا المتصفح لاحقاً.</p>
  `;

  $("copyTempPasswords")?.addEventListener("click",async()=>{
    const text=tempPasswords.map(([n,p])=>`${n}: ${p}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      notify("تم نسخ القائمة. الصقيها في ملف واحفظيه.");
    } catch {
      notify("تعذّر النسخ. حددي القائمة وانسخيها يدوياً.");
    }
  });
}

$("loginForm").onsubmit = async e => {
  e.preventDefault();

  const name = $("loginName").value;
  const password = $("loginPassword").value;
  const button = e.target.querySelector("button");
  $("loginError").textContent = "";
  button.disabled = true;

  try {
    const login = await fs.collection("logins").doc(loginKey(name)).get();
    if (!login.exists) {
      $("loginError").textContent = "الاسم أو كلمة المرور غير صحيحة.";
      return;
    }
    await auth.signInWithEmailAndPassword(String(login.data().email).trim(),password);
    $("loginPassword").value = "";
  } catch (err) {
    $("loginError").textContent = authErrorText(err);
  } finally {
    button.disabled = false;
  }
};

$("logoutBtn").onclick = () => auth.signOut();

$("changePasswordBtn").onclick = () => {
  openModal("تغيير كلمة المرور",`
    <label>كلمة المرور الحالية</label>
    <input id="currentPassword" type="password">
    <label>كلمة المرور الجديدة</label>
    <input id="newPassword" type="password">
    <label>تأكيد كلمة المرور الجديدة</label>
    <input id="newPasswordConfirm" type="password">
    <p id="passwordError" class="error"></p>
    <button class="btn primary" id="savePassword">حفظ</button>
  `);

  $("savePassword").onclick = async () => {
    const password = $("newPassword").value;
    if (password.length < 6) {
      $("passwordError").textContent = "كلمة المرور يجب أن تكون 6 أحرف على الأقل.";
      return;
    }
    if (password !== $("newPasswordConfirm").value) {
      $("passwordError").textContent = "كلمتا المرور غير متطابقتين.";
      return;
    }

    try {
      const fbUser = auth.currentUser;
      await fbUser.reauthenticateWithCredential(
        firebase.auth.EmailAuthProvider.credential(fbUser.email,$("currentPassword").value)
      );
      await fbUser.updatePassword(password);
      closeModal();
      notify("تم تغيير كلمة المرور.");
    } catch (err) {
      $("passwordError").textContent = authErrorText(err);
    }
  };
};

async function handleSignedIn(fbUser) {
  showPage("loadingPage");
  $("loadingText").textContent = "جاري تحميل البيانات...";

  try {
    const account = await fs.collection("accounts").doc(fbUser.uid).get();
    if (!account.exists) throw { code:"no-account" };

    // تجاهل المسافات وعلامات التنصيص الملصوقة بالخطأ
    currentUserId = String(account.data().userId).replace(/"/g,"").trim();
    await startSync(currentUserId);

    if (!current() || current().active === false) throw { code:"inactive" };
  } catch (err) {
    console.error(err);
    const message = {
      "no-account":"حسابك غير مضاف في شؤون الموظفين بعد. تواصل مع مديرة النظام.",
      "inactive":"هذا الحساب موقوف. تواصل مع مديرة النظام."
    }[err?.code] || authErrorText(err);

    // لا نسجّل الخروج هنا لأن الحساب مشترك مع الصفحة الرئيسية
    stopSync();
    showPage("loginPage");
    $("loginError").textContent = message;
    return;
  }

  // أخطاء العرض لا تُخرج المستخدم من حسابه (تظهر في renderAll)
  try { ensureAbsences(); } catch (err) { console.error(err); }
  enterApp();
}

function enterApp() {
  if (!current()) return showAuth();

  showPage("appPage");

  $("currentUserInfo").textContent = current().name;

  // رابط مباشر لصفحة معيّنة، مثل staff/#orgChart للهيكل التنظيمي
  const linked = location.hash.slice(1);
  showTab(titles[linked] ? linked : "dashboard");
}

const titles = {
  dashboard:"الرئيسية",
  leaves:"الإجازات",
  newRequest:"طلب دورة تدريبية",
  myRequests:"دوراتي التدريبية",
  approvals:"اعتمادات الدورات",
  coverTasks:"مهام الموظف البديل",
  inquiries:"الاستفسارات والطلبات",
  assignments:"التكليفات",
  instructions:"تعليمات الفريق",
  notes:"ملاحظاتي الخاصة",
  orgChart:"الهيكل التنظيمي",
  admin:"إدارة النظام"
};

function showTab(tab) {
  if (tab === "admin" && !isAdmin()) return;
  if (tab === "approvals" && !managesAnyone() && !isAdmin()) return;

  currentTab = tab;

  document.querySelectorAll(".tab").forEach(el =>
    el.classList.add("hidden")
  );

  $(tab+"Tab")?.classList.remove("hidden");

  document.querySelectorAll(".nav-btn").forEach(b =>
    b.classList.toggle("active",b.dataset.tab === tab)
  );

  $("pageTitle").textContent = titles[tab];
  $("pageSubtitle").textContent =
    `${departmentName(current().departmentId)} — ${current().name}`;

  renderAll();
}

document.querySelectorAll("[data-tab]").forEach(btn => {
  btn.onclick = () => showTab(btn.dataset.tab);
});

/* =========================
   الدورات التدريبية
========================= */

function renderCourseForm() {
  const me = current();
  const managerId = getManagerId(me);

  fillManagerSelect("requestManager");
  fillManagerSelect("inquiryManager");

  const old = $("proposedCover").value;

  const eligible = coverCandidates(me);

  $("proposedCover").innerHTML =
    option("","بدون بديل مقترح") +
    eligible.map(u => option(u.id,u.name)).join("");

  if (eligible.some(u => u.id === old)) {
    $("proposedCover").value = old;
  }
}

function calculateDays() {
  const n = daysBetween($("courseStart").value,$("courseEnd").value);
  $("courseDays").value = n > 0 ? n : "";
}

$("courseStart").onchange = calculateDays;
$("courseEnd").onchange = calculateDays;

function addTaskRow(title="",description="") {
  const div = document.createElement("div");
  div.className = "task-entry";
  div.innerHTML = `
    <label>عنوان المهمة</label>
    <input class="task-title" value="${esc(title)}">
    <label>تفاصيل المهمة</label>
    <textarea class="task-description">${esc(description)}</textarea>
    <button type="button" class="btn danger small remove-task">
      حذف المهمة
    </button>
  `;
  div.querySelector(".remove-task").onclick = () => div.remove();
  $("requestTasks").appendChild(div);
}

$("addTaskBtn").onclick = () => addTaskRow();

$("requestForm").onsubmit = e => {
  e.preventDefault();

  const managerId = selectedManager("requestManager");

  if (!managerId) {
    return notify("يجب تعيين مسؤول مباشر لحسابك أولاً.");
  }

  const startDate = $("courseStart").value;
  const endDate = $("courseEnd").value;
  const days = daysBetween(startDate,endDate);

  if (days < 1) return notify("تاريخ نهاية الدورة غير صحيح.");

  const tasks = [...document.querySelectorAll("#requestTasks .task-entry")]
    .map(el => ({
      id:uid(),
      title:el.querySelector(".task-title").value.trim(),
      description:el.querySelector(".task-description").value.trim(),
      status:"not_started",
      notes:"",
      updatedAt:null
    }))
    .filter(t => t.title);

  const r = {
    id:uid(),
    employeeId:currentUserId,
    managerId,
    departmentId:current().departmentId || "",
    unitId:current().unitId || "",
    courseName:$("courseName").value.trim(),
    startDate,endDate,days,
    proposedCoverId:$("proposedCover").value,
    coverId:"",
    employeeNotes:$("employeeNotes").value.trim(),
    managerNotes:"",
    tasks,
    status:"pending",
    createdAt:now(),
    decidedAt:null,
    withdrawnAt:null,
    withdrawalReason:"",
    hiddenForEmployee:false,
    hiddenForManager:false,
    history:[]
  };

  log(r,"إنشاء طلب دورة");
  db.requests.push(r);
  save();

  e.target.reset();
  $("requestTasks").innerHTML = "";
  notify("تم إرسال طلب الدورة للمسؤول.");
  showTab("myRequests");
};

function courseCard(r,context) {
  const canManage = r.managerId === currentUserId || isAdmin();
  const mine = r.employeeId === currentUserId;

  let buttons = "";

  if (context === "mine" && mine) {
    if (["pending","approved"].includes(r.status) &&
        r.startDate >= today()) {
      buttons += `
        <button class="btn warning small"
          data-action="withdraw-course" data-id="${r.id}">
          سحب الطلب
        </button>`;
    }

    if (["withdrawn","rejected","approved"].includes(r.status)) {
      buttons += `
        <button class="btn danger small"
          data-action="hide-course-employee" data-id="${r.id}">
          حذف من قائمتي
        </button>`;
    }
  }

  if (context === "manager" && canManage) {
    if (r.status === "pending") {
      buttons += `
        <button class="btn primary small"
          data-action="approve-course" data-id="${r.id}">اعتماد</button>
        <button class="btn danger small"
          data-action="reject-course" data-id="${r.id}">رفض</button>`;
    }

    if (r.status === "approved") {
      buttons += `
        <button class="btn purple small"
          data-action="change-cover" data-id="${r.id}">
          تغيير البديل
        </button>`;
    }

    if (["approved","rejected"].includes(r.status)) {
      buttons += `
        <button class="btn danger small"
          data-action="hide-course-manager" data-id="${r.id}">
          حذف من قائمتي
        </button>`;
    }
  }

  // تعديل الطلب: لصاحبه قبل القرار، وللمديرة دائماً
  if ((context === "mine" && mine && r.status === "pending") ||
      (context === "admin" && isAdmin())) {
    buttons += `
      <button class="btn outline small"
        data-action="edit-course" data-id="${r.id}">تعديل</button>`;
  }

  if (isAdmin() && r.status !== "pending" || context === "admin" && isAdmin()) {
    buttons += `
      <button class="btn danger small"
        data-action="delete-course" data-id="${r.id}">حذف نهائي</button>`;
  }

  return `
    <article class="card green">
      <div class="section-head">
        <h3>${esc(r.courseName)}</h3>
        ${badge(r.status)}
      </div>
      <p>الموظف: <b>${esc(username(r.employeeId))}</b></p>
      <p class="meta">
        ${formatDate(r.startDate)} إلى ${formatDate(r.endDate)}
        — ${esc(r.days)} أيام
      </p>
      <p>المسؤول: ${esc(username(r.managerId))}</p>
      <p>البديل المقترح: ${esc(username(r.proposedCoverId))}</p>
      <p>البديل المعتمد: ${esc(username(r.coverId))}</p>
      ${r.employeeNotes
        ? `<p>ملاحظات الموظف: ${esc(r.employeeNotes)}</p>` : ""}
      ${r.managerNotes
        ? `<p>ملاحظات المسؤول: ${esc(r.managerNotes)}</p>` : ""}
      ${r.withdrawalReason
        ? `<p>سبب السحب: ${esc(r.withdrawalReason)}</p>` : ""}
      ${courseTasksHTML(r)}
      <div class="actions">${buttons}</div>
    </article>`;
}

function renderCourses() {
  const mine = db.requests.filter(r =>
    r.employeeId === currentUserId && !r.hiddenForEmployee
  );

  const approvals = db.requests.filter(r =>
    (r.managerId === currentUserId || isAdmin()) &&
    !r.hiddenForManager
  );

  $("myRequestsList").innerHTML = mine.length
    ? [...mine].reverse().map(r => courseCard(r,"mine")).join("")
    : `<div class="empty">لا توجد طلبات دورات.</div>`;

  $("approvalsList").innerHTML = approvals.length
    ? [...approvals].reverse().map(r => courseCard(r,"manager")).join("")
    : `<div class="empty">لا توجد طلبات واردة.</div>`;

  $("allRequestsList").innerHTML = db.requests.length
    ? [...db.requests].reverse().map(r => courseCard(r,"admin")).join("")
    : `<div class="empty">لا توجد دورات في السجل.</div>`;
}

function coverOptions(r,selectedId) {
  const allowed = [...coverCandidates(user(r.employeeId)),user(r.managerId)]
    .filter((u,i,arr) => u && arr.indexOf(u) === i);

  return option("","بدون موظف بديل") +
    allowed.map(u => option(u.id,u.name,u.id === selectedId)).join("");
}

function decisionModal(r,action) {
  const approve = action === "approve";

  openModal(approve ? "اعتماد طلب الدورة" : "رفض طلب الدورة",`
    <p><b>${esc(r.courseName)}</b></p>
    <p>الموظف: ${esc(username(r.employeeId))}</p>
    <p>الفترة: ${formatDate(r.startDate)} إلى ${formatDate(r.endDate)}</p>
    <div class="divider"></div>
    <h3>المهام المطلوبة</h3>
    ${(r.tasks||[]).map(t =>
      `<p>• ${esc(t.title)} — ${esc(t.description)}</p>`
    ).join("") || "<p>لا توجد مهام.</p>"}
    ${approve ? `
      <label>الموظف البديل النهائي</label>
      <select id="modalCover">
        ${coverOptions(r,r.proposedCoverId)}
      </select>` : ""}
    <label>ملاحظات المسؤول (اختياري)</label>
    <textarea id="modalNotes" rows="3"></textarea>
    <div class="actions">
      <button class="btn ${approve?"primary":"danger"}"
        id="confirmDecision">
        ${approve?"تأكيد الاعتماد":"تأكيد الرفض"}
      </button>
      <button class="btn outline" id="cancelDecision">إلغاء</button>
    </div>
  `);

  $("cancelDecision").onclick = closeModal;

  $("confirmDecision").onclick = () => {
    if (r.status !== "pending") return closeModal();

    r.status = approve ? "approved" : "rejected";
    r.managerNotes = $("modalNotes").value.trim();
    r.coverId = approve ? $("modalCover").value : "";
    r.decidedAt = now();

    log(r,approve?"اعتماد الدورة":"رفض الدورة",r.managerNotes);
    save();closeModal();renderAll();
    notify("تم حفظ القرار.");
  };
}

function changeCover(r) {
  openModal("تغيير الموظف البديل",`
    <p>${esc(r.courseName)}</p>
    <label>الموظف البديل</label>
    <select id="modalCover">
      ${coverOptions(r,r.coverId)}
    </select>
    <label>سبب التغيير (اختياري)</label>
    <textarea id="modalNotes"></textarea>
    <button class="btn primary" id="saveCover">حفظ التغيير</button>
  `);

  $("saveCover").onclick = () => {
    const old = r.coverId;
    r.coverId = $("modalCover").value;
    log(r,"تغيير البديل",
      `${username(old)} ← ${username(r.coverId)}. ${$("modalNotes").value}`);
    save();closeModal();renderAll();
    notify("تم تغيير الموظف البديل.");
  };
}

function editCourse(r) {
  openModal("تعديل طلب الدورة",`
    <label>اسم الدورة</label>
    <input id="editCourseName" value="${esc(r.courseName)}">
    <div class="form-grid">
      <div>
        <label>من تاريخ</label>
        <input id="editCourseStart" type="date" value="${esc(r.startDate)}">
      </div>
      <div>
        <label>إلى تاريخ</label>
        <input id="editCourseEnd" type="date" value="${esc(r.endDate)}">
      </div>
    </div>
    <label>ملاحظات الموظف</label>
    <textarea id="editCourseNotes" rows="3">${esc(r.employeeNotes || "")}</textarea>
    <button class="btn primary" id="saveCourseEdit">حفظ التعديل</button>
  `);

  $("saveCourseEdit").onclick = () => {
    const courseName = $("editCourseName").value.trim();
    const startDate = $("editCourseStart").value;
    const endDate = $("editCourseEnd").value;
    const days = daysBetween(startDate,endDate);

    if (!courseName) return notify("اكتب اسم الدورة.");
    if (!(days >= 1)) return notify("تاريخ نهاية الدورة غير صحيح.");

    Object.assign(r,{
      courseName,startDate,endDate,days,
      employeeNotes:$("editCourseNotes").value.trim()
    });
    log(r,"تعديل طلب الدورة");
    save();closeModal();renderAll();
    notify("تم تعديل الطلب.");
  };
}

function withdrawCourse(r) {
  openModal("سحب طلب الدورة",`
    <p>هل تريد سحب طلب «${esc(r.courseName)}»؟</p>
    <label>سبب السحب (اختياري)</label>
    <textarea id="withdrawReason"></textarea>
    <button class="btn warning" id="confirmWithdraw">تأكيد السحب</button>
  `);

  $("confirmWithdraw").onclick = () => {
    if (!["pending","approved"].includes(r.status) ||
        r.startDate < today()) {
      closeModal();
      return notify("لم يعد سحب هذا الطلب متاحاً.");
    }

    r.status = "withdrawn";
    r.withdrawnAt = now();
    r.withdrawalReason = $("withdrawReason").value.trim();
    log(r,"سحب طلب الدورة",r.withdrawalReason);
    save();closeModal();renderAll();
    notify("تم سحب الطلب.");
  };
}

/* =========================
   مهام الموظف البديل
========================= */

function renderCoverTasks() {
  const courses = db.requests.filter(r =>
    r.status === "approved" && r.coverId === currentUserId
  );

  $("coverTasksList").innerHTML = courses.length
    ? courses.map(r => `
      <article class="card purple">
        <div class="section-head">
          <h3>${esc(r.courseName)}</h3>
          ${badge(r.status)}
        </div>
        <p>الموظف الأساسي: ${esc(username(r.employeeId))}</p>
        <p class="meta">
          ${formatDate(r.startDate)} إلى ${formatDate(r.endDate)}
        </p>
        ${(r.tasks||[]).map(t => `
          <div class="task-entry">
            <b>${esc(t.title)}</b>
            <p>${esc(t.description)}</p>
            <label>حالة المهمة</label>
            <select data-cover-status="${r.id}" data-task-id="${t.id}">
              ${[
                ["not_started","لم تبدأ"],
                ["in_progress","قيد التنفيذ"],
                ["completed","مكتملة"]
              ].map(([v,n])=>option(v,n,t.status===v)).join("")}
            </select>
            <label>ملاحظات المتابعة</label>
            <textarea data-cover-notes="${r.id}"
              data-task-id="${t.id}">${esc(t.notes||"")}</textarea>
            <button class="btn purple small"
              data-action="save-cover-task"
              data-id="${r.id}" data-task-id="${t.id}">
              حفظ المتابعة
            </button>
            ${t.updatedAt ? `<p class="meta">آخر حفظ: ${new Date(t.updatedAt).toLocaleString("ar-AE")}</p>` : ""}
          </div>
        `).join("") || "<p>لا توجد مهام مسجلة.</p>"}
      </article>
    `).join("")
    : `<div class="empty">لا توجد مهام بديلة نشطة.</div>`;
}

/* =========================
   الاستفسارات والطلبات
========================= */

$("inquiryForm").onsubmit = e => {
  e.preventDefault();

  const managerId = selectedManager("inquiryManager");
  if (!managerId) return notify("لم يتم تعيين مسؤول مباشر.");

  const item = {
    id:uid(),
    employeeId:currentUserId,
    managerId,
    type:$("inquiryType").value,
    subject:$("inquirySubject").value.trim(),
    body:$("inquiryBody").value.trim(),
    status:"open",
    createdAt:now(),
    messages:[],
    history:[]
  };

  log(item,"إرسال استفسار أو طلب");
  db.inquiries.push(item);
  save();
  e.target.reset();
  renderAll();
  notify("تم إرسال المعاملة للمسؤول.");
};

function inquiryCard(item) {
  const mine = item.employeeId === currentUserId;
  const manager = item.managerId === currentUserId || isAdmin();

  return `
    <article class="card orange">
      <div class="section-head">
        <h3>${esc(item.subject)}</h3>
        ${badge(item.status)}
      </div>
      <p>${item.type==="request"?"طلب":"استفسار"}</p>
      <p>${esc(item.body)}</p>
      <small>من: ${esc(username(item.employeeId))}</small>
      <small>إلى: ${esc(username(item.managerId))}</small>
      <small>${new Date(item.createdAt).toLocaleString("ar-AE")}</small>
      <div class="actions">
        ${(mine||manager) ? `
          <button class="btn outline small"
            data-action="open-inquiry" data-id="${item.id}">
            عرض المحادثة والردود
          </button>` : ""}
        ${(item.employeeId === currentUserId || item.managerId === currentUserId) ? `
          <button class="btn danger small"
            data-action="hide-inquiry" data-id="${item.id}">حذف من قائمتي</button>` : ""}
        ${isAdmin() ? `
          <button class="btn danger small"
            data-action="delete-inquiry" data-id="${item.id}">حذف نهائي</button>` : ""}
      </div>
    </article>`;
}

function renderInquiries() {
  const mine = db.inquiries.filter(i =>
    i.employeeId === currentUserId && !(i.hiddenFor || []).includes(currentUserId)
  );

  const inbox = db.inquiries.filter(i =>
    i.managerId === currentUserId && !(i.hiddenFor || []).includes(currentUserId)
  );

  $("myInquiries").innerHTML = mine.length
    ? [...mine].reverse().map(inquiryCard).join("")
    : `<div class="empty">لا توجد معاملات مرسلة.</div>`;

  $("inquiryInbox").innerHTML = inbox.length
    ? [...inbox].reverse().map(inquiryCard).join("")
    : `<div class="empty">لا توجد معاملات واردة.</div>`;

  $("inboxTitle").classList.toggle(
    "hidden",!managesAnyone()&&!inbox.length
  );
}

function openInquiry(item) {
  const messages = item.messages || [];

  openModal(item.subject,`
    <p>${esc(item.body)}</p>
    <p>${badge(item.status)}</p>
    <div class="divider"></div>
    <h3>سجل الردود</h3>
    ${messages.map(m=>`
      <div class="message ${m.by===currentUserId?"mine":""}">
        <b>${esc(username(m.by))}</b>
        <p>${esc(m.text)}</p>
        <small>${new Date(m.at).toLocaleString("ar-AE")}</small>
      </div>
    `).join("") || "<p>لا توجد ردود بعد.</p>"}
    ${item.status !== "closed" ? `
      <label>إضافة رد</label>
      <textarea id="inquiryReply"></textarea>
      <button class="btn primary" id="sendInquiryReply">إرسال الرد</button>
      ${item.managerId===currentUserId ? `
        <button class="btn outline" id="closeInquiry">
          إغلاق المعاملة
        </button>` : ""}
    ` : ""}
  `);

  $("sendInquiryReply")?.addEventListener("click",()=>{
    const text = $("inquiryReply").value.trim();
    if (!text) return notify("اكتب الرد أولاً.");

    item.messages ||= [];
    item.messages.push({id:uid(),by:currentUserId,text,at:now()});
    log(item,"إضافة رد",text);
    save();renderAll();openInquiry(item);
  });

  $("closeInquiry")?.addEventListener("click",()=>{
    item.status="closed";
    log(item,"إغلاق المعاملة");
    save();renderAll();openInquiry(item);
  });
}

/* =========================
   تكليفات المسؤول
========================= */

function renderAssignmentRecipients() {
  const team = teamMembers();
  $("assignmentRecipients").innerHTML = team.length
    ? team.map(u=>`
      <label>
        <input type="checkbox" value="${esc(u.id)}">
        ${esc(u.name)}
      </label>
    `).join("")
    : `<p class="meta">لا يوجد موظفون مرتبطون بك مباشرة.</p>`;
}

$("assignmentForm").onsubmit = e => {
  e.preventDefault();

  const recipients = [
    ...document.querySelectorAll("#assignmentRecipients input:checked")
  ].map(x=>x.value);

  if (!recipients.length) return notify("اختَر موظفاً واحداً على الأقل.");

  const groupId = uid();
  const title = $("assignmentTitle").value.trim();
  const body = $("assignmentBody").value.trim();
  const dueDate = $("assignmentDue").value;

  recipients.forEach(employeeId=>{
    const item = {
      id:uid(),
      groupId,
      managerId:currentUserId,
      employeeId,
      title,body,dueDate,
      status:"new",
      createdAt:now(),
      updatedAt:now(),
      completedAt:null,
      returnedAt:null,
      returnReason:"",
      completionNotes:"",
      hiddenForManager:false,
      history:[]
    };
    log(item,"إرسال تكليف");
    db.assignments.push(item);
  });

  save();e.target.reset();renderAll();
  notify("تم إرسال التكليف للموظفين.");
};

function assignmentCard(a,context) {
  const managerView = context==="sent";
  const employeeView = context==="received";

  let actions = "";

  if (employeeView && a.employeeId===currentUserId) {
    if (a.status==="new") {
      actions += `<button class="btn outline small"
        data-action="start-assignment" data-id="${a.id}">
        بدء التنفيذ
      </button>`;
    }

    if (["new","in_progress"].includes(a.status)) {
      actions += `
        <button class="btn primary small"
          data-action="complete-assignment" data-id="${a.id}">
          تم الإنجاز
        </button>
        <button class="btn warning small"
          data-action="return-assignment" data-id="${a.id}">
          إرجاع للمسؤول
        </button>`;
    }
  }

  if (managerView && a.managerId===currentUserId) {
    if (["new","in_progress","returned"].includes(a.status)) {
      actions += `
        <button class="btn outline small"
          data-action="withdraw-assignment" data-id="${a.id}">
          سحب المهمة
        </button>`;
    }

    if (a.status!=="completed") {
      actions += `
        <button class="btn purple small"
          data-action="transfer-assignment" data-id="${a.id}">
          تحويل المهمة
        </button>`;
    }

    if (a.status==="returned") {
      actions += `
        <button class="btn primary small"
          data-action="resend-assignment" data-id="${a.id}">
          إعادة إرسال
        </button>`;
    }

    if (["withdrawn","completed","returned"].includes(a.status)) {
      actions += `
        <button class="btn danger small"
          data-action="hide-assignment" data-id="${a.id}">
          حذف من قائمتي
        </button>`;
    }
  }

  const cardColor = a.status==="withdrawn" ? "muted" : "red";

  return `
    <article class="card ${cardColor}">
      <div class="section-head">
        <h3>${esc(a.title)}</h3>
        ${badge(a.status)}
      </div>
      <p>${esc(a.body)}</p>
      <small>من: ${esc(username(a.managerId))}</small>
      <small>إلى: ${esc(username(a.employeeId))}</small>
      <small>تاريخ الإرسال:
        ${new Date(a.createdAt).toLocaleString("ar-AE")}
      </small>
      ${a.dueDate?`<p>موعد الإنجاز: ${formatDate(a.dueDate)}</p>`:""}
      ${a.returnReason
        ? `<p><b>سبب الإرجاع:</b> ${esc(a.returnReason)}</p>` : ""}
      ${a.completionNotes
        ? `<p><b>ملاحظة الإنجاز:</b> ${esc(a.completionNotes)}</p>` : ""}
      <div class="actions">${actions}</div>
    </article>`;
}

function renderAssignments() {
  const received = db.assignments.filter(a =>
    a.employeeId===currentUserId && a.status!=="withdrawn"
  );

  const sent = db.assignments.filter(a =>
    a.managerId===currentUserId && !a.hiddenForManager
  );

  $("receivedAssignments").innerHTML = received.length
    ? [...received].reverse().map(a=>assignmentCard(a,"received")).join("")
    : `<div class="empty">لا توجد تكليفات واردة.</div>`;

  $("sentAssignments").innerHTML = sent.length
    ? [...sent].reverse().map(a=>assignmentCard(a,"sent")).join("")
    : `<div class="empty">لا توجد تكليفات مرسلة.</div>`;

  $("allAssignmentsList").innerHTML = db.assignments.length
    ? [...db.assignments].reverse()
      .map(a=>assignmentCard(a,"admin")).join("")
    : `<div class="empty">لا توجد تكليفات في السجل.</div>`;

  const manager = managesAnyone();
  $("assignmentCreatePanel").classList.toggle("hidden",!manager);
  $("sentAssignmentsTitle").classList.toggle("hidden",!manager);
}

function assignmentAction(a,action) {
  if (action==="start-assignment") {
    a.status="in_progress";
    a.updatedAt=now();
    log(a,"بدء التنفيذ");
    save();renderAll();return;
  }

  if (action==="complete-assignment") {
    openModal("تأكيد إنجاز المهمة",`
      <p>${esc(a.title)}</p>
      <label>ملاحظة الإنجاز (اختياري)</label>
      <textarea id="actionNotes"></textarea>
      <button class="btn primary" id="confirmAction">تم الإنجاز</button>
    `);

    $("confirmAction").onclick=()=>{
      a.status="completed";
      a.completedAt=now();
      a.completionNotes=$("actionNotes").value.trim();
      log(a,"تم الإنجاز",a.completionNotes);
      save();closeModal();renderAll();
      notify("تم إبلاغ المسؤول بالإنجاز.");
    };
    return;
  }

  if (action==="return-assignment") {
    openModal("إرجاع المهمة للمسؤول",`
      <p>${esc(a.title)}</p>
      <label>سبب تعذر التنفيذ (إلزامي)</label>
      <textarea id="actionNotes" required></textarea>
      <button class="btn warning" id="confirmAction">
        تأكيد الإرجاع
      </button>
    `);

    $("confirmAction").onclick=()=>{
      const reason=$("actionNotes").value.trim();
      if (!reason) return notify("يجب كتابة سبب الإرجاع.");

      a.status="returned";
      a.returnedAt=now();
      a.returnReason=reason;
      log(a,"إرجاع المهمة",reason);
      save();closeModal();renderAll();
      notify("تم إرجاع المهمة مع السبب.");
    };
    return;
  }

  if (action==="withdraw-assignment") {
    if (!confirm("هل تريد سحب المهمة من الموظف؟")) return;
    a.status="withdrawn";
    a.updatedAt=now();
    log(a,"سحب المهمة");
    save();renderAll();
    notify("تم سحب المهمة.");
    return;
  }

  if (action==="resend-assignment") {
    openModal("إعادة إرسال المهمة",`
      <label>التعليمات المحدثة</label>
      <textarea id="resendBody">${esc(a.body)}</textarea>
      <button class="btn primary" id="confirmAction">إعادة إرسال</button>
    `);

    $("confirmAction").onclick=()=>{
      const body=$("resendBody").value.trim();
      if (!body) return notify("اكتب تفاصيل التكليف.");

      a.body=body;
      a.status="new";
      a.returnReason="";
      a.updatedAt=now();
      log(a,"إعادة إرسال التكليف");
      save();closeModal();renderAll();
      notify("تمت إعادة إرسال المهمة.");
    };
    return;
  }

  if (action==="transfer-assignment") {
    const candidates=teamMembers(a.managerId)
      .filter(u=>u.id!==a.employeeId);

    if (!candidates.length) {
      return notify("لا يوجد موظف آخر متاح ضمن فريقك.");
    }

    openModal("تحويل المهمة",`
      <p>${esc(a.title)}</p>
      <label>تحويل إلى</label>
      <select id="transferTo">
        ${candidates.map(u=>option(u.id,u.name)).join("")}
      </select>
      <label>سبب التحويل (اختياري)</label>
      <textarea id="transferReason"></textarea>
      <button class="btn purple" id="confirmAction">
        تأكيد التحويل
      </button>
    `);

    $("confirmAction").onclick=()=>{
      const oldId=a.employeeId;
      const newId=$("transferTo").value;
      if (!newId || oldId===newId) return;

      a.employeeId=newId;
      a.status="new";
      a.returnReason="";
      a.completedAt=null;
      a.completionNotes="";
      a.updatedAt=now();

      log(a,"تحويل المهمة",
        `${username(oldId)} ← ${username(newId)}. ${
          $("transferReason").value.trim()
        }`);

      save();closeModal();renderAll();
      notify("تم تحويل المهمة للموظف الجديد.");
    };
    return;
  }

  if (action==="hide-assignment") {
    if (!confirm("حذف المهمة من قائمتك مع الاحتفاظ بالسجل؟")) return;
    a.hiddenForManager=true;
    log(a,"إخفاء التكليف من قائمة المسؤول");
    save();renderAll();
  }
}

/* =========================
   تعليمات المسؤول
========================= */

$("instructionForm").onsubmit=e=>{
  e.preventDefault();

  if (!managesAnyone()) return notify("ليس لديك فريق تابع حالياً.");

  const item={
    id:uid(),
    managerId:currentUserId,
    title:$("instructionTitle").value.trim(),
    body:$("instructionBody").value.trim(),
    createdAt:now(),
    updatedAt:now()
  };

  db.instructions.push(item);
  save();e.target.reset();renderAll();
  notify("تم نشر التعليمات.");
};

function renderInstructions() {
  const myManager=getManagerId(current());

  const visible=db.instructions.filter(i=>
    i.managerId===myManager ||
    i.managerId===currentUserId ||
    isAdmin()
  );

  $("instructionCreatePanel").classList.toggle(
    "hidden",!managesAnyone()
  );

  $("instructionsList").innerHTML=visible.length
    ? [...visible].reverse().map(i=>`
      <article class="card blue">
        <h3>${esc(i.title||"تعليمات المسؤول")}</h3>
        <p>${esc(i.body)}</p>
        <small>المسؤول: ${esc(username(i.managerId))}</small>
        <small>${new Date(i.createdAt).toLocaleString("ar-AE")}</small>
        ${(i.managerId===currentUserId||isAdmin())?`
          <div class="actions">
            <button class="btn outline small"
              data-action="edit-instruction" data-id="${i.id}">
              تعديل
            </button>
            <button class="btn danger small"
              data-action="delete-instruction" data-id="${i.id}">
              حذف
            </button>
          </div>`:""}
      </article>
    `).join("")
    : `<div class="empty">لا توجد تعليمات حالياً.</div>`;
}

function editInstruction(item) {
  openModal("تعديل التعليمات",`
    <label>العنوان (اختياري)</label>
    <input id="editInstructionTitle" value="${esc(item.title)}">
    <label>التعليمات</label>
    <textarea id="editInstructionBody">${esc(item.body)}</textarea>
    <button class="btn primary" id="saveInstructionEdit">حفظ</button>
  `);

  $("saveInstructionEdit").onclick=()=>{
    const body=$("editInstructionBody").value.trim();
    if (!body) return notify("اكتب نص التعليمات.");

    item.title=$("editInstructionTitle").value.trim();
    item.body=body;
    item.updatedAt=now();
    save();closeModal();renderAll();
  };
}

/* =========================
   الملاحظات الخاصة
========================= */

$("noteForm").onsubmit=e=>{
  e.preventDefault();

  const id=$("editingNoteId").value;
  const title=$("noteTitle").value.trim();
  const body=$("noteBody").value.trim();

  if (!body) return;

  if (id) {
    const note=db.notes.find(n=>
      n.id===id && n.userId===currentUserId
    );
    if (!note) return;

    note.title=title;
    note.body=body;
    note.updatedAt=now();
  } else {
    db.notes.push({
      id:uid(),
      userId:currentUserId,
      title,body,
      createdAt:now(),
      updatedAt:now()
    });
  }

  save();
  resetNoteForm();
  renderNotes();
  notify("تم حفظ الملاحظة.");
};

function resetNoteForm() {
  $("noteForm").reset();
  $("editingNoteId").value="";
}

$("cancelNoteEdit").onclick=resetNoteForm;

function renderNotes() {
  const mine=db.notes.filter(n=>n.userId===currentUserId);

  $("notesList").innerHTML=mine.length
    ? [...mine].reverse().map(n=>`
      <article class="card note-card">
        <h3>${esc(n.title||"ملاحظة بدون عنوان")}</h3>
        <p>${esc(n.body)}</p>
        <small>آخر تحديث:
          ${new Date(n.updatedAt).toLocaleString("ar-AE")}
        </small>
        <div class="actions">
          <button class="btn outline small"
            data-action="edit-note" data-id="${n.id}">
            تعديل
          </button>
          <button class="btn danger small"
            data-action="delete-note" data-id="${n.id}">
            حذف
          </button>
        </div>
      </article>
    `).join("")
    : `<div class="empty">مساحتك الخاصة فارغة حالياً.</div>`;
}

/* =========================
   إدارة الأقسام والشُعب
========================= */

$("departmentForm").onsubmit=e=>{
  e.preventDefault();

  const name=$("departmentName").value.trim();
  if (db.departments.some(d=>d.name===name)) {
    return notify("هذا القسم موجود بالفعل.");
  }

  db.departments.push({id:uid(),name,managerId:""});
  save();e.target.reset();renderAll();
};

// قائمة الموظفين النشطين لاختيار مسؤول
function userOptions(selectedId,emptyText) {
  return option("",emptyText,!selectedId)+
    activeUsers().map(u=>option(u.id,u.name,u.id===selectedId)).join("");
}

// الشعبة والمكتب نفس البنية، والفرق في التسمية فقط
const UNIT_KINDS={unit:"شعبة",office:"مكتب"};
const unitKindName=u=>UNIT_KINDS[u?.kind]||UNIT_KINDS.unit;
const unitHeadTitle=u=>u?.kind==="office"?"مسؤول المكتب":"رئيس الشعبة";

// زر «إضافة شعبة» أو «إضافة مكتب» يحدد النوع
$("unitForm").onsubmit=e=>{
  e.preventDefault();

  const departmentId=$("unitDepartment").value;
  const name=$("unitName").value.trim();
  const kind=e.submitter?.value==="office"?"office":"unit";

  if (!departmentId) return notify("اختَر القسم.");

  db.units.push({
    id:uid(),name,departmentId,managerId:$("unitManager").value,kind
  });

  save();e.target.reset();renderAll();
  notify(`تمت إضافة ال${unitKindName({kind})}.`);
};

function fillDepartmentSelect(id,includeBlank=true) {
  const el=$(id);
  const old=el.value;

  el.innerHTML=
    (includeBlank?option("","بدون قسم"):"")+
    db.departments.map(d=>option(d.id,d.name)).join("");

  if ([...el.options].some(o=>o.value===old)) el.value=old;
}

function fillUnitSelect(departmentId,selectId) {
  const el=$(selectId);
  const old=el.value;

  el.innerHTML=option("","بدون شعبة أو مكتب")+
    db.units.filter(u=>u.departmentId===departmentId)
      .map(u=>option(u.id,`${unitKindName(u)}: ${u.name}`)).join("");

  if ([...el.options].some(o=>o.value===old)) el.value=old;
}

$("employeeDepartment").onchange=()=>{
  fillUnitSelect($("employeeDepartment").value,"employeeUnit");
};

$("employeeForm").onsubmit=async e=>{
  e.preventDefault();

  const name=$("employeeName").value.trim();
  const password=$("employeePassword").value;

  if (name.split(/\s+/).length<3) {
    return notify("يرجى كتابة الاسم الثلاثي.");
  }

  if (password.length<6) {
    return notify("كلمة المرور يجب أن تكون 6 أحرف على الأقل.");
  }

  if (db.users.some(u=>loginKey(u.name)===loginKey(name))) {
    return notify("يوجد مستخدم بهذا الاسم. عدّل حسابه بدلاً من تكراره.");
  }

  const button=e.target.querySelector("button[type=submit]");
  button.disabled=true;

  try {
    const account=await createLoginAccount(password);
    const u={
      id:uid(),
      name,
      departmentId:$("employeeDepartment").value,
      unitId:$("employeeUnit").value,
      role:$("employeeRole").value,
      active:true,
      authUid:account.authUid,
      loginEmail:account.email,
      _createdAt:now()
    };

    const batch=fs.batch();
    batch.set(fs.collection("accounts").doc(account.authUid),{userId:u.id});
    batch.set(fs.collection("users").doc(u.id),u);
    batch.set(fs.collection("logins").doc(loginKey(name)),{email:account.email});
    await batch.commit();

    e.target.reset();
    notify("تمت إضافة المستخدم.");
  } catch (err) {
    console.error(err);
    notify(authErrorText(err));
  } finally {
    button.disabled=false;
  }
};

function managerSelect(selected,scope,id) {
  return `
    <select data-manager-scope="${scope}" data-manager-id="${id}">
      ${option("","بدون مسؤول",!selected)}
      ${activeUsers().map(u=>
        option(u.id,u.name,u.id===selected)
      ).join("")}
    </select>`;
}

function renderAdmin() {
  if (!isAdmin()) return;

  fillDepartmentSelect("unitDepartment",false);
  $("unitManager").innerHTML=userOptions($("unitManager").value,"يُحدد لاحقاً");
  fillDepartmentSelect("employeeDepartment",true);
  fillUnitSelect($("employeeDepartment").value,"employeeUnit");

  $("departmentsList").innerHTML=db.departments.map(d=>`
    <div class="inline-row">
      <span>${esc(d.name)}
        ${d===directorate()?`<span class="badge approved">الإدارة العليا</span>`:""}
      </span>
      <div class="actions inline-actions">
        <button class="btn outline small"
          data-action="edit-department" data-id="${d.id}">
          تعديل
        </button>
        <button class="btn danger small"
          data-action="delete-department" data-id="${d.id}">
          حذف
        </button>
      </div>
    </div>
  `).join("");

  $("unitsList").innerHTML=db.units.map(u=>`
    <div class="inline-row">
      <span><span class="badge ${u.kind==="office"?"progress":"new"}">${unitKindName(u)}</span>
        ${esc(u.name)} — ${esc(departmentName(u.departmentId))}</span>
      <div class="actions inline-actions">
        <button class="btn outline small"
          data-action="edit-unit" data-id="${u.id}">
          تعديل
        </button>
        <button class="btn danger small"
          data-action="delete-unit" data-id="${u.id}">
          حذف
        </button>
      </div>
    </div>
  `).join("");

  $("managerAssignments").innerHTML=`
    <h4>مسؤولو الأقسام</h4>
    ${db.departments.map(d=>`
      <label>${esc(d.name)}</label>
      ${managerSelect(d.managerId,"department",d.id)}
    `).join("")}
    <h4>مسؤولو الشُعب والمكاتب</h4>
    ${db.units.map(u=>`
      <label>${unitKindName(u)}: ${esc(u.name)}</label>
      ${managerSelect(u.managerId,"unit",u.id)}
    `).join("")}
  `;

  $("usersList").innerHTML=duplicatesHTML()+renderOrgChart();
}

/* ---------- الحسابات المكررة بنفس الاسم ---------- */

function describeUser(u) {
  return [positionOf(u),ROLE_LABELS[u.role]].filter(Boolean).join(" — ") || "بدون قسم";
}

function duplicatesHTML() {
  const groups={};
  db.users.forEach(u=>{ (groups[loginKey(u.name)] ||= []).push(u); });

  return Object.values(groups).filter(g=>g.length>1).map(g=>{
    const mine=g.find(u=>u.id===currentUserId);
    return alertBox("warn",`
      <b>يوجد ${g.length} حسابات بنفس الاسم «${esc(g[0].name)}»:</b>
      ${g.map(u=>`<p>• ${esc(describeUser(u))}
        ${u.id===currentUserId?" <b>(حسابك الحالي)</b>":""}
        ${mine && u.id!==currentUserId
          ? `<button class="btn primary small" data-action="merge-user" data-id="${u.id}">
               دمج هذا الحساب في حسابي</button>` : ""}</p>`).join("")}
      <p class="meta">الدمج ينقل الرئاسة والطلبات والتكليفات إلى حسابك ثم يحذف الحساب المكرر.</p>`);
  }).join("");
}

// نقل كل ما يخص الحساب المكرر إلى الحساب الحالي ثم حذفه
async function mergeUserInto(fromId,toId) {
  const swap=(obj,fields)=>fields.forEach(f=>{ if (obj[f]===fromId) obj[f]=toId; });

  db.departments.forEach(d=>swap(d,["managerId","adminReviewerId"]));
  db.units.forEach(u=>swap(u,["managerId"]));
  db.leaves.forEach(l=>swap(l,["employeeId","managerId","coManagerId","coverId"]));
  db.requests.forEach(r=>swap(r,["employeeId","managerId","currentReviewerId",
    "forwardedBy","coverId","proposedCoverId"]));
  db.inquiries.forEach(i=>{
    swap(i,["employeeId","managerId"]);
    (i.messages||[]).forEach(m=>swap(m,["by"]));
  });
  db.assignments.forEach(a=>swap(a,["employeeId","managerId"]));
  db.instructions.forEach(i=>swap(i,["managerId"]));
  db.absences.forEach(a=>swap(a,["employeeId","coverId"]));

  const from=user(fromId);
  db.users=db.users.filter(u=>u.id!==fromId);
  const ok=await save();

  // إلغاء ربط حساب الدخول القديم (اسم الدخول نفسه يبقى لحسابك)
  if (ok && from?.authUid && from.authUid!==user(toId)?.authUid) {
    await fs.collection("accounts").doc(from.authUid).delete().catch(()=>{});
  }
  return ok;
}

document.addEventListener("click",async e=>{
  const btn=e.target.closest("[data-action='merge-user']");
  if (!btn || !isAdmin()) return;

  const from=user(btn.dataset.id);
  if (!from || from.id===currentUserId) return;
  if (!confirm(`دمج الحساب المكرر (${describeUser(from)}) في حسابك؟\nتنتقل إليك رئاسته وطلباته، ثم يُحذف. لا يمكن التراجع.`)) return;

  btn.disabled=true;
  const ok=await mergeUserInto(from.id,currentUserId);
  renderAll();
  notify(ok ? "تم دمج الحسابين." : "تعذّر الدمج. حاولي مرة أخرى.");
});

/* =========================
   الهيكل التنظيمي
========================= */

// سحب بطاقات الأقسام وإفلاتها لتغيير الترتيب
let draggedDeptId=null;

document.addEventListener("dragstart",e=>{
  const card=e.target.closest?.("[data-dept-id]");
  if (!card || !isAdmin()) return;
  draggedDeptId=card.dataset.deptId;
  card.classList.add("dragging");
  e.dataTransfer.effectAllowed="move";
  e.dataTransfer.setData("text/plain",draggedDeptId);
});

document.addEventListener("dragend",()=>{
  draggedDeptId=null;
  document.querySelectorAll(".org-dept.dragging,.org-dept.drop-before,.org-dept.drop-after")
    .forEach(el=>el.classList.remove("dragging","drop-before","drop-after"));
});

// في الاتجاه من اليمين لليسار: النصف الأيمن من البطاقة = قبلها
function dropSide(card,e) {
  const r=card.getBoundingClientRect();
  return e.clientX>r.left+r.width/2 ? "before" : "after";
}

document.addEventListener("dragover",e=>{
  if (!draggedDeptId) return;
  const card=e.target.closest("[data-dept-id]");
  const grid=e.target.closest(".org-grid");
  if (!card && !grid) return;
  e.preventDefault();

  document.querySelectorAll(".org-dept.drop-before,.org-dept.drop-after")
    .forEach(el=>el.classList.remove("drop-before","drop-after"));
  if (card && card.dataset.deptId!==draggedDeptId) {
    card.classList.add("drop-"+dropSide(card,e));
  }
});

document.addEventListener("drop",e=>{
  if (!draggedDeptId) return;
  const card=e.target.closest("[data-dept-id]");
  const grid=e.target.closest(".org-grid");
  if (!card && !grid) return;
  e.preventDefault();

  const id=draggedDeptId;
  draggedDeptId=null;
  if (card) moveDepartment(id,card.dataset.deptId,dropSide(card,e)==="after");
  else moveDepartment(id,null);
  notify("تم حفظ ترتيب الأقسام.");
});

document.addEventListener("click",e=>{
  const btn=e.target.closest("[data-action='dept-earlier'],[data-action='dept-later']");
  if (!btn || !isAdmin()) return;

  const list=orderedDepartments();
  const i=list.findIndex(d=>d.id===btn.dataset.id);
  if (btn.dataset.action==="dept-earlier" && i>0) {
    moveDepartment(list[i].id,list[i-1].id);
  }
  if (btn.dataset.action==="dept-later" && i<list.length-1) {
    moveDepartment(list[i].id,list[i+1].id,true);
  }
});

const ROLE_LABELS={employee:"موظف",manager:"مسؤول",admin:"مديرة النظام"};

// الموظف العادي يظهر باسمه فقط لتصغير البطاقة
const staffTitle=u=>{
  // من يرأس قسماً أو شعبة في مكان آخر يظهر منصبه هناك
  const d=db.departments.find(x=>x.managerId===u.id);
  if (d) return `رئيس ${d.name}`;
  const un=db.units.find(x=>x.managerId===u.id);
  if (un) return `${unitHeadTitle(un)}: ${un.name}`;
  return u.role==="employee"?"":ROLE_LABELS[u.role]||"";
};

function orgPerson(u,title,kind="") {
  // بدون مسؤول معيّن لا يظهر بوكس فارغ (إلا لمدير الإدارة)
  if (!u) {
    return kind==="director" ? `<div class="org-person vacant ${kind}">
      <b>${esc(title)}</b><small>لم يتم التعيين</small>
    </div>` : "";
  }

  const extra=[
    u.role==="admin" && title!==ROLE_LABELS.admin?"مديرة النظام":"",
    u.active===false?"موقوف":""
  ].filter(Boolean).join(" — ");

  const ext=contactOf(u.id)?.extension;
  const isMyCover=u.id!==currentUserId && myCoverIds().has(u.id);
  const iCoverThem=u.id!==currentUserId && coveredByMeIds().has(u.id);

  return `
    <button type="button" class="org-person ${kind} ${u.active===false?"inactive":""} ${u.id===currentUserId?"me":""} ${isMyCover||iCoverThem?"cover":""}"
      data-action="${orgEditable?"edit-user":"view-contact"}" data-id="${u.id}"
      title="${orgEditable?`المسؤول المباشر: ${esc(username(getManagerId(u)))}`:"عرض بيانات التواصل"}">
      <b>${esc(u.name)}${u.id===currentUserId?` <span class="org-me-tag">(أنت)</span>`:""}${isMyCover?` <span class="org-cover-tag">(بديلك)</span>`:""}${iCoverThem?` <span class="org-cover-tag">(أنت بديله)</span>`:""}</b>
      ${title||extra?`<small>${esc([title,extra].filter(Boolean).join(" — "))}</small>`:""}
      ${ext?`<small class="org-ext">☎ ${esc(ext)}</small>`:""}
    </button>`;
}

/* ---------- الهيكل العام وبيانات التواصل ---------- */

// true في لوحة الإدارة (أدوات التعديل)، false في الهيكل العام (عرض فقط)
let orgEditable=true;

function contactOf(userId) {
  return db.contacts.find(c=>c.userId===userId);
}

function renderPublicOrgChart() {
  $("publicOrgChart").innerHTML=renderOrgChart(false);
  orgEditable=true;
}

// منصب الشخص كما يظهر في بطاقة التواصل
function positionOf(u) {
  const d=db.departments.find(x=>x.managerId===u.id);
  if (d) return d===directorate() ? `مدير ${d.name}` : `رئيس ${d.name}`;
  const un=db.units.find(x=>x.managerId===u.id);
  if (un) return `${unitHeadTitle(un)}: ${un.name}`;
  return [unitName(u.unitId)!=="بدون شعبة"?unitName(u.unitId):"",departmentName(u.departmentId)]
    .filter(x=>x && x!=="بدون قسم").join(" — ");
}

function viewContact(u) {
  const c=contactOf(u.id)||{};
  const row=(label,value,href)=>value?`
    <p><b>${label}:</b> ${href?`<a href="${esc(href)}" dir="ltr">${esc(value)}</a>`:`<span dir="ltr">${esc(value)}</span>`}</p>`:"";

  openModal(u.name,`
    ${positionOf(u)?`<p class="meta">${esc(positionOf(u))}</p>`:""}
    ${c.bio?`<p>${esc(c.bio)}</p>`:""}
    ${row("الإيميل",c.email,c.email?`mailto:${c.email}`:"")}
    ${row("رقم التواصل",c.phone,c.phone?`tel:${c.phone.replace(/\s+/g,"")}`:"")}
    ${row("تحويلة المكتب",c.extension)}
    ${!c.bio&&!c.email&&!c.phone&&!c.extension?`<p class="meta">لم يضف بيانات تواصل بعد.</p>`:""}
    ${u.id===currentUserId?`<button class="btn primary" data-action="edit-my-contact">✎ تعديل بياناتي</button>`:""}
  `);
}

function editMyContact() {
  const c=contactOf(currentUserId)||{};
  openModal("بيانات التواصل الخاصة بي",`
    <label>وصف مختصر عنك (اختياري)</label>
    <textarea id="contactBio" rows="3" maxlength="300"
      placeholder="مثال: مسؤولة المراسلات الحكومية ومتابعة الكتب الرسمية">${esc(c.bio||"")}</textarea>
    <label>إيميل التواصل</label>
    <input id="contactEmail" type="email" dir="ltr" value="${esc(c.email||"")}">
    <label>رقم التواصل</label>
    <input id="contactPhone" type="tel" dir="ltr" inputmode="tel" value="${esc(c.phone||"")}">
    <label>تحويلة المكتب</label>
    <input id="contactExt" dir="ltr" inputmode="numeric" maxlength="10" value="${esc(c.extension||"")}">
    <p class="meta">هذه البيانات تظهر لجميع الموظفين في الهيكل التنظيمي.</p>
    <button class="btn primary" id="saveContact">حفظ</button>
  `);

  $("saveContact").onclick=async()=>{
    const email=$("contactEmail").value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return notify("صيغة الإيميل غير صحيحة.");
    }

    let rec=contactOf(currentUserId);
    if (!rec) {
      rec={id:currentUserId,userId:currentUserId};
      db.contacts.push(rec);
    }
    Object.assign(rec,{
      bio:$("contactBio").value.trim(),
      email,
      phone:$("contactPhone").value.trim(),
      extension:$("contactExt").value.trim(),
      updatedAt:now()
    });

    const ok=await save();
    closeModal();renderAll();
    if (ok) notify("تم حفظ بيانات التواصل.");
  };
}

document.addEventListener("click",e=>{
  const btn=e.target.closest("[data-action='view-contact'],[data-action='edit-my-contact']");
  if (!btn) return;
  if (btn.dataset.action==="edit-my-contact") return editMyContact();
  const u=user(btn.dataset.id);
  if (u) viewContact(u);
});

// ترتيب الأقسام في الهيكل كما رتّبته المديرة بالسحب
function orderedDepartments() {
  const top=directorate();
  return db.departments
    .filter(d=>d!==top)
    .map((d,i)=>({d,i}))
    .sort((a,b)=>(a.d.order ?? 1e6+a.i)-(b.d.order ?? 1e6+b.i))
    .map(x=>x.d);
}

function moveDepartment(id,targetId,after=false) {
  const list=orderedDepartments();
  const moving=list.find(d=>d.id===id);
  if (!moving || id===targetId) return;

  const rest=list.filter(d=>d.id!==id);
  let index=targetId ? rest.findIndex(d=>d.id===targetId) : rest.length;
  if (index<0) index=rest.length;
  if (after && targetId) index++;
  rest.splice(index,0,moving);

  rest.forEach((d,i)=>{ d.order=i; });
  save();renderAll();
}

// القسم الكبير (أكثر من 10 موظفين وفيه شعبة أو أكثر) يأخذ عرض الصفحة
function isWideDept(d) {
  return db.users.filter(u=>u.departmentId===d.id).length > 10 &&
    db.units.some(u=>u.departmentId===d.id);
}

// إضافة قسم من داخل الهيكل في موضع محدد
function addDepartmentAt(index) {
  openModal("إضافة قسم",`
    <label>اسم القسم</label>
    <input id="newDeptName">
    <label>رئيس القسم (اختياري)</label>
    <select id="newDeptManager">
      ${option("","يُحدد لاحقاً")}
      ${activeUsers().map(u=>option(u.id,u.name)).join("")}
    </select>
    <button class="btn primary" id="saveNewDept">إضافة القسم</button>
  `);
  $("newDeptName").focus();

  $("saveNewDept").onclick=()=>{
    const name=$("newDeptName").value.trim();
    if (!name) return notify("اكتبي اسم القسم.");
    if (db.departments.some(d=>d.name===name)) {
      return notify("هذا القسم موجود بالفعل.");
    }

    const d={id:uid(),name,managerId:$("newDeptManager").value};
    const list=orderedDepartments();
    list.splice(Math.min(index,list.length),0,d);
    db.departments.push(d);
    list.forEach((x,i)=>{ x.order=i; });

    save();closeModal();renderAll();
    notify("تمت إضافة القسم.");
  };
}

document.addEventListener("click",e=>{
  const btn=e.target.closest("[data-action='org-add-dept']");
  if (btn && isAdmin()) addDepartmentAt(Number(btn.dataset.index));
});

// نقل موظف إلى قسم أو شعبة أو مكتب من داخل الهيكل
function addMemberTo(departmentId,unitId) {
  const place=unitId
    ? `${unitKindName(unit(unitId))}: ${unitName(unitId)}`
    : departmentName(departmentId);

  const where=u=>u.departmentId
    ? departmentName(u.departmentId)+(u.unitId?" / "+unitName(u.unitId):"")
    : "بدون قسم";

  const candidates=activeUsers()
    .filter(u=>!(u.departmentId===departmentId && (u.unitId||"")===unitId))
    .sort((a,b)=>(a.id===currentUserId?-1:b.id===currentUserId?1:a.name.localeCompare(b.name,"ar")));

  openModal(`إضافة موظف إلى ${place}`,`
    <label>الموظف</label>
    <select id="memberUser">
      ${option("","اختاري الموظف")}
      ${candidates.map(u=>option(u.id,
        `${u.name}${u.id===currentUserId?" (أنتِ)":""} — حالياً: ${where(u)}`)).join("")}
    </select>
    <p class="meta">ينتقل الموظف إلى هذا المكان. إذا كان يرأس قسماً أو شعبة أخرى يبقى رئيساً لها.</p>
    <button class="btn primary" id="saveMember">إضافة</button>
  `);

  $("saveMember").onclick=()=>{
    const u=user($("memberUser").value);
    if (!u) return notify("اختاري الموظف.");

    u.departmentId=departmentId;
    u.unitId=unitId;
    save();closeModal();renderAll();
    if (u.id===currentUserId) {
      $("pageSubtitle").textContent=`${departmentName(u.departmentId)} — ${u.name}`;
    }
    notify(`تمت إضافة ${u.name} إلى ${place}.`);
  };
}

document.addEventListener("click",e=>{
  const btn=e.target.closest("[data-action='org-add-member']");
  if (btn && isAdmin()) addMemberTo(btn.dataset.dept,btn.dataset.unit||"");
});

function renderOrgChart(editable=true) {
  orgEditable=editable;
  const top=directorate();
  const others=orderedDepartments();

  // الرؤساء يظهرون في مواقع إدارتهم، وليس ضمن الموظفين
  const heads=new Set([
    ...db.departments.map(d=>d.managerId),
    ...db.units.map(u=>u.managerId)
  ].filter(Boolean));
  const placed=new Set(heads);

  // رئيس يعمل في قسم غير الذي يرأسه يظهر أيضاً في مكان عضويته
  const headedDepts=id=>new Set([
    ...db.departments.filter(d=>d.managerId===id).map(d=>d.id),
    ...db.units.filter(un=>un.managerId===id).map(un=>un.departmentId)
  ]);
  const memberShown=new Set();
  const alsoMember=u=>heads.has(u.id) && !memberShown.has(u.id) &&
    u.departmentId && !headedDepts(u.id).has(u.departmentId);

  const staffOf=filter=>db.users
    .filter(u=>(orgEditable || u.active!==false) && filter(u) && (!placed.has(u.id) || alsoMember(u)))
    .map(u=>{
      if (heads.has(u.id)) memberShown.add(u.id);
      placed.add(u.id);
      return u;
    });

  const staffBlock=(list,title,managerId)=>list.length?`
    <div class="org-unit">
      <h5>${esc(title)} <span class="org-count">${list.length}</span></h5>
      ${managerId?`<p class="org-manager">المسؤول: <b>${esc(username(managerId))}</b></p>`:""}
      <div class="org-staff">
        ${list.map(u=>orgPerson(u,staffTitle(u))).join("")}
      </div>
    </div>`:"";

  const unitsBlock=(d,headTitle="رئيس الشعبة")=>db.units.filter(u=>u.departmentId===d.id).map(un=>{
    const staff=staffOf(u=>u.unitId===un.id);
    return `
      <div class="org-unit">
        <h5>${esc(un.name)} <span class="org-count">${staff.length}</span></h5>
        ${orgPerson(user(un.managerId),un.kind==="office"?"مسؤول المكتب":headTitle,"unit-head")}
        ${staff.length?`<div class="org-staff">
          ${staff.map(u=>orgPerson(u,staffTitle(u))).join("")}
        </div>`:""}
        ${orgEditable?`<button type="button" class="org-add-member" data-action="org-add-member"
          data-dept="${d.id}" data-unit="${un.id}">＋ إضافة موظف</button>`:""}
      </div>`;
  }).join("");

  const deptBlock=d=>{
    const units=unitsBlock(d);
    const staff=staffOf(u=>u.departmentId===d.id);
    const unitCount=db.units.filter(u=>u.departmentId===d.id).length;

    // القسم الكبير يأخذ عرض الصفحة وتصطف مجموعاته جنب بعض
    const wide=isWideDept(d);

    return `
      <section class="org-dept ${wide?"wide":""}" ${orgEditable?`draggable="true"`:""} data-dept-id="${d.id}">
        <div class="org-dept-title">
          <h4>${orgEditable?`<span class="org-grip" title="اسحبي لتغيير الترتيب">⠿</span> `:""}${esc(d.name)}</h4>
          ${orgEditable?`<span class="org-move">
            <button type="button" data-action="dept-earlier" data-id="${d.id}" title="تقديم">▶</button>
            <button type="button" data-action="dept-later" data-id="${d.id}" title="تأخير">◀</button>
          </span>`:""}
        </div>
        ${orgPerson(user(d.managerId),"رئيس القسم","dept-head")}
        <div class="org-dept-body">
          ${units}
          ${staffBlock(staff,"موظفو القسم",d.managerId)}
          ${orgEditable?`<button type="button" class="org-add-member" data-action="org-add-member"
            data-dept="${d.id}" data-unit="">＋ إضافة موظف للقسم</button>`:""}
        </div>
      </section>`;
  };

  const topHtml=top?`
    <div class="org-top">
      ${orgPerson(user(top.managerId),"مدير "+top.name,"director")}
      ${(()=>{
        const units=unitsBlock(top,"المسؤول");
        const staff=staffOf(u=>u.departmentId===top.id);
        return units||staff.length?`<div class="org-line org-line-short"></div><div class="org-office">
          ${units}${staffBlock(staff,"مكتب "+top.name)}
        </div>`:"";
      })()}
    </div>
    ${others.length?`<div class="org-line"></div>`:""}`
  :orgEditable?`<div class="alert info">
      لم يتم تحديد الإدارة العليا بعد. اضغطي «تعديل» على القسم الرئيسي
      وحددي «هذه هي الإدارة العليا».
    </div>`:"";

  // بطاقة إضافة قسم
  const blocks=others.map(deptBlock);
  // في آخر القائمة، والشبكة ترفعها لأول مكان فاضي
  const addAt=others.length;
  if (orgEditable) blocks.splice(addAt,0,`
    <button type="button" class="org-add-dept"
      data-action="org-add-dept" data-index="${addAt}">
      <span>＋</span> إضافة قسم
    </button>`);

  const deptsHtml=`<div class="org-grid">${blocks.join("")}</div>`;

  const rest=staffOf(()=>true);
  const restHtml=rest.length?`
    <section class="org-dept org-unassigned">
      <h4>بدون قسم <span class="org-count">${rest.length}</span></h4>
      <div class="org-staff">
        ${rest.map(u=>orgPerson(u,staffTitle(u))).join("")}
      </div>
    </section>`:"";

  return topHtml+deptsHtml+restHtml;
}

function editUser(u) {
  openModal("تعديل المستخدم",`
    <label>الاسم الثلاثي</label>
    <input id="editUserName" value="${esc(u.name)}">

    <label>القسم</label>
    <select id="editUserDepartment">
      ${option("","بدون قسم")}
      ${db.departments.map(d=>
        option(d.id,d.name,d.id===u.departmentId)
      ).join("")}
    </select>

    <label>الشعبة أو المكتب</label>
    <select id="editUserUnit"></select>

    <label>الصلاحية</label>
    <select id="editUserRole">
      ${[
        ["employee","موظف"],
        ["manager","مسؤول"],
        ["admin","مديرة النظام"]
      ].map(([v,n])=>option(v,n,u.role===v)).join("")}
    </select>

    <!-- كلمات المرور تُغيَّر من الصفحة الرئيسية -->
    <input id="editUserPassword" type="password" class="hidden">

    <label>حالة الحساب</label>
    <select id="editUserActive">
      ${option("true","نشط",u.active!==false)}
      ${option("false","موقوف",u.active===false)}
    </select>

    <button class="btn primary" id="saveUserEdit">حفظ التعديل</button>
  `);

  const updateUnits=()=>{
    const selected=$("editUserDepartment").value;
    const old=$("editUserUnit").value || u.unitId;

    $("editUserUnit").innerHTML=option("","بدون شعبة أو مكتب")+
      db.units.filter(x=>x.departmentId===selected)
        .map(x=>option(x.id,`${unitKindName(x)}: ${x.name}`,x.id===old)).join("");
  };

  $("editUserDepartment").onchange=updateUnits;
  updateUnits();

  $("saveUserEdit").onclick=async()=>{
    const name=$("editUserName").value.trim();
    const password=$("editUserPassword").value;

    if (!name || db.users.some(x=>
      x.id!==u.id && loginKey(x.name)===loginKey(name)
    )) return notify("الاسم غير صالح أو مستخدم.");

    const newRole=$("editUserRole").value;
    if (u.id===currentUserId && newRole!=="admin" && isAdmin()) {
      return notify("لا يمكن إزالة صلاحية الإدارة من حسابك الحالي.");
    }

    if (password && password.length<6) {
      return notify("كلمة المرور يجب أن تكون 6 أحرف على الأقل.");
    }

    if (password && u.id===currentUserId) {
      return notify("لتغيير كلمة مرورك استخدمي زر «تغيير كلمة المرور».");
    }

    $("saveUserEdit").disabled=true;

    try {
      const batch=fs.batch();
      const oldKey=loginKey(u.name);
      const newKey=loginKey(name);

      // Firebase لا يسمح بتغيير كلمة مرور مستخدم آخر من المتصفح،
      // لذلك يُنشأ له حساب دخول جديد ويُلغى ربط الحساب القديم
      if (password) {
        const account=await createLoginAccount(password);
        if (u.authUid) batch.delete(fs.collection("accounts").doc(u.authUid));
        batch.set(fs.collection("accounts").doc(account.authUid),{userId:u.id});
        u.authUid=account.authUid;
        u.loginEmail=account.email;
      }

      if (password || oldKey!==newKey) {
        if (oldKey!==newKey) batch.delete(fs.collection("logins").doc(oldKey));
        if (u.loginEmail) {
          batch.set(fs.collection("logins").doc(newKey),{email:u.loginEmail});
        }
      }

      await batch.commit();

      u.name=name;
      u.departmentId=$("editUserDepartment").value;
      u.unitId=$("editUserUnit").value;
      u.role=newRole;
      u.active=$("editUserActive").value==="true";

      await save();
      closeModal();renderAll();
      $("currentUserInfo").textContent=current().name;
      notify("تم تحديث المستخدم.");
    } catch (err) {
      console.error(err);
      notify(authErrorText(err));
      $("saveUserEdit").disabled=false;
    }
  };
}

function editDepartment(d) {
  openModal("تعديل القسم",`
    <label>اسم القسم</label>
    <input id="editName" value="${esc(d.name)}">
    <label class="check-row">
      <input id="editIsDirectorate" type="checkbox" ${d===directorate()?"checked":""}>
      <span>هذه هي الإدارة العليا (رئيسها مسؤول جميع رؤساء الأقسام)</span>
    </label>
    <button class="btn primary" id="saveName">حفظ</button>
  `);

  $("saveName").onclick=()=>{
    const name=$("editName").value.trim();
    if (!name) return;
    d.name=name;

    // إدارة عليا واحدة فقط
    if ($("editIsDirectorate").checked) {
      db.departments.forEach(x=>{ if (x.id!==d.id) delete x.isDirectorate; });
      d.isDirectorate=true;
    } else {
      // false صريحة حتى لا يعيدها التعرّف التلقائي
      d.isDirectorate=false;
    }

    save();closeModal();renderAll();
  };
}

function editUnit(u) {
  openModal(`تعديل ال${unitKindName(u)}`,`
    <label>النوع</label>
    <select id="editUnitKind">
      ${Object.entries(UNIT_KINDS).map(([v,n])=>
        option(v,n,(u.kind||"unit")===v)).join("")}
    </select>
    <label>الاسم</label>
    <input id="editName" value="${esc(u.name)}">
    <label>القسم أو الإدارة التابع لها</label>
    <select id="editUnitDepartment">
      ${db.departments.map(d=>
        option(d.id,d.name,d.id===u.departmentId)
      ).join("")}
    </select>
    <label>المسؤول (اختياري)</label>
    <select id="editUnitManager">${userOptions(u.managerId,"بدون مسؤول")}</select>
    <button class="btn primary" id="saveName">حفظ</button>
  `);

  $("saveName").onclick=()=>{
    const name=$("editName").value.trim();
    if (!name) return;
    u.name=name;
    u.kind=$("editUnitKind").value;
    u.departmentId=$("editUnitDepartment").value;
    u.managerId=$("editUnitManager").value;
    save();closeModal();renderAll();
  };
}

$("managerAssignments").addEventListener("change",e=>{
  const select=e.target.closest("[data-manager-scope]");
  if (!select || !isAdmin()) return;

  const scope=select.dataset.managerScope;
  const id=select.dataset.managerId;
  const target=scope==="department"?department(id):unit(id);

  if (!target) return;

  const old=target.managerId;
  target.managerId=select.value;

  // منع أن يكون الشخص مسؤولاً عن نفسه مباشرة
  const invalid=activeUsers().some(u=>
    u.id===select.value && getManagerId(u)===u.id
  );

  if (invalid) {
    target.managerId=old;
    renderAll();
    return notify("لا يمكن تعيين الشخص مسؤولاً عن نفسه.");
  }

  save();renderAll();
  notify("تم تحديث المسؤول المباشر.");
});

/* =========================
   لوحة المعلومات
========================= */

function renderDashboard() {
  const mine=db.requests.filter(r=>r.employeeId===currentUserId);
  const managerId=getManagerId(current());

  // 1) طلبات تنتظر قراري، أو طلباتي قيد المراجعة للموظف
  const waitingLeaves=db.leaves.filter(awaitingMyLeaveDecision).length;
  const waitingCourses=db.requests.filter(r=>r.status==="pending" &&
    currentCourseReviewer(r)===currentUserId && r.employeeId!==currentUserId).length;
  const isReviewer=managesAnyone() || waitingLeaves+waitingCourses>0;

  const myPending=db.leaves.filter(l=>l.employeeId===currentUserId && l.status==="pending").length+
    mine.filter(r=>r.status==="pending").length;

  // 2) رصيدي
  const balance=availableBalance(currentUserId);

  // 3) الغائبون اليوم في قسمي (إجازات ودورات معتمدة)
  const myDept=current().departmentId;
  const absentToday=db.absences.filter(a=>a.status==="approved" &&
    a.startDate<=today() && a.endDate>=today() &&
    a.departmentId===myDept && a.employeeId!==currentUserId);

  // 4) مهامي كبديل التي لم تكتمل
  const coverTasks=[
    ...db.leaves.filter(l=>l.coverId===currentUserId && l.status==="approved"),
    ...db.requests.filter(r=>r.coverId===currentUserId && r.status==="approved")
  ].flatMap(x=>x.tasks||[]).filter(t=>t.status!=="completed").length;

  const cards=[
    isReviewer
      ? { n:waitingLeaves+waitingCourses, title:"طلبات تنتظر قرارك",
          sub:waitingLeaves+waitingCourses
            ? `${waitingLeaves} إجازة · ${waitingCourses} دورة` : "لا يوجد شيء معلّق",
          tab:waitingLeaves||!waitingCourses ? "leaves" : "approvals",
          alert:waitingLeaves+waitingCourses>0 }
      : { n:myPending, title:"طلباتي قيد المراجعة",
          sub:myPending ? "بانتظار قرار المسؤول" : "لا توجد طلبات معلّقة", tab:"leaves" },
    { n:balance ? balance.available : "—", title:"رصيد إجازاتي",
      sub:balance ? "يوم عمل متاح" : "أدخل رصيدك من صفحة الإجازات", tab:"leaves" },
    { n:absentToday.length, title:"غائبون اليوم في قسمي",
      sub:absentToday.length
        ? absentToday.map(a=>username(a.employeeId)+
            (a.coverId?` (البديل: ${username(a.coverId)})`:"")).join("، ")
        : "الجميع على رأس العمل", tab:"leaves" },
    { n:coverTasks, title:"مهامي كبديل",
      sub:coverTasks ? "مهام لم تكتمل بعد" : "لا توجد مهام", tab:"leaves" }
  ];

  $("stats").innerHTML=cards.map(c=>`
    <button type="button" class="stat stat-link ${c.alert?"stat-alert":""}" data-goto="${c.tab}">
      <strong>${esc(c.n)}</strong>
      <span>${esc(c.title)}</span>
      <small>${esc(c.sub)}</small>
    </button>
  `).join("");

  const instructions=db.instructions.filter(i=>i.managerId===managerId);

  const managerBlock=`
    <article class="panel">
      <h2>المسؤول المباشر</h2>
      <h3>${esc(username(managerId))}</h3>
      <div class="divider"></div>
      <h3>تعليمات المسؤول</h3>
      ${instructions.length
        ? [...instructions].reverse().map(i=>`
          <div class="message blue">
            <b>${esc(i.title||"تعليمات للفريق")}</b>
            <p>${esc(i.body)}</p>
          </div>
        `).join("")
        : `<p class="meta">لا توجد تعليمات منشورة حالياً.</p>`}
    </article>`;

  const received=db.assignments.filter(a=>
    a.employeeId===currentUserId &&
    ["new","in_progress"].includes(a.status)
  ).length;

  const waiting=db.requests.filter(r=>
    r.managerId===currentUserId && r.status==="pending"
  ).length;

  const inquiries=db.inquiries.filter(i=>
    i.managerId===currentUserId && i.status==="open"
  ).length;

  $("dashboardContent").innerHTML=`
    ${managerBlock}
    <div class="panel">
      <h2>ملخص المتابعة</h2>
      <p>طلبات دوراتي: <b>${mine.length}</b></p>
      <p>تكليفاتي النشطة: <b>${received}</b></p>
      ${managesAnyone()?`
        <p>دورات تنتظر اعتمادي: <b>${waiting}</b></p>
        <p>استفسارات وطلبات واردة: <b>${inquiries}</b></p>
        <p>تكليفات مرتجعة:
          <b>${db.assignments.filter(a=>
            a.managerId===currentUserId && a.status==="returned"
          ).length}</b>
        </p>`:""}
    </div>
  `;
}

/* =========================
   الإجراءات العامة
========================= */

document.addEventListener("click",e=>{
  const btn=e.target.closest("[data-action]");
  if (!btn) return;

  const action=btn.dataset.action;
  const id=btn.dataset.id;

  const r=db.requests.find(x=>x.id===id);
  const a=db.assignments.find(x=>x.id===id);
  const i=db.inquiries.find(x=>x.id===id);
  const n=db.notes.find(x=>x.id===id);
  const instruction=db.instructions.find(x=>x.id===id);

  if (r) {
    const mine=r.employeeId===currentUserId;
    const manager=r.managerId===currentUserId||isAdmin();

    if (action==="withdraw-course" && mine) return withdrawCourse(r);
    if (action==="approve-course" && manager && r.status==="pending")
      return decisionModal(r,"approve");
    if (action==="reject-course" && manager && r.status==="pending")
      return decisionModal(r,"reject");
    if (action==="change-cover" && manager && r.status==="approved")
      return changeCover(r);

    if (action==="edit-course" &&
        (isAdmin() || (mine && r.status==="pending")))
      return editCourse(r);

    if (action==="delete-course" && isAdmin()) {
      if (!confirm(`حذف طلب دورة «${r.courseName}» نهائياً؟ لا يمكن التراجع.`)) return;
      db.requests=db.requests.filter(x=>x.id!==r.id);
      save();renderAll();
      return notify("تم حذف الطلب.");
    }

    if (action==="hide-course-employee" &&
        mine && ["withdrawn","rejected","approved"].includes(r.status)) {
      if (!confirm("حذف الطلب من قائمتك؟ يبقى محفوظاً في السجل.")) return;
      r.hiddenForEmployee=true;
      log(r,"إخفاء الطلب من قائمة الموظف");
      save();renderAll();return;
    }

    if (action==="hide-course-manager" &&
        manager && ["approved","rejected"].includes(r.status)) {
      if (!confirm("حذف الطلب من قائمتك؟ يبقى محفوظاً في السجل.")) return;
      r.hiddenForManager=true;
      log(r,"إخفاء الطلب من قائمة المسؤول");
      save();renderAll();return;
    }

    if (action==="save-cover-task" &&
        r.coverId===currentUserId && r.status==="approved") {
      const task=(r.tasks||[]).find(t=>t.id===btn.dataset.taskId);
      if (!task) return;

      const status=document.querySelector(
        `[data-cover-status="${r.id}"][data-task-id="${task.id}"]`
      );
      const notes=document.querySelector(
        `[data-cover-notes="${r.id}"][data-task-id="${task.id}"]`
      );

      task.status=status.value;
      task.notes=notes.value.trim();
      task.updatedAt=now();
      log(r,"تحديث مهمة البديل",task.title);
      save();renderAll();notify("تم حفظ متابعة المهمة.");
      return;
    }
  }

  if (i && action==="open-inquiry" &&
      ([i.employeeId,i.managerId].includes(currentUserId) || isAdmin())) {
    return openInquiry(i);
  }

  if (a) {
    const employeeActions=[
      "start-assignment","complete-assignment","return-assignment"
    ];
    const managerActions=[
      "withdraw-assignment","transfer-assignment",
      "resend-assignment","hide-assignment"
    ];

    if (employeeActions.includes(action) &&
        a.employeeId===currentUserId &&
        ["new","in_progress"].includes(a.status)) {
      return assignmentAction(a,action);
    }

    if (managerActions.includes(action) &&
        a.managerId===currentUserId) {
      return assignmentAction(a,action);
    }
  }

  if (instruction &&
      (instruction.managerId===currentUserId||isAdmin())) {
    if (action==="edit-instruction") return editInstruction(instruction);

    if (action==="delete-instruction") {
      if (!confirm("حذف التعليمات؟")) return;
      db.instructions=db.instructions.filter(x=>x.id!==id);
      save();renderAll();return;
    }
  }

  if (n && n.userId===currentUserId) {
    if (action==="edit-note") {
      $("editingNoteId").value=n.id;
      $("noteTitle").value=n.title;
      $("noteBody").value=n.body;
      showTab("notes");
      $("noteBody").focus();
      return;
    }

    if (action==="delete-note") {
      if (!confirm("حذف الملاحظة الخاصة؟")) return;
      db.notes=db.notes.filter(x=>x.id!==id);
      save();renderAll();return;
    }
  }

  if (isAdmin()) {
    if (action==="edit-user") {
      const u=user(id);
      if (u) return editUser(u);
    }

    if (action==="edit-department") {
      const d=department(id);
      if (d) return editDepartment(d);
    }

    if (action==="edit-unit") {
      const u=unit(id);
      if (u) return editUnit(u);
    }

    if (action==="delete-unit") {
      const u=unit(id);
      if (!u) return;

      const members=db.users.filter(x=>x.unitId===id);
      if (members.length) {
        return notify(`لا يمكن حذف «${u.name}»: مرتبط بها ${members.length} موظف. انقليهم لشعبة أخرى أولاً.`);
      }

      if (!confirm(`حذف شعبة «${u.name}»؟`)) return;
      db.units=db.units.filter(x=>x.id!==id);
      save();renderAll();
      return notify("تم حذف الشعبة.");
    }

    if (action==="delete-department") {
      const d=department(id);
      if (!d) return;

      const units=db.units.filter(x=>x.departmentId===id);
      const members=db.users.filter(x=>x.departmentId===id);
      if (units.length || members.length) {
        return notify(`لا يمكن حذف «${d.name}»: مرتبط به ${units.length} شعبة و${members.length} موظف. انقليهم أو احذفي الشعب أولاً.`);
      }

      if (!confirm(`حذف قسم «${d.name}»؟`)) return;
      db.departments=db.departments.filter(x=>x.id!==id);
      save();renderAll();
      return notify("تم حذف القسم.");
    }
  }
});

/* =========================
   النسخة الاحتياطية
========================= */

$("exportBackupBtn").onclick=()=>{
  if (!isAdmin()) return;

  const blob=new Blob(
    [JSON.stringify(db,null,2)],
    {type:"application/json;charset=utf-8"}
  );

  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");
  link.href=url;
  link.download=`training_backup_${today()}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

// استيراد ملف «تصدير نسخة احتياطية» من نظام آخر (مثل النسخة القديمة)
$("importBackupBtn").onclick=()=>{
  if (isAdmin()) $("importBackupFile").click();
};

$("importBackupFile").onchange=async e=>{
  const file=e.target.files[0];
  e.target.value="";
  if (!file || !isAdmin()) return;

  let backup;
  try {
    backup=JSON.parse(await file.text());
    if (!Array.isArray(backup.users)) throw new Error("no-users");
  } catch {
    return notify("الملف غير صالح. اختاري ملف «تصدير نسخة احتياطية».");
  }

  // حسابي في النسخة يُدمج مع حسابي الحالي: كل ما يشير لمعرّفي القديم يشير لمعرّفي الحالي
  const me=current();
  const oldMe=backup.users.find(u=>loginKey(u.name)===loginKey(me.name));
  if (oldMe && oldMe.id!==me.id) {
    backup=JSON.parse(JSON.stringify(backup).split(oldMe.id).join(me.id));
  }

  // من له حساب هنا مسبقاً لا يُنشأ له حساب جديد
  const existing=new Set(db.users.map(u=>loginKey(u.name)));
  const newUsers=backup.users.filter(u=>u.id!==me.id && !existing.has(loginKey(u.name)));

  if (!confirm(`سيتم استيراد ${newUsers.length} موظف مع الأقسام والشعب والطلبات والسجلات.\nكل موظف يحصل على كلمة مرور مؤقتة تظهر لك في النهاية.\nمتابعة؟`)) return;

  // نقلي إلى مكاني في الهيكل حسب النسخة (مع بقاء صلاحيتي وحساب دخولي)
  const mine=backup.users.find(u=>u.id===me.id);
  if (mine) {
    Object.assign(me,{
      departmentId:mine.departmentId||me.departmentId||"",
      unitId:mine.unitId||me.unitId||""
    });
    await save();
  }

  backup.users=newUsers;
  await importLegacyData(backup,me.id);
};

/* =========================
   العرض والصلاحيات
========================= */

function renderNavigation() {
  const manager=managesAnyone();

  document.querySelectorAll(".nav-btn").forEach(btn=>{
    const tab=btn.dataset.tab;
    let visible=true;

    if (tab==="admin") visible=isAdmin();
    if (tab==="approvals") visible=manager||isAdmin();

    btn.classList.toggle("hidden",!visible);
  });
}

/* ---------- الإشعارات (العلامة الحمراء في القائمة) ---------- */

// آخر زيارة لكل صفحة، محفوظة في هذا المتصفح لكل مستخدم
const SEEN_KEY = "staff_seen_v1";

function seenMap() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}")[currentUserId] || null; }
  catch { return null; }
}

function saveSeen(map) {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    all[currentUserId] = map;
    localStorage.setItem(SEEN_KEY,JSON.stringify(all));
  } catch {}
}

// آخر نشاط قام به شخص غيري على المعاملة
function lastOtherActivity(item,creatorId) {
  const events = [
    ...(item.history || []),
    ...(item.messages || []),
    { by:creatorId, at:item.createdAt || item._createdAt },
    // التعليمات بلا سجل: تعديلها يُنسب لصاحبها
    ...(!item.history && !item.messages ? [{ by:creatorId, at:item.updatedAt }] : [])
  ];
  return events
    .filter(ev => ev.at && ev.by && ev.by !== currentUserId)
    .reduce((max,ev) => ev.at > max ? ev.at : max,"");
}

// لكل صفحة: المعاملات التي تخصني، وأيها ينتظر إجراءً مني
function notifySources() {
  const me = currentUserId;
  // ما حذفه المستخدم من قائمته لا يُحتسب في الإشعارات
  const hidden = item => (item.hiddenFor || []).includes(me) ||
    (item.hiddenForEmployee && item.employeeId === me) ||
    (item.hiddenForManager && item.employeeId !== me);
  const mine = (list,creator,pending=()=>false) =>
    list.filter(item => !hidden(item))
      .map(item => ({ item, creator:creator(item), pending:pending(item) }));

  return {
    leaves: mine(
      db.leaves.filter(l => [l.employeeId,l.managerId,l.coManagerId,l.finalApproverId,l.coverId].includes(me)),
      l => l.employeeId,
      l => awaitingMyLeaveDecision(l)),
    myRequests: mine(db.requests.filter(r => r.employeeId === me), r => r.employeeId),
    approvals: mine(
      db.requests.filter(r => r.employeeId !== me &&
        [currentCourseReviewer(r),r.managerId,r.forwardedBy].includes(me)),
      r => r.employeeId,
      r => r.status === "pending" && currentCourseReviewer(r) === me),
    coverTasks: mine(
      db.requests.filter(r => r.coverId === me && r.status === "approved"),
      r => r.employeeId),
    inquiries: mine(
      db.inquiries.filter(i => [i.employeeId,i.managerId].includes(me)),
      i => i.employeeId,
      i => i.status === "open" && i.managerId === me && i.employeeId !== me),
    assignments: mine(
      db.assignments.filter(a => [a.employeeId,a.managerId].includes(me)),
      a => a.managerId,
      a => a.employeeId === me && a.status === "new"),
    instructions: mine(
      db.instructions.filter(i => i.managerId === getManagerId(current()) &&
        i.managerId !== me),
      i => i.managerId)
  };
}

function renderNavBadges() {
  let seen = seenMap();
  const sources = notifySources();

  // أول دخول من هذا المتصفح: لا نعتبر القديم جديداً
  if (!seen) {
    seen = Object.fromEntries(Object.keys(sources).map(t => [t,now()]));
  }
  // الصفحة المفتوحة الآن تُعتبر مقروءة (حتى لو كانت ساعة جهاز المرسل متقدمة)
  if (sources[currentTab]) {
    seen[currentTab] = sources[currentTab]
      .map(x => lastOtherActivity(x.item,x.creator))
      .reduce((max,at) => at > max ? at : max,now());
  }
  saveSeen(seen);

  let total = 0;
  for (const [tab,list] of Object.entries(sources)) {
    const n = list.filter(x =>
      x.pending || lastOtherActivity(x.item,x.creator) > (seen[tab] || "")).length;
    total += n;

    const btn = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
    if (!btn) continue;
    btn.querySelector(".nav-badge")?.remove();
    if (n) {
      btn.insertAdjacentHTML("beforeend",
        `<span class="nav-badge" title="جديد أو ينتظر إجراءك">${n}</span>`);
    }
  }

  document.title = (total ? `(${total}) ` : "") + "نظام إدارة شؤون الموظفين";
}

function renderAll() {
  if (!current()) return;

  // كل جزء مستقل: خطأ في جزء لا يوقف بقية الصفحة
  const parts = {
    renderNavigation, renderCourseForm, renderCourses, renderCoverTasks,
    renderLeaves, renderInquiries, renderAssignmentRecipients,
    renderAssignments, renderInstructions, renderNotes,
    renderDashboard, renderAdmin, renderPublicOrgChart, renderNavBadges
  };
  const failed = [];

  for (const [name,fn] of Object.entries(parts)) {
    try { fn(); }
    catch (err) {
      console.error(name,err);
      failed.push(`${name}: ${err?.message || err}`);
    }
  }

  if (failed.length) notify(`حدث خطأ في العرض — ${failed.join(" | ")}`);
}

/* =========================
   الإجازات
========================= */

const LEAVE_TYPES = {
  annual:"إجازة سنوية",
  sick:"إجازة مرضية",
  emergency:"إجازة طارئة",
  unpaid:"إجازة بدون راتب",
  other:"إجازة أخرى"
};

// رصيد الإجازة السنوية بأيام العمل
const ANNUAL_LEAVE_DAYS = 30;

// أيام العطلة الأسبوعية في الشارقة: الجمعة والسبت والأحد (0 الأحد — 5 الجمعة — 6 السبت)
const WEEKEND_DAYS = [5,6,0];

const ACTIVE_STATUSES = ["pending","approved"];

function workingDays(start,end) {
  if (!start || !end || end < start) return 0;
  const last = Date.parse(end + "T00:00:00Z");
  let n = 0;
  for (let t = Date.parse(start + "T00:00:00Z"); t <= last; t += 86400000) {
    if (!WEEKEND_DAYS.includes(new Date(t).getUTCDay())) n++;
  }
  return n;
}

function overlapDays(aStart,aEnd,bStart,bEnd) {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  return s <= e ? daysBetween(s,e) : 0;
}

function absenceLabel(a) {
  return a.source === "leaves"
    ? LEAVE_TYPES[a.type] || "إجازة"
    : "دورة تدريبية";
}

// جميع غيابات الموظف النشطة (إجازات ودورات) من ملخصات الغياب
function absencesOf(userId,excludeId="") {
  return db.absences
    .filter(a => a.employeeId === userId && a.id !== excludeId &&
      ACTIVE_STATUSES.includes(a.status))
    .map(a => ({ ...a, kind:absenceLabel(a) }));
}

function overlapsOf(userId,start,end,excludeId="") {
  return absencesOf(userId,excludeId)
    .map(a => ({ ...a, userId, days:overlapDays(start,end,a.startDate,a.endDate) }))
    .filter(a => a.days > 0);
}

// إجازات زملاء القسم المتداخلة مع الفترة
function departmentConflicts(employeeId,departmentId,start,end,excludeId="") {
  if (!departmentId) return [];
  return activeUsers()
    .filter(u => u.id !== employeeId && u.departmentId === departmentId)
    .flatMap(u => overlapsOf(u.id,start,end,excludeId));
}

// الفترات التي يكون فيها الموظف بديلاً لغيره
function coverDutiesOf(userId,start,end,excludeId="") {
  return db.absences
    .filter(a => a.coverId === userId && a.id !== excludeId &&
      (a.source === "leaves"
        ? ACTIVE_STATUSES.includes(a.status)
        : a.status === "approved"))
    .map(a => ({ ...a, kind:absenceLabel(a),
      days:overlapDays(start,end,a.startDate,a.endDate) }))
    .filter(d => d.days > 0);
}

function annualTaken(userId,year,excludeId="") {
  const sum = status => db.absences
    .filter(a => a.source === "leaves" && a.employeeId === userId &&
      a.id !== excludeId && a.type === "annual" && a.status === status &&
      a.startDate.startsWith(String(year)))
    .reduce((n,a) => n + (a.workDays || 0),0);

  return { approved:sum("approved"), pending:sum("pending") };
}

function alertBox(kind,html) {
  return `<div class="alert ${kind}">${html}</div>`;
}

function periodText(a) {
  return `${formatDate(a.startDate)} إلى ${formatDate(a.endDate)}`;
}

/* ---------- تاريخ التعيين ورصيد الإجازات ---------- */

function profileOf(userId) {
  return db.profiles.find(p => p.userId === userId);
}

// أيام العمل المعتمدة التي أخذها الموظف في سنة معيّنة، لكل نوع إجازة
function takenByType(employeeId,year,excludeId="") {
  const result = {};
  db.absences
    .filter(a => a.source === "leaves" && a.status === "approved" &&
      a.employeeId === employeeId && a.id !== excludeId &&
      String(a.startDate).startsWith(String(year)))
    .forEach(a => { result[a.type] = (result[a.type] || 0) + (a.workDays || 0); });
  return result;
}

// ملخص للمسؤول؛ يُدمج مع ما حُفظ في الطلب لأن المسؤول قد لا يرى كل غيابات الموظف
function takenSummaryHTML(employeeId,year,excludeId,snapshot) {
  const live = takenByType(employeeId,year,excludeId);
  const merged = { ...(snapshot || {}) };
  for (const [t,n] of Object.entries(live)) merged[t] = Math.max(merged[t] || 0,n);

  const parts = Object.keys(LEAVE_TYPES)
    .filter(t => merged[t])
    .map(t => `${LEAVE_TYPES[t]}: <b>${dayCount(merged[t])}</b>`);

  return alertBox("info",
    `<b>إجازات ${esc(username(employeeId))} المعتمدة في ${year}:</b> ` +
    (parts.length ? parts.join(" · ") : "لم يأخذ إجازات بعد"));
}

// الرصيد المتاح = المُدخل − الإجازات السنوية المعتمدة والمعلقة بعد تاريخ إدخاله
function availableBalance(employeeId,excludeId="") {
  const p = profileOf(employeeId);
  if (!p || p.leaveBalance === "" || p.leaveBalance == null) return null;

  const since = p.balanceDate || "";
  const sum = status => db.absences
    .filter(a => a.source === "leaves" && a.type === "annual" &&
      a.employeeId === employeeId && a.id !== excludeId &&
      a.status === status && a.startDate >= since)
    .reduce((n,a) => n + (a.workDays || 0),0);

  const approved = sum("approved");
  const pending = sum("pending");
  return { balance:Number(p.leaveBalance), since, approved, pending,
    available:Number(p.leaveBalance) - approved - pending };
}

// تاريخ التعيين يُكتب يوماً وشهراً فقط (مثال 30/10) ويُحفظ "DD/MM"
// يرجع "" للخانة الفارغة و null لغير الصحيح
function parseDayMonth(text) {
  const s = String(text || "")
    .replace(/[٠-٩]/g,d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .trim();
  if (!s) return "";

  // تُقبل سنة مكتوبة بالخطأ وتُتجاهل
  const m = s.match(/^(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?:\s*[\/\-.]\s*\d{2,4})?$/);
  if (!m) return null;

  const [d,mo] = [Number(m[1]),Number(m[2])];
  const daysInMonth = [31,29,31,30,31,30,31,31,30,31,30,31][mo - 1];
  if (!daysInMonth || d < 1 || d > daysInMonth) return null;

  return `${String(d).padStart(2,"0")}/${String(mo).padStart(2,"0")}`;
}

// يعرض المحفوظ "DD/MM"، ويحوّل التواريخ القديمة الكاملة (YYYY-MM-DD)
function formatDayMonth(value) {
  if (!value) return "";
  const iso = String(value).match(/^\d{4}-(\d{2})-(\d{2})$/);
  return iso ? `${iso[2]}/${iso[1]}` : value;
}

// حفظ أو تحديث بيانات التعيين والرصيد لموظف
function saveProfile(userId,hireDate,balanceText) {
  let p = profileOf(userId);
  if (!p) {
    p = { id:userId, userId, hireDate:"", leaveBalance:"", balanceDate:"" };
    db.profiles.push(p);
  }

  const balance = balanceText === "" ? "" : Number(balanceText);
  if (balance !== p.leaveBalance) {
    p.leaveBalance = balance;
    p.balanceDate = balance === "" ? "" : today();
  }
  p.hireDate = hireDate;
  p.updatedAt = now();
  return save();
}

function renderProfileForm() {
  const p = profileOf(currentUserId);
  const editing = $("profileForm").contains(document.activeElement);

  if (!editing) {
    $("profileHireDate").value = formatDayMonth(p?.hireDate);
    $("profileBalance").value = p?.leaveBalance ?? "";
  }

  const info = availableBalance(currentUserId);
  $("profileSummary").innerHTML = [
    info ?`<span>الرصيد المتاح الآن: <b>${info.available}</b> يوم
      ${info.approved || info.pending
        ? `<small>(أُدخل ${info.balance} يوم بتاريخ ${formatDate(info.since)}،
           وخُصم منه ${info.approved + info.pending})</small>` : ""}</span>` : "",
    !info
      ? `<span class="meta">أدخل رصيدك الحالي حتى تحسب الحاسبة إجازتك بدقة.</span>` : ""
  ].filter(Boolean).join("");
}

$("profileForm").onsubmit = async e => {
  e.preventDefault();
  const balance = $("profileBalance").value;
  if (balance !== "" && Number(balance) < 0) return notify("الرصيد لا يمكن أن يكون سالباً.");

  const hire = parseDayMonth($("profileHireDate").value);
  if (hire === null) return notify("اكتب تاريخ التعيين بصيغة يوم/شهر، مثال 30/10.");

  const ok = await saveProfile(currentUserId,hire,balance);
  document.activeElement?.blur();
  renderAll();
  if (ok) notify("تم حفظ بياناتك.");
};

// ملخص الحاسبة والتعارضات
function leaveCalcHTML({employeeId,departmentId,type,startDate,endDate,coverId,excludeId="",takenSummary}) {
  if (!startDate || !endDate) {
    return alertBox("info","اختر تاريخ البداية والنهاية لحساب الإجازة.");
  }

  if (endDate < startDate) {
    return alertBox("danger","تاريخ النهاية قبل تاريخ البداية.");
  }

  const total = daysBetween(startDate,endDate);
  const work = workingDays(startDate,endDate);
  const stats = [["إجمالي الأيام",total],["أيام العمل",work]];
  const alerts = [];

  // المسؤول: ما أخذه الموظف هذه السنة حسب النوع (الرصيد نفسه سري)
  if (employeeId !== currentUserId) {
    alerts.push(takenSummaryHTML(employeeId,startDate.slice(0,4),excludeId,takenSummary));
  }

  // الرصيد خاص بالموظف: لا يظهر للمسؤول أو غيره
  if (type === "annual" && employeeId === currentUserId) {
    const info = availableBalance(employeeId,excludeId);

    if (info) {
      const remaining = info.available - work;
      stats.push(
        ["الرصيد المتاح",info.available],
        ["المتبقي بعد الإجازة",remaining]
      );

      if (info.pending) {
        alerts.push(alertBox("info",
          `يوجد ${info.pending} يوم عمل في طلبات سنوية قيد المراجعة، وتم خصمها من الرصيد.`));
      }
      if (remaining < 0) {
        alerts.push(alertBox("danger",
          `الإجازة تتجاوز الرصيد المتاح (${info.available} يوم) بـ ${-remaining} يوم.`));
      }
    } else {
      const year = startDate.slice(0,4);
      const taken = annualTaken(employeeId,year,excludeId);
      const remaining = ANNUAL_LEAVE_DAYS - taken.approved - taken.pending - work;

      stats.push(
        [`المستخدم في ${year}`,taken.approved],
        ["المتبقي بعد الإجازة",remaining]
      );
      alerts.push(alertBox("info",
        `لم يتم إدخال رصيد الإجازات، فتم الاحتساب على ${ANNUAL_LEAVE_DAYS} يوم سنوياً.`));

      if (remaining < 0) {
        alerts.push(alertBox("danger",
          `الإجازة تتجاوز الرصيد السنوي (${ANNUAL_LEAVE_DAYS} يوم عمل) بـ ${-remaining} يوم.`));
      }
    }
  }

  const own = overlapsOf(employeeId,startDate,endDate,excludeId);
  if (own.length) {
    alerts.push(alertBox("danger",
      `<b>${employeeId === currentUserId ? "لديك" : "للموظف"} غياب مسجّل في نفس الفترة:</b>` +
      own.map(a => `<p>• ${esc(a.kind)} — ${periodText(a)}</p>`).join("")));
  }

  const conflicts = departmentConflicts(employeeId,departmentId,startDate,endDate,excludeId);
  alerts.push(conflicts.length
    ? alertBox("danger",
        `<b>تعارض مع ${conflicts.length} من غيابات زملاء القسم:</b>` +
        conflicts.map(a => `<p>• ${esc(username(a.userId))} — ${esc(a.kind)}
          (${periodText(a)}) — تداخل ${a.days} يوم ${a.status === "pending" ? "— قيد المراجعة" : ""}</p>`
        ).join(""))
    : alertBox("ok", departmentId
        ? "لا يوجد تعارض مع إجازات زملاء القسم."
        : "لم يتم تحديد قسم للموظف، لذلك لم يتم فحص التعارض."));

  if (!coverId) {
    alerts.push(alertBox("warn","لم يتم اختيار موظف بديل."));
  } else {
    const busy = overlapsOf(coverId,startDate,endDate);
    const duties = coverDutiesOf(coverId,startDate,endDate,excludeId);

    if (busy.length) {
      alerts.push(alertBox("danger",
        `<b>البديل ${esc(username(coverId))} غير متاح:</b>` +
        busy.map(a => `<p>• ${esc(a.kind)} — ${periodText(a)}</p>`).join("")));
    } else {
      alerts.push(alertBox("ok",
        `البديل ${esc(username(coverId))} متاح طوال الفترة.`));
    }

    if (duties.length) {
      alerts.push(alertBox("warn",
        `<b>البديل مكلّف أيضاً بتغطية:</b>` +
        duties.map(d => `<p>• ${esc(username(d.employeeId))} — ${esc(d.kind)} (${periodText(d)})</p>`).join("")));
    }
  }

  const myDuties = coverDutiesOf(employeeId,startDate,endDate,excludeId);
  if (myDuties.length) {
    alerts.push(alertBox("warn",
      `<b>أنت مسجّل كبديل لزميل في هذه الفترة:</b>` +
      myDuties.map(d => `<p>• ${esc(username(d.employeeId))} — ${esc(d.kind)} (${periodText(d)})</p>`).join("")));
  }

  return `
    <div class="calc-grid">
      ${stats.map(([t,n]) => `
        <div class="stat"><strong>${n}</strong><span>${esc(t)}</span></div>
      `).join("")}
    </div>
    ${alerts.join("")}`;
}

// قائمة البدلاء مع تمييز غير المتاحين في الفترة
function leaveCoverOptions(employeeId,departmentId,selectedId,startDate,endDate) {
  const allowed = coverCandidates(user(employeeId));

  const busy = id => startDate && endDate && endDate >= startDate &&
    overlapsOf(id,startDate,endDate).length;

  return option("","اختر الموظف البديل") +
    allowed.map(u => option(u.id,
      busy(u.id) ? `${u.name} — غير متاح في الفترة` : u.name,
      u.id === selectedId)).join("");
}

function renderLeaveForm() {
  const me = current();
  const managerId = getManagerId(me);

  if (!$("leaveType").options.length) {
    $("leaveType").innerHTML = Object.entries(LEAVE_TYPES)
      .map(([v,t]) => option(v,t)).join("");
  }

  fillManagerSelect("leaveManager");
  renderCoManagerRow();

  updateLeaveCalc();
}

function updateLeaveCalc() {
  const me = current();
  if (!me) return;

  $("leaveCover").innerHTML = leaveCoverOptions(
    me.id,me.departmentId,$("leaveCover").value,
    $("leaveStart").value,$("leaveEnd").value
  );

  $("leaveCalc").innerHTML = leaveCalcHTML({
    employeeId:me.id,
    departmentId:me.departmentId,
    type:$("leaveType").value,
    startDate:$("leaveStart").value,
    endDate:$("leaveEnd").value,
    coverId:$("leaveCover").value
  });
}

["leaveType","leaveStart","leaveEnd","leaveCover"].forEach(id => {
  $(id).onchange = updateLeaveCalc;
});

function addLeaveTaskRow() {
  const div = document.createElement("div");
  div.className = "task-entry";
  div.innerHTML = `
    <label>المهمة</label>
    <input class="leave-task-title">
    <label>وضعها الحالي (ما تم إنجازه وما بقي)</label>
    <textarea class="leave-task-state" rows="2"></textarea>
    <label>المطلوب من الموظف البديل</label>
    <textarea class="leave-task-action" rows="2"></textarea>
    <label>موعد التسليم (اختياري)</label>
    <input class="leave-task-due" type="date">
    <button type="button" class="btn danger small remove-task">
      حذف المهمة
    </button>
  `;
  div.querySelector(".remove-task").onclick = () => div.remove();
  $("leaveTasks").appendChild(div);
}

$("addLeaveTaskBtn").onclick = addLeaveTaskRow;

$("leaveForm").onsubmit = e => {
  e.preventDefault();

  const me = current();
  const managerId = selectedManager("leaveManager");

  if (!managerId) {
    return notify("يجب تعيين مسؤول مباشر لحسابك أولاً.");
  }

  const startDate = $("leaveStart").value;
  const endDate = $("leaveEnd").value;
  if (endDate < startDate) return notify("تاريخ نهاية الإجازة غير صحيح.");

  if (overlapsOf(me.id,startDate,endDate).length) {
    return notify("لديك إجازة أو دورة مسجّلة في نفس الفترة.");
  }

  const coverId = $("leaveCover").value;
  if (coverId && overlapsOf(coverId,startDate,endDate).length &&
      !confirm("الموظف البديل غير متاح في هذه الفترة. إرسال الطلب مع ذلك؟")) {
    return;
  }

  const tasks = [...document.querySelectorAll("#leaveTasks .task-entry")]
    .map(el => ({
      id:uid(),
      title:el.querySelector(".leave-task-title").value.trim(),
      currentState:el.querySelector(".leave-task-state").value.trim(),
      coverAction:el.querySelector(".leave-task-action").value.trim(),
      dueDate:el.querySelector(".leave-task-due").value,
      status:"not_started",
      coverNotes:"",
      updatedAt:null
    }))
    .filter(t => t.title);

  const l = {
    id:uid(),
    employeeId:me.id,
    managerId,
    // صاحب الوظيفتين: نفس الطلب لمسؤوله الثاني ويلزم اعتماد الاثنين
    coManagerId:$("leaveCoCheck").checked ? coLeaveManager() : "",
    // بعد رئيس الشعبة يعتمد رئيس القسم نهائياً
    finalApproverId:finalApproverFor(me,managerId),
    departmentId:me.departmentId || "",
    unitId:me.unitId || "",
    type:$("leaveType").value,
    startDate,endDate,
    days:daysBetween(startDate,endDate),
    workDays:workingDays(startDate,endDate),
    // ما أخذه الموظف هذه السنة حسب النوع، ليراه المسؤول (بدون الرصيد)
    takenSummary:takenByType(me.id,startDate.slice(0,4)),
    coverId,
    notes:$("leaveNotes").value.trim(),
    managerNotes:"",
    tasks,
    status:"pending",
    createdAt:now(),
    decidedAt:null,
    history:[]
  };

  log(l,"إنشاء طلب إجازة");
  db.leaves.push(l);
  save();

  e.target.reset();
  $("leaveTasks").innerHTML = "";
  notify("تم إرسال طلب الإجازة للمسؤول.");
  renderAll();
};

/* ---------- مراحل اعتماد الإجازة ----------
   المرحلة الأولى: المسؤول المباشر (ومسؤول ثانٍ لصاحب الوظيفتين)
   المرحلة النهائية: رئيس القسم إذا كان الطلب أولاً عند رئيس الشعبة */

function leaveApprovers(l) {
  return [l.managerId,l.coManagerId].filter(Boolean);
}

// قرار كل معتمد: managerApproval / coManagerApproval / finalApproval
function approvalOf(l,id) {
  if (id === l.managerId) return l.managerApproval || "";
  if (id === l.coManagerId) return l.coManagerApproval || "";
  if (id === l.finalApproverId) return l.finalApproval || "";
  return "";
}

function firstStageDone(l) {
  return leaveApprovers(l).every(id => approvalOf(l,id) === "approved");
}

// رئيس القسم الذي يعتمد نهائياً بعد رئيس الشعبة (إن وُجد ومختلف)
function finalApproverFor(employee,managerId) {
  const un = unit(employee.unitId);
  if (!un || un.managerId !== managerId) return "";
  const head = department(un.departmentId)?.managerId;
  return head && head !== managerId && head !== employee.id && user(head) ? head : "";
}

function leaveStatusOf(l) {
  const states = [...leaveApprovers(l).map(id => approvalOf(l,id)),
    l.finalApproverId ? l.finalApproval || "" : "approved"];
  if (states.includes("rejected")) return "rejected";
  return states.every(s => s === "approved") ? "approved" : "pending";
}

// هل دوري الآن في اتخاذ القرار؟
function canActOnLeave(l) {
  if (l.status !== "pending") return false;
  if (isAdmin() && ![...leaveApprovers(l),l.finalApproverId].includes(currentUserId)) return true;
  if (leaveApprovers(l).includes(currentUserId)) return !approvalOf(l,currentUserId);
  return currentUserId === l.finalApproverId && firstStageDone(l) && !l.finalApproval;
}

function awaitingMyLeaveDecision(l) {
  return l.employeeId !== currentUserId && canActOnLeave(l) &&
    [...leaveApprovers(l),l.finalApproverId].includes(currentUserId);
}

function canDecideLeave(l) {
  return [...leaveApprovers(l),l.finalApproverId].includes(currentUserId) || isAdmin();
}

// المسؤول الثاني المتاح لصاحب الوظيفتين (غير المختار في القائمة)
function coLeaveManager() {
  const primary = $("leaveManager").value;
  return managerChoices(current()).find(c => c.id !== primary)?.id || "";
}

function renderCoManagerRow() {
  const primary = $("leaveManager").value;
  const other = managerChoices(current()).find(c => c.id !== primary);
  $("leaveCoRow").classList.toggle("hidden",!other);
  if (other) {
    $("leaveCoText").textContent =
      `إرسال نفس الطلب أيضاً إلى ${username(other.id)}${other.why ? " — " + other.why : ""} (يلزم اعتماد الاثنين)`;
  } else {
    $("leaveCoCheck").checked = false;
  }
}

$("leaveManager").addEventListener("change",renderCoManagerRow);

function approvalsHTML(l) {
  if (!l.coManagerId && !l.finalApproverId) return "";
  const label = s => s === "approved" ? "✅ معتمد" : s === "rejected" ? "❌ مرفوض"
    : l.status === "rejected" ? "— لا يلزم" : "⏳ بانتظار القرار";
  const finalLabel = l.finalApproval ? label(l.finalApproval)
    : l.status === "rejected" ? "— لا يلزم"
    : firstStageDone(l) ? "⏳ بانتظار الاعتماد النهائي" : "— بعد موافقة رئيس الشعبة";

  return `<div class="approvals">
    ${leaveApprovers(l).map(id =>
      `<span>${esc(username(id))}: <b>${label(approvalOf(l,id))}</b></span>`).join("")}
    ${l.finalApproverId ? `<span>${esc(username(l.finalApproverId))} (رئيس القسم): <b>${finalLabel}</b></span>` : ""}
  </div>`;
}

// خيارات البديل لرئيس القسم: أي موظف في القسم كله
function departmentCoverOptions(l,selectedId) {
  const busy = id => overlapsOf(id,l.startDate,l.endDate).length;
  const staff = activeUsers().filter(u =>
    u.id !== l.employeeId && u.departmentId === l.departmentId);

  return option("","اختر الموظف البديل") +
    staff.map(u => option(u.id,
      `${u.name}${u.unitId ? " — " + unitName(u.unitId) : ""}${busy(u.id) ? " — غير متاح في الفترة" : ""}`,
      u.id === selectedId)).join("");
}

// رئيس القسم والمديرة يختاران البديل من القسم كله
function coverOptionsFor(l,selectedId) {
  return currentUserId === l.finalApproverId || isAdmin()
    ? departmentCoverOptions(l,selectedId)
    : leaveCoverOptions(l.employeeId,l.departmentId,selectedId,l.startDate,l.endDate);
}

function leaveTasksHTML(l,editable) {
  if (!(l.tasks || []).length) return "<p class=\"meta\">لا توجد مهام معلّقة.</p>";

  return l.tasks.map(t => `
    <div class="task-entry">
      <div class="section-head">
        <b>${esc(t.title)}</b>
        ${badge(t.status)}
      </div>
      ${t.currentState ? `<p><b>الوضع الحالي:</b> ${esc(t.currentState)}</p>` : ""}
      ${t.coverAction ? `<p><b>المطلوب من البديل:</b> ${esc(t.coverAction)}</p>` : ""}
      ${t.dueDate ? `<p class="meta">موعد التسليم: ${formatDate(t.dueDate)}</p>` : ""}
      ${editable ? `
        <label>حالة المهمة</label>
        <select data-leave-status="${l.id}" data-task-id="${t.id}">
          ${[
            ["not_started","لم تبدأ"],
            ["in_progress","قيد التنفيذ"],
            ["completed","مكتملة"]
          ].map(([v,n]) => option(v,n,t.status === v)).join("")}
        </select>
        <label>ملاحظات البديل</label>
        <textarea data-leave-notes="${l.id}"
          data-task-id="${t.id}">${esc(t.coverNotes || "")}</textarea>
        <button class="btn purple small" data-action="leave-save-task"
          data-id="${l.id}" data-task-id="${t.id}">حفظ المتابعة</button>
      ` : t.coverNotes ? `<p><b>ملاحظات البديل:</b> ${esc(t.coverNotes)}</p>` : ""}
    </div>
  `).join("");
}

function leaveCard(l,context) {
  let buttons = "";

  if (context === "mine" && l.status === "pending") {
    buttons += `<button class="btn warning small"
      data-action="leave-withdraw" data-id="${l.id}">سحب الطلب</button>`;
  }

  // الطلب المنتهي بالرفض أو السحب يمكن إخفاؤه من القائمة
  if (canHideLeave(l) && ["mine","manager"].includes(context)) {
    buttons += `<button class="btn danger small"
      data-action="leave-hide" data-id="${l.id}">حذف من قائمتي</button>`;
  }

  if (context === "manager" && canDecideLeave(l)) {
    if (canActOnLeave(l)) {
      buttons += `
        <button class="btn primary small"
          data-action="leave-approve" data-id="${l.id}">اعتماد</button>
        <button class="btn danger small"
          data-action="leave-reject" data-id="${l.id}">رفض</button>`;
    }
    if (l.status === "approved" && l.endDate >= today()) {
      buttons += `<button class="btn purple small"
        data-action="leave-change-cover" data-id="${l.id}">تغيير البديل</button>`;
    }
    if (canEscalateLeave(l)) {
      buttons += `<button class="btn warning small"
        data-action="leave-escalate" data-id="${l.id}">إرسال لرئيس القسم للاعتماد</button>`;
    }
  }

  // تعديل الطلب: لصاحبه قبل القرار، وللمديرة دائماً
  if ((context === "mine" && l.status === "pending") ||
      (context === "manager" && isAdmin())) {
    buttons += `<button class="btn outline small"
      data-action="leave-edit" data-id="${l.id}">تعديل</button>`;
  }

  if (context === "manager" && isAdmin()) {
    buttons += `<button class="btn danger small"
      data-action="leave-delete" data-id="${l.id}">حذف نهائي</button>`;
  }

  const showCalc = l.status === "pending" && ["mine","manager"].includes(context);
  const showTasks = context !== "department";

  return `
    <article class="card ${context === "cover" ? "purple" : "blue"}">
      <div class="section-head">
        <h3>${esc(LEAVE_TYPES[l.type] || "إجازة")}</h3>
        ${badge(l.status)}
      </div>
      <p>الموظف: <b>${esc(username(l.employeeId))}</b></p>
      <p class="meta">
        ${periodText(l)} — ${l.days} يوم (${l.workDays} يوم عمل)
      </p>
      <p>الموظف البديل: <b>${esc(username(l.coverId))}</b></p>
      ${context !== "department" ? `<p>المسؤول: ${[...leaveApprovers(l),l.finalApproverId].filter(Boolean).map(id => esc(username(id))).join(" ثم ")}</p>${approvalsHTML(l)}` : ""}
      ${l.notes && showTasks ? `<p>ملاحظات الموظف: ${esc(l.notes)}</p>` : ""}
      ${l.managerNotes ? `<p>ملاحظات المسؤول: ${esc(l.managerNotes)}</p>` : ""}
      ${showCalc ? `<div class="leave-calc">${leaveCalcHTML({ ...l, excludeId:l.id })}</div>` : ""}
      ${showTasks ? `
        <div class="divider"></div>
        <h3>المهام المسلّمة للبديل (${(l.tasks || []).length})</h3>
        ${leaveTasksHTML(l,context === "cover")}` : ""}
      <div class="actions">${buttons}</div>
    </article>`;
}

function renderLeaves() {
  renderLeaveForm();
  renderProfileForm();

  const hiddenForMe = l => (l.hiddenFor || []).includes(currentUserId);
  const mine = db.leaves.filter(l => l.employeeId === currentUserId && !hiddenForMe(l));
  const approvals = db.leaves.filter(l =>
    canDecideLeave(l) && l.employeeId !== currentUserId && !hiddenForMe(l)
  );
  const covering = db.leaves.filter(l =>
    l.coverId === currentUserId && l.status === "approved"
  );

  const myDepartment = current().departmentId;
  // من ملخصات الغياب: التاريخ والبديل فقط بدون تفاصيل الطلب
  const upcoming = db.absences
    .filter(a => a.source === "leaves" &&
      ACTIVE_STATUSES.includes(a.status) && a.endDate >= today() &&
      (isAdmin() || (myDepartment && a.departmentId === myDepartment)))
    .sort((a,b) => a.startDate.localeCompare(b.startDate));

  const list = (items,context,message) => items.length
    ? items.map(l => leaveCard(l,context)).join("")
    : `<div class="empty">${esc(message)}</div>`;

  $("myLeavesList").innerHTML =
    list([...mine].reverse(),"mine","لا توجد طلبات إجازة.");

  $("leaveApprovalsBlock").classList.toggle(
    "hidden", !approvals.length && !managesAnyone() && !isAdmin()
  );
  $("leaveApprovalsList").innerHTML =
    list([...approvals].reverse(),"manager","لا توجد طلبات إجازة واردة.");

  $("leaveCoverList").innerHTML =
    list([...covering].reverse(),"cover","لا توجد إجازات أنت البديل فيها.");

  $("departmentLeavesList").innerHTML =
    list(upcoming,"department","لا توجد إجازات قادمة في القسم.");
}

function leaveDecisionModal(l,approve) {
  openModal(approve ? "اعتماد طلب الإجازة" : "رفض طلب الإجازة",`
    <p><b>${esc(LEAVE_TYPES[l.type])}</b> — ${esc(username(l.employeeId))}</p>
    <p>الفترة: ${periodText(l)} — ${l.days} يوم (${l.workDays} يوم عمل)</p>
    <div class="leave-calc" id="leaveModalCalc">${leaveCalcHTML({ ...l, excludeId:l.id })}</div>
    ${approve ? `
      <label>${currentUserId === l.finalApproverId ? "الموظف البديل (يمكنك اختيار أي موظف في القسم)" : "الموظف البديل"}</label>
      <select id="leaveModalCover">
        ${coverOptionsFor(l,l.coverId)}
      </select>` : ""}
    ${approve && leaveApprovers(l).includes(currentUserId) &&
      (l.finalApproverId || finalApproverFor(user(l.employeeId) || {},l.managerId))
      ? alertBox("info",`بعد موافقتك ينتقل الطلب إلى ${esc(username(l.finalApproverId || finalApproverFor(user(l.employeeId) || {},l.managerId)))} (رئيس القسم) للاعتماد النهائي.`) : ""}
    <label>ملاحظات المسؤول (اختياري)</label>
    <textarea id="leaveModalNotes" rows="3"></textarea>
    <div class="actions">
      <button class="btn ${approve ? "primary" : "danger"}" id="confirmLeaveDecision">
        ${approve ? "تأكيد الاعتماد" : "تأكيد الرفض"}
      </button>
      <button class="btn outline" id="cancelLeaveDecision">إلغاء</button>
    </div>
  `);

  $("cancelLeaveDecision").onclick = closeModal;

  if (approve) {
    $("leaveModalCover").onchange = () => {
      $("leaveModalCalc").innerHTML = leaveCalcHTML({
        ...l, coverId:$("leaveModalCover").value, excludeId:l.id
      });
    };
  }

  $("confirmLeaveDecision").onclick = () => {
    if (l.status !== "pending") return closeModal();

    const decision = approve ? "approved" : "rejected";
    const notes = $("leaveModalNotes").value.trim();
    if (approve) l.coverId = $("leaveModalCover").value;

    // قرار كل معتمد على حدة؛ المديرة من خارج المعتمدين تقرر عن الجميع
    // الطلب محفوظ باسم حساب قديم (محذوف أو مكرر بنفس اسمي) وأنا رئيس الشعبة الفعلي
    const emp = user(l.employeeId) || {};
    const staleManager = !user(l.managerId) ||
      loginKey(username(l.managerId)) === loginKey(current().name);
    if (unitHeadOf(emp) === currentUserId && !leaveApprovers(l).includes(currentUserId) &&
        staleManager) {
      l.managerId = currentUserId;
    }

    // طلبات قُدّمت قبل مرحلة رئيس القسم: تُضاف المرحلة عند موافقة رئيس الشعبة
    if (!l.finalApproverId && currentUserId === l.managerId) {
      l.finalApproverId = finalApproverFor(emp,l.managerId);
    }

    const involved = [...leaveApprovers(l),l.finalApproverId].includes(currentUserId);
    if (!involved || currentUserId === l.managerId) l.managerApproval = decision;
    if (l.coManagerId && (!involved || currentUserId === l.coManagerId)) l.coManagerApproval = decision;
    if (l.finalApproverId && (!involved || currentUserId === l.finalApproverId)) l.finalApproval = decision;

    l.status = leaveStatusOf(l);

    if (notes) {
      l.managerNotes = [l.managerNotes, `${username(currentUserId)}: ${notes}`]
        .filter(Boolean).join(" — ");
    }
    if (l.status !== "pending") l.decidedAt = now();

    log(l,approve ? "اعتماد الإجازة" : "رفض الإجازة",notes);
    save();closeModal();renderAll();
    notify("تم حفظ القرار.");
  };
}

function editLeave(l) {
  openModal("تعديل طلب الإجازة",`
    <label>نوع الإجازة</label>
    <select id="editLeaveType">
      ${Object.entries(LEAVE_TYPES).map(([v,t]) => option(v,t,v === l.type)).join("")}
    </select>
    <div class="form-grid">
      <div>
        <label>من تاريخ</label>
        <input id="editLeaveStart" type="date" value="${esc(l.startDate)}">
      </div>
      <div>
        <label>إلى تاريخ</label>
        <input id="editLeaveEnd" type="date" value="${esc(l.endDate)}">
      </div>
    </div>
    <label>الموظف البديل</label>
    <select id="editLeaveCover"></select>
    <div class="leave-calc" id="editLeaveCalc"></div>
    <label>ملاحظات</label>
    <textarea id="editLeaveNotes" rows="3">${esc(l.notes || "")}</textarea>
    <button class="btn primary" id="saveLeaveEdit">حفظ التعديل</button>
  `);

  const draft = () => ({
    ...l,
    type:$("editLeaveType").value,
    startDate:$("editLeaveStart").value,
    endDate:$("editLeaveEnd").value,
    coverId:$("editLeaveCover").value || l.coverId,
    excludeId:l.id
  });

  const refresh = () => {
    const d = draft();
    $("editLeaveCover").innerHTML = leaveCoverOptions(
      l.employeeId,l.departmentId,d.coverId,d.startDate,d.endDate);
    $("editLeaveCalc").innerHTML = leaveCalcHTML(d);
  };

  ["editLeaveType","editLeaveStart","editLeaveEnd","editLeaveCover"]
    .forEach(id => $(id).onchange = refresh);
  refresh();

  $("saveLeaveEdit").onclick = () => {
    const d = draft();
    if (!d.startDate || !d.endDate || d.endDate < d.startDate) {
      return notify("تاريخ نهاية الإجازة غير صحيح.");
    }

    Object.assign(l,{
      type:d.type,
      startDate:d.startDate,
      endDate:d.endDate,
      days:daysBetween(d.startDate,d.endDate),
      workDays:workingDays(d.startDate,d.endDate),
      coverId:$("editLeaveCover").value,
      notes:$("editLeaveNotes").value.trim()
    });
    log(l,"تعديل طلب الإجازة");
    save();closeModal();renderAll();
    notify("تم تعديل الطلب.");
  };
}

function changeLeaveCover(l) {
  openModal("تغيير الموظف البديل",`
    <p>${esc(LEAVE_TYPES[l.type])} — ${esc(username(l.employeeId))}</p>
    <label>الموظف البديل</label>
    <select id="leaveModalCover">
      ${coverOptionsFor(l,l.coverId)}
    </select>
    <label>سبب التغيير (اختياري)</label>
    <textarea id="leaveModalNotes"></textarea>
    <button class="btn primary" id="saveLeaveCover">حفظ التغيير</button>
  `);

  $("saveLeaveCover").onclick = () => {
    const old = l.coverId;
    l.coverId = $("leaveModalCover").value;
    log(l,"تغيير البديل",
      `${username(old)} ← ${username(l.coverId)}. ${$("leaveModalNotes").value}`);
    save();closeModal();renderAll();
    notify("تم تغيير الموظف البديل.");
  };
}

document.addEventListener("click",e => {
  const btn = e.target.closest("[data-action^='leave-']");
  if (!btn) return;

  const l = db.leaves.find(x => x.id === btn.dataset.id);
  if (!l) return;

  const action = btn.dataset.action;

  if (action === "leave-hide" && canHideLeave(l)) {
    if (!confirm("حذف هذه الإجازة من قائمتك؟ تبقى محفوظة في السجل.")) return;
    l.hiddenFor = [...new Set([...(l.hiddenFor || []),currentUserId])];
    save();renderAll();
    return notify("تم حذف الإجازة من قائمتك.");
  }

  if (action === "leave-escalate" && canEscalateLeave(l)) {
    if (!confirm(`إرسال الإجازة إلى ${username(finalApproverFor(user(l.employeeId),unitHeadOf(user(l.employeeId))))} (رئيس القسم) للاعتماد النهائي؟`)) return;
    l.finalApproverId = finalApproverFor(user(l.employeeId),unitHeadOf(user(l.employeeId)));
    l.managerId = unitHeadOf(user(l.employeeId)) || l.managerId;
    l.managerApproval = "approved";
    if (l.coManagerId && !l.coManagerApproval) l.coManagerApproval = "approved";
    l.status = leaveStatusOf(l);
    log(l,"إرسال الإجازة لرئيس القسم للاعتماد النهائي");
    save();renderAll();
    return notify("تم إرسال الطلب لرئيس القسم.");
  }

  if (action === "leave-edit" &&
      (isAdmin() || (l.employeeId === currentUserId && l.status === "pending"))) {
    return editLeave(l);
  }

  if (action === "leave-delete" && isAdmin()) {
    if (!confirm(`حذف ${LEAVE_TYPES[l.type] || "الإجازة"} لـ ${username(l.employeeId)} نهائياً؟ لا يمكن التراجع.`)) return;
    db.leaves = db.leaves.filter(x => x.id !== l.id);
    save();renderAll();
    return notify("تم حذف الإجازة.");
  }

  if (action === "leave-withdraw" &&
      l.employeeId === currentUserId && l.status === "pending") {
    if (!confirm("سحب طلب الإجازة؟")) return;
    l.status = "withdrawn";
    log(l,"سحب طلب الإجازة");
    save();renderAll();
    return notify("تم سحب الطلب.");
  }

  if (canDecideLeave(l)) {
    if (action === "leave-approve" && l.status === "pending")
      return leaveDecisionModal(l,true);
    if (action === "leave-reject" && l.status === "pending")
      return leaveDecisionModal(l,false);
    if (action === "leave-change-cover" && l.status === "approved")
      return changeLeaveCover(l);
  }

  if (action === "leave-save-task" &&
      l.coverId === currentUserId && l.status === "approved") {
    const task = (l.tasks || []).find(t => t.id === btn.dataset.taskId);
    if (!task) return;

    task.status = document.querySelector(
      `[data-leave-status="${l.id}"][data-task-id="${task.id}"]`).value;
    task.coverNotes = document.querySelector(
      `[data-leave-notes="${l.id}"][data-task-id="${task.id}"]`).value.trim();
    task.updatedAt = now();

    log(l,"تحديث مهمة البديل",task.title);
    save();renderAll();
    notify("تم حفظ متابعة المهمة.");
  }
});

/* =========================
   تشغيل النظام
========================= */

// يبدأ التشغيل في آخر الملف بعد تعريف كل الإضافات


/* ==========================================
   مسار اعتماد الدورات لرؤساء الشعب والأقسام
========================================== */

// تحديد ما إذا كان المستخدم رئيس شعبة
function isUnitHead(userId) {
  return db.units.some(u => u.managerId === userId);
}

// تحديد ما إذا كان المستخدم رئيس قسم
function isDepartmentHead(userId) {
  return db.departments.some(d => d.managerId === userId);
}

// رئيس القسم التابع لرئيس الشعبة
function departmentHeadForUnitHead(userId) {
  const managedUnit = db.units.find(u => u.managerId === userId);
  if (!managedUnit) return null;

  const dept = department(managedUnit.departmentId);
  return dept?.managerId && dept.managerId !== userId
    ? dept.managerId
    : null;
}

// تحديد المسؤول الإداري لرئيس القسم
function administrativeReviewer(userId) {
  const managedDept = db.departments.find(
    d => d.managerId === userId
  );

  // مدير الإدارة العليا لا يتبع أحداً
  if (managedDept && managedDept === directorate()) return null;
  return managedDept?.adminReviewerId || null;
}

// الإدارة العليا: المحددة يدوياً، وإلا أول قسم يبدأ اسمه بـ«إدارة»
function directorate() {
  return db.departments.find(d => d.isDirectorate === true) ||
    db.departments.find(d => d.isDirectorate !== false &&
      /^\s*(ال)?[إا]دار[ةه]/.test(d.name));
}

// مدير الإدارة العليا هو المسؤول الافتراضي لرؤساء الأقسام
function directorFor(userId) {
  const top = directorate();
  return top?.managerId && top.managerId !== userId && user(top.managerId)
    ? top.managerId
    : null;
}

// من يحق للموظف الإرسال إليه: مسؤوله حسب منصبه، ومسؤول مكان عضويته
function managerChoices(u) {
  const list = [];
  const add = (id,why) => {
    if (id && id !== u.id && user(id) && !list.some(x => x.id === id)) {
      list.push({ id, why });
    }
  };

  const headedUnit = db.units.find(x => x.managerId === u.id);
  const headedDept = db.departments.find(x => x.managerId === u.id);
  add(getManagerId(u),
    headedDept ? `بصفتك رئيس ${headedDept.name}` :
    headedUnit ? `بصفتك ${unitHeadTitle(headedUnit)}: ${headedUnit.name}` : "");

  // صاحب الوظيفتين فقط: مسؤول المكان الذي يعمل فيه فعلياً
  // (الأقرب: مسؤول المكتب/الشعبة، ثم رئيس القسم، ثم مدير الإدارة)
  if (headedUnit || headedDept) {
    const myUnit = unit(u.unitId);
    const myDept = department(u.departmentId);
    const where = myUnit ? `${unitKindName(myUnit)} ${myUnit.name}` : myDept?.name || "";
    const candidates = [myUnit?.managerId, myDept?.managerId, myDept ? directorFor(u.id) : ""]
      .filter(id => id && id !== u.id && user(id));
    if (candidates.length) add(candidates[0], `بصفتك في ${where}`);
  }

  return list;
}

function fillManagerSelect(id) {
  const el = $(id);
  if (!el || !current()) return;

  const old = el.value;
  const choices = managerChoices(current());

  el.innerHTML = choices.length
    ? choices.map(c => option(c.id, c.why ? `${username(c.id)} — ${c.why}` : username(c.id)))
        .join("")
    : option("","لم يتم تحديد مسؤول مباشر");
  el.disabled = choices.length < 2;
  if (choices.some(c => c.id === old)) el.value = old;
}

function selectedManager(id) {
  return $(id)?.value || getManagerId(current());
}

// الاحتفاظ بالدالة الأصلية
const originalGetManagerId = getManagerId;

getManagerId = function(u) {
  if (!u) return null;

  // رئيس القسم يتبع المسؤول الإداري المحدد له
  if (isDepartmentHead(u.id)) {
    return administrativeReviewer(u.id) || directorFor(u.id);
  }

  // رئيس الشعبة يتبع رئيس القسم
  if (isUnitHead(u.id)) {
    return departmentHeadForUnitHead(u.id) || directorFor(u.id);
  }

  return originalGetManagerId(u);
};

// الجهة التي تملك الطلب حالياً
function currentCourseReviewer(r) {
  return r.currentReviewerId || r.managerId;
}

// عرض اسم الجهة الحالية
function courseReviewerName(r) {
  return username(currentCourseReviewer(r));
}

// هل يستطيع المستخدم اتخاذ إجراء؟
function canReviewCourse(r) {
  return r.status === "pending" &&
    (
      currentCourseReviewer(r) === currentUserId ||
      isAdmin()
    );
}

// حفظ التحويل
function forwardCourse(r) {
  if (!canReviewCourse(r)) {
    return notify("ليس لديك صلاحية تحويل هذا الطلب.");
  }

  const reviewerId = currentCourseReviewer(r);

  if (!isUnitHead(reviewerId)) {
    return notify("التحويل متاح لرئيس الشعبة فقط.");
  }

  const departmentManagerId =
    departmentHeadForUnitHead(reviewerId);

  if (!departmentManagerId) {
    return notify("يجب تعيين رئيس القسم أولاً.");
  }

  openModal("تحويل طلب الدورة إلى رئيس القسم", `
    <p><b>${esc(r.courseName)}</b></p>
    <p>مقدم الطلب: ${esc(username(r.employeeId))}</p>
    <p>التحويل إلى:
      <b>${esc(username(departmentManagerId))}</b>
    </p>

    <label>ملاحظات التحويل (اختياري)</label>
    <textarea id="forwardCourseNotes" rows="3"></textarea>

    <div class="actions">
      <button class="btn primary" id="confirmForwardCourse">
        تأكيد التحويل
      </button>
      <button class="btn outline" id="cancelForwardCourse">
        إلغاء
      </button>
    </div>
  `);

  $("cancelForwardCourse").onclick = closeModal;

  $("confirmForwardCourse").onclick = () => {
    if (!canReviewCourse(r)) {
      closeModal();
      return;
    }

    const notes = $("forwardCourseNotes").value.trim();

    r.currentReviewerId = departmentManagerId;
    r.forwardedBy = currentUserId;
    r.forwardedAt = now();
    r.forwardNotes = notes;

    log(
      r,
      "تحويل طلب الدورة إلى رئيس القسم",
      `من ${username(currentUserId)} إلى
       ${username(departmentManagerId)}.
       ${notes}`
    );

    save();
    closeModal();
    renderAll();
    notify("تم تحويل الطلب إلى رئيس القسم.");
  };
}

// إضافة زر التحويل وبطاقة الجهة الحالية
const originalCourseCard = courseCard;

courseCard = function(r, context) {
  let html = originalCourseCard(r, context);

  const reviewerId = currentCourseReviewer(r);

  // إظهار الجهة الحالية لجميع الأطراف المعنية
  const info = `
    <p>
      <b>الطلب لدى:</b>
      ${esc(courseReviewerName(r))}
    </p>
    ${r.forwardedAt ? `
      <p>
        <b>تم التحويل بواسطة:</b>
        ${esc(username(r.forwardedBy))}
      </p>
      ${r.forwardNotes ? `
        <p>ملاحظات التحويل:
          ${esc(r.forwardNotes)}
        </p>
      ` : ""}
    ` : ""}
  `;

  html = html.replace(
    '<div class="actions">',
    info + '<div class="actions">'
  );

  if (
    context === "manager" &&
    canReviewCourse(r) &&
    isUnitHead(reviewerId) &&
    departmentHeadForUnitHead(reviewerId)
  ) {
    html = html.replace(
      '<div class="actions">',
      `<div class="actions">
        <button
          class="btn purple small"
          data-action="forward-course"
          data-id="${esc(r.id)}">
          تحويل إلى رئيس القسم
        </button>`
    );
  }

  // منع ظهور الاعتماد والرفض لمسؤول سابق
  if (
    context === "manager" &&
    !canReviewCourse(r) &&
    r.status === "pending"
  ) {
    html = html.replace(
      /<button[^>]*data-action="approve-course"[\s\S]*?<\/button>/g,
      ""
    ).replace(
      /<button[^>]*data-action="reject-course"[\s\S]*?<\/button>/g,
      ""
    );
  }

  return html;
};

// تحديث قائمة طلبات الدورات
renderCourses = function() {
  const mine = db.requests.filter(r =>
    r.employeeId === currentUserId &&
    !r.hiddenForEmployee
  );

  const approvals = db.requests.filter(r =>
    (
      currentCourseReviewer(r) === currentUserId ||
      isAdmin() ||
      r.managerId === currentUserId
    ) &&
    !r.hiddenForManager
  );

  $("myRequestsList").innerHTML = mine.length
    ? [...mine].reverse()
        .map(r => courseCard(r, "mine")).join("")
    : '<div class="empty">لا توجد طلبات دورات.</div>';

  $("approvalsList").innerHTML = approvals.length
    ? [...approvals].reverse()
        .map(r => courseCard(r, "manager")).join("")
    : '<div class="empty">لا توجد طلبات واردة.</div>';

  const forwarded = db.requests.filter(r =>
    r.forwardedBy === currentUserId
  );

  if ($("forwardedRequestsList")) {
    $("forwardedRequestsList").innerHTML = forwarded.length
      ? [...forwarded].reverse()
          .map(r => courseCard(r, "forwarded")).join("")
      : '<div class="empty">لا توجد طلبات محوّلة.</div>';
  }

  $("allRequestsList").innerHTML = db.requests.length
    ? [...db.requests].reverse()
        .map(r => courseCard(r, "admin")).join("")
    : '<div class="empty">لا توجد دورات في السجل.</div>';
};

// إضافة إعداد المسؤول الإداري في لوحة الإدارة
const originalRenderAdmin = renderAdmin;

renderAdmin = function() {
  originalRenderAdmin();

  const container = $("managerAssignments");
  if (!container) return;

  const existing = $("administrativeReviewers");
  if (existing) existing.remove();

  const section = document.createElement("div");
  section.id = "administrativeReviewers";

  const top = directorate();
  const directorName = top?.managerId && user(top.managerId)
    ? username(top.managerId) : "";

  section.innerHTML = `
    <hr>
    <h4>مسؤول رؤساء الأقسام</h4>
    <p class="meta">
      ${directorName
        ? `يتبع كل رئيس قسم مدير الإدارة (${esc(directorName)}) تلقائياً.
           غيّري القسم فقط إذا كان يتبع شخصاً آخر.`
        : `حددي أولاً الإدارة العليا ومديرها، ليتبعه رؤساء الأقسام تلقائياً.`}
    </p>

    ${db.departments.filter(d => d !== top).map(d => `
      <label>${esc(d.name)}</label>
      <select
        data-admin-reviewer="${esc(d.id)}">
        ${option("", directorName
          ? `مدير الإدارة: ${directorName} (تلقائي)`
          : "لم يتم التحديد",
          !d.adminReviewerId)}
        ${activeUsers()
          .filter(u => u.id !== d.managerId)
          .map(u => option(
            u.id,
            u.name,
            u.id === d.adminReviewerId
          )).join("")}
      </select>
    `).join("")}

    ${top ? `
      <div class="director-info">
        <span>مدير ${esc(top.name)}</span>
        <b>${directorName ? esc(directorName) : "لم يتم التعيين بعد"}</b>
        <small>أعلى مستوى — يُعيَّن من «مسؤولو الأقسام» أعلاه</small>
      </div>` : ""}
  `;

  container.appendChild(section);
};

// حفظ تعيين المسؤول الإداري
document.addEventListener("change", e => {
  const select = e.target.closest("[data-admin-reviewer]");

  if (!select || !isAdmin()) return;

  const d = department(select.dataset.adminReviewer);
  if (!d) return;

  if (select.value === d.managerId) {
    renderAll();
    return notify("لا يمكن تعيين رئيس القسم مسؤولاً عن نفسه.");
  }

  d.adminReviewerId = select.value;
  save();
  renderAll();
  notify("تم حفظ المسؤول الإداري.");
});

// اعتراض إجراءات الدورات لضبط الصلاحيات
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;

  if (![
    "forward-course",
    "approve-course",
    "reject-course"
  ].includes(action)) return;

  const r = db.requests.find(x => x.id === btn.dataset.id);
  if (!r) return;

  // منع تنفيذ المعالج القديم
  e.stopImmediatePropagation();

  if (!canReviewCourse(r)) {
    return notify("تم تحويل الطلب أو لا تملك صلاحية الإجراء.");
  }

  if (action === "forward-course") {
    return forwardCourse(r);
  }

  if (action === "approve-course") {
    return decisionModal(r, "approve");
  }

  if (action === "reject-course") {
    return decisionModal(r, "reject");
  }
}, true);

// تحديث الصلاحيات والعرض بعد الإضافات
renderNavigation = (function(original) {
  return function() {
    original();

    const approvalsButton = document.querySelector(
      '[data-tab="approvals"]'
    );

    if (approvalsButton) {
      const hasIncoming = db.requests.some(r =>
        currentCourseReviewer(r) === currentUserId
      );

      approvalsButton.classList.toggle(
        "hidden",
        !isAdmin() && !managesAnyone() && !hasIncoming
      );
    }
  };
})(renderNavigation);

showTab = (function(original) {
  return function(tab) {
    if (
      tab === "approvals" &&
      !isAdmin() &&
      !managesAnyone() &&
      !db.requests.some(r =>
        currentCourseReviewer(r) === currentUserId
      )
    ) return;

    if (tab === "approvals") {
      // العرض مباشرة مع الصلاحيات الجديدة
      currentTab = tab;

      document.querySelectorAll(".tab").forEach(el =>
        el.classList.add("hidden")
      );

      $("approvalsTab").classList.remove("hidden");

      document.querySelectorAll(".nav-btn").forEach(b =>
        b.classList.toggle(
          "active",
          b.dataset.tab === tab
        )
      );

      $("pageTitle").textContent = titles[tab];
      $("pageSubtitle").textContent =
        `${departmentName(current().departmentId)} — ${current().name}`;

      renderAll();
      return;
    }

    original(tab);
  };
})(showTab);


/* =========================
   تشغيل النظام
========================= */

auth.onAuthStateChanged(fbUser => {
  if (setupBusy) return;

  if (fbUser) return handleSignedIn(fbUser);

  stopSync();
  currentUserId = null;
  closeModal();
  showAuth();
});

// مربعات الرئيسية تنقل إلى الصفحة المعنية
document.addEventListener("click", e => {
  const card = e.target.closest("[data-goto]");
  if (card) showTab(card.dataset.goto);
});

// خانة dd/mm: أرقام فقط ويُضاف الخط المائل تلقائياً بعد اليوم
document.addEventListener("input", e => {
  const el = e.target;
  if (!el.classList?.contains("date-text")) return;

  const digits = el.value
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/\D/g, "")
    .slice(0, 4);
  el.value = digits.length > 2 ? `${digits.slice(0,2)}/${digits.slice(2)}` : digits;
});

// عدد الأيام بالعربية: يوم، يومان، 3 أيام، 11 يوماً
function dayCount(n) {
  if (n === 1) return "يوم واحد";
  if (n === 2) return "يومان";
  if (n >= 3 && n <= 10 && Number.isInteger(n)) return `${n} أيام`;
  return `${n} يوماً`;
}

// مهام الدورة كما يتابعها البديل، لصاحب الطلب ومسؤوله
function courseTasksHTML(r) {
  const tasks = r.tasks || [];
  if (!tasks.length) return `<p class="meta">لا توجد مهام مسلّمة للبديل.</p>`;

  return `
    <div class="divider"></div>
    <h3>متابعة البديل للمهام (${tasks.length})</h3>
    ${tasks.map(t => `
      <div class="task-entry">
        <div class="section-head">
          <b>${esc(t.title)}</b>
          ${badge(t.status || "not_started")}
        </div>
        ${t.description ? `<p>${esc(t.description)}</p>` : ""}
        ${t.notes ? `<p><b>ملاحظات البديل:</b> ${esc(t.notes)}</p>` : ""}
        ${t.updatedAt ? `<p class="meta">آخر تحديث: ${new Date(t.updatedAt).toLocaleString("ar-AE")}</p>` : ""}
      </div>`).join("")}`;
}

// بدلائي في الإجازات والدورات المعتمدة الحالية أو القادمة
function myCoverIds() {
  return new Set([...db.leaves,...db.requests]
    .filter(x => x.employeeId === currentUserId && x.status === "approved" &&
      x.coverId && x.endDate >= today())
    .map(x => x.coverId));
}

// الموظفون الذين أنا بديلهم في إجازة أو دورة معتمدة حالية أو قادمة
function coveredByMeIds() {
  return new Set([...db.leaves,...db.requests]
    .filter(x => x.coverId === currentUserId && x.status === "approved" &&
      x.endDate >= today())
    .map(x => x.employeeId));
}

// من يحق اختياره بديلاً:
// - الرؤساء والمدير: أي موظف أو رئيس
// - الموظف: زملاؤه في نفس الشعبة/المكتب، وإن لم يكن في شعبة فزملاء القسم مثله بدون شعبة
function coverCandidates(u) {
  if (!u) return [];
  const others = activeUsers().filter(x => x.id !== u.id);

  if (isHead(u.id)) return others;

  return others.filter(x => !isHead(x.id) && (u.unitId
    ? x.unitId === u.unitId
    : x.departmentId === u.departmentId && !x.unitId));
}

// إجازة اعتمدها رئيس الشعبة قبل إضافة مرحلة رئيس القسم ولم تبدأ بعد
function canEscalateLeave(l) {
  const emp = user(l.employeeId) || {};
  return l.status === "approved" && !l.finalApproverId && l.startDate >= today() &&
    (l.managerId === currentUserId || unitHeadOf(emp) === currentUserId || isAdmin()) &&
    !!finalApproverFor(emp,unitHeadOf(emp));
}

// صاحب الطلب يخفي المرفوض أو المسحوب، والمعتمدون يخفون المرفوض
function canHideLeave(l) {
  if ((l.hiddenFor || []).includes(currentUserId)) return false;
  if (l.employeeId === currentUserId) return ["rejected","withdrawn"].includes(l.status);
  return l.status === "rejected" && canDecideLeave(l);
}

// رئيس الشعبة أو المكتب الذي يتبعه الموظف حسب الهيكل الحالي
function unitHeadOf(employee) {
  return unit(employee?.unitId)?.managerId || "";
}

// حذف الاستفسار أو الطلب من قائمتي (يبقى عند الطرف الآخر)، أو حذفه نهائياً للمديرة
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-action='hide-inquiry'],[data-action='delete-inquiry']");
  if (!btn) return;
  const item = db.inquiries.find(x => x.id === btn.dataset.id);
  if (!item) return;

  if (btn.dataset.action === "hide-inquiry" &&
      [item.employeeId,item.managerId].includes(currentUserId)) {
    if (!confirm("حذف هذه المعاملة من قائمتك؟ تبقى عند الطرف الآخر.")) return;
    item.hiddenFor = [...new Set([...(item.hiddenFor || []),currentUserId])];
    save();renderAll();
    return notify("تم حذف المعاملة من قائمتك.");
  }

  if (btn.dataset.action === "delete-inquiry" && isAdmin()) {
    if (!confirm(`حذف «${item.subject}» نهائياً من النظام؟ لا يمكن التراجع.`)) return;
    db.inquiries = db.inquiries.filter(x => x.id !== item.id);
    save();renderAll();
    notify("تم حذف المعاملة نهائياً.");
  }
});
