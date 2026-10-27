"use strict";

// ================= الإعدادات =================

const REPORT_TYPES = ["كهرباء", "صبغ", "حدادة", "بناء", "نجارة"];
// قسم واحد حالياً، فيُكتب تلقائياً وتُخفى خانة الاختيار
const DEPARTMENTS = ["قسم المشاريع وصيانة المرافق"];

// مدير النظام ومدير الإدارة يديران المنصة كاملة (حسب صلاحيتهم في الصفحة الرئيسية)
const ADMIN_ROLES = ["super_admin", "director"];

// فريق القسم: رئيس القسم يضيف موظفيه ويحذفهم، والمدير يعيّن رؤساء الأقسام
const MEMBERS = "facility_members";
const MEMBER_ROLES = { head: "رئيس القسم", employee: "موظف" };

const MAX_PHOTOS = 10;

// تُصغَّر الصور قبل الحفظ لأنها تُحفظ داخل قاعدة البيانات
const PHOTO_MAX_SIDE = 1280;

// نفس اسم تطبيق الصفحة الرئيسية، فيُستخدم نفس تسجيل الدخول بدون دخول ثانٍ
const app = firebase.initializeApp(FIREBASE_CONFIG, "portal");
const auth = app.auth();
const fs = app.firestore();

const REPORTS = "facility_reports";

// ================= أدوات مساعدة =================

const $ = id => document.getElementById(id);

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;",
        '"': "&quot;", "'": "&#39;"
    })[c]);
}

// مقارنة الأسماء بدون فرق المسافات والهمزات
function normalizeName(value) {
    return String(value ?? "")
        .replace(/[أإآ]/g, "ا")
        .replace(/ة/g, "ه")
        .replace(/ى/g, "ي")
        .replace(/\s+/g, " ")
        .trim();
}

function option(value, text) {
    return `<option value="${esc(value)}">${esc(text)}</option>`;
}

function pad(n) {
    return String(n).padStart(2, "0");
}

function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowTime() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(iso) {
    return iso ? new Date(iso + "T12:00:00").toLocaleDateString("ar-AE") : "";
}

function formatTime(hhmm) {
    if (!hhmm) return "";
    const [h, m] = hhmm.split(":").map(Number);
    return `${(h % 12) || 12}:${pad(m)} ${h < 12 ? "ص" : "م"}`;
}

function notify(message) {
    $("toast").textContent = message;
    $("toast").classList.remove("hidden");
    setTimeout(() => $("toast").classList.add("hidden"), 3200);
}

function showScreen(id) {
    ["loadingPage", "needLoginPage", "appPage"].forEach(page =>
        $(page).classList.toggle("hidden", page !== id)
    );
}

// ================= الحالة =================

let me = null;
let reports = [];
let pendingPhotos = [];
let selectedType = "";
let stopListening = null;
let stopMembers = null;

// admin | head | employee | "" (غير مضاف للفريق)
let myRole = "";
let members = [];
let allUsers = [];

const isAdmin = () => ADMIN_ROLES.includes(me?.role);

// المدير ورئيس القسم يرون كل التقارير ويديرون الفريق
const isHead = () => myRole === "admin" || myRole === "head";

// ================= الدخول (من الصفحة الرئيسية) =================

auth.onAuthStateChanged(async fbUser => {
    [stopListening, stopMembers].forEach(stop => stop && stop());
    stopListening = null;
    stopMembers = null;

    if (!fbUser) {
        showScreen("needLoginPage");
        return;
    }

    try {
        const account = await fs.collection("portal_accounts").doc(fbUser.uid).get();
        if (!account.exists) throw new Error("no-account");

        const userId = account.data().userId;
        const doc = await fs.collection("portal_users").doc(userId).get();
        if (!doc.exists) throw new Error("no-account");

        me = { ...doc.data(), id: userId };

        const membership = await fs.collection(MEMBERS).doc(userId).get();
        myRole = isAdmin() ? "admin" : membership.exists ? membership.data().role : "";

        startApp();
    } catch (err) {
        console.error(err);
        showScreen("needLoginPage");
    }
});

function startApp() {
    $("userLine").textContent = [me.fullName, me.department].filter(Boolean).join(" — ");
    $("employeeName").value = me.fullName || "";

    $("department").innerHTML = option("", "اختر القسم") +
        DEPARTMENTS.map(d => option(d, d)).join("");

    $("filterDepartment").innerHTML = option("", "كل الأقسام") +
        DEPARTMENTS.map(d => option(d, d)).join("");
    $("filterType").innerHTML = option("", "كل الأنواع") +
        REPORT_TYPES.map(t => option(t, t)).join("");

    const singleDepartment = DEPARTMENTS.length === 1;
    $("department").closest("div").classList.toggle("hidden", singleDepartment);
    $("filterDepartment").classList.toggle("hidden", singleDepartment);

    // غير المضاف للفريق يرى رسالة فقط
    const hasAccess = Boolean(myRole);
    document.querySelector(".tabs").classList.toggle("hidden", !hasAccess);
    $("noAccess").classList.toggle("hidden", hasAccess);
    $("teamTabBtn").classList.toggle("hidden", !isHead());

    if (hasAccess) {
        renderTypeChoices();
        resetForm();
        listenToReports();
        selectTab("newTab");
    } else {
        ["newTab", "listTab", "teamTab"].forEach(id => $(id).classList.add("hidden"));
    }

    if (isHead()) setupTeam();

    showScreen("appPage");
}

// ================= التبويبات =================

function selectTab(tab) {
    document.querySelectorAll(".tab-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.tab === tab)
    );
    ["newTab", "listTab", "teamTab"].forEach(id =>
        $(id).classList.toggle("hidden", id !== tab)
    );
}

document.querySelectorAll(".tab-btn").forEach(button => {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
});

// ================= نموذج التقرير =================

function renderTypeChoices() {
    $("typeChoices").innerHTML = REPORT_TYPES.map(t => `
        <button type="button" class="chip ${t === selectedType ? "selected" : ""}" data-type="${esc(t)}">${esc(t)}</button>
    `).join("");
}

$("typeChoices").addEventListener("click", event => {
    const chip = event.target.closest("[data-type]");
    if (!chip) return;
    selectedType = chip.dataset.type;
    renderTypeChoices();
});

function resetForm() {
    $("reportForm").reset();
    $("employeeName").value = me?.fullName || "";
    $("reportDate").value = todayISO();
    $("reportTime").value = nowTime();
    if (DEPARTMENTS.length === 1) $("department").value = DEPARTMENTS[0];
    $("formError").textContent = "";
    selectedType = "";
    pendingPhotos = [];
    renderTypeChoices();
    renderPendingPhotos();
}

// تصغير الصورة وتحويلها إلى JPEG
function compressPhoto(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();

        img.onload = () => {
            URL.revokeObjectURL(url);

            const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.width, img.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);

            // حد المستند في قاعدة البيانات 1 ميجا، فنقلل الجودة إذا كبرت الصورة
            let quality = 0.72;
            let data = canvas.toDataURL("image/jpeg", quality);
            while (data.length > 700000 && quality > 0.35) {
                quality -= 0.12;
                data = canvas.toDataURL("image/jpeg", quality);
            }
            resolve(data);
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("bad-image"));
        };

        img.src = url;
    });
}

$("photoBox").addEventListener("click", () => $("photoInput").click());

$("photoInput").addEventListener("change", async function () {
    const files = [...this.files].filter(f => f.type.startsWith("image/"));
    this.value = "";

    const room = MAX_PHOTOS - pendingPhotos.length;
    if (files.length > room) {
        notify(`الحد الأقصى ${MAX_PHOTOS} صور للتقرير الواحد.`);
    }

    $("photoBox").disabled = true;

    for (const file of files.slice(0, room)) {
        try {
            pendingPhotos.push(await compressPhoto(file));
        } catch {
            notify("تعذّر قراءة إحدى الصور.");
        }
    }

    $("photoBox").disabled = false;
    renderPendingPhotos();
});

function renderPendingPhotos() {
    $("photoPreview").innerHTML = pendingPhotos.map((src, i) => `
        <div class="thumb">
            <img src="${src}" alt="صورة ${i + 1}" data-zoom="${i}">
            <button type="button" class="thumb-remove" data-remove="${i}" aria-label="حذف الصورة">×</button>
        </div>
    `).join("");
}

$("photoPreview").addEventListener("click", event => {
    const remove = event.target.closest("[data-remove]");
    if (remove) {
        pendingPhotos.splice(Number(remove.dataset.remove), 1);
        renderPendingPhotos();
        return;
    }

    const zoom = event.target.closest("[data-zoom]");
    if (zoom) openLightbox(zoom.src);
});

$("reportForm").addEventListener("submit", async event => {
    event.preventDefault();
    $("formError").textContent = "";

    const department = $("department").value;
    const date = $("reportDate").value;
    const time = $("reportTime").value;
    const notes = $("notes").value.trim();

    if (!department) return ($("formError").textContent = "اختر القسم.");
    if (!selectedType) return ($("formError").textContent = "اختر نوع التقرير.");
    if (!date || !time) return ($("formError").textContent = "أدخل تاريخ وساعة التقرير.");
    if (!notes && !pendingPhotos.length) {
        return ($("formError").textContent = "أضف صوراً أو اكتب ملاحظات.");
    }

    const button = $("submitBtn");
    button.disabled = true;
    button.textContent = "جاري الإرسال...";

    try {
        const ref = fs.collection(REPORTS).doc();
        const batch = fs.batch();

        batch.set(ref, {
            byId: me.id,
            byName: me.fullName || "",
            department,
            type: selectedType,
            date,
            time,
            notes,
            photoCount: pendingPhotos.length,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // كل صورة في مستند مستقل حتى لا يتجاوز التقرير حجم المستند
        pendingPhotos.forEach((data, order) => {
            batch.set(ref.collection("photos").doc(String(order)), { data, order });
        });

        await batch.commit();

        resetForm();
        notify("تم إرسال التقرير بنجاح ✓");
    } catch (err) {
        console.error(err);
        $("formError").textContent = "تعذّر إرسال التقرير. تأكد من الاتصال ثم حاول مرة أخرى.";
    } finally {
        button.disabled = false;
        button.textContent = "إرسال التقرير";
    }
});

// ================= قائمة التقارير =================

function listenToReports() {
    // الموظف يقرأ تقاريره فقط (حسب قواعد الحماية)، والرؤساء يقرؤون الكل
    const query = isHead()
        ? fs.collection(REPORTS)
        : fs.collection(REPORTS).where("byId", "==", me.id);

    stopListening = query.onSnapshot(snapshot => {
        reports = snapshot.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
        renderReports();
    }, err => {
        console.error(err);
        $("reportsList").innerHTML = `<p class="empty">تعذّر تحميل التقارير.</p>`;
    });
}

const STATUS_LABELS = {
    submitted: "مُرسل",
    returned: "مُعاد للتعديل",
    resubmitted: "أُعيد إرساله"
};

function renderReports() {

    const department = $("filterDepartment").value;
    const type = $("filterType").value;
    const shown = reports.filter(r =>
        (!department || r.department === department) && (!type || r.type === type)
    );

    // التقارير المعادة لي تظهر أولاً حتى أعدّلها
    shown.sort((a, b) =>
        Number(b.status === "returned" && b.byId === me.id) -
        Number(a.status === "returned" && a.byId === me.id));

    $("reportsList").innerHTML = shown.map(r => {
        const returnedToMe = r.status === "returned" && r.byId === me.id;
        const lastEdit = (r.history || []).slice(-1)[0];

        return `
        <article class="report-card ${r.status === "returned" ? "returned" : ""}" data-id="${esc(r.id)}">
            <div class="report-head">
                <span><span class="type-badge">${esc(r.type)}</span>
                    <span class="status-badge ${esc(r.status || "")}">${esc(STATUS_LABELS[r.status] || STATUS_LABELS.submitted)}</span></span>
                <span class="report-when">${esc(formatDate(r.date))} — ${esc(formatTime(r.time))}</span>
            </div>
            ${r.status === "returned" && r.returnNote ? `
                <p class="return-note"><b>${returnedToMe ? "مطلوب منك تعديل التقرير" : "أُعيد للتعديل"} — ملاحظة ${esc(r.returnedByName || "رئيس القسم")}:</b><br>${esc(r.returnNote)}</p>` : ""}
            <p><b>الموظف:</b> ${esc(r.byName)}</p>
            <p><b>القسم:</b> ${esc(r.department)}</p>
            ${r.notes ? `<p class="notes">${esc(r.notes)}</p>` : ""}
            ${lastEdit ? `<p class="report-history">آخر إجراء: ${esc(lastEdit.action)} — ${esc(lastEdit.byName)} — ${esc(new Date(lastEdit.at).toLocaleString("ar-AE"))}</p>` : ""}
            <div class="report-actions">
                ${isHead() ? `
                    <button type="button" class="secondary-btn" data-edit="${esc(r.id)}">✎ تعديل</button>
                    ${r.status !== "returned" ? `<button type="button" class="secondary-btn" data-return="${esc(r.id)}">↩ إعادة للتعديل</button>` : ""}` : ""}
                ${returnedToMe && !isHead() ? `<button type="button" class="primary-btn" data-edit="${esc(r.id)}">✎ تعديل وإعادة الإرسال</button>` : ""}
                ${r.photoCount ? `<button type="button" class="secondary-btn" data-photos="${esc(r.id)}">📷 عرض الصور (${r.photoCount})</button>` : ""}
                <button type="button" class="secondary-btn" data-pdf="${esc(r.id)}">📄 حفظ / طباعة PDF</button>
                ${me.role === "super_admin" ? `<button type="button" class="danger-btn" data-delete="${esc(r.id)}">حذف</button>` : ""}
            </div>
            <div class="thumbs report-photos"></div>
        </article>`;
    }).join("") || `<p class="empty">لا توجد تقارير${department || type ? " مطابقة" : " بعد"}.</p>`;

    // تنبيه على تبويب التقارير إذا أُعيد لي تقرير
    const returnedCount = reports.filter(r => r.status === "returned" && r.byId === me.id).length;
    $("reportCount").textContent = returnedCount ? `${returnedCount} للتعديل` : (reports.length || "");
    $("reportCount").classList.toggle("alert", returnedCount > 0);
}

$("filterDepartment").addEventListener("change", renderReports);
$("filterType").addEventListener("change", renderReports);

$("reportsList").addEventListener("click", async event => {
    const zoom = event.target.closest(".report-photos img");
    if (zoom) return openLightbox(zoom.src);

    const pdfBtn = event.target.closest("[data-pdf]");
    if (pdfBtn) return printReport(pdfBtn.dataset.pdf);

    const editBtn = event.target.closest("[data-edit]");
    if (editBtn) return openEdit(editBtn.dataset.edit);

    const returnBtn = event.target.closest("[data-return]");
    if (returnBtn) return returnReport(returnBtn.dataset.return);

    const photosBtn = event.target.closest("[data-photos]");
    if (photosBtn) {
        const box = photosBtn.closest(".report-card").querySelector(".report-photos");
        if (box.childElementCount) {
            box.innerHTML = "";
            return;
        }

        photosBtn.disabled = true;
        try {
            const snap = await fs.collection(REPORTS).doc(photosBtn.dataset.photos)
                .collection("photos").orderBy("order").get();
            box.innerHTML = snap.docs.map((d, i) =>
                `<div class="thumb"><img src="${d.data().data}" alt="صورة ${i + 1}"></div>`
            ).join("");
        } catch (err) {
            console.error(err);
            notify("تعذّر تحميل الصور.");
        } finally {
            photosBtn.disabled = false;
        }
        return;
    }

    const deleteBtn = event.target.closest("[data-delete]");
    if (deleteBtn && me.role === "super_admin") {
        if (!confirm("حذف هذا التقرير نهائياً؟")) return;

        try {
            const ref = fs.collection(REPORTS).doc(deleteBtn.dataset.delete);
            const photos = await ref.collection("photos").get();
            const batch = fs.batch();
            photos.docs.forEach(d => batch.delete(d.ref));
            batch.delete(ref);
            await batch.commit();
            notify("تم حذف التقرير.");
        } catch (err) {
            console.error(err);
            notify("تعذّر حذف التقرير.");
        }
    }
});

// ================= التعديل والإعادة للتعديل =================

function historyEntry(action, note = "") {
    return firebase.firestore.FieldValue.arrayUnion({
        action,
        note,
        byId: me.id,
        byName: me.fullName || "",
        at: new Date().toISOString()
    });
}

async function returnReport(id) {
    const report = reports.find(r => r.id === id);
    if (!report || !isHead()) return;

    const note = prompt(`ما المطلوب تعديله في تقرير ${report.byName}؟`);
    if (note === null) return;
    if (!note.trim()) return notify("اكتب ملاحظة توضح المطلوب تعديله.");

    try {
        await fs.collection(REPORTS).doc(id).update({
            status: "returned",
            returnNote: note.trim(),
            returnedById: me.id,
            returnedByName: me.fullName || "",
            history: historyEntry("أُعيد للتعديل", note.trim())
        });
        notify("أُعيد التقرير للموظف للتعديل.");
    } catch (err) {
        console.error(err);
        notify("تعذّرت إعادة التقرير.");
    }
}

let editingId = null;

function openEdit(id) {
    const report = reports.find(r => r.id === id);
    if (!report) return;

    const asOwner = !isHead();
    if (asOwner && !(report.byId === me.id && report.status === "returned")) return;

    editingId = id;
    $("editTitle").textContent = asOwner ? "تعديل التقرير وإعادة إرساله" : `تعديل تقرير ${report.byName}`;
    $("editReturnNote").textContent = report.status === "returned" && report.returnNote
        ? `ملاحظة ${report.returnedByName || "رئيس القسم"}: ${report.returnNote}` : "";
    $("editReturnNote").classList.toggle("hidden", !$("editReturnNote").textContent);

    $("editType").innerHTML = REPORT_TYPES.map(t => option(t, t)).join("");
    $("editType").value = report.type;
    $("editDate").value = report.date;
    $("editTime").value = report.time;
    $("editNotes").value = report.notes || "";
    $("editSaveBtn").textContent = asOwner ? "حفظ وإعادة الإرسال" : "حفظ التعديل";

    $("editDialog").showModal();
}

$("editCancelBtn").addEventListener("click", () => $("editDialog").close());

$("editForm").addEventListener("submit", async event => {
    event.preventDefault();

    const report = reports.find(r => r.id === editingId);
    if (!report) return $("editDialog").close();

    const changes = {
        type: $("editType").value,
        date: $("editDate").value,
        time: $("editTime").value,
        notes: $("editNotes").value.trim()
    };

    // الموظف يعيد الإرسال، والرئيس يعدّل فقط (وتبقى حالة التقرير كما هي)
    const asOwner = !isHead();
    const update = {
        ...changes,
        history: historyEntry(asOwner ? "عُدّل وأُعيد إرساله" : "عدّله رئيس القسم")
    };
    if (asOwner) update.status = "resubmitted";

    $("editSaveBtn").disabled = true;
    try {
        await fs.collection(REPORTS).doc(editingId).update(update);
        $("editDialog").close();
        notify(asOwner ? "تم إرسال التقرير بعد التعديل ✓" : "تم حفظ التعديل ✓");
    } catch (err) {
        console.error(err);
        notify("تعذّر حفظ التعديل.");
    } finally {
        $("editSaveBtn").disabled = false;
    }
});


// ================= الفريق =================

async function setupTeam() {
    $("teamHint").textContent = myRole === "admin"
        ? "اختر الموظف وحدد إن كان رئيس القسم أو موظفاً. رئيس القسم يستطيع بعدها إضافة موظفيه وحذفهم."
        : "اختر الموظف من القائمة. تظهر له المنصة في الصفحة الرئيسية تلقائياً بعد إضافته.";

    $("teamHint").textContent +=
        " القائمة تعرض موظفي «قسم المشاريع وصيانة المرافق». ويمكن أيضاً الإضافة من الصفحة الرئيسية بالتأشير على هذه المنصة للموظف.";

    // رئيس القسم يضيف موظفين فقط، والمدير يعيّن الرؤساء أيضاً
    const roles = myRole === "admin" ? ["employee", "head"] : ["employee"];
    $("memberRole").innerHTML = roles.map(r => option(r, MEMBER_ROLES[r])).join("");
    $("memberRole").classList.toggle("hidden", roles.length === 1);

    stopMembers = fs.collection(MEMBERS).onSnapshot(snapshot => {
        members = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderTeam();
    }, err => console.error(err));

    try {
        const usersSnap = await fs.collection("portal_users").get();

        const sameDepartment = u => DEPARTMENTS.some(name =>
            normalizeName(u.department) === normalizeName(name));

        // تظهر فقط أسماء موظفي القسم (حسب خانة القسم في الصفحة الرئيسية)
        allUsers = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(sameDepartment)
            .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName), "ar"));
    } catch (err) {
        console.error(err);
        allUsers = [];
    }

    renderTeam();
}

// الحذف يسحب صلاحية المنصة من الصفحة الرئيسية أيضاً، وهذا لمدير النظام فقط
function canRemoveMember() {
    return me.role === "super_admin";
}

function renderTeam() {
    const memberIds = new Set(members.map(m => m.id));

    $("memberUser").innerHTML = option("", "اختر الموظف") + allUsers
        .filter(u => !memberIds.has(u.id) && u.id !== me.id)
        .map(u => option(u.id, [u.fullName, u.department].filter(Boolean).join(" — ")))
        .join("");

    const sorted = [...members].sort((a, b) =>
        (a.role === "head" ? 0 : 1) - (b.role === "head" ? 0 : 1) ||
        String(a.name).localeCompare(String(b.name), "ar")
    );

    $("teamList").innerHTML = sorted.map(m => `
        <div class="member-row">
            <span><b>${esc(m.name)}</b><span class="role-badge ${m.role === "head" ? "head" : ""}">${esc(MEMBER_ROLES[m.role] || m.role)}</span></span>
            ${canRemoveMember(m) && m.id !== me.id
                ? `<button type="button" class="danger-btn" data-remove-member="${esc(m.id)}">حذف من الفريق</button>`
                : ""}
        </div>
    `).join("") || `<p class="empty">لا يوجد أحد في الفريق بعد.</p>`;
}

$("addMemberBtn").addEventListener("click", async () => {
    const user = allUsers.find(u => u.id === $("memberUser").value);
    if (!user) return notify("اختر الموظف.");

    const role = myRole === "admin" ? $("memberRole").value : "employee";

    const button = $("addMemberBtn");
    button.disabled = true;

    try {
        const batch = fs.batch();

        batch.set(fs.collection(MEMBERS).doc(user.id), {
            name: user.fullName || "",
            role,
            addedBy: me.id,
            addedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // مدير النظام: تُضاف صلاحية المنصة ودوره في الصفحة الرئيسية أيضاً حتى يتطابق الاثنان
        if (me.role === "super_admin") {
            const platformsSnap = await fs.collection("portal_platforms").get();
            const platformId = platformsSnap.docs
                .find(d => String(d.data().url || "").includes("/maintenance/"))?.id;

            if (platformId) {
                batch.set(fs.collection("portal_users").doc(user.id), {
                    platforms: firebase.firestore.FieldValue.arrayUnion(platformId),
                    platformRoles: { [platformId]: role }
                }, { merge: true });
            }
        }

        await batch.commit();
        notify(`تمت إضافة ${user.fullName} كـ${MEMBER_ROLES[role]}.`);
    } catch (err) {
        console.error(err);
        notify("تعذّرت الإضافة: " + (err?.code === "permission-denied"
            ? "لا توجد صلاحية." : err?.message || err));
    } finally {
        button.disabled = false;
    }
});

$("teamList").addEventListener("click", async event => {
    const btn = event.target.closest("[data-remove-member]");
    if (!btn) return;

    const member = members.find(m => m.id === btn.dataset.removeMember);
    if (!member || !canRemoveMember(member)) return;

    // تأكيد داخل الصفحة (نوافذ التأكيد في المتصفح قد تكون محظورة):
    // الضغطة الأولى تطلب التأكيد، والثانية خلال 5 ثوانٍ تحذف
    if (btn.dataset.confirming !== "yes") {
        btn.dataset.confirming = "yes";
        btn.textContent = "اضغط مرة ثانية للتأكيد";
        btn.classList.add("confirming");
        setTimeout(() => {
            if (!btn.isConnected) return;
            btn.dataset.confirming = "";
            btn.textContent = "حذف من الفريق";
            btn.classList.remove("confirming");
        }, 5000);
        return;
    }

    btn.disabled = true;
    btn.textContent = "جاري الحذف...";

    try {
        // سحب صلاحية هذه المنصة من الموظف في الصفحة الرئيسية حتى لا يُضاف للفريق مرة أخرى
        const platformsSnap = await fs.collection("portal_platforms").get();
        const platformIds = platformsSnap.docs
            .filter(d => String(d.data().url || "").includes("/maintenance/"))
            .map(d => d.id);

        const batch = fs.batch();
        batch.delete(fs.collection(MEMBERS).doc(member.id));

        const userRef = fs.collection("portal_users").doc(member.id);
        if ((await userRef.get()).exists && platformIds.length) {
            batch.set(userRef, {
                platforms: firebase.firestore.FieldValue.arrayRemove(...platformIds),
                platformRoles: Object.fromEntries(platformIds.map(id =>
                    [id, firebase.firestore.FieldValue.delete()]))
            }, { merge: true });
        }

        await batch.commit();
        notify("تم الحذف من الفريق وسحب صلاحية المنصة.");
    } catch (err) {
        console.error(err);
        btn.disabled = false;
        btn.dataset.confirming = "";
        btn.classList.remove("confirming");
        // الخطأ يظهر على الزر نفسه حتى لو كانت النوافذ محظورة
        btn.textContent = err?.code === "permission-denied"
            ? "تعذّر: لا توجد صلاحية"
            : "تعذّر الحذف: " + (err?.message || err);
    }
});


// ================= التقرير بصيغة PDF =================

// شعار حكومة الشارقة وبلدية مدينة الذيد في أعلى يمين التقرير
const HEADER_LOGO = new URL("../sharjah-header.png", location.href).href;

async function printReport(id) {
    const report = reports.find(r => r.id === id);
    if (!report) return;

    // تُفتح النافذة فوراً قبل تحميل الصور حتى لا يمنعها المتصفح
    const win = window.open("", "_blank");
    if (!win) {
        notify("اسمح بفتح النوافذ المنبثقة ثم أعد المحاولة.");
        return;
    }
    win.document.write(`<p dir="rtl" style="font-family:Tahoma;padding:30px">جاري تجهيز التقرير...</p>`);

    let photos = [];
    if (report.photoCount) {
        try {
            const snap = await fs.collection(REPORTS).doc(id)
                .collection("photos").orderBy("order").get();
            photos = snap.docs.map(d => d.data().data);
        } catch (err) {
            console.error(err);
        }
    }

    const row = (label, value) =>
        `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;

    win.document.open();
    win.document.write(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>تقرير ${esc(report.type)} - ${esc(report.date)}</title>
<style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Tahoma, Arial, sans-serif; color: #2f2a24; }
header { display: flex; justify-content: flex-start; padding-bottom: 12px; border-bottom: 3px solid #9a7a45; }
header img { width: 240px; height: auto; }
h1 { margin: 22px 0 16px; font-size: 21px; text-align: center; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 12px; border: 1px solid #d9cdb8; text-align: right; vertical-align: top; font-size: 14px; }
th { width: 28%; background: #f3eadb; }
h2 { margin: 22px 0 10px; font-size: 16px; }
.notes { padding: 12px 14px; border: 1px solid #d9cdb8; border-radius: 6px; white-space: pre-wrap; line-height: 1.9; font-size: 14px; }
.photos { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.photos img { width: 100%; max-height: 300px; object-fit: contain; border: 1px solid #ddd; break-inside: avoid; }
footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid #ddd; text-align: center; color: #7d7263; font-size: 11px; }
@media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style>
</head>
<body>
<header><img src="${HEADER_LOGO}" alt="حكومة الشارقة - بلدية مدينة الذيد"></header>
<h1>تقرير ${esc(report.department)}</h1>
<table>
${row("اسم الموظف", report.byName)}
${row("القسم", report.department)}
${row("نوع التقرير", report.type)}
${row("تاريخ التقرير", formatDate(report.date))}
${row("الساعة", formatTime(report.time))}
</table>
<h2>الملاحظات</h2>
<div class="notes">${esc(report.notes || "لا توجد ملاحظات")}</div>
${photos.length ? `<h2>الصور (${photos.length})</h2><div class="photos">${photos.map(src => `<img src="${src}" alt="">`).join("")}</div>` : ""}
<footer>بلدية مدينة الذيد – إدارة الخدمات الفنية</footer>
</body>
</html>`);
    win.document.close();

    // الطباعة بعد تحميل الشعار والصور
    const images = [...win.document.images];
    await Promise.all(images.map(img => img.complete ? null :
        new Promise(resolve => { img.onload = img.onerror = resolve; })));
    win.focus();
    win.print();
}


// ================= تكبير الصور =================

function openLightbox(src) {
    $("lightboxImage").src = src;
    $("lightbox").classList.remove("hidden");
}

function closeLightbox() {
    $("lightbox").classList.add("hidden");
    $("lightboxImage").removeAttribute("src");
}

$("lightbox").addEventListener("click", event => {
    if (event.target !== $("lightboxImage")) closeLightbox();
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeLightbox();
});
