"use strict";

// ================= الإعدادات =================

// مفاتيح الحفظ في المتصفح (النسخة التجريبية فقط)
const LOCAL_KEY = "dhaid_platforms_portal_v1";
const SESSION_KEY = "dhaid_platforms_portal_session";

const ROLE_LABELS = {
    super_admin: "مدير النظام الرئيسي",
    director: "مدير الإدارة",
    department_head: "رئيس القسم",
    employee: "موظف"
};

// المنصات المنشورة، تُضاف تلقائياً عند إعداد النظام لأول مرة
const DEFAULT_PLATFORMS = [
    {
        id: "inspectors-areas",
        name: "نطاقات المفتشين",
        nameEn: "Inspectors Zones",
        url: "https://muntechsys-96a48.web.app/zones/",
        department: "شعبة التفتيش والمتابعة",
        icon: "🗺️",
        color: "#3fae6b"
    },
    {
        id: "customer-inquiries",
        name: "رضى المتعاملين",
        nameEn: "Customer Satisfaction",
        url: "https://muntechsys-96a48.web.app/inquiries/dashboard.html",
        department: "خدمة المتعاملين",
        icon: "💬",
        color: "#e0a43a"
    },
    {
        id: "staff-affairs",
        name: "إدارة شؤون الموظفين",
        nameEn: "Staff Affairs",
        url: "https://muntechsys-96a48.web.app/staff/",
        department: "إدارة الخدمات الفنية",
        icon: "👥",
        color: "#5b8def"
    },
    {
        id: "inspection-reports",
        name: "تقارير التفتيش",
        nameEn: "Inspection Reports",
        url: "https://muntechsys-96a48.web.app/reports/",
        department: "شعبة التفتيش والمتابعة",
        icon: "📋",
        color: "#155b48"
    },
    {
        id: "facility-reports",
        name: "تقارير المشاريع وصيانة المرافق",
        nameEn: "Projects & Facilities Maintenance",
        url: "https://muntechsys-96a48.web.app/maintenance/",
        department: "قسم المشاريع وصيانة المرافق",
        icon: "🏗️",
        color: "#c9822b"
    }
];

// لغة عرض البطاقات (تُحفظ على هذا الجهاز)
let language = "ar";

try {
    language = localStorage.getItem("dhaid_portal_language") || "ar";
} catch {}

const USE_FIREBASE = Boolean(
    typeof FIREBASE_CONFIG !== "undefined" && FIREBASE_CONFIG.apiKey
);

// ================= أدوات مساعدة =================

function $(id) {
    return document.getElementById(id);
}

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;",
        '"': "&quot;", "'": "&#39;"
    })[c]);
}

function uid() {
    return crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(36).slice(2);
}

function now() {
    return new Date().toISOString();
}

// توحيد اسم المستخدم حتى لا تؤثر الهمزات والمسافات على الدخول
function loginKey(name) {
    return String(name ?? "")
        .replace(/[ً-ْـ]/g, "")
        .replace(/[أإآ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ة/g, "ه")
        .replace(/\//g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

// نوع المنصة يُعرف من مسار رابطها داخل الموقع
function platformKind(platform) {
    let path = "";
    try {
        path = new URL(platform.url).pathname;
    } catch {}

    return ["staff", "zones", "inquiries", "maintenance"]
        .find(kind => path.startsWith(`/${kind}/`)) || "";
}

async function hashPassword(password) {
    if (!crypto.subtle) {
        return password;
    }

    const bytes = new TextEncoder().encode("dhaid-portal:" + password);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return [...new Uint8Array(digest)]
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

// بيانات المستخدم بدون كلمة المرور
function publicUser(user) {
    const { passwordHash, ...rest } = user;
    return rest;
}

function errorText(err) {
    const messages = {
        "bad-login": "اسم المستخدم أو كلمة المرور غير صحيحة.",
        "username-taken": "اسم المستخدم مستخدم لموظف آخر.",
        "no-account": "هذا الحساب غير مسجل في النظام.",
        "auth/invalid-credential": "اسم المستخدم أو كلمة المرور غير صحيحة.",
        "auth/invalid-login-credentials": "اسم المستخدم أو كلمة المرور غير صحيحة.",
        "auth/wrong-password": "اسم المستخدم أو كلمة المرور غير صحيحة.",
        "auth/user-not-found": "اسم المستخدم أو كلمة المرور غير صحيحة.",
        "auth/weak-password": "كلمة المرور يجب أن تكون 6 أحرف على الأقل.",
        "auth/too-many-requests": "محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.",
        "auth/network-request-failed": "تعذّر الاتصال بالإنترنت.",
        "auth/requires-recent-login": "لتغيير كلمة مرورك سجّل الخروج ثم الدخول مرة أخرى وأعد المحاولة.",
        "auth/operation-not-allowed": "تسجيل الدخول بالبريد وكلمة المرور غير مفعّل في Firebase.",
        "permission-denied": "لا توجد صلاحية. تأكد من نشر قواعد الحماية في Firestore."
    };

    return messages[err?.code] || `حدث خطأ: ${err?.message || err}`;
}

// ================= الحفظ في المتصفح (نسخة تجريبية) =================

const localStore = {

    data() {
        try {
            return JSON.parse(localStorage.getItem(LOCAL_KEY)) ||
                { platforms: [], users: [], audit: [] };
        } catch {
            return { platforms: [], users: [], audit: [] };
        }
    },

    write(data) {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
    },

    async isSetUp() {
        return this.data().users.length > 0;
    },

    async setup(admin, password) {
        const data = this.data();

        data.users.push({
            ...admin,
            passwordHash: await hashPassword(password)
        });

        data.platforms = DEFAULT_PLATFORMS.map(p => ({ ...p, createdAt: now() }));

        this.write(data);
        sessionStorage.setItem(SESSION_KEY, admin.id);

        return admin;
    },

    async login(username, password) {
        const user = this.data().users.find(
            u => loginKey(u.username) === loginKey(username)
        );

        if (!user || user.passwordHash !== await hashPassword(password)) {
            throw { code: "bad-login" };
        }

        sessionStorage.setItem(SESSION_KEY, user.id);

        return publicUser(user);
    },

    async restore() {
        const id = sessionStorage.getItem(SESSION_KEY);
        const user = this.data().users.find(u => u.id === id);

        return user ? publicUser(user) : null;
    },

    async logout() {
        sessionStorage.removeItem(SESSION_KEY);
    },

    async load(me) {
        const data = this.data();
        const admin = me.role === "super_admin";
        const fresh = data.users.find(u => u.id === me.id);

        return {
            me: fresh ? publicUser(fresh) : me,
            platforms: admin
                ? data.platforms
                : data.platforms.filter(p => (fresh?.platforms || []).includes(p.id)),
            users: admin ? data.users.map(publicUser) : [],
            audit: admin ? data.audit : []
        };
    },

    async savePlatform(platform) {
        const data = this.data();
        const index = data.platforms.findIndex(p => p.id === platform.id);

        if (index >= 0) {
            data.platforms[index] = platform;
        } else {
            data.platforms.push(platform);
        }

        this.write(data);
    },

    async deletePlatform(id) {
        const data = this.data();

        data.platforms = data.platforms.filter(p => p.id !== id);

        data.users.forEach(u => {
            u.platforms = (u.platforms || []).filter(p => p !== id);
        });

        this.write(data);
    },

    async saveUser(user, password) {
        const data = this.data();

        const taken = data.users.some(
            u => u.id !== user.id && loginKey(u.username) === loginKey(user.username)
        );

        if (taken) {
            throw { code: "username-taken" };
        }

        const old = data.users.find(u => u.id === user.id);
        const record = { ...user, passwordHash: old?.passwordHash };

        if (password) {
            record.passwordHash = await hashPassword(password);
        }

        if (old) {
            data.users[data.users.indexOf(old)] = record;
        } else {
            data.users.push(record);
        }

        this.write(data);
    },

    async deleteUser(user) {
        const data = this.data();

        data.users = data.users.filter(u => u.id !== user.id);

        this.write(data);
    },

    async addAudit(entry) {
        const data = this.data();

        data.audit.unshift(entry);
        data.audit = data.audit.slice(0, 500);

        this.write(data);
    }
};

// ================= الحفظ في Firebase =================

function createFirebaseStore() {

    // اسم مستقل حتى لا يختلط دخول الواجهة بدخول شؤون الموظفين
    // (نفس المشروع ونفس الموقع، فبدون الاسم يتشاركان نفس الجلسة)
    const app = firebase.initializeApp(FIREBASE_CONFIG, "portal");

    const auth = app.auth();
    const fs = app.firestore();

    // جداول الواجهة في المشروع المشترك تبدأ بـ portal_
    const col = name => fs.collection("portal_" + name);

    // نطاق حسابات الدخول الداخلية (الموظف لا يراها)
    const loginDomain = `staff.${FIREBASE_CONFIG.authDomain}`;

    // تطبيق ثانوي لإنشاء حسابات الموظفين دون تسجيل خروج المدير
    let secondaryAuth = null;

    function newLoginEmail() {
        return `u${uid().replace(/-/g, "").slice(0, 20)}@${loginDomain}`;
    }

    async function createLoginAccount(password) {
        if (!secondaryAuth) {
            secondaryAuth = firebase.initializeApp(FIREBASE_CONFIG, "secondary").auth();
            await secondaryAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);
        }

        const email = newLoginEmail();
        const cred = await secondaryAuth.createUserWithEmailAndPassword(email, password);

        await secondaryAuth.signOut();

        return { email, authUid: cred.user.uid };
    }

    async function userOf(fbUser) {
        const account = await col("accounts").doc(fbUser.uid).get();

        if (!account.exists) {
            throw { code: "no-account" };
        }

        const doc = await col("users").doc(account.data().userId).get();

        if (!doc.exists) {
            throw { code: "no-account" };
        }

        return doc.data();
    }

    const docs = snapshot => snapshot.docs.map(d => d.data());

    // ===== شؤون الموظفين تأخذ موظفيها من هذه الصفحة =====
    // كل موظف هنا يُنشأ له (أو يُحدَّث) سجل في شؤون الموظفين بنفس حساب الدخول،
    // مع قسمه وشعبته، ويُعيَّن رئيساً للقسم أو الشعبة حسب منصبه في الهيكل.
    async function syncStaff(portalUsers) {
        const all = await Promise.all([
            fs.collection("users").get(),
            fs.collection("departments").get(),
            fs.collection("units").get(),
            fs.collection("meta").doc("setup").get()
        ]);
        const [staffUsers, depts, units] = all.slice(0, 3)
            .map(snap => snap.docs.map(d => ({ ...d.data(), id: d.id })));
        const setup = all[3];

        const writes = new Map();
        const put = (collection, id, data) => writes.set(`${collection}/${id}`, { collection, id, data });

        // الاسم بدون اللقب (م. / د. / أ.) حتى يُطابق الاسم المسجل في شؤون الموظفين
        const personKey = name => loginKey(String(name ?? "").replace(/^\s*[مدأا]\s*\.\s*/, ""));
        const sameKey = (a, b) => loginKey(normalizeSpaces(a)) === loginKey(normalizeSpaces(b));

        const ensureDept = name => {
            name = normalizeSpaces(name);
            if (!name) return null;
            let dept = depts.find(d => sameKey(d.name, name));
            if (!dept) {
                dept = { id: uid(), name, managerId: "" };
                depts.push(dept);
                put("departments", dept.id, dept);
            }
            return dept;
        };

        const ensureUnit = (dept, name) => {
            name = normalizeSpaces(name);
            if (!dept || !name) return null;
            let unit = units.find(u => u.departmentId === dept.id && sameKey(u.name, name));
            if (!unit) {
                unit = {
                    id: uid(), name, departmentId: dept.id, managerId: "",
                    kind: /^\s*مكتب/.test(name) ? "office" : "unit"
                };
                units.push(unit);
                put("units", unit.id, unit);
            }
            return unit;
        };

        const setManager = (collection, target, userId) => {
            if (target && target.managerId !== userId) {
                target.managerId = userId;
                put(collection, target.id, target);
            }
        };

        const linked = new Set();

        portalUsers.filter(p => p.authUid).forEach(p => {
            const title = orgTitleOf(p);
            const dept = ensureDept(p.department);
            const unit = ensureUnit(dept, p.section);

            const existing = staffUsers.find(u => personKey(u.name) === personKey(p.fullName));
            const id = existing?.id || p.id;
            linked.add(id);

            const role = p.role === "super_admin" || existing?.role === "admin" ? "admin"
                : ["director", "department_head", "section_head"].includes(title) ? "manager"
                : "employee";

            const record = {
                ...(existing || {}),
                id,
                name: p.fullName,
                role,
                departmentId: dept?.id || "",
                unitId: unit?.id || "",
                active: true,
                authUid: p.authUid,
                loginEmail: p.loginEmail || "",
                fromPortal: true,
                _createdAt: existing?._createdAt || existing?.createdAt || now()
            };

            if (JSON.stringify(existing) !== JSON.stringify(record)) put("users", id, record);
            if (!existing || existing.authUid !== p.authUid) put("accounts", p.authUid, { userId: id });

            if (title === "director" && dept) {
                setManager("departments", dept, id);
                if (!depts.some(d => d.isDirectorate === true)) {
                    dept.isDirectorate = true;
                    put("departments", dept.id, dept);
                }
            }
            if (title === "department_head") setManager("departments", dept, id);
            if (title === "section_head") setManager("units", unit, id);
        });

        // من حُذف من هذه الصفحة يُوقف في شؤون الموظفين (وتبقى سجلاته)
        staffUsers
            .filter(u => u.fromPortal && !linked.has(u.id) && u.active !== false)
            .forEach(u => {
                put("users", u.id, { ...u, active: false });
                if (u.authUid) writes.set(`accounts/${u.authUid}`, { collection: "accounts", id: u.authUid, remove: true });
            });

        if (!setup.exists) put("meta", "setup", { by: currentUser.id, at: now(), fromPortal: true });

        const list = [...writes.values()];
        for (let i = 0; i < list.length; i += 400) {
            const batch = fs.batch();
            list.slice(i, i + 400).forEach(w => {
                const ref = fs.collection(w.collection).doc(w.id);
                if (w.remove) batch.delete(ref);
                else {
                    // الموظفون والأقسام والشعب تحفظ معرّفها داخلها كما في شؤون الموظفين
                    const keepsId = ["users", "departments", "units"].includes(w.collection);
                    const { id, ...data } = w.data;
                    batch.set(ref, keepsId ? { ...data, id: w.id } : data);
                }
            });
            await batch.commit();
        }

        return list.length;
    }

    // ===== فريق تقارير المشاريع وصيانة المرافق =====
    // من أُعطي صلاحية المنصة يُضاف لفريقها بالدور المختار (موظف أو رئيس)،
    // ومن سُحبت صلاحيته يُزال (من أُضيف يدوياً من داخل المنصة يبقى)
    async function syncFacilityTeam(portalUsers, allPlatforms) {
        const platformIds = allPlatforms
            .filter(p => String(p.url || "").includes("/maintenance/"))
            .map(p => p.id);
        if (!platformIds.length) return 0;

        const snap = await fs.collection("facility_members").get();
        const existing = new Map(snap.docs.map(d => [d.id, d.data()]));
        const batch = fs.batch();
        let count = 0;

        portalUsers.forEach(u => {
            const id = platformIds.find(pid => (u.platforms || []).includes(pid));
            const current = existing.get(u.id);

            // مدير النظام ومدير الإدارة يديران المنصة أصلاً فلا يُضافان للفريق
            if (id && !["super_admin", "director"].includes(u.role)) {
                const chosen = u.platformRoles?.[id];

                // من أُضيف للفريق قبل اختيار الأدوار هنا يحتفظ بدوره، ويُسجَّل دوره هنا
                if (!chosen && current) {
                    batch.set(col("users").doc(u.id),
                        { platformRoles: { [id]: current.role } }, { merge: true });
                    count++;
                }

                const role = chosen ? (chosen === "head" ? "head" : "employee")
                    : (current?.role || "employee");
                if (!current || current.role !== role || current.name !== u.fullName) {
                    batch.set(fs.collection("facility_members").doc(u.id), {
                        name: u.fullName || "",
                        role,
                        fromPortal: true,
                        addedBy: currentUser.id,
                        addedAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                    count++;
                }
            } else if (current?.fromPortal) {
                batch.delete(fs.collection("facility_members").doc(u.id));
                count++;
            }
        });

        if (count) await batch.commit();
        return count;
    }

    // المنصات التي تُبنى لاحقاً تُضاف تلقائياً عند دخول المدير (مرة واحدة لكل منصة،
    // فإذا حذفها المدير بعد ذلك لا تعود)
    async function addNewDefaultPlatforms(existing) {
        const seededRef = col("meta").doc("seeded");

        try {
            const snap = await seededRef.get();
            const seeded = new Set(snap.exists ? snap.data().ids || [] : []);

            const added = DEFAULT_PLATFORMS
                .filter(p => !seeded.has(p.id) && !existing.some(e => e.id === p.id))
                .map(p => ({ ...p, createdAt: now() }));

            if (!added.length && snap.exists) return [];

            const batch = fs.batch();
            added.forEach(p => batch.set(col("platforms").doc(p.id), p));
            batch.set(seededRef, { ids: DEFAULT_PLATFORMS.map(p => p.id) });
            await batch.commit();

            return added;
        } catch (err) {
            console.error(err);
            return [];
        }
    }

    // المنصات التي سُجّل فيها الموظف بنفس اسمه (من قوائم المنصات نفسها)
    async function registeredPlatforms(user) {
        const kinds = new Set();
        const name = user.fullName || "";

        const checks = [
            // شؤون الموظفين: حساب الدخول نفسه مرتبط بموظف فيها
            user.authUid
                ? fs.collection("accounts").doc(user.authUid).get()
                    .then(d => { if (d.exists) kinds.add("staff"); })
                : null,

            // نطاقات المفتشين: قائمة أسماء مستخدميها (بدون كلمات مرور)
            fs.collection("zones_directory").doc("users").get()
                .then(d => {
                    const list = d.exists ? JSON.parse(d.data().value || "[]") : [];
                    if (list.some(u => loginKey(u.name || u.fullName) === loginKey(name))) {
                        kinds.add("zones");
                    }
                }),

            // تقارير المشاريع وصيانة المرافق: أضافه رئيس القسم للفريق
            fs.collection("facility_members").doc(user.id).get()
                .then(d => { if (d.exists) kinds.add("maintenance"); }),

            // رضى المتعاملين: الموظف مسجّل باسم المستخدم الإنجليزي نفسه
            user.username
                ? fs.collection("ci_staff")
                    .doc(user.username.trim().toLowerCase() + "@dhaid-inquiries.app").get()
                    .then(d => { if (d.exists) kinds.add("inquiries"); })
                : null
        ];

        // تعذّر فحص منصة لا يمنع عرض الباقي
        await Promise.all(checks.map(p => p && p.catch(err => console.warn(err))));

        return kinds;
    }

    return {

        syncStaff,
        syncFacilityTeam,

        async isSetUp() {
            return (await col("meta").doc("setup").get()).exists;
        },

        async setup(admin, password) {
            const email = newLoginEmail();
            const cred = await auth.createUserWithEmailAndPassword(email, password);

            const record = { ...admin, authUid: cred.user.uid, loginEmail: email };
            const batch = fs.batch();

            batch.set(col("meta").doc("setup"), { by: admin.id, at: now() });
            batch.set(col("accounts").doc(cred.user.uid), { userId: admin.id });
            batch.set(col("users").doc(admin.id), record);
            batch.set(col("logins").doc(loginKey(admin.username)), { email });

            DEFAULT_PLATFORMS.forEach(p => {
                batch.set(col("platforms").doc(p.id), { ...p, createdAt: now() });
            });

            try {
                await batch.commit();
            } catch (err) {
                await cred.user.delete().catch(() => {});
                throw err;
            }

            return record;
        },

        async login(username, password) {
            const login = await col("logins").doc(loginKey(username)).get();

            if (!login.exists) {
                throw { code: "bad-login" };
            }

            const cred = await auth.signInWithEmailAndPassword(login.data().email, password);

            try {
                return await userOf(cred.user);
            } catch (err) {
                await auth.signOut();
                throw err;
            }
        },

        restore() {
            return new Promise(resolve => {
                const stop = auth.onAuthStateChanged(async fbUser => {
                    stop();

                    if (!fbUser) {
                        resolve(null);
                        return;
                    }

                    try {
                        resolve(await userOf(fbUser));
                    } catch {
                        await auth.signOut();
                        resolve(null);
                    }
                });
            });
        },

        logout() {
            return auth.signOut();
        },

        async load(me) {
            const fresh = (await col("users").doc(me.id).get()).data() || me;

            if (fresh.role === "super_admin") {
                const [platforms, users, audit] = await Promise.all([
                    col("platforms").get(),
                    col("users").get(),
                    col("audit").orderBy("at", "desc").limit(300).get()
                ]);

                const added = await addNewDefaultPlatforms(docs(platforms));

                return {
                    me: fresh,
                    platforms: [...docs(platforms), ...added],
                    users: docs(users),
                    audit: docs(audit)
                };
            }

            // الموظف يرى المنصات المخصصة له، والمنصات المسجّل اسمه فيها تلقائياً
            const [all, registered, directory] = await Promise.all([
                col("platforms").get(),
                registeredPlatforms(fresh),
                col("directory").doc("org").get().catch(() => null)
            ]);

            const assigned = new Set(fresh.platforms || []);

            return {
                me: fresh,
                platforms: docs(all).filter(p =>
                    assigned.has(p.id) || registered.has(platformKind(p))
                ),
                users: [],
                audit: [],
                directory: directory?.exists ? JSON.parse(directory.data().value || "[]") : []
            };
        },

        // ملاحظات الموظف الخاصة: لا يقرؤها ولا يعدّلها غيره
        listMyNotes(userId) {
            return col("my_notes").where("ownerId", "==", userId).get()
                .then(snap => snap.docs.map(d => ({ ...d.data(), id: d.id })));
        },

        saveMyNote(note) {
            return col("my_notes").doc(note.id).set(note);
        },

        deleteMyNote(id) {
            return col("my_notes").doc(id).delete();
        },

        // نسخة الهيكل للموظفين: الاسم والقسم والشعبة والمنصب فقط
        async saveDirectory(list) {
            const ref = col("directory").doc("org");
            const value = JSON.stringify(list);
            const current = await ref.get();
            if (!current.exists || current.data().value !== value) {
                await ref.set({ value, updatedAt: now() });
            }
        },

        savePlatform(platform) {
            return col("platforms").doc(platform.id).set(platform);
        },

        async deletePlatform(id) {
            const holders = await col("users")
                .where("platforms", "array-contains", id)
                .get();

            const batch = fs.batch();

            batch.delete(col("platforms").doc(id));

            holders.docs.forEach(d => {
                batch.update(d.ref, {
                    platforms: firebase.firestore.FieldValue.arrayRemove(id)
                });
            });

            await batch.commit();
        },

        async saveUser(user, password) {
            const old = (await col("users").doc(user.id).get()).data();
            const newKey = loginKey(user.username);
            const keyChanged = !old || loginKey(old.username) !== newKey;

            if (keyChanged && (await col("logins").doc(newKey).get()).exists) {
                throw { code: "username-taken" };
            }

            const record = { ...user };
            const batch = fs.batch();
            let loginChanged = keyChanged;

            if (old) {
                record.authUid = old.authUid;
                record.loginEmail = old.loginEmail;

                if (password && old.authUid === auth.currentUser?.uid) {
                    // المدير يغيّر كلمة مروره هو
                    await auth.currentUser.updatePassword(password);
                } else if (password) {
                    // Firebase لا يسمح بتغيير كلمة مرور مستخدم آخر من المتصفح،
                    // لذلك يُنشأ له حساب دخول جديد ويُلغى ربط القديم
                    // (فيخرج تلقائياً من الأجهزة المسجّل فيها بكلمة المرور القديمة)
                    const account = await createLoginAccount(password);

                    if (old.authUid) {
                        batch.delete(col("accounts").doc(old.authUid));
                    }
                    batch.set(col("accounts").doc(account.authUid), { userId: user.id });

                    record.authUid = account.authUid;
                    record.loginEmail = account.email;
                    loginChanged = true;
                }
            } else {
                const account = await createLoginAccount(password);

                record.authUid = account.authUid;
                record.loginEmail = account.email;

                batch.set(col("accounts").doc(account.authUid), { userId: user.id });
            }

            if (loginChanged) {
                if (old && keyChanged) {
                    batch.delete(col("logins").doc(loginKey(old.username)));
                }

                batch.set(col("logins").doc(newKey), { email: record.loginEmail });
            }

            batch.set(col("users").doc(user.id), record);

            await batch.commit();
        },

        async deleteUser(user) {
            const batch = fs.batch();

            batch.delete(col("users").doc(user.id));
            batch.delete(col("logins").doc(loginKey(user.username)));

            if (user.authUid) {
                batch.delete(col("accounts").doc(user.authUid));
            }

            await batch.commit();
        },

        addAudit(entry) {
            return col("audit").doc(entry.id).set(entry);
        }
    };
}

// ================= حالة النظام =================

let store = null;
let currentUser = null;
let platforms = [];
let users = [];
let auditLog = [];
let orgDirectory = [];
let myNotes = [];

function isAdmin() {
    return currentUser?.role === "super_admin";
}

function platformName(id) {
    return platforms.find(p => p.id === id)?.name || "";
}

// ================= الشاشات =================

function showScreen(screenId) {

    ["loadingPage", "setupPage", "loginPage", "systemMain"].forEach(id => {
        $(id).classList.toggle("hidden", id !== screenId);
    });
}

// ================= التنقل بين الصفحات =================

function showPage(pageId) {

    const pages = document.querySelectorAll(".page");

    pages.forEach(page => {
        page.classList.add("hidden");
    });

    const selectedPage = $(pageId);

    if (!selectedPage) {
        return;
    }

    selectedPage.classList.remove("hidden");

    document.querySelectorAll(".nav-btn").forEach(button => {
        button.classList.toggle(
            "active",
            button.dataset.page === pageId
        );
    });

    if (pageId !== "platformViewerPage") {
        $("platformFrame").removeAttribute("src");
    }
}

// ================= أزرار القائمة =================

document.querySelectorAll("[data-page]").forEach(button => {

    button.addEventListener("click", () => {
        showPage(button.dataset.page);
    });

});

// ================= سجل التغييرات =================

async function logAction(action, details = "", platform = "") {

    const entry = {
        id: uid(),
        at: now(),
        byId: currentUser.id,
        byName: currentUser.fullName,
        platform,
        action,
        details
    };

    try {
        await store.addAudit(entry);

        if (isAdmin()) {
            auditLog.unshift(entry);
            renderAudit();
        }
    } catch (err) {
        console.error(err);
    }
}

// ================= عرض البيانات =================

async function refresh() {

    const data = await store.load(currentUser);

    currentUser = data.me;
    platforms = data.platforms;
    users = data.users;
    auditLog = data.audit;
    orgDirectory = isAdmin() ? orgEntries(users) : data.directory || [];

    renderAll();

    // المدير يحدّث نسخة الهيكل التي يراها الموظفون
    if (isAdmin() && store.saveDirectory) {
        store.saveDirectory(orgDirectory).catch(err => console.error(err));
    }

    // تحديث موظفي شؤون الموظفين من هذه القائمة (في الخلفية)
    if (isAdmin() && store.syncStaff) {
        store.syncStaff(users).catch(err => {
            console.error(err);
            notifyStaffSyncError(err);
        });
    }

    // فريق تقارير المشاريع وصيانة المرافق من صلاحيات المنصات
    if (isAdmin() && store.syncFacilityTeam) {
        store.syncFacilityTeam(users, platforms).catch(err => {
            console.error(err);
            notifyStaffSyncError(err);
        });
    }
}

let staffSyncErrorShown = false;

function notifyStaffSyncError(err) {
    if (staffSyncErrorShown) return;
    staffSyncErrorShown = true;
    alert("تعذّر تحديث الموظفين في منصة شؤون الموظفين: " + errorText(err));
}

function renderAll() {

    $("currentUserName").textContent = currentUser.fullName;
    $("currentUserRole").textContent = ROLE_LABELS[currentUser.role] || "";
    $("currentUserDepartment").textContent = currentUser.department || "";

    document.querySelectorAll(".admin-only").forEach(element => {
        element.classList.toggle("hidden", !isAdmin());
    });

    renderMyPlatforms();
    renderOrgChart();

    if (isAdmin()) {
        renderPlatformsList();
        renderUserPlatformOptions();
        renderUsers();
        renderAudit();
        renderNameSuggestions();
    }
}

// ================= الهيكل التنظيمي =================

const ORG_TITLES = {
    director: "مدير الإدارة",
    department_head: "رئيس القسم",
    section_head: "رئيس الشعبة",
    employee: "موظف"
};

// ما يظهر للموظفين في الهيكل فقط (بدون أسماء الدخول والصلاحيات)
function orgEntries(list) {
    return list.map(u => ({
        id: u.id,
        fullName: u.fullName || "",
        department: normalizeSpaces(u.department),
        section: normalizeSpaces(u.section),
        orgTitle: orgTitleOf(u)
    }));
}

// رئيس شعبة اسمها يبدأ بـ«مكتب» يُسمى «مسؤول المكتب»
function orgTitleLabel(person) {
    if (person.orgTitle === "section_head" && /^\s*مكتب/.test(person.section || "")) return "مسؤول المكتب";
    return ORG_TITLES[person.orgTitle];
}

function orgPersonHTML(person, kind = "") {
    // المدير يضغط على الاسم لتعديل بياناته، والموظفون يرون الهيكل فقط
    const tag = isAdmin() ? "button" : "div";
    const me = person.id === currentUser.id ? "me" : "";

    return `
        <${tag} ${isAdmin() ? `type="button" data-org-user="${esc(person.id)}"` : ""} class="org-person ${kind} ${me}">
            <b>${esc(person.fullName)}${me ? " (أنت)" : ""}</b>
            ${kind ? `<small>${esc(orgTitleLabel(person))}</small>` : ""}
        </${tag}>`;
}

function renderOrgChart() {

    $("orgHint").textContent = isAdmin()
        ? "يُرسم تلقائياً من بيانات الموظفين (القسم، الشعبة، المنصب). اضغط على أي اسم لتعديل بياناته."
        : "الهيكل التنظيمي لإدارة الخدمات الفنية. اسمك مميّز باللون البني.";

    // الأقسام والشعب تُجمع حسب الاسم (بدون فرق المسافات والهمزات)
    const groupBy = (list, field) => {
        const groups = new Map();
        list.forEach(u => {
            const key = loginKey(u[field]);
            if (!groups.has(key)) groups.set(key, { name: u[field], members: [] });
            groups.get(key).members.push(u);
        });
        return [...groups.values()];
    };

    const byName = (a, b) => String(a.fullName).localeCompare(String(b.fullName), "ar");
    const people = orgDirectory;

    const directors = people.filter(u => u.orgTitle === "director").sort(byName);

    // من في نفس قسم مدير الإدارة يتبعه مباشرة (مكاتب الإدارة)
    const directorDepts = new Set(directors.map(u => loginKey(u.department)));
    const inDirectorate = u => u.orgTitle !== "director" && directorDepts.has(loginKey(u.department));

    const officeStaff = people.filter(inDirectorate);
    const others = people.filter(u => u.orgTitle !== "director" && !inDirectorate(u));

    const departments = groupBy(others, "department")
        .sort((a, b) => b.members.length - a.members.length);

    const sectionHTML = section => {
        const heads = section.members.filter(u => u.orgTitle === "section_head").sort(byName);
        const staff = section.members.filter(u => u.orgTitle !== "section_head").sort(byName);

        return `
            <div class="org-section">
                <h5>${esc(section.name)} <span class="org-count">${section.members.length}</span></h5>
                ${heads.map(u => orgPersonHTML(u, "section-head")).join("")}
                ${staff.length ? `<div class="org-staff">${staff.map(u => orgPersonHTML(u)).join("")}</div>` : ""}
            </div>`;
    };

    const departmentHTML = dept => {
        const heads = dept.members.filter(u => u.orgTitle === "department_head").sort(byName);
        const rest = dept.members.filter(u => u.orgTitle !== "department_head");
        const sections = groupBy(rest.filter(u => u.section), "section");
        const direct = rest.filter(u => !u.section);

        return `
            <section class="org-dept ${dept.members.length > 10 && sections.length ? "wide" : ""}">
                <h4>${esc(dept.name || "بدون قسم")} <span class="org-count">${dept.members.length}</span></h4>
                ${heads.map(u => orgPersonHTML(u, "dept-head")).join("") ||
                    `<p class="org-vacant">رئيس القسم: لم يُحدد</p>`}
                <div class="org-dept-body">
                    ${sections.map(sectionHTML).join("")}
                    ${direct.length ? sectionHTML({ name: "موظفو القسم", members: direct }) : ""}
                </div>
            </section>`;
    };

    const offices = groupBy(officeStaff.filter(u => u.section), "section");
    const officeDirect = officeStaff.filter(u => !u.section);

    $("orgChart").innerHTML = `
        <div class="org-top">
            ${directors.map(u => orgPersonHTML(u, "director")).join("") ||
                `<div class="org-person director vacant"><b>مدير الإدارة</b><small>لم يُحدد</small></div>`}
        </div>
        ${officeStaff.length ? `
            <div class="org-line"></div>
            <div class="org-offices">
                ${offices.map(sectionHTML).join("")}
                ${officeDirect.length ? sectionHTML({ name: "مكتب مدير الإدارة", members: officeDirect }) : ""}
            </div>` : ""}
        <div class="org-line"></div>
        <div class="org-grid">
            ${departments.map(departmentHTML).join("")}
        </div>`;
}

// المدير: الضغط على اسم في الهيكل يفتح تعديل بياناته
$("orgChart").addEventListener("click", event => {

    const id = event.target.closest("[data-org-user]")?.dataset.orgUser;
    const user = isAdmin() && users.find(u => u.id === id);

    if (!user) {
        return;
    }

    showPage("usersPage");
    editUserForm(user);
    $("userForm").scrollIntoView({ behavior: "smooth" });
});

// ================= القسم والشعبة والمنصب =================

function normalizeSpaces(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

// المنصب المختار، وإلا يُؤخذ من الدور الوظيفي
function orgTitleOf(user) {
    if (user.orgTitle) return user.orgTitle;
    if (user.role === "director") return "director";
    if (user.role === "department_head") return "department_head";
    return "employee";
}

// اقتراح أسماء الأقسام والشعب المكتوبة سابقاً حتى تُكتب بنفس الطريقة
function renderNameSuggestions() {
    const unique = list => [...new Set(list.map(normalizeSpaces).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "ar"));

    $("departmentNames").innerHTML = unique(users.map(u => u.department))
        .map(name => `<option value="${esc(name)}">`).join("");
    $("sectionNames").innerHTML = unique(users.map(u => u.section))
        .map(name => `<option value="${esc(name)}">`).join("");
}

// البطاقة تعرض الاسم بلغة العرض في الأعلى وباللغة الأخرى تحته
function tileNames(p) {
    const en = p.nameEn || p.name;
    return language === "en" ? [en, p.name] : [p.name, en];
}

function renderMyPlatforms() {

    $("myPlatformsTitle").textContent = language === "en" ? "My Platforms" : "منصاتي";
    $("adminToolsTitle").textContent = language === "en" ? "Administration" : "أدوات الإدارة";

    $("dashboardPlatforms").innerHTML = platforms.map(p => {
        const [title, subtitle] = tileNames(p);

        return `
            <button type="button" class="tile" data-platform="${esc(p.id)}" style="--tile-color:${esc(p.color || "#b08d57")}">
                <div class="tile-icon">${esc(p.icon || "🧩")}</div>
                <strong>${esc(title)}</strong>
                <span>${esc(subtitle)}</span>
            </button>
        `;
    }).join("") || `
        <p class="empty-message">
            لم تُخصص لك أي منصة بعد. تواصل مع مدير النظام.
        </p>
    `;

    // ملاحظاتي: لكل موظف مساحة خاصة به
    if (store.listMyNotes) {
        $("dashboardPlatforms").insertAdjacentHTML("beforeend", `
            <button type="button" class="tile" data-open-page="notesPage" style="--tile-color:#c9822b">
                <div class="tile-icon">📝</div>
                <strong>${language === "en" ? "My Notes" : "ملاحظاتي"}</strong>
                <span>${language === "en" ? "ملاحظاتي" : "My Notes"}</span>
            </button>`);
    }

    // الهيكل التنظيمي متاح للجميع
    if (orgDirectory.length) {
        $("dashboardPlatforms").insertAdjacentHTML("beforeend", `
            <button type="button" class="tile" data-open-page="orgPage" style="--tile-color:#2f7a55">
                <div class="tile-icon">🏛️</div>
                <strong>${language === "en" ? "Org Chart" : "الهيكل التنظيمي"}</strong>
                <span>${language === "en" ? "الهيكل التنظيمي" : "Org Chart"}</span>
            </button>`);
    }
}

$("dashboardPlatforms").addEventListener("click", event => {
    const page = event.target.closest("[data-open-page]")?.dataset.openPage;
    if (!page) return;
    showPage(page);
    if (page === "notesPage") loadMyNotes();
});

// ================= ملاحظاتي =================

async function loadMyNotes() {
    $("notesList").innerHTML = `<p class="empty-message">جاري التحميل...</p>`;
    try {
        myNotes = await store.listMyNotes(currentUser.id);
    } catch (err) {
        console.error(err);
        myNotes = [];
    }
    renderMyNotes();
}

function renderMyNotes() {
    const query = loginKey($("noteSearch").value);

    const shown = myNotes
        .filter(n => !query || loginKey(`${n.title} ${n.text}`).includes(query))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

    $("notesList").innerHTML = shown.map(n => `
        <div class="card note-card">
            ${n.title ? `<h4>${esc(n.title)}</h4>` : ""}
            <p class="note-text">${esc(n.text)}</p>
            <small class="note-date">آخر تحديث: ${esc(new Date(n.updatedAt).toLocaleString("ar-AE"))}</small>
            <div class="form-actions">
                <button type="button" class="secondary-btn small-btn" data-edit-note="${esc(n.id)}">تعديل</button>
                <button type="button" class="danger-btn" data-delete-note="${esc(n.id)}">حذف</button>
            </div>
        </div>
    `).join("") || `<p class="empty-message">${query ? "لا توجد ملاحظة مطابقة." : "لا توجد ملاحظات بعد. اكتب أول ملاحظة فوق."}</p>`;
}

$("noteSearch").addEventListener("input", renderMyNotes);

$("noteForm").addEventListener("submit", async event => {
    event.preventDefault();

    const text = $("noteText").value.trim();
    if (!text) return;

    const old = myNotes.find(n => n.id === $("noteId").value);
    const note = {
        id: old?.id || uid(),
        ownerId: currentUser.id,
        title: $("noteTitle").value.trim(),
        text,
        createdAt: old?.createdAt || now(),
        updatedAt: now()
    };

    $("noteSaveBtn").disabled = true;
    try {
        await store.saveMyNote(note);
        myNotes = [...myNotes.filter(n => n.id !== note.id), note];
        $("noteForm").reset();
        renderMyNotes();
    } catch (err) {
        alert(errorText(err));
    } finally {
        $("noteSaveBtn").disabled = false;
    }
});

$("noteForm").addEventListener("reset", () => {
    $("noteId").value = "";
    $("noteSaveBtn").textContent = "حفظ الملاحظة";
});

$("notesList").addEventListener("click", async event => {
    const editId = event.target.closest("[data-edit-note]")?.dataset.editNote;
    const deleteBtn = event.target.closest("[data-delete-note]");

    if (editId) {
        const note = myNotes.find(n => n.id === editId);
        $("noteId").value = note.id;
        $("noteTitle").value = note.title || "";
        $("noteText").value = note.text;
        $("noteSaveBtn").textContent = "حفظ التعديل";
        $("noteText").focus();
        $("noteForm").scrollIntoView({ behavior: "smooth" });
    }

    if (deleteBtn) {
        // تأكيد داخل الصفحة: الضغطة الثانية خلال 5 ثوانٍ تحذف
        if (deleteBtn.dataset.confirming !== "yes") {
            deleteBtn.dataset.confirming = "yes";
            deleteBtn.textContent = "اضغط مرة ثانية للتأكيد";
            setTimeout(() => {
                if (!deleteBtn.isConnected) return;
                deleteBtn.dataset.confirming = "";
                deleteBtn.textContent = "حذف";
            }, 5000);
            return;
        }

        const id = deleteBtn.dataset.deleteNote;
        try {
            await store.deleteMyNote(id);
            myNotes = myNotes.filter(n => n.id !== id);
            renderMyNotes();
        } catch (err) {
            deleteBtn.textContent = "تعذّر الحذف";
        }
    }
});

function renderPlatformsList() {

    $("platformsList").innerHTML = platforms.map(p => `
        <div class="card platform-card" style="--tile-color:${esc(p.color || "#b08d57")}">
            <h4>${esc(p.icon || "🧩")} ${esc(p.name)}</h4>
            <p class="department" dir="ltr" style="text-align:right">${esc(p.nameEn || "")}</p>
            <p class="department">${esc(p.department)}</p>
            <p class="url">${esc(p.url)}</p>
            <p class="department">
                عدد الموظفين: ${users.filter(u => (u.platforms || []).includes(p.id)).length}
            </p>
            <div class="form-actions">
                <button type="button" class="secondary-btn small-btn" data-edit-platform="${esc(p.id)}">
                    تعديل
                </button>
                <button type="button" class="danger-btn" data-delete-platform="${esc(p.id)}">
                    حذف
                </button>
            </div>
        </div>
    `).join("") || `<p class="empty-message">لا توجد منصات مسجلة.</p>`;
}

// لكل منصة مختارة يحدد المدير دور الموظف فيها (موظف أو رئيس)
function renderUserPlatformOptions(selected = [], roles = {}) {

    $("userPlatformPermissions").innerHTML = platforms.map(p => `
        <label class="check-label platform-option">
            <input
                type="checkbox"
                name="userPlatform"
                value="${esc(p.id)}"
                ${selected.includes(p.id) ? "checked" : ""}
            >
            ${esc(p.name)}
            <select class="platform-role ${selected.includes(p.id) ? "" : "hidden"}" data-platform-role="${esc(p.id)}">
                <option value="employee" ${roles[p.id] !== "head" ? "selected" : ""}>موظف</option>
                <option value="head" ${roles[p.id] === "head" ? "selected" : ""}>رئيس</option>
            </select>
        </label>
    `).join("") || `<p class="empty-message">أضف المنصات أولاً.</p>`;
}

$("userPlatformPermissions").addEventListener("change", event => {
    const box = event.target.closest("[name=userPlatform]");
    if (!box) return;
    box.closest("label").querySelector(".platform-role")
        .classList.toggle("hidden", !box.checked);
});

// ترتيب المستخدمين حسب القسم ثم الشعبة، والرؤساء أولاً، مع البحث
const ORG_ORDER = { director: 0, department_head: 1, section_head: 2, employee: 3 };

function renderUsers() {

    const query = loginKey($("userSearch").value);
    const byName = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), "ar");

    const shown = users
        .filter(u => !query || loginKey(
            [u.fullName, u.username, u.department, u.section].join(" ")
        ).includes(query))
        .sort((a, b) =>
            // من بدون قسم في الآخر
            Number(!normalizeSpaces(a.department)) - Number(!normalizeSpaces(b.department)) ||
            byName(normalizeSpaces(a.department), normalizeSpaces(b.department)) ||
            byName(normalizeSpaces(a.section), normalizeSpaces(b.section)) ||
            ORG_ORDER[orgTitleOf(a)] - ORG_ORDER[orgTitleOf(b)] ||
            byName(a.fullName, b.fullName));

    // عنوان لكل قسم مع عدد موظفيه
    let lastDepartment = null;

    $("usersList").innerHTML = shown.map(u => {
        const department = normalizeSpaces(u.department) || "بدون قسم";
        const header = loginKey(department) !== lastDepartment
            ? `<tr class="group-row"><td colspan="6">${esc(department)}
                <span class="badge">${shown.filter(x =>
                    loginKey(normalizeSpaces(x.department) || "بدون قسم") === loginKey(department)).length}</span></td></tr>`
            : "";
        lastDepartment = loginKey(department);

        return header + `
        <tr>
            <td>${esc(u.fullName)}</td>
            <td>${esc(u.username)}</td>
            <td>${esc(u.department)}${u.section ? `<br><small>${esc(u.section)}</small>` : ""}</td>
            <td>${esc(ROLE_LABELS[u.role] || u.role)}</td>
            <td>
                ${u.role === "super_admin"
                    ? `<span class="badge">جميع المنصات</span>`
                    : (u.platforms || [])
                        .map(platformName)
                        .filter(Boolean)
                        .map(name => `<span class="badge">${esc(name)}</span>`)
                        .join("") || "—"}
            </td>
            <td>
                <div class="form-actions">
                    <button type="button" class="secondary-btn small-btn" data-edit-user="${esc(u.id)}">
                        تعديل
                    </button>
                    ${u.id === currentUser.id ? "" : `
                        <button type="button" class="danger-btn" data-delete-user="${esc(u.id)}">
                            حذف
                        </button>
                    `}
                </div>
            </td>
        </tr>`;
    }).join("") || `<tr><td colspan="6">لا يوجد موظف مطابق للبحث.</td></tr>`;
}

$("userSearch").addEventListener("input", renderUsers);

function renderAudit() {

    $("auditTableBody").innerHTML = auditLog.map(entry => `
        <tr>
            <td>${esc(new Date(entry.at).toLocaleString("ar-AE"))}</td>
            <td>${esc(entry.byName)}</td>
            <td>${esc(entry.platform || "—")}</td>
            <td>${esc(entry.action)}</td>
            <td>${esc(entry.details)}</td>
        </tr>
    `).join("") || `
        <tr><td colspan="5">لا توجد عمليات مسجلة.</td></tr>
    `;
}

// ================= فتح المنصة =================

function openPlatform(id) {

    const platform = platforms.find(p => p.id === id);

    if (!platform) {
        return;
    }

    $("viewerTitle").textContent = platform.name;
    $("viewerNewTab").href = platform.url;
    $("platformFrame").src = platform.url;

    showPage("platformViewerPage");

    logAction("فتح المنصة", "", platform.name);
}

document.addEventListener("click", event => {

    const button = event.target.closest("[data-platform]");

    if (button) {
        openPlatform(button.dataset.platform);
    }

});

// ================= حسابي واللغة =================

$("profileBtn").addEventListener("click", event => {

    event.stopPropagation();
    $("profileMenu").classList.toggle("hidden");

});

document.addEventListener("click", event => {

    if (!event.target.closest("#profileMenu")) {
        $("profileMenu").classList.add("hidden");
    }

});

$("languageBtn").addEventListener("click", () => {

    language = language === "ar" ? "en" : "ar";

    try {
        localStorage.setItem("dhaid_portal_language", language);
    } catch {}

    renderMyPlatforms();

});

// ================= العودة للرئيسية =================

$("backToDashboard")?.addEventListener("click", () => {

    showPage("dashboardPage");

});

// ================= إدارة المنصات =================

$("platformForm").addEventListener("submit", async event => {

    event.preventDefault();

    const id = $("platformId").value;
    const old = platforms.find(p => p.id === id);

    const platform = {
        id: id || uid(),
        name: $("platformName").value.trim(),
        nameEn: $("platformNameEn").value.trim(),
        url: $("platformUrl").value.trim(),
        department: $("platformDepartment").value.trim(),
        icon: $("platformIcon").value,
        color: $("platformColor").value,
        createdAt: old?.createdAt || now()
    };

    try {
        await store.savePlatform(platform);
        await logAction(old ? "تعديل منصة" : "إضافة منصة", platform.url, platform.name);

        $("platformForm").reset();
        await refresh();
    } catch (err) {
        alert(errorText(err));
    }

});

$("platformForm").addEventListener("reset", () => {

    $("platformId").value = "";

});

$("platformsList").addEventListener("click", async event => {

    const editId = event.target.closest("[data-edit-platform]")?.dataset.editPlatform;
    const deleteId = event.target.closest("[data-delete-platform]")?.dataset.deletePlatform;

    if (editId) {
        const platform = platforms.find(p => p.id === editId);

        $("platformId").value = platform.id;
        $("platformName").value = platform.name;
        $("platformNameEn").value = platform.nameEn || "";
        $("platformUrl").value = platform.url;
        $("platformDepartment").value = platform.department;
        $("platformIcon").value = platform.icon || "📋";
        $("platformColor").value = platform.color || "#b08d57";
        $("platformName").focus();
    }

    if (deleteId) {
        const platform = platforms.find(p => p.id === deleteId);

        if (!confirm(`حذف منصة "${platform.name}"؟ ستُزال من جميع الموظفين.`)) {
            return;
        }

        try {
            await store.deletePlatform(deleteId);
            await logAction("حذف منصة", "", platform.name);
            await refresh();
        } catch (err) {
            alert(errorText(err));
        }
    }

});

// ================= إدارة المستخدمين =================

function resetUserForm() {

    $("userId").value = "";
    $("userPassword").required = true;
    $("userPasswordHint").textContent = "6 أحرف على الأقل.";

    renderUserPlatformOptions();
}

$("userForm").addEventListener("submit", async event => {

    event.preventDefault();

    const id = $("userId").value;
    const old = users.find(u => u.id === id);
    const password = $("userPassword").value;

    if ((!old || password) && password.length < 6) {
        alert("كلمة المرور يجب أن تكون 6 أحرف على الأقل.");
        return;
    }

    if (old && old.role === "super_admin" && $("userRole").value !== "super_admin" &&
        users.filter(u => u.role === "super_admin").length === 1) {
        alert("يجب أن يبقى مدير نظام رئيسي واحد على الأقل.");
        return;
    }

    const user = {
        ...(old || {}),
        id: id || uid(),
        fullName: $("userFullName").value.trim(),
        username: $("userUsername").value.trim(),
        department: normalizeSpaces($("userDepartment").value),
        section: normalizeSpaces($("userSection").value),
        orgTitle: $("userOrgTitle").value,
        role: $("userRole").value,
        platforms: [...document.querySelectorAll("[name=userPlatform]:checked")]
            .map(input => input.value),
        platformRoles: Object.fromEntries(
            [...document.querySelectorAll("[name=userPlatform]:checked")].map(input => [
                input.value,
                input.closest("label").querySelector(".platform-role").value
            ])
        ),
        canApprove: $("permissionApprove").checked,
        canReject: $("permissionReject").checked,
        createdAt: old?.createdAt || now()
    };

    try {
        await store.saveUser(user, password);

        await logAction(
            old ? (password ? "تعديل مستخدم وتغيير كلمة المرور" : "تعديل مستخدم") : "إضافة مستخدم",
            `${user.fullName} — ${user.platforms.map(platformName).join("، ") || "بدون منصات"}`
        );

        $("userForm").reset();
        await refresh();
    } catch (err) {
        alert(errorText(err));
    }

});

$("userForm").addEventListener("reset", () => {

    setTimeout(resetUserForm);

});

function editUserForm(user) {

    if (!user) {
        return;
    }

    $("userId").value = user.id;
    $("userFullName").value = user.fullName;
    $("userUsername").value = user.username;
    $("userDepartment").value = user.department;
    $("userSection").value = user.section || "";
    $("userOrgTitle").value = user.orgTitle || "";
    $("userRole").value = user.role;
    $("userPassword").value = "";
    $("userPassword").required = false;
    $("userPasswordHint").textContent =
        "اتركها فارغة للإبقاء على كلمة المرور الحالية، أو اكتب كلمة مرور جديدة (6 أحرف على الأقل).";
    $("permissionApprove").checked = Boolean(user.canApprove);
    $("permissionReject").checked = Boolean(user.canReject);

    renderUserPlatformOptions(user.platforms || [], user.platformRoles || {});

    $("userFullName").focus();
}

$("usersList").addEventListener("click", async event => {

    const editId = event.target.closest("[data-edit-user]")?.dataset.editUser;
    const deleteId = event.target.closest("[data-delete-user]")?.dataset.deleteUser;

    if (editId) {
        editUserForm(users.find(u => u.id === editId));
    }

    if (deleteId) {
        const user = users.find(u => u.id === deleteId);

        if (!confirm(`حذف حساب "${user.fullName}"؟`)) {
            return;
        }

        try {
            await store.deleteUser(user);
            await logAction("حذف مستخدم", user.fullName);
            await refresh();
        } catch (err) {
            alert(errorText(err));
        }
    }

});

// ================= إعداد النظام لأول مرة =================

$("setupForm").addEventListener("submit", async event => {

    event.preventDefault();

    const password = $("setupPassword").value;
    const button = event.target.querySelector("button");

    $("setupError").textContent = "";

    if (password.length < 6) {
        $("setupError").textContent = "كلمة المرور يجب أن تكون 6 أحرف على الأقل.";
        return;
    }

    if (password !== $("setupConfirm").value) {
        $("setupError").textContent = "كلمتا المرور غير متطابقتين.";
        return;
    }

    const admin = {
        id: uid(),
        fullName: $("setupFullName").value.trim(),
        username: $("setupUsername").value.trim(),
        department: "",
        role: "super_admin",
        platforms: [],
        canApprove: true,
        canReject: true,
        createdAt: now()
    };

    button.disabled = true;

    try {
        await enterSystem(await store.setup(admin, password));
        await logAction("إعداد النظام", "إنشاء حساب مدير النظام وإضافة المنصات");
    } catch (err) {
        $("setupError").textContent = errorText(err);
    } finally {
        button.disabled = false;
    }

});

// ================= تسجيل الدخول =================

async function enterSystem(user) {

    currentUser = user;

    await refresh();

    resetUserForm();
    showScreen("systemMain");
    showPage("dashboardPage");
}

$("loginForm").addEventListener("submit", async event => {

    event.preventDefault();

    const button = event.target.querySelector("button");

    $("loginError").textContent = "";
    button.disabled = true;

    try {
        const user = await store.login(
            $("loginUsername").value,
            $("loginPassword").value
        );

        $("loginForm").reset();

        await enterSystem(user);
    } catch (err) {
        $("loginError").textContent = errorText(err);
    } finally {
        button.disabled = false;
    }

});

// ================= تسجيل الخروج =================

$("logoutBtn")?.addEventListener("click", async () => {

    await store.logout();

    currentUser = null;

    $("platformFrame").removeAttribute("src");
    $("loginForm").reset();

    showScreen("loginPage");

});

// ================= بداية التشغيل =================

async function start() {

    showScreen("loadingPage");

    if (!USE_FIREBASE) {
        document.querySelectorAll(".mode-note").forEach(note => {
            note.textContent =
                "نسخة تجريبية: الحسابات والمنصات محفوظة في هذا المتصفح فقط. " +
                "لربط النظام بقاعدة بيانات أضف إعدادات Firebase في ملف firebase-config.js.";
            note.classList.remove("hidden");
        });
    }

    try {
        if (USE_FIREBASE && typeof firebase === "undefined") {
            throw new Error("تعذّر تحميل Firebase. تأكد من الاتصال بالإنترنت.");
        }

        store = USE_FIREBASE ? createFirebaseStore() : localStore;

        if (!await store.isSetUp()) {
            showScreen("setupPage");
            return;
        }

        const user = await store.restore();

        if (user) {
            await enterSystem(user);
        } else {
            showScreen("loginPage");
        }
    } catch (err) {
        console.error(err);
        $("loadingText").textContent = errorText(err);
    }
}

start();
