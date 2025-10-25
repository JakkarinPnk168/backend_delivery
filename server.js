import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

dotenv.config();

// ===== Firebase Admin =====
if (!process.env.FIREBASE_KEY) {
  console.error("❌ Missing FIREBASE_KEY");
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ===== Cloudinary =====
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ===== App / Helpers =====
const app = express();
app.use(cors());
app.use(express.json());

const USERS = "users";
const RIDERS = 'riders';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const sanitize = (u) => {
  if (!u) return u;
  const { passwordHash, ...safe } = u;
  return safe;
};

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: "Missing token" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { userId: payload.userId, role: payload.role, phone: payload.phone };
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: "Invalid/expired token" });
  }
}

function uploadBufferToCloudinary(buf, folder) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder }, (err, result) => (err ? reject(err) : resolve(result)))
      .end(buf);
  });
}

app.get("/", (_req, res) => res.send("Delivery API ✅ Flutter → Node.js → Firebase"));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

/////////////////////////////////////////////////////////////เส้น
////Register 

// ✅ ตรวจสอบเบอร์โทรว่ามีในระบบหรือยัง
app.get("/api/auth/check-phone/:phone", async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) {
      return res.status(400).json({ success: false, message: "phone required" });
    }

    const inUser = await findPhoneInCollection(USERS, phone);
    const inRider = await findPhoneInCollection(RIDERS, phone);

    // ✅ ตอบกลับตามสถานะ
    if (!inUser && !inRider) {
      return res.json({
        success: true,
        status: "available",
        message: "เบอร์นี้ยังไม่ถูกใช้งาน สามารถสมัครได้",
      });
    } else if (inUser && !inRider) {
      return res.json({
        success: true,
        status: "user-exists",
        message: "เบอร์นี้มีในบัญชีผู้ใช้แล้ว (สมัคร Rider เพิ่มได้)",
      });
    } else if (!inUser && inRider) {
      return res.json({
        success: true,
        status: "rider-exists",
        message: "เบอร์นี้มีในบัญชี Rider แล้ว (ห้ามสมัครซ้ำ)",
      });
    } else {
      return res.json({
        success: true,
        status: "both-exist",
        message: "เบอร์นี้มีทั้งในบัญชีผู้ใช้และ Rider แล้ว",
      });
    }
  } catch (err) {
    console.error("❌ check-phone:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
});


// ✅ ฟังก์ชันตรวจเบอร์ในคอลเลกชัน
async function findPhoneInCollection(collection, phone) {
  const snap = await db.collection(collection)
    .where("phone", "==", phone)
    .limit(1)
    .get();
  return !snap.empty;
}

// ✅ สมัครผู้ใช้ (User)
app.post("/api/auth/register-user", upload.single("profileImage"), async (req, res) => {
  try {
    const { phone, password, name } = req.body || {};
    if (!phone || !password)
      return res.status(400).json({ success: false, message: "phone & password required" });

    // ✅ เช็กซ้ำเฉพาะใน users
    const dupUser = await findPhoneInCollection(USERS, phone);
    if (dupUser)
      return res.status(409).json({ success: false, message: "เบอร์นี้ถูกใช้งานในบัญชีผู้ใช้แล้ว" });

    // ✅ อัปโหลดรูป (ถ้ามี)
    let profileImage = "", imagePublicId = "";
    if (req.file?.buffer) {
      try {
        const up = await uploadBufferToCloudinary(req.file.buffer, "delivery/profile");
        profileImage = up.secure_url;
        imagePublicId = up.public_id;
      } catch (err) {
        console.warn("⚠️ อัปโหลดรูปไม่สำเร็จ:", err.message);
      }
    }

    const ref = db.collection(USERS).doc();
    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      userId: ref.id,
      role: "user",
      phone,
      name: name || "",
      wallet: 0,
      profileImage,
      imagePublicId,
      createdAt: new Date(),
      updatedAt: new Date(),
      passwordHash,
    };

    await ref.set(user);
    res.json({ success: true, message: "registered-user", data: { userId: ref.id } });
  } catch (err) {
    console.error("❌ register-user:", err);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});


// ✅ สมัคร Rider
app.post(
  "/api/auth/register-rider",
  upload.fields([
    { name: "profileImage", maxCount: 1 },
    { name: "vehicleImage", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { phone, password, name, vehiclePlate } = req.body || {};
      if (!phone || !password)
        return res.status(400).json({ success: false, message: "phone & password required" });

      // ✅ อนุญาตเบอร์ใน users ได้ แต่ห้ามซ้ำใน riders
      const dupRider = await findPhoneInCollection(RIDERS, phone);
      if (dupRider)
        return res.status(409).json({ success: false, message: "เบอร์นี้ถูกใช้งานในบัญชี Rider แล้ว" });

      let profileImage = "", imagePublicId = "";
      let vehicleImage = "", vehicleImagePublicId = "";

      // ✅ อัปโหลดรูปโปรไฟล์
      const profileBuf = req.files?.profileImage?.[0]?.buffer;
      if (profileBuf) {
        try {
          const up = await uploadBufferToCloudinary(profileBuf, "delivery/profile");
          profileImage = up.secure_url;
          imagePublicId = up.public_id;
        } catch (err) {
          console.warn("⚠️ อัปโหลดรูปโปรไฟล์ไม่สำเร็จ:", err.message);
        }
      }

      // ✅ อัปโหลดรูปรถ
      const vehicleBuf = req.files?.vehicleImage?.[0]?.buffer;
      if (vehicleBuf) {
        try {
          const up = await uploadBufferToCloudinary(vehicleBuf, "delivery/vehicle");
          vehicleImage = up.secure_url;
          vehicleImagePublicId = up.public_id;
        } catch (err) {
          console.warn("⚠️ อัปโหลดรูปรถไม่สำเร็จ:", err.message);
        }
      }

      const ref = db.collection(RIDERS).doc();
      const passwordHash = await bcrypt.hash(password, 10);
      const rider = {
        userId: ref.id,
        role: "rider",
        phone,
        name: name || "",
        wallet: 0,
        profileImage,
        imagePublicId,
        vehiclePlate: vehiclePlate || "",
        vehicleImage,
        vehicleImagePublicId,
        createdAt: new Date(),
        updatedAt: new Date(),
        passwordHash,
      };

      await ref.set(rider);
      res.json({ success: true, message: "registered-rider", data: { userId: ref.id } });
    } catch (err) {
      console.error("❌ register-rider:", err);
      res.status(500).json({ success: false, message: err.message || "Server error" });
    }
  }
);




// ===== Login =====
app.post("/api/auth/login", async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password)
      return res.status(400).json({ success: false, message: "phone & password required" });

    // ✅ ค้นหาใน users และ riders พร้อมกัน
    const userSnap = await db.collection(USERS).where("phone", "==", phone).limit(1).get();
    const riderSnap = await db.collection(RIDERS).where("phone", "==", phone).limit(1).get();

    let foundDoc = null;
    let foundRole = null;

    if (!userSnap.empty && !riderSnap.empty) {
      const user = userSnap.docs[0].data();
      const rider = riderSnap.docs[0].data();

      const okUser = await bcrypt.compare(password, user.passwordHash || "");
      const okRider = await bcrypt.compare(password, rider.passwordHash || "");

      if (okUser) {
        foundDoc = userSnap.docs[0];
        foundRole = "user";
      } else if (okRider) {
        foundDoc = riderSnap.docs[0];
        foundRole = "rider";
      } else {
        return res.status(401).json({ success: false, message: "รหัสผ่านไม่ถูกต้อง" });
      }
    } else if (!userSnap.empty) {
      foundDoc = userSnap.docs[0];
      foundRole = "user";
    } else if (!riderSnap.empty) {
      foundDoc = riderSnap.docs[0];
      foundRole = "rider";
    }

    if (!foundDoc)
      return res.status(401).json({ success: false, message: "ไม่พบเบอร์โทรนี้ในระบบ" });

    const data = foundDoc.data();
    const token = jwt.sign(
      { userId: data.userId, role: foundRole, phone: data.phone },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "7d" }
    );

    const { passwordHash, ...safe } = data;
    res.json({ success: true, message: "logged-in", data: { token, user: safe } });
  } catch (err) {
    console.error("❌ login error:", err);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});

// ===== ดึงข้อมูลโปรไฟล์ตัวเอง =====
app.get("/api/users/me", authRequired, async (req, res) => {
  try {
    const col = req.user.role === "rider" ? RIDERS : USERS;  // ✅ ดูจาก role ใน JWT
    const doc = await db.collection(col).doc(req.user.userId).get();
    if (!doc.exists) return res.status(404).json({ success: false, message: "User not found" });

    const data = doc.data();
    const { passwordHash, ...safe } = data;
    return res.json({ success: true, data: safe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});


// ===== Update Profile (me) - รองรับแก้ชื่อ + เบอร์โทร + รูปโปรไฟล์ + (rider) vehicle =====
app.put(
  "/api/users/me",
  authRequired,
  upload.fields([
    { name: "profileImage", maxCount: 1 },
    { name: "vehicleImage", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { name, phone, vehiclePlate } = req.body || {};
      const ref = db.collection(USERS).doc(req.user.userId);
      const snap = await ref.get();
      if (!snap.exists)
        return res
          .status(404)
          .json({ success: false, message: "User not found" });

      // ✅ ประกาศ updates ก่อนใช้งาน
      const updates = { updatedAt: new Date() };

      // ✅ อัปเดตชื่อ
      if (typeof name === "string" && name.trim() !== "")
        updates.name = name.trim();

      // ✅ อัปเดตเบอร์โทร
      if (typeof phone === "string" && phone.trim() !== "")
        updates.phone = phone.trim();

      const old = snap.data();

      // ✅ อัปโหลดรูปโปรไฟล์
      const profileBuf = req.files?.profileImage?.[0]?.buffer;
      if (profileBuf) {
        if (old?.imagePublicId) {
          try {
            await cloudinary.uploader.destroy(old.imagePublicId);
          } catch (err) {
            console.warn("⚠️ ลบรูปเก่าไม่สำเร็จ:", err.message);
          }
        }

        const up = await uploadBufferToCloudinary(
          profileBuf,
          "delivery/profile"
        );
        updates.profileImage = up.secure_url;
        updates.imagePublicId = up.public_id;
      }

      // ✅ เฉพาะ Rider: ข้อมูลรถ
      if (req.user.role === "rider") {
        if (typeof vehiclePlate === "string" && vehiclePlate.trim() !== "")
          updates.vehiclePlate = vehiclePlate.trim();

        const vehicleBuf = req.files?.vehicleImage?.[0]?.buffer;
        if (vehicleBuf) {
          if (old?.vehicleImagePublicId) {
            try {
              await cloudinary.uploader.destroy(old.vehicleImagePublicId);
            } catch (err) {
              console.warn("⚠️ ลบรูปเก่ารถไม่สำเร็จ:", err.message);
            }
          }
          const up = await uploadBufferToCloudinary(
            vehicleBuf,
            "delivery/vehicle"
          );
          updates.vehicleImage = up.secure_url;
          updates.vehicleImagePublicId = up.public_id;
        }
      }

      console.log("🔥 updates =", updates);

      // ✅ ใช้ set merge เพื่อแน่ใจว่าสร้าง field ใหม่ได้ด้วย
      await ref.set(updates, { merge: true });

      console.log("✅ Firestore updated");

      const after = (await ref.get()).data();
      console.log("📄 After update:", after);

      return res.json({
        success: true,
        message: "updated",
        data: after, // ✅ ส่งข้อมูลใหม่กลับ
      });
    } catch (err) {
      console.error("❌ PUT /api/users/me:", err);
      res
        .status(500)
        .json({ success: false, message: err.message || "Server error" });
    }
  }
);



//////////////////////////////////////ที่อยู่
////แสดงที่อยู่
// ===============================
// 📍 ดึงรายการที่อยู่ทั้งหมดของผู้ใช้
// ===============================
app.get("/api/users/me/addresses", authRequired, async (req, res) => {
  try {
    const userId = req.user.userId;
    const snapshot = await db
      .collection("addresses")
      .where("user_id", "==", userId)
      .get();

    const list = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ success: true, data: list });
  } catch (err) {
    console.error("❌ GET /api/users/me/addresses:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
});

// ✅ ดึงข้อมูลที่อยู่ตาม ID
app.get("/api/users/me/addresses/:id", authRequired, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const ref = db.collection("addresses").doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, message: "ไม่พบที่อยู่นี้" });
    }

    const data = doc.data();

    // ✅ ตรวจสิทธิ์ก่อนเข้าถึง
    if (data.user_id !== userId) {
      return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์เข้าถึงที่อยู่นี้" });
    }

    // ✅ เพิ่ม id / address_id ลงไปให้ Flutter อ่านได้ครบ
    const result = {
      id: doc.id,
      address_id: data.address_id || doc.id,
      user_id: data.user_id,
      label: data.label || "",
      recipientName: data.recipientName || "",
      phone: data.phone || "",
      address_detail: data.address_detail || "",
      subDistrict: data.subDistrict || "",
      district: data.district || "",
      province: data.province || "",
      postalCode: data.postalCode || "",
      gps_latitude: data.gps_latitude || 0,
      gps_longitude: data.gps_longitude || 0,
      isDefault: data.isDefault || false,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };

    res.json({ success: true, data: result });
  } catch (err) {
    console.error("❌ GET /api/users/me/addresses/:id:", err);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});

app.get("/api/users/all", async (req, res) => {
  try {
    const [userSnap, riderSnap] = await Promise.all([
      db.collection("users").get(),
      db.collection("riders").get(),
    ]);

    const users = [
      ...userSnap.docs.map((d) => ({
        id: d.id,
        role: "user",
        name: d.data().name || "ไม่ระบุชื่อ",
        phone: d.data().phone || "-",
        profileImage: d.data().profileImage || "",
      })),
      ...riderSnap.docs.map((d) => ({
        id: d.id,
        role: "rider",
        name: d.data().name || "ไม่ระบุชื่อ",
        phone: d.data().phone || "-",
        profileImage: d.data().profileImage || "",
      })),
    ];

    res.json({ success: true, data: users });
  } catch (err) {
    console.error("🔥 Error /api/users/all:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
});


// ===============================
// 🏠 เพิ่มที่อยู่ใหม่
// ===============================
app.post("/api/users/me/addresses", authRequired, async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      label,
      recipientName,
      phone,
      address_detail,
      subDistrict,
      district,
      province,
      postalCode,
      gps_latitude,
      gps_longitude,
      isDefault,
    } = req.body;

    const docRef = db.collection("addresses").doc();

    const payload = {
      address_id: docRef.id,
      user_id: userId,
      label: label || "Manual Address",
      recipientName: recipientName || "",
      phone: phone || "",
      address_detail: address_detail || "ไม่ระบุที่อยู่",
      subDistrict: subDistrict || "",
      district: district || "",
      province: province || "",
      postalCode: postalCode || "",
      gps_latitude: Number(gps_latitude) || 0,
      gps_longitude: Number(gps_longitude) || 0,
      isDefault: !!isDefault,
      created_at: new Date(),
      updated_at: new Date(),
    };

    // ✅ หากตั้งค่า default ให้ที่อยู่อื่น false
    if (payload.isDefault) {
      const oldDefaults = await db
        .collection("addresses")
        .where("user_id", "==", userId)
        .where("isDefault", "==", true)
        .get();

      for (const doc of oldDefaults.docs) {
        await doc.ref.update({ isDefault: false });
      }
    }

    await docRef.set(payload);
    res.status(201).json({ success: true, data: { id: docRef.id, ...payload } });
  } catch (err) {
    console.error("❌ POST /api/users/me/addresses:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
});

// ===============================
// ✏️ แก้ไขข้อมูลที่อยู่
// ===============================
app.put("/api/users/me/addresses/:id", authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const ref = db.collection("addresses").doc(id);
    const snap = await ref.get();

    if (!snap.exists)
      return res.status(404).json({ success: false, message: "ไม่พบที่อยู่" });

    const oldData = snap.data();

    if (oldData.user_id !== userId) {
      return res.status(403).json({
        success: false,
        message: "คุณไม่มีสิทธิ์แก้ไขที่อยู่นี้",
      });
    }

    const {
      label,
      recipientName,
      phone,
      address_detail,
      subDistrict,
      district,
      province,
      postalCode,
      gps_latitude,
      gps_longitude,
      isDefault,
    } = req.body;

    const updates = { updated_at: new Date() };

    if (label !== undefined) updates.label = label;
    if (recipientName !== undefined) updates.recipientName = recipientName;
    if (phone !== undefined) updates.phone = phone;
    if (address_detail !== undefined) updates.address_detail = address_detail;
    if (subDistrict !== undefined) updates.subDistrict = subDistrict;
    if (district !== undefined) updates.district = district;
    if (province !== undefined) updates.province = province;
    if (postalCode !== undefined) updates.postalCode = postalCode;
    if (gps_latitude !== undefined)
      updates.gps_latitude = Number(gps_latitude);
    if (gps_longitude !== undefined)
      updates.gps_longitude = Number(gps_longitude);
    if (isDefault !== undefined) updates.isDefault = !!isDefault;

    // ✅ ถ้ามีที่อยู่ default ใหม่ ต้องยกเลิกของเก่า
    if (updates.isDefault) {
      const oldDefaults = await db
        .collection("addresses")
        .where("user_id", "==", userId)
        .where("isDefault", "==", true)
        .get();

      for (const doc of oldDefaults.docs) {
        if (doc.id !== id) await doc.ref.update({ isDefault: false });
      }
    }

    await ref.update(updates);
    const after = (await ref.get()).data();

    res.json({ success: true, data: { id, ...after } });
  } catch (err) {
    console.error("❌ PUT /api/users/me/addresses/:id:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
});


// ===============================
// 🗑️ ลบที่อยู่
// ===============================
app.delete("/api/users/me/addresses/:id", authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const ref = db.collection("addresses").doc(id);
    const snap = await ref.get();

    if (!snap.exists)
      return res.status(404).json({ success: false, message: "ไม่พบที่อยู่" });

    const data = snap.data();

    // ✅ ตรวจสิทธิ์ก่อนลบ
    if (data.user_id !== userId) {
      return res
        .status(403)
        .json({ success: false, message: "คุณไม่มีสิทธิ์ลบที่อยู่นี้" });
    }

    await ref.delete();
    res.json({ success: true, message: "ลบที่อยู่สำเร็จ" });
  } catch (err) {
    console.error("❌ DELETE /api/users/me/addresses/:id:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
});

/////////////////////////ส่งพัสดุ
////เพิ่ม
app.post(
  "/api/parcels",
  upload.fields([
    { name: "images", maxCount: 10 },
    { name: "proofImage", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      let { senderId, receiverId, receiverAddress, items } = req.body;
      console.log("📦 รับพัสดุใหม่จาก senderId:", senderId, "ให้ receiverId:", receiverId);

      // ✅ ตรวจสอบค่าที่จำเป็น
      if (!senderId || !receiverId || !items) {
        return res.status(400).json({
          success: false,
          message: "กรุณากรอก senderId, receiverId และ items ให้ครบ",
        });
      }

      // ✅ แปลง items เป็น array ถ้ายังเป็น string
      if (typeof items === "string") {
        try {
          items = JSON.parse(items);
        } catch (e) {
          console.warn("⚠️ items parse failed:", e);
          return res.status(400).json({
            success: false,
            message: "รูปแบบ items ไม่ถูกต้อง (ต้องเป็น JSON array)",
          });
        }
      }

      // ✅ แปลง receiverAddress เป็น object ถ้าเป็น string
      if (typeof receiverAddress === "string") {
        try {
          receiverAddress = JSON.parse(receiverAddress);
        } catch (e) {
          console.warn("⚠️ receiverAddress parse failed:", e);
          receiverAddress = {};
        }
      }

      // ✅ Normalize address
      const normalizedAddress = {
        label:
          receiverAddress.label ||
          receiverAddress.address_label ||
          "ที่อยู่จากระบบหรือพิกัดแผนที่",
        address:
          receiverAddress.address_detail ||
          receiverAddress.address ||
          "เลือกจากแผนที่",
        lat:
          Number(receiverAddress.gps_latitude) ||
          Number(receiverAddress.lat) ||
          0,
        lng:
          Number(receiverAddress.gps_longitude) ||
          Number(receiverAddress.lng) ||
          0,
      };

      if (!normalizedAddress.lat || !normalizedAddress.lng) {
        console.warn("⚠️ Missing lat/lng in receiverAddress");
      }

      // ✅ อัปโหลดรูปสินค้า
      const imageUrls = [];
      if (req.files && req.files["images"] && req.files["images"].length > 0) {
        console.log(`🖼️ อัปโหลดรูปสินค้า ${req.files["images"].length} ไฟล์`);
        for (const file of req.files["images"]) {
          const up = await uploadBufferToCloudinary(file.buffer, "delivery/parcels");
          imageUrls.push(up.secure_url);
        }
      }

      // ✅ อัปโหลดรูปหลักฐาน (proofImage)
      let proofImageUrl = "";
      if (req.files && req.files["proofImage"] && req.files["proofImage"].length > 0) {
        const proof = req.files["proofImage"][0];
        const upProof = await uploadBufferToCloudinary(proof.buffer, "delivery/proof");
        proofImageUrl = upProof.secure_url;
        console.log("📸 อัปโหลดรูปหลักฐานสำเร็จ:", proofImageUrl);
      } else {
        console.warn("⚠️ ไม่มีรูปหลักฐานแนบมาจาก Flutter");
      }

      // ✅ รวม items กับรูปภาพ
      const enrichedItems = items.map((item, i) => ({
        ...item,
        productName: item.productName || "ไม่ระบุชื่อสินค้า",
        imageUrl: imageUrls[i] || null,
      }));

      // ✅ เตรียมข้อมูล order
      const newDoc = db.collection("orders").doc();
      const orderData = {
        orderId: newDoc.id,
        senderId,
        receiverId,
        address: normalizedAddress,
        items: enrichedItems,
        itemsCount: enrichedItems.length,
        proofImage: proofImageUrl || null,
        status: 1, // 1 = รอไรเดอร์รับสินค้า
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // ✅ บันทึกลง Firestore
      await newDoc.set(orderData);
      console.log(`✅ สร้างออเดอร์สำเร็จ senderId=${senderId}, items=${enrichedItems.length}`);

      // ✅ ส่งกลับ Flutter
      res.json({
        success: true,
        message: "✅ เพิ่มพัสดุสำเร็จ!",
        data: {
          orderId: newDoc.id,
          itemsCount: enrichedItems.length,
          proofImageUrl,
        },
      });
    } catch (err) {
      console.error("🔥 Error /api/parcels:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);




//////////////////////////////////////////////////////////
// 🔍 ค้นหาผู้ใช้ด้วยเบอร์โทร
//////////////////////////////////////////////////////////
app.get("/api/users/search", async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res
        .status(400)
        .json({ success: false, message: "กรุณากรอกเบอร์โทร" });
    }

    // ✅ ค้นทั้ง users และ riders
    const userSnap = await db
      .collection(USERS)
      .where("phone", "==", phone)
      .limit(1)
      .get();
    const riderSnap = await db
      .collection(RIDERS)
      .where("phone", "==", phone)
      .limit(1)
      .get();

    let foundDoc = null;
    let role = null;

    if (!userSnap.empty) {
      foundDoc = userSnap.docs[0];
      role = "user";
    } else if (!riderSnap.empty) {
      foundDoc = riderSnap.docs[0];
      role = "rider";
    }

    if (!foundDoc) {
      return res
        .status(404)
        .json({ success: false, message: "ไม่พบผู้ใช้หมายเลขนี้" });
    }

    const data = foundDoc.data();

    // ✅ ดึงรายการที่อยู่ทั้งหมดของผู้ใช้คนนั้น
    const addressSnap = await db
      .collection("addresses")
      .where("user_id", "==", data.userId)
      .get();

    const addresses = addressSnap.docs.map((d) => ({
      id: d.id,
      label: d.data().label || "",
      address_detail: d.data().address_detail || "",
      gps_latitude: d.data().gps_latitude || 0,
      gps_longitude: d.data().gps_longitude || 0,
      isDefault: d.data().isDefault || false,
    }));

    res.json({
      success: true,
      message: "พบผู้ใช้",
      data: {
        userId: data.userId,
        name: data.name,
        phone: data.phone,
        role,
        profileImage: data.profileImage || "",
        addresses,
      },
    });
  } catch (err) {
    console.error("🔥 Error /api/users/search:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
});

//////////////////////////////////////////////////////////
// 📸 อัปโหลดหลักฐานการส่งสินค้า
//////////////////////////////////////////////////////////
app.post("/api/orders/:id/proof", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file?.buffer) {
      return res
        .status(400)
        .json({ success: false, message: "กรุณาแนบรูปภาพ" });
    }

    // 📸 อัปโหลดรูปไป Cloudinary
    const up = await uploadBufferToCloudinary(
      req.file.buffer,
      "delivery/proof"
    );

    // ✅ อัปเดต Firestore
    const ref = db.collection("orders").doc(id);
    await ref.update({
      proofImageUrl: up.secure_url,
      updatedAt: new Date(),
    });

    res.json({
      success: true,
      message: "อัปโหลดรูปหลักฐานสำเร็จ",
      proofImageUrl: up.secure_url,
    });
  } catch (err) {
    console.error("🔥 Error /api/orders/:id/proof:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
});

//////////////////////////////////////////////////////////
// 📦 ดึงพัสดุของผู้ส่ง (Sender)
//////////////////////////////////////////////////////////
app.get("/api/parcels/sender/:senderId", async (req, res) => {
  try {
    const { senderId } = req.params;
    if (!senderId) {
      return res
        .status(400)
        .json({ success: false, message: "senderId จำเป็นต้องมี" });
    }

    console.log(`📦 ดึงข้อมูลพัสดุ senderId=${senderId}`);

    const snapshot = await db
      .collection("orders")
      .where("senderId", "==", senderId)
      .orderBy("createdAt", "desc")
      .get();

    if (snapshot.empty) {
      console.log("⚠️ ไม่พบพัสดุของ senderId:", senderId);
      return res.json({ success: true, data: [] });
    }

    const data = snapshot.docs.map((doc) => {
      const d = doc.data();

      // ✅ แปลง Timestamp → ISO string (หรือ milliseconds ก็ได้)
      const createdAt =
        d.createdAt && d.createdAt.toDate
          ? d.createdAt.toDate().toISOString()
          : d.createdAt || null;

      const updatedAt =
        d.updatedAt && d.updatedAt.toDate
          ? d.updatedAt.toDate().toISOString()
          : d.updatedAt || null;

      return {
        orderId: doc.id,
        senderId: d.senderId,
        receiverId: d.receiverId,
        address: d.address || null,
        itemsCount: d.itemsCount || (d.items ? d.items.length : 0),
        items: d.items || [],
        imageUrl:
          d.items?.[0]?.imageUrl || d.proofImageUrl || d.imageUrl || null,
        status: d.status || 0, // ❗เก็บเป็น int เพื่อ Flutter จัดการเอง
        createdAt,
        updatedAt,
      };
    });

    res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (err) {
    console.error("🔥 Error /api/parcels/sender:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
});


//////////////////////////////////////////////////////////
// 📦 ดึงพัสดุที่ตนเองเป็นผู้รับ (Receiver)
//////////////////////////////////////////////////////////
app.get("/api/parcels/receiver/:receiverId", async (req, res) => {
  try {
    const { receiverId } = req.params;
    if (!receiverId) {
      return res
        .status(400)
        .json({ success: false, message: "receiverId จำเป็นต้องมี" });
    }

    console.log(`📦 ดึงข้อมูลพัสดุ receiverId=${receiverId}`);

    const snapshot = await db
      .collection("orders")
      .where("receiverId", "==", receiverId)
      .orderBy("createdAt", "desc")
      .get();

    if (snapshot.empty) {
      console.log("⚠️ ไม่พบพัสดุของ receiverId:", receiverId);
      return res.json({ success: true, data: [] });
    }

    // ✅ แปลงข้อมูลให้อยู่ในโครงสร้างเดียวกับ sender
    const data = snapshot.docs.map((doc) => {
      const d = doc.data();

      // ✅ แปลง Timestamp เป็น ISO string (หรือ milliseconds ก็ได้)
      const createdAt =
        d.createdAt && d.createdAt.toDate
          ? d.createdAt.toDate().toISOString()
          : d.createdAt || null;

      const updatedAt =
        d.updatedAt && d.updatedAt.toDate
          ? d.updatedAt.toDate().toISOString()
          : d.updatedAt || null;

      return {
        orderId: doc.id,
        senderId: d.senderId,
        receiverId: d.receiverId,
        address: d.address || null,
        itemsCount: d.itemsCount || (d.items ? d.items.length : 0),
        items: d.items || [],
        imageUrl:
          d.items?.[0]?.imageUrl || d.proofImageUrl || d.imageUrl || null,
        status: d.status || 0, // ✅ ส่งเป็นตัวเลข ให้ Flutter แปลเอง
        createdAt,
        updatedAt,
      };
    });

    res.json({
      success: true,
      count: data.length,
      data,
    });
  } catch (err) {
    console.error("🔥 Error /api/parcels/receiver:", err);
    res
      .status(500)
      .json({ success: false, message: err.message || "Server error" });
  }
});

////หน้ารายละเอียดคำสั่ง
// 📦 ดึงรายละเอียดพัสดุ (Shipment Detail)
app.get("/api/parcels/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "orderId จำเป็นต้องมี",
      });
    }

    // 🔍 ดึงข้อมูลจาก Firestore
    const ref = db.collection("orders").doc(orderId);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: "ไม่พบข้อมูลพัสดุนี้",
      });
    }

    const d = doc.data();

    // ✅ ดึงข้อมูลผู้ส่ง ผู้รับ และไรเดอร์แบบ parallel
    const [senderDoc, receiverDoc, riderDoc] = await Promise.all([
      d.senderId ? db.collection("users").doc(d.senderId).get() : null,
      d.receiverId ? db.collection("users").doc(d.receiverId).get() : null,
      d.riderId ? db.collection("riders").doc(d.riderId).get() : null,
    ]);

    // ✅ แปลงเอกสารเป็น object ปลอดภัย
    const sender = senderDoc?.exists ? senderDoc.data() : null;
    const receiver = receiverDoc?.exists ? receiverDoc.data() : null;
    const rider = riderDoc?.exists ? riderDoc.data() : null;

    // ✅ สร้างโครงสร้างข้อมูลแบบสมบูรณ์
    const data = {
      orderId: doc.id,
      senderId: d.senderId,
      receiverId: d.receiverId,
      riderId: d.riderId || null,

      address: d.address || {},
      items: Array.isArray(d.items) ? d.items : [],
      itemsCount: Array.isArray(d.items) ? d.items.length : 0,

      proofImageUrl: d.proofImageUrl || "",
      status: d.status || 0,
      createdAt: d.createdAt || null,
      updatedAt: d.updatedAt || null,

      sender: sender
        ? {
            name: sender.name || "ไม่ระบุชื่อผู้ส่ง",
            phone: sender.phone || "-",
            profileImage: sender.profileImage || "",
          }
        : null,

      receiver: receiver
        ? {
            name: receiver.name || "ไม่ระบุชื่อผู้รับ",
            phone: receiver.phone || "-",
            profileImage: receiver.profileImage || "",
          }
        : null,

      rider: rider
        ? {
            name: rider.name || "ไม่ระบุชื่อไรเดอร์",
            phone: rider.phone || "-",
            vehiclePlate: rider.vehiclePlate || "ไม่ระบุ",
            profileImage: rider.profileImage || "",
          }
        : null,
    };

    console.log(`📦 ดึงรายละเอียดพัสดุสำเร็จ: ${orderId}`);

    return res.json({
      success: true,
      message: "โหลดรายละเอียดพัสดุสำเร็จ",
      data,
    });
  } catch (err) {
    console.error("🔥 Error /api/parcels/:orderId:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
});



