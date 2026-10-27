


/* =====================================================
   GLOBAL VARIABLES
===================================================== */

let selectedRole = "reviewer";


/* =====================================================
   ROLE BUTTONS
===================================================== */

const roles =
    document.querySelectorAll(".role");


roles.forEach(function(role) {

    role.addEventListener("click", function() {

        roles.forEach(function(item) {

            item.classList.remove("active");

        });


        this.classList.add("active");


        selectedRole = this.dataset.role;
        const passwordWrap = document.getElementById("reviewerPasswordWrap");
        if (passwordWrap) passwordWrap.classList.toggle("hidden", selectedRole !== "reviewer");

    });

});



/* =====================================================
   LOGIN
===================================================== */

function login() {


    const name =
        document
            .getElementById("employeeName")
            .value
            .trim();


    if (!name) {

        alert(
            "من فضلك اكتب اسم الموظف"
        );

        return;

    }


    if (selectedRole === "reviewer") {
        const password = document.getElementById("reviewerPassword")?.value || "";
        if (password !== "2468") {
            alert("كلمة مرور مسؤول المراجعة غير صحيحة");
            return;
        }
    }

    document
        .getElementById("loginPage")
        .classList.add("hidden");


    /*
       لو مسؤول المراجعة
       افتح لوحة المراجعة
    */

    if (selectedRole === "reviewer") {


        document
            .getElementById("reportPage")
            .classList.add("hidden");


        document
            .getElementById("reviewPage")
            .classList.remove("hidden");

    }


    /*
       لو موظف ميداني
       افتح نموذج التقرير
    */

    else {


        document
            .getElementById("reviewPage")
            .classList.add("hidden");


        document
            .getElementById("reportPage")
            .classList.remove("hidden");

    }


    document.getElementById("assignedEmployee").textContent = name;

    const dateInput = document.getElementById("reportDate");
    if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);

    renderSavedReports();

    window.scrollTo(
        0,
        0
    );

}



/* =====================================================
   LOGOUT
===================================================== */

function logout() {


    document
        .getElementById("reviewPage")
        .classList.add("hidden");


    document
        .getElementById("reportPage")
        .classList.add("hidden");


    document
        .getElementById("loginPage")
        .classList.remove("hidden");


    document
        .getElementById("employeeName")
        .value = "";

}



/* =====================================================
   CHIPS
===================================================== */

document
    .querySelectorAll(".chip")
    .forEach(function(button) {


        button.addEventListener(
            "click",
            function() {


                const parent =
                    this.parentElement;


                parent
                    .querySelectorAll(".chip")
                    .forEach(function(item) {

                        item.classList
                            .remove("selected");

                    });


                this.classList
                    .add("selected");

            }
        );

    });



/* =====================================================
   YES / NO
===================================================== */

document
    .querySelectorAll(".yes-no button")
    .forEach(function(button) {


        button.addEventListener(
            "click",
            function() {


                document
                    .querySelectorAll(
                        ".yes-no button"
                    )
                    .forEach(function(item) {

                        item.classList
                            .remove("selected");

                    });


                this.classList
                    .add("selected");

            }
        );

    });



/* =====================================================
   UPLOAD DRAWING
===================================================== */

const uploadBox =
    document.getElementById(
        "uploadBox"
    );


const fileInput =
    document.getElementById(
        "file"
    );


uploadBox.addEventListener(
    "click",
    function() {

        fileInput.click();

    }
);


let attachedDrawingImages = [];

fileInput.addEventListener("change", function () {
    const files = Array.from(this.files || []);
    if (!files.length) return;
    const readers = files.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = event => resolve({ name: file.name, src: event.target.result });
        reader.onerror = reject;
        reader.readAsDataURL(file);
    }));
    Promise.all(readers).then(images => {
        attachedDrawingImages = attachedDrawingImages.concat(images);
        latestReportImage = attachedDrawingImages[0]?.src || "";
        renderDrawingGallery();
        const reviewDrawing = document.getElementById("reviewDrawing");
        if (reviewDrawing) {
            reviewDrawing.innerHTML = attachedDrawingImages.map((img, index) =>
                `<button type="button" class="drawing-thumb review-thumb" onclick="openDrawingImage(${index})" aria-label="تكبير الرسم ${index + 1}"><img src="${img.src}" alt="رسم كروكي ${index + 1}"></button>`
            ).join("");
        }
        uploadBox.innerHTML = `<div class="upload-icon">☁</div>تم إرفاق ${attachedDrawingImages.length} صورة — اضغط لإضافة صور أخرى`;
        this.value = "";
    }).catch(() => alert("تعذر قراءة إحدى الصور. جربي اختيار صورة أخرى."));
});

function renderDrawingGallery() {
    const gallery = document.getElementById("drawingGallery");
    if (!gallery) return;
    gallery.innerHTML = attachedDrawingImages.map((img, index) =>
        `<button type="button" class="drawing-thumb" onclick="openDrawingImage(${index})" title="اضغط لتكبير الصورة"><img src="${img.src}" alt="${escapeHTML(img.name)}"><span>${index + 1}</span></button>`
    ).join("");
}

function openDrawingImage(index) {
    const image = attachedDrawingImages[index];
    if (!image) return;
    document.getElementById("lightboxImage").src = image.src;
    document.getElementById("imageLightbox").classList.remove("hidden");
}
function closeDrawingImage() {
    document.getElementById("imageLightbox")?.classList.add("hidden");
}
document.addEventListener("keydown", event => { if (event.key === "Escape") closeDrawingImage(); });

// صور الموقع أثناء التفتيش: رفع عدة صور وعرضها مصغرة مع إمكانية التكبير
let attachedSiteImages = [];
const sitePhotoInput = document.getElementById("sitePhotos");
const sitePhotoUploadBox = document.getElementById("sitePhotoUploadBox");
sitePhotoUploadBox?.addEventListener("click", () => sitePhotoInput?.click());
sitePhotoInput?.addEventListener("change", async function () {
    const files = Array.from(this.files || []).filter(file => file.type.startsWith("image/"));
    if (!files.length) return;
    try {
        const images = await Promise.all(files.map(file => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve({ name: file.name, src: e.target.result });
            reader.onerror = reject;
            reader.readAsDataURL(file);
        })));
        attachedSiteImages = attachedSiteImages.concat(images);
        renderSitePhotoGallery();
        const reviewerGallery = document.getElementById("reviewSitePhotos");
        if (reviewerGallery) reviewerGallery.innerHTML = attachedSiteImages.map((img, i) =>
            `<button type="button" class="drawing-thumb review-thumb" onclick="openSiteImage(${i})" aria-label="تكبير صورة الموقع ${i + 1}"><img src="${img.src}" alt="صورة الموقع ${i + 1}"></button>`
        ).join("");
        sitePhotoUploadBox.innerHTML = `<span class="upload-icon">📷</span>تم إرفاق ${attachedSiteImages.length} صورة — اضغط لإضافة المزيد`;
    } catch (e) { alert("تعذر قراءة إحدى الصور. جربي اختيار صورة أخرى."); }
    this.value = "";
});
function renderSitePhotoGallery() {
    const gallery = document.getElementById("sitePhotoGallery");
    if (!gallery) return;
    gallery.innerHTML = attachedSiteImages.map((img, i) =>
        `<button type="button" class="drawing-thumb" onclick="openSiteImage(${i})" title="اضغط لتكبير الصورة"><img src="${img.src}" alt="${escapeHTML(img.name)}"><span>${i + 1}</span></button>`
    ).join("");
}
function openSiteImage(index) {
    const image = attachedSiteImages[index];
    if (!image) return;
    document.getElementById("lightboxImage").src = image.src;
    document.getElementById("imageLightbox").classList.remove("hidden");
}




/* =====================================================
   البناء المقترح والبناء القائم (كما في النموذج الورقي)
===================================================== */

const PROPOSED_TYPES = ["عادي", "مظلة", "سور مسلح", "سور طابوق", "سور شبك", "مسلح (يحوّل للاستشاري)"];
const EXISTING_TYPES = ["عادي", "مظلة مغلقة", "مظلة غير مغلقة", "سور", "مسلح (يحوّل للاستشاري)"];

// حد المساحة الذي يُحوَّل بعده الطلب لمكتب استشاري
const CONSULTANT_AREA_LIMIT = 250;

// كل نوع في سطر: اختيار + (عدد الكتل للقائم) + الطول + العرض + المساحة
function renderBuildTable(containerId, types, withCount) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = types.map(type => `
        <div class="build-row" data-type="${escapeHTML(type)}">
            <label class="check"><input type="checkbox" class="build-on"> ${escapeHTML(type)}</label>
            ${withCount ? `<input type="number" min="1" step="1" class="build-count" placeholder="عدد الكتل">` : ""}
            <input type="number" min="0" step="0.01" class="build-length" placeholder="الطول (م)">
            <input type="number" min="0" step="0.01" class="build-width" placeholder="العرض (م)">
            <span class="build-area"></span>
        </div>`).join("");
}

function readBuildRows(containerId) {
    return [...document.querySelectorAll(`#${containerId} .build-row`)]
        .filter(row => row.querySelector(".build-on").checked)
        .map(row => {
            const count = Number(row.querySelector(".build-count")?.value) || 0;
            const length = Number(row.querySelector(".build-length").value) || 0;
            const width = Number(row.querySelector(".build-width").value) || 0;
            return {
                type: row.dataset.type,
                count,
                length,
                width,
                area: Math.round(length * width * (count || 1) * 100) / 100
            };
        });
}

function buildingText(item) {
    const parts = [item.type];
    if (item.count) parts.push(`${item.count} كتلة`);
    if (item.length || item.width) parts.push(`${item.length} × ${item.width} م`);
    if (item.area) parts.push(`(${item.area} م²)`);
    return parts.join(" — ");
}

function updateBuildAreas() {
    ["proposedTable", "existingTable"].forEach(id => {
        const areas = new Map(readBuildRows(id).map(item => [item.type, item.area]));
        document.querySelectorAll(`#${id} .build-row`).forEach(row => {
            const area = areas.get(row.dataset.type);
            row.querySelector(".build-area").textContent = area ? `${area} م²` : "";
        });
    });

    const noProposed = document.getElementById("noProposed")?.checked;
    document.querySelectorAll("#proposedTable input").forEach(input => {
        input.disabled = !!noProposed;
    });

    const total = [...(noProposed ? [] : readBuildRows("proposedTable")), ...readBuildRows("existingTable")]
        .reduce((sum, item) => sum + item.area, 0);
    const summary = document.getElementById("areaSummary");
    if (!summary) return;
    summary.className = "area-summary" + (total > CONSULTANT_AREA_LIMIT ? " over" : "");
    summary.innerHTML = total
        ? `مجموع مساحات كتل المباني: <b>${Math.round(total * 100) / 100} م²</b>` +
          (total > CONSULTANT_AREA_LIMIT
              ? `<br>⚠ تجاوز ${CONSULTANT_AREA_LIMIT} متر مربع — يُقدَّم الطلب عن طريق مكتب استشاري مختص (موظفين المرسم).`
              : "")
        : "";
}

renderBuildTable("proposedTable", PROPOSED_TYPES, false);
renderBuildTable("existingTable", EXISTING_TYPES, true);

document.getElementById("reportPage")?.addEventListener("input", event => {
    const row = event.target.closest(".build-row");
    // كتابة رقم في السطر تختار النوع تلقائياً
    if (row && event.target.type === "number" && event.target.value) {
        row.querySelector(".build-on").checked = true;
    }
    if (row || event.target.id === "noProposed") updateBuildAreas();
});
document.getElementById("reportPage")?.addEventListener("change", event => {
    if (event.target.closest(".build-row") || event.target.id === "noProposed") updateBuildAreas();
});


/* =====================================================
   التوقيع
===================================================== */

const signaturePad = document.getElementById("signaturePad");
let signatureDrawn = false;

function prepareSignaturePad() {
    if (!signaturePad) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = signaturePad.getBoundingClientRect();
    if (!rect.width) return;
    signaturePad.width = rect.width * ratio;
    signaturePad.height = rect.height * ratio;
    const ctx = signaturePad.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1d2b26";
    signatureDrawn = false;
}

function clearSignature() {
    prepareSignaturePad();
}

if (signaturePad) {
    let drawing = false;
    const point = e => {
        const rect = signaturePad.getBoundingClientRect();
        return [e.clientX - rect.left, e.clientY - rect.top];
    };
    signaturePad.addEventListener("pointerdown", e => {
        // لوحة التوقيع تُجهَّز عند أول لمسة (الصفحة تكون مخفية عند التحميل)
        if (signaturePad.width !== Math.round(signaturePad.getBoundingClientRect().width * (window.devicePixelRatio || 1))) {
            prepareSignaturePad();
        }
        drawing = true;
        signaturePad.setPointerCapture(e.pointerId);
        const ctx = signaturePad.getContext("2d");
        ctx.beginPath();
        ctx.moveTo(...point(e));
    });
    signaturePad.addEventListener("pointermove", e => {
        if (!drawing) return;
        const ctx = signaturePad.getContext("2d");
        ctx.lineTo(...point(e));
        ctx.stroke();
        signatureDrawn = true;
    });
    ["pointerup", "pointercancel"].forEach(type =>
        signaturePad.addEventListener(type, () => { drawing = false; })
    );
}


/* =====================================================
   SUBMIT REPORT
===================================================== */

let latestSubmittedReport = null;
let latestReportImage = "";

function collectReportData() {
    const root = document.getElementById("reportPage");
    const data = {
        id: "RPT-" + Date.now(),
        submittedAt: new Date().toLocaleString("ar-AE"),
        employee: document.getElementById("employeeName").value.trim(),
        location: document.getElementById("reportLocation")?.value.trim() || "",
        coordinates: document.getElementById("locationCoords")?.value || "",
        fields: [],
        choices: [],
        requests: [],
        image: latestReportImage,
        images: attachedDrawingImages.map(img => ({ name: img.name, src: img.src })),
        siteImages: attachedSiteImages.map(img => ({ name: img.name, src: img.src })),
        status: "قيد المراجعة"
    };

    const noProposed = document.getElementById("noProposed")?.checked || false;
    data.noProposed = noProposed;
    data.proposed = noProposed ? [] : readBuildRows("proposedTable");
    data.existing = readBuildRows("existingTable");
    data.totalArea = Math.round([...data.proposed, ...data.existing]
        .reduce((sum, item) => sum + item.area, 0) * 100) / 100;
    data.violation = root.querySelector("input[name=violation]:checked")?.value || "";
    data.adjacent = root.querySelector("input[name=adjacent]:checked")?.value || "";
    data.checklist = [...root.querySelectorAll("#checklist .check")]
        .filter(label => label.querySelector("input").checked)
        .map(label => label.textContent.trim());
    data.signature = signatureDrawn ? signaturePad.toDataURL("image/png") : "";

    root.querySelectorAll(".panel .field").forEach(field => {
        const label = field.querySelector("label");
        const control = field.querySelector("input:not([type=file]):not([type=hidden]), textarea, select");
        if (label && control && control.id !== "reportLocation") {
            const value = (control.value || "").trim();
            if (value) data.fields.push({ label: label.textContent.trim(), value });
        }
    });

    root.querySelectorAll(".panel .chips").forEach(group => {
        const selected = group.querySelector(".chip.selected");
        if (selected) data.choices.push(selected.textContent.trim());
    });
    root.querySelectorAll(".yes-no .selected").forEach(btn => data.choices.push(btn.textContent.trim()));
    root.querySelectorAll(".request-grid:not(#checklist) .check").forEach(label => {
        const input = label.querySelector("input");
        if (input && input.checked) data.requests.push(label.textContent.trim());
    });
    return data;
}

function submitReport() {
    const data = collectReportData();
    if (!data.fields.some(item => /رقم القطعة|اسم المالك/.test(item.label) && item.value)) {
        const proceed = confirm("لم يتم إدخال اسم المالك أو رقم القطعة. هل تريدين حفظ التقرير على أي حال؟");
        if (!proceed) return;
    }

    latestSubmittedReport = data;
    try {
        const saved = JSON.parse(localStorage.getItem("inspectionReports") || "[]");
        saved.unshift({ ...data, image: "" });
        localStorage.setItem("inspectionReports", JSON.stringify(saved.slice(0, 100)));
    } catch (error) {
        alert("تعذر حفظ بيانات التقرير على هذا الجهاز. جرّبي صورة أصغر أو احذفي بعض البيانات.");
        return;
    }

    const success = document.getElementById("success");
    success.classList.remove("hidden");
    document.getElementById("reportActions").classList.remove("hidden");
    renderSavedReports();
    success.scrollIntoView({ behavior: "smooth", block: "center" });
}

let activeFilter = "all";

function loadReports() {
    try { return JSON.parse(localStorage.getItem("inspectionReports") || "[]"); } catch (_) { return []; }
}

function statusKey(status) {
    return /مقبول/.test(status || "") ? "accepted" : /مرفوض/.test(status || "") ? "rejected" : "review";
}

// تفاصيل البناء والمتطلبات كأسطر (عنوان، قيمة) للمراجع وملف PDF
function buildingDetails(report) {
    const list = items => (items || []).map(buildingText).join("\n");
    const rows = [];
    if (report.checklist?.length) rows.push(["المتطلبات المستوفاة", report.checklist.join("\n")]);
    if (report.noProposed) rows.push(["البناء المقترح", "لا يوجد بناء مقترح"]);
    else if (report.proposed?.length) rows.push(["البناء المقترح", list(report.proposed)]);
    if (report.existing?.length) rows.push(["البناء القائم", list(report.existing)]);
    if (report.violation) rows.push(["البناء المخالف", report.violation]);
    if (report.adjacent) rows.push(["بناء ملاصق بالسور", report.adjacent]);
    if (report.totalArea) {
        rows.push(["مجموع المساحات", `${report.totalArea} م²` +
            (report.totalArea > CONSULTANT_AREA_LIMIT ? " — يُحوَّل لمكتب استشاري" : "")]);
    }
    return rows;
}

function thumbsHTML(images, label) {
    if (!images?.length) return "";
    return `<div class="site-review-block"><label>${label}</label><div class="drawing-gallery">${images.map((img, i) =>
        `<button type="button" class="drawing-thumb" data-image-src="${escapeHTML(img.src)}" title="اضغط لتكبير الصورة"><img src="${escapeHTML(img.src)}" alt="${label} ${i + 1}"></button>`
    ).join("")}</div></div>`;
}

function renderSavedReports() {
    const container = document.getElementById("savedReportsList");
    if (!container) return;
    const reports = loadReports();

    const counts = { all: reports.length, review: 0, accepted: 0, rejected: 0 };
    reports.forEach(r => counts[statusKey(r.status)]++);
    document.getElementById("countAll").textContent = counts.all;
    document.getElementById("countReview").textContent = counts.review;
    document.getElementById("countAccepted").textContent = counts.accepted;
    document.getElementById("countRejected").textContent = counts.rejected;

    const shown = reports.filter(r => activeFilter === "all" || statusKey(r.status) === activeFilter);
    if (!shown.length) {
        container.innerHTML = `<div class="report-card saved-report-details">لا توجد تقارير${activeFilter === "all" ? " بعد" : " في هذا التصنيف"}.</div>`;
        return;
    }

    container.innerHTML = shown.map(report => {
        const parcel = report.fields?.find(x => /رقم القطعة/.test(x.label))?.value || "غير محدد";
        const owner = report.fields?.find(x => /اسم المالك/.test(x.label))?.value || "غير محدد";
        const map = report.coordinates ? `https://www.google.com/maps?q=${encodeURIComponent(report.coordinates)}` : "";
        const rows = (report.fields || []).map(item =>
            `<div class="info-row"><span>${escapeHTML(item.label)}</span><strong>${escapeHTML(item.value)}</strong></div>`
        ).join("");
        const extra = [...(report.requests || []), ...(report.choices || [])];
        const key = statusKey(report.status);
        return `<section class="report-card" data-report-id="${escapeHTML(report.id)}">
            <div class="report-header">
                <div><strong>${escapeHTML("قطعة " + parcel + " - " + owner)}</strong><small>${escapeHTML(report.submittedAt || "")} · ${escapeHTML(report.employee || "")}</small></div>
                <span class="status status-${key === "review" ? "review" : key}">${escapeHTML(report.status || "قيد المراجعة")}</span>
            </div>
            <div class="saved-report-details">
                ${rows}
                <div class="info-row"><span>الموقع</span><strong>${escapeHTML(report.location || "غير محدد")} ${map ? `— <a href="${map}" target="_blank" rel="noopener">الخريطة</a>` : ""}</strong></div>
                ${extra.length ? `<div class="info-row"><span>التفاصيل</span><strong>${extra.map(escapeHTML).join("، ")}</strong></div>` : ""}
                ${buildingDetails(report).map(([label, value]) =>
                    `<div class="info-row"><span>${escapeHTML(label)}</span><strong class="multiline">${escapeHTML(value)}</strong></div>`
                ).join("")}
                ${report.signature ? `<div class="info-row"><span>التوقيع</span><strong><img class="signature-img" src="${escapeHTML(report.signature)}" alt="توقيع الموظف"></strong></div>` : ""}
                ${thumbsHTML(report.images, "الرسم الكروكي")}
                ${thumbsHTML(report.siteImages, "صور الموقع أثناء التفتيش")}
            </div>
            ${report.reviewedBy ? `<div class="decision-note">آخر إجراء: ${escapeHTML(report.status)} بواسطة ${escapeHTML(report.reviewedBy)} — ${escapeHTML(report.reviewedAt || "")}</div>` : ""}
            <div class="review-buttons">
                <button class="reject" data-status="مرفوض ✕">رفض ⊗</button>
                <button class="under-review" data-status="قيد المراجعة ⏱">قيد المراجعة ⏱</button>
                <button class="accept" data-status="مقبول ✓">قبول ⊙</button>
            </div>
            <div class="review-buttons" style="grid-template-columns:1fr"><button class="under-review" data-pdf="1">حفظ / طباعة PDF</button></div>
        </section>`;
    }).join("");
}

document.getElementById("savedReportsList")?.addEventListener("click", event => {
    const card = event.target.closest("[data-report-id]");
    const thumb = event.target.closest("[data-image-src]");
    if (thumb) {
        document.getElementById("lightboxImage").src = thumb.dataset.imageSrc;
        document.getElementById("imageLightbox").classList.remove("hidden");
        return;
    }
    if (!card) return;
    const report = loadReports().find(r => r.id === card.dataset.reportId);
    if (!report) return;
    const statusButton = event.target.closest("[data-status]");
    if (statusButton) setReportStatus(report.id, statusButton.dataset.status);
    if (event.target.closest("[data-pdf]")) {
        latestSubmittedReport = report;
        downloadReportPDF();
    }
});

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}

function buildReportHTML(report, includeImage = true) {
    const rows = [...(report.fields || []).map(item => [item.label, item.value]), ...buildingDetails(report)]
        .map(([label, value]) => `<tr><th>${escapeHTML(label)}</th><td style="white-space:pre-line">${escapeHTML(value)}</td></tr>`).join("");
    const signature = report.signature
        ? `<p><b>الموظف المختص:</b> ${escapeHTML(report.employee || "")} &nbsp; <b>التوقيع:</b><br><img src="${report.signature}" alt="التوقيع" style="max-width:260px;max-height:110px;border-bottom:1px solid #999"></p>`
        : "";
    const choices = (report.choices || []).map(x => `<li>${escapeHTML(x)}</li>`).join("");
    const requests = (report.requests || []).map(x => `<li>${escapeHTML(x)}</li>`).join("");
    const reportImages = (report.images && report.images.length) ? report.images : (report.image ? [{src: report.image}] : []);
    const siteImages = report.siteImages || [];
    const image = includeImage ? `${reportImages.length ? `<h3>الرسم الكروكي</h3><div style="display:flex;flex-wrap:wrap;gap:10px">${reportImages.map((img, i) => `<img class="report-image" src="${img.src}" alt="الرسم الكروكي ${i+1}">`).join("")}</div>` : ""}${siteImages.length ? `<h3>صور الموقع أثناء التفتيش</h3><div style="display:flex;flex-wrap:wrap;gap:10px">${siteImages.map((img, i) => `<img class="report-image" src="${img.src}" alt="صورة الموقع ${i+1}">`).join("")}</div>` : ""}` : "";
    // شعار حكومة الشارقة وبلدية مدينة الذيد في أعلى يمين التقرير
    const logoMarkup = `<img class="brand-image" src="${new URL("../sharjah-header.png", location.href).href}" alt="حكومة الشارقة - بلدية مدينة الذيد">`;
    const map = report.coordinates ? `https://www.google.com/maps?q=${encodeURIComponent(report.coordinates)}` : "";
    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير التفتيش ${escapeHTML(report.id)}</title><style>body{font-family:Tahoma,Arial,sans-serif;color:#263a33;margin:28px}header{border-bottom:3px solid #155b48;padding-bottom:12px}.brand-image{display:block;width:240px;height:auto}.title{margin:18px 0 4px;text-align:center}h1{font-size:20px;margin:0}small{color:#66756f}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #d6dfdb;padding:9px;text-align:right}th{background:#edf4f1;width:30%}h3{margin-top:20px}img.report-image{max-width:100%;max-height:420px;object-fit:contain;border:1px solid #ddd}li{margin:5px 0}.meta{margin-top:12px}</style></head><body><header>${logoMarkup}</header><div class="title"><h1>تقرير تفتيش تفصيلي</h1><small>تقرير تفتيش ميداني</small></div><div class="meta"><b>رقم التقرير:</b> ${escapeHTML(report.id)} &nbsp; <b>تاريخ الإرسال:</b> ${escapeHTML(report.submittedAt)}<br><b>الموظف:</b> ${escapeHTML(report.employee || "")}<br><b>الموقع:</b> ${escapeHTML(report.location || "غير محدد")} ${map ? `— <a href="${map}">فتح الخريطة</a>` : ""}</div><table>${rows}</table>${choices ? `<h3>الاختيارات</h3><ul>${choices}</ul>` : ""}${requests ? `<h3>نوع الطلب</h3><ul>${requests}</ul>` : ""}${image}${signature}<p><b>الحالة:</b> ${escapeHTML(report.status || "قيد المراجعة")}</p><script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script></body></html>`;
}

function downloadReportPDF() {
    if (!latestSubmittedReport) { alert("احفظي التقرير أولًا بالضغط على إرسال التقرير."); return; }
    const win = window.open("", "_blank");
    if (!win) { alert("اسمحي بفتح النوافذ المنبثقة ثم أعيدي المحاولة."); return; }
    win.document.open();
    win.document.write(buildReportHTML(latestSubmittedReport, true));
    win.document.close();
}


function useCurrentLocation() {
    if (!navigator.geolocation) { alert("المتصفح لا يدعم تحديد الموقع."); return; }
    const button = document.querySelector(".location-field .small-action");
    if (button) { button.disabled = true; button.textContent = "جارٍ تحديد الموقع..."; }
    navigator.geolocation.getCurrentPosition(position => {
        const coords = `${position.coords.latitude},${position.coords.longitude}`;
        document.getElementById("locationCoords").value = coords;
        const input = document.getElementById("reportLocation");
        if (!input.value.trim()) input.value = `إحداثيات: ${coords}`;
        const link = document.getElementById("mapLink");
        link.href = `https://www.google.com/maps?q=${encodeURIComponent(coords)}`;
        link.classList.remove("hidden");
        if (button) { button.disabled = false; button.textContent = "تحديد موقعي الحالي"; }
    }, error => {
        alert("لم نتمكن من تحديد الموقع. اسمحي للمتصفح باستخدام الموقع أو اكتبي العنوان يدويًا.");
        if (button) { button.disabled = false; button.textContent = "تحديد موقعي الحالي"; }
    }, { enableHighAccuracy: true, timeout: 10000 });
}

/* تغيير حالة التقرير مع حفظ اسم مسؤول المراجعة */
function setReportStatus(reportId, statusText) {
    const reviewer = document.getElementById("employeeName")?.value.trim() || "مسؤول المراجعة";
    try {
        const saved = loadReports();
        const report = saved.find(r => r.id === reportId);
        if (!report) return;
        report.status = statusText;
        report.reviewedBy = reviewer;
        report.reviewedAt = new Date().toLocaleString("ar-AE");
        localStorage.setItem("inspectionReports", JSON.stringify(saved));
    } catch (_) {}
    renderSavedReports();
}


/* =====================================================
   FILTER BUTTONS
===================================================== */

document
    .querySelectorAll(".filter")
    .forEach(function(button) {


        button.addEventListener(
            "click",
            function() {


                document
                    .querySelectorAll(".filter")
                    .forEach(function(item) {

                        item.classList
                            .remove("active");

                    });


                this.classList
                    .add("active");

                activeFilter = this.dataset.filter || "all";
                renderSavedReports();

            }
        );

    });





// Load reports saved in this browser when the page opens
document.addEventListener("DOMContentLoaded", () => { renderSavedReports(); });
