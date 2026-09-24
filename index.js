const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

app.enable('trust proxy');

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['*'],
    exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Disposition']
}));

app.use(express.json({ limit: '50mb' }));

// ============================================================
// إعدادات بوت التلجرام
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8313488960:AAHejLd90K3ADVKT_bWJtblAzcIwGBlPvbQ';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003974721866';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ============================================================
// إعداد المجلد المؤقت
// ============================================================
const uploadDir = path.join('/tmp', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueId = crypto.randomBytes(8).toString('hex');
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${uniqueId}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

// ============================================================
// قاعدة البيانات المؤقتة
// ============================================================
const DB_FILE = path.join('/tmp', 'files-database.json');
let filesDatabase = {};

function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            filesDatabase = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {
        filesDatabase = {};
    }
}

function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(filesDatabase, null, 2));
    } catch (e) {
        console.error('Error saving DB:', e);
    }
}

loadDatabase();

// ============================================================
// 1. رفع الملفات (صور/مستندات) إلى تلجرام
// ============================================================
app.post('/api/upload-to-telegram', upload.single('file'), async (req, res) => {
    let localFilePath = null;
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'لم يتم توفير ملف' });
        }

        localFilePath = req.file.path;
        const title = req.body.title || req.file.originalname;
        const originalName = req.file.originalname;
        const fileId = crypto.randomBytes(12).toString('hex');
        const filename = req.file.filename;

        const hostUrl = `${req.protocol}://${req.get('host')}`;
        const permanentLink = `${hostUrl}/files/${filename}`;

        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('document', fs.createReadStream(localFilePath), {
            filename: originalName,
            contentType: req.file.mimetype
        });
        formData.append('caption', `📄 ${title}\n🔗 الرابط: ${permanentLink}`);

        const tgRes = await fetch(`${TELEGRAM_API}/sendDocument`, {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders()
        });

        const tgData = await tgRes.json();

        if (!tgData.ok) {
            throw new Error(tgData.description || 'فشل رفع الملف إلى تلجرام');
        }

        const doc = tgData.result.document;
        const fileInfo = {
            id: fileId,
            title: title,
            originalName: originalName,
            permanentFileName: filename,
            permanentLink: permanentLink,
            fileSize: req.file.size,
            mimeType: req.file.mimetype,
            telegramFileId: doc.file_id,
            telegramFileUniqueId: doc.file_unique_id,
            uploadDate: new Date().toISOString()
        };

        filesDatabase[fileId] = fileInfo;
        filesDatabase[filename] = fileInfo;
        saveDatabase();

        if (fs.existsSync(localFilePath)) {
            fs.unlinkSync(localFilePath);
        }

        return res.json({
            success: true,
            fileId: fileId,
            filename: filename,
            originalName: originalName,
            title: title,
            permanentLink: permanentLink,
            telegramFileId: doc.file_id,
            telegramFileUniqueId: doc.file_unique_id,
            fileSize: req.file.size,
            mimeType: req.file.mimetype
        });

    } catch (err) {
        if (localFilePath && fs.existsSync(localFilePath)) {
            try { fs.unlinkSync(localFilePath); } catch (e) {}
        }
        console.error('Upload Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 2. رفع تقرير PDF إلى تلجرام
// ============================================================
app.post('/api/upload-report', upload.single('file'), async (req, res) => {
    let localFilePath = null;
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'لم يتم توفير ملف' });
        }

        localFilePath = req.file.path;
        const caption = req.body.caption || '📊 تقرير حملة جديد';

        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('document', fs.createReadStream(localFilePath), {
            filename: req.file.originalname,
            contentType: 'application/pdf'
        });
        formData.append('caption', caption);

        const tgRes = await fetch(`${TELEGRAM_API}/sendDocument`, {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders()
        });

        const tgData = await tgRes.json();

        if (fs.existsSync(localFilePath)) {
            fs.unlinkSync(localFilePath);
        }

        if (!tgData.ok) {
            throw new Error(tgData.description || 'فشل رفع التقرير');
        }

        return res.json({
            success: true,
            telegramFileId: tgData.result.document.file_id,
            messageId: tgData.result.message_id
        });

    } catch (err) {
        if (localFilePath && fs.existsSync(localFilePath)) {
            try { fs.unlinkSync(localFilePath); } catch (e) {}
        }
        console.error('Report Upload Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 3. إرسال رسالة نصية إلى تلجرام
// ============================================================
app.post('/api/send-message', async (req, res) => {
    try {
        const { text, parse_mode } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'النص مطلوب' });
        }

        const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: parse_mode || 'HTML'
            })
        });

        const data = await response.json();

        if (!data.ok) {
            throw new Error(data.description || 'فشل إرسال الرسالة');
        }

        res.json({ success: true, messageId: data.result.message_id });

    } catch (err) {
        console.error('Send Message Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 4. معاينة وتنزيل الملفات
// ============================================================
app.get('/files/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const fileEntry = filesDatabase[filename] || {};

        const telegramFileId = req.query.fileId || fileEntry.telegramFileId;
        const mimeType = req.query.mime || fileEntry.mimeType || 'application/octet-stream';
        const originalName = req.query.name || fileEntry.originalName || filename;
        const fileSize = fileEntry.fileSize || '';

        if (!telegramFileId) {
            return res.status(404).json({ error: 'الملف غير موجود' });
        }

        const fileUrlResponse = await fetch(`${TELEGRAM_API}/getFile?file_id=${telegramFileId}`);
        const fileUrlData = await fileUrlResponse.json();

        if (!fileUrlData.ok) {
            return res.status(404).json({ error: 'تعذر الوصول إلى الملف' });
        }

        const directUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileUrlData.result.file_path}`;
        const tgStream = await fetch(directUrl);

        if (!tgStream.ok) {
            return res.status(502).json({ error: 'فشل استجلاب الملف' });
        }

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', tgStream.headers.get('content-length') || fileSize);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(originalName)}"`);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Access-Control-Allow-Origin', '*');

        tgStream.body.pipe(res);

        req.on('close', () => {
            if (tgStream.body && typeof tgStream.body.destroy === 'function') {
                tgStream.body.destroy();
            }
        });

    } catch (err) {
        console.error('Proxy Fetch Error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'حدث خطأ في جلب الملف' });
        }
    }
});

// ============================================================
// 5. نقطة التحقق (Health Check)
// ============================================================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        botConnected: !!TELEGRAM_BOT_TOKEN,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));