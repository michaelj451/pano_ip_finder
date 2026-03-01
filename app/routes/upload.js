// app/routes/upload.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { setConfigFile } = require("../lib/config");

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");

function ensureUploadDir() {
    if (!fs.existsSync(UPLOAD_DIR)) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
}

ensureUploadDir();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const safeBase = (file.originalname || "pano.xml")
            .replace(/[^a-zA-Z0-9._-]+/g, "_")
            .slice(0, 120);

        cb(null, `${ts}_${safeBase}`);
    },
});

function fileFilter(req, file, cb) {
    // Allow .xml and also "text/xml" / "application/xml"
    const nameOk = (file.originalname || "").toLowerCase().endsWith(".xml");
    const typeOk =
        file.mimetype === "text/xml" ||
        file.mimetype === "application/xml" ||
        file.mimetype === "application/octet-stream"; // some browsers lie

    if (nameOk || typeOk) {
        cb(null, true);
        return;
    }
    cb(new Error("Only XML files are allowed"));
}

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 200 * 1024 * 1024, // 200MB
    },
});

router.post("/upload", upload.single("config"), (req, res) => {
    try {
        if (!req.file || !req.file.path) {
            return res.status(400).json({ error: "Missing file field 'config'" });
        }

        // Switch the app to use this uploaded config file
        setConfigFile(req.file.path);

        res.json({
            ok: true,
            config_file: req.file.path,
            original_name: req.file.originalname,
            size_bytes: req.file.size,
        });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

module.exports = router;