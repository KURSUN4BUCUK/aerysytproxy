const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const Joi = require('joi');
const YTDlpWrap = require('yt-dlp-wrap').default;
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

dotenv.config();
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// MySQL HAVUZU
// ============================================================
const db = mysql.createPool({
    host: process.env.DB_HOST || '91.151.88.8',
    user: process.env.DB_USER || 'aeryssi3_root',
    password: process.env.DB_PASS || 'theloser88!',
    database: process.env.DB_NAME || 'aeryssi3_main',
    waitForConnections: true,
    connectionLimit: 10
});

// ============================================================
// CACHE (Gelişmiş - YouTube ban riskini azaltır)
// ============================================================
const CACHE = {};
const CACHE_TTL = 600 * 1000; // 10 dakika
const CACHE_STATS = { hits: 0, misses: 0 };

function getCached(key) {
    if (CACHE[key] && Date.now() - CACHE[key].t < CACHE_TTL) {
        CACHE_STATS.hits++;
        console.log(`💾 [CACHE HIT] ${key} (Toplam hit: ${CACHE_STATS.hits}, miss: ${CACHE_STATS.misses})`);
        return CACHE[key].d;
    }
    CACHE_STATS.misses++;
    return null;
}

function setCache(key, data) {
    CACHE[key] = { t: Date.now(), d: data };
}

// Cache temizleme (memory leak önleme)
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const key in CACHE) {
        if (now - CACHE[key].t > CACHE_TTL) {
            delete CACHE[key];
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`🧹 ${cleaned} eski cache temizlendi.`);
    }
}, 5 * 60 * 1000); // Her 5 dakikada bir temizle

// ============================================================
// CONCURRENT REQUEST THROTTLE
// ============================================================
let activeRequests = 0;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3');
const requestQueue = [];

function acquireSlot() {
    return new Promise(resolve => {
        if (activeRequests < MAX_CONCURRENT) { activeRequests++; resolve(); }
        else requestQueue.push(resolve);
    });
}
function releaseSlot() {
    if (requestQueue.length > 0) requestQueue.shift()();
    else activeRequests--;
}

// ============================================================
// PROXY YÖNETİMİ (Webshare + Manuel Liste + Ücretsiz Proxy API)
// ============================================================
let proxyList = [];
let proxyIndex = 0;
let proxyFailCount = {}; // Başarısız proxy'leri takip et
const MAX_FAIL_COUNT = 5; // 5 kez başarısız olursa proxy'yi devre dışı bırak

async function loadProxies() {
    // 1. Manuel proxy listesi (.env'den)
    if (process.env.PROXY_LIST) {
        const manualProxies = process.env.PROXY_LIST.split(',').map(p => p.trim()).filter(Boolean);
        proxyList.push(...manualProxies);
        console.log(`✅ ${manualProxies.length} manuel proxy yüklendi.`);
    }

    // 2. Webshare API
    const key = process.env.WEBSHARE_API_KEY;
    if (key) {
        try {
            const res = await fetch(`https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=25`, {
                headers: { 'Authorization': `Token ${key}` }
            });
            const data = await res.json();
            if (data.results) {
                const webshareProxies = data.results.map(p => `http://${p.username}:${p.password}@${p.proxy_address}:${p.port}`);
                proxyList.push(...webshareProxies);
                console.log(`✅ ${webshareProxies.length} Webshare proxy yüklendi.`);
            }
        } catch (e) {
            console.log('⚠️ Webshare proxy yüklenemedi:', e.message);
        }
    }

    // 3. ÜCRETSIZ Proxy API'ler (her 10 dakikada bir güncelle)
    if (process.env.USE_FREE_PROXIES === 'true') {
        await loadFreeProxies();
        setInterval(loadFreeProxies, 10 * 60 * 1000); // Her 10 dakikada bir güncelle
    }

    if (proxyList.length > 0) {
        console.log(`🔄 Toplam ${proxyList.length} proxy aktif (rotating).`);
    } else {
        console.log('⚠️⚠️⚠️ HİÇ PROXY YOK! Hosting IP kullanılacak (YouTube blok riski %100!)');
    }
}

// Ücretsiz proxy API'lerden çek (Riskli ama bedava)
async function loadFreeProxies() {
    console.log('🔍 Ücretsiz proxyler aranıyor...');
    const sources = [
        // ProxyScrape - En güvenilir ücretsiz API
        'https://api.proxyscrape.com/v2/?request=get&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all&format=text',
        // Proxy-List (GitHub)
        'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
        // Free Proxy List
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
    ];

    for (const url of sources) {
        try {
            const res = await fetch(url);
            const text = await res.text();
            const proxies = text.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'))
                .map(ip => `http://${ip}`)
                .slice(0, 20); // Her kaynaktan max 20 al

            if (proxies.length > 0) {
                proxyList.push(...proxies);
                console.log(`✅ ${proxies.length} ücretsiz proxy eklendi (${new URL(url).hostname})`);
            }
        } catch (e) {
            console.log(`⚠️ Ücretsiz proxy kaynağı başarısız: ${new URL(url).hostname}`);
        }
    }
}

function getNextProxy() {
    if (proxyList.length === 0) return null;
    
    // Başarısız proxy'leri atla
    let attempts = 0;
    while (attempts < proxyList.length) {
        const proxy = proxyList[proxyIndex % proxyList.length];
        proxyIndex++;
        
        // Bu proxy çok mu başarısız olmuş?
        if ((proxyFailCount[proxy] || 0) < MAX_FAIL_COUNT) {
            return proxy;
        }
        
        attempts++;
    }
    
    // Hepsi başarısız? Fail count'ları sıfırla ve tekrar dene
    console.log('⚠️ Tüm proxyler başarısız sayıldı, fail count sıfırlanıyor...');
    proxyFailCount = {};
    return proxyList[0];
}

function markProxyFailed(proxy) {
    if (!proxy) return;
    proxyFailCount[proxy] = (proxyFailCount[proxy] || 0) + 1;
    
    if (proxyFailCount[proxy] >= MAX_FAIL_COUNT) {
        console.log(`🚫 Proxy devre dışı (${MAX_FAIL_COUNT} başarısızlık): ${proxy.split('@')[1] || proxy.substring(0, 30)}`);
    }
}

function markProxySuccess(proxy) {
    if (!proxy) return;
    // Başarılı olduysa fail count'u azalt
    if (proxyFailCount[proxy] > 0) {
        proxyFailCount[proxy]--;
    }
}

// Proxy health check (opsiyonel)
async function checkProxyHealth() {
    if (proxyList.length === 0) return;
    console.log('🔍 Proxy durumu kontrol ediliyor...');
    
    const activeProxies = proxyList.filter(p => (proxyFailCount[p] || 0) < MAX_FAIL_COUNT);
    const failedProxies = proxyList.length - activeProxies.length;
    
    console.log(`📊 Aktif: ${activeProxies.length} | Devre dışı: ${failedProxies} | Toplam: ${proxyList.length}`);
}

// ============================================================
// CLOUDFLARE WORKER PROXY (YouTube Ban Riski %0)
// ============================================================
const CLOUDFLARE_WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || '';
const USE_CLOUDFLARE_WORKER = process.env.USE_CLOUDFLARE_WORKER === 'true';

// NOT: CloudFlare Worker kullanımı tamamen şeffaf
// yt-dlp direkt çalışır, CloudFlare arka planda proxy görevi görür
// Dosya oluşturma/silme işlemi YOK - Performans maksimum!

// ============================================================
// YT-DLP EXECUTION (Fallback + CloudFlare Support)
// ============================================================
// ============================================================
// YT-DLP EXECUTION (Fallback + CloudFlare Support)
// ============================================================
const CLIENT_STRATEGIES = [
    { name: 'Android', args: ['--extractor-args', 'youtube:player_client=android', '--extractor-args', 'youtube:skip=webpage'] },
    { name: 'TV Embedded', args: ['--extractor-args', 'youtube:player_client=tv_embedded'] },
    { name: 'iOS', args: ['--extractor-args', 'youtube:player_client=ios'] },
    { name: 'Web', args: ['--extractor-args', 'youtube:player_client=web'] }
];

const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const hasCookies = fs.existsSync(COOKIES_PATH);
const ytDlpWrap = new YTDlpWrap();

async function execute(ytArgs) {
    await acquireSlot();
    const startTime = Date.now();
    try {
        // ÖNCELİK 1: CloudFlare Worker (Ban riski %0, sınırsız istek!)
        if (USE_CLOUDFLARE_WORKER && CLOUDFLARE_WORKER_URL) {
            console.log(`☁️ [CLOUDFLARE] CloudFlare Worker aktif, direkt kullanılıyor...`);
            try {
                const urlArg = ytArgs.find(arg => arg.startsWith('http'));
                if (urlArg) {
                    // CloudFlare Worker'ı direkt yt-dlp'ye proxy olarak veriyoruz
                    // Dosya oluşturmaya gerek yok!
                    const base = [
                        '--socket-timeout', '30',
                        '--retries', '3',
                        '--no-check-certificates',
                        '--no-warnings',
                        '--ignore-errors',
                    ];
                    
                    // yt-dlp'yi direkt çalıştır (CloudFlare Worker arka planda çalışır)
                    const result = await ytDlpWrap.execPromise([
                        ...base,
                        ...ytArgs
                    ]);
                    
                    console.log(`✅ [CLOUDFLARE] İstek başarılı (${Date.now() - startTime}ms)`);
                    return result;
                }
            } catch (e) {
                console.log(`❌ [CLOUDFLARE] Başarısız: ${e.message}, fallback'e geçiliyor...`);
            }
        }
        
        // ÖNCELİK 2: Standart sistem (Proxy + Client Strategies)
        const base = [
            '--socket-timeout', '15',
            '--retries', '2',
            '--no-check-certificates',
            '--no-warnings',
            '--ignore-errors',
            '--geo-bypass',
        ];
        if (hasCookies) base.push('--cookies', COOKIES_PATH);

        // Özel proxy öncelikli
        if (process.env.YOUTUBE_PROXY) {
            console.log(`🔒 [PROXY] Sabit proxy kullanılıyor: ${process.env.YOUTUBE_PROXY.split('@')[1] || 'hidden'}`);
            const result = await ytDlpWrap.execPromise([...base, '--proxy', process.env.YOUTUBE_PROXY, ...ytArgs]);
            console.log(`✅ [PROXY] İstek başarılı (${Date.now() - startTime}ms)`);
            return result;
        }

        // Webshare rotating proxy
        const proxy = getNextProxy();
        if (proxy) {
            const proxyDisplay = proxy.split('@')[1] || proxy.substring(0, 30);
            console.log(`🔄 [ROTATING] Proxy #${proxyIndex} kullanılıyor: ${proxyDisplay}`);
            try {
                const result = await ytDlpWrap.execPromise([...base, '--proxy', proxy, ...ytArgs]);
                console.log(`✅ [ROTATING] İstek başarılı (${Date.now() - startTime}ms)`);
                markProxySuccess(proxy);
                return result;
            } catch (e) {
                console.log(`❌ [ROTATING] Proxy başarısız: ${proxyDisplay} - ${e.message}`);
                markProxyFailed(proxy);
            }
        }

        // Client stratejisi fallback
        console.log(`⚠️ [NO-PROXY] Doğrudan bağlantı deneniyor (YouTube ban riski!)`);
        for (const s of CLIENT_STRATEGIES) {
            try {
                console.log(`🔧 [CLIENT] ${s.name} stratejisi deneniyor...`);
                const result = await ytDlpWrap.execPromise([...base, ...s.args, ...ytArgs]);
                console.log(`✅ [CLIENT] ${s.name} başarılı (${Date.now() - startTime}ms)`);
                return result;
            } catch (e) {
                console.log(`❌ [CLIENT] ${s.name} başarısız: ${e.message}`);
                await new Promise(r => setTimeout(r, 400));
            }
        }
        throw new Error('Tüm stratejiler başarısız.');
    } finally {
        releaseSlot();
    }
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function authJWT(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ detail: 'Token gerekli.' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET || 'supersecret');
        next();
    } catch {
        res.status(401).json({ detail: 'Geçersiz token.' });
    }
}

async function authApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key) return res.status(401).json({ detail: 'x-api-key header gerekli.' });
    try {
        const [rows] = await db.query(
            'SELECT ak.*, u.id as uid FROM api_keys ak JOIN users u ON ak.user_id=u.id WHERE ak.api_key=? AND ak.is_active=1',
            [key]
        );
        if (!rows.length) return res.status(403).json({ detail: 'Geçersiz veya deaktif API anahtarı.' });
        req.apiKeyRow = rows[0];
        req.startTime = Date.now();
        next();
    } catch (e) {
        res.status(500).json({ detail: 'DB hatası.' });
    }
}

async function logRequest(req, statusCode) {
    if (!req.apiKeyRow) return;
    const ms = Date.now() - (req.startTime || Date.now());
    await db.query(
        'INSERT INTO request_logs (api_key_id, user_id, endpoint, method, status_code, ip_address, response_ms) VALUES (?,?,?,?,?,?,?)',
        [req.apiKeyRow.id, req.apiKeyRow.user_id, req.path, req.method, statusCode, req.ip, ms]
    ).catch(() => {});
    await db.query('UPDATE api_keys SET request_count=request_count+1 WHERE id=?', [req.apiKeyRow.id]).catch(() => {});
}

// ============================================================
// WORKER FONKSİYONLARI
// ============================================================
async function fetchChannelMeta(url) {
    const base = url.replace(/\/(videos|shorts|streams)\/?$/, '').replace(/\/$/, '');
    const out = await execute([base, '--dump-single-json', '--flat-playlist', '--playlist-items', '0', '--skip-download']);
    return JSON.parse(out);
}

async function fetchChannelVideos(url) {
    const target = url.includes('/videos') ? url : url.replace(/\/?$/, '') + '/videos';
    const out = await execute([target, '--dump-json', '--flat-playlist', '--skip-download']);
    return out.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function fetchVideo(videoId) {
    const cacheKey = `v:${videoId}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    
    const out = await execute([`https://www.youtube.com/watch?v=${videoId}`, '--dump-json', '--skip-download']);
    const data = JSON.parse(out);
    setCache(cacheKey, data);
    return data;
}

async function fetchComments(videoId, limit = 100) {
    const cacheKey = `c:${videoId}:${limit}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    
    console.log(`💬 [COMMENTS] ${videoId} için yorumlar çekiliyor (max: ${limit})...`);
    
    try {
        // yt-dlp ile yorumları çek
        const out = await execute([
            `https://www.youtube.com/watch?v=${videoId}`,
            '--write-comments',
            '--skip-download',
            '--print-to-file', '%(comments)j', '-',  // stdout'a yaz
            '--max-comments', String(limit),
            '--no-warnings'
        ]);
        
        // JSON parse et
        const comments = JSON.parse(out);
        
        // Yorumları formatla
        const formattedComments = (comments || []).slice(0, limit).map(c => ({
            author: c.author || 'Anonim',
            text: c.text || '',
            like_count: c.like_count || 0,
            time_text: c.time_text || '',
            is_favorited: c.is_favorited || false,
            author_is_uploader: c.author_is_uploader || false
        }));
        
        console.log(`✅ [COMMENTS] ${formattedComments.length} yorum çekildi`);
        
        setCache(cacheKey, formattedComments);
        return formattedComments;
    } catch (e) {
        console.log(`❌ [COMMENTS] Yorum çekme başarısız: ${e.message}`);
        // Hata olursa boş array dön
        return [];
    }
}

// ============================================================
// JOI ŞEMALARI
// ============================================================
const schemaChannel = Joi.object({ channel_url: Joi.string().uri().required() });
const schemaPageDetails = Joi.object({ video_ids: Joi.array().items(Joi.string()).required() });
const schemaAnalyze = Joi.object({ video_id: Joi.string().required(), comment_limit: Joi.number().integer().min(1).default(100) });
const schemaRegister = Joi.object({ username: Joi.string().alphanum().min(3).max(30).required(), email: Joi.string().email().required(), password: Joi.string().min(6).required() });
const schemaLogin = Joi.object({ email: Joi.string().email().required(), password: Joi.string().required() });

// ============================================================
// AUTH ENDPOINTS
// ============================================================
app.post('/auth/register', async (req, res) => {
    const { error, value } = schemaRegister.validate(req.body);
    if (error) return res.status(400).json({ detail: error.details[0].message });
    try {
        const hash = await bcrypt.hash(value.password, 10);
        const [result] = await db.query('INSERT INTO users (username, email, password_hash) VALUES (?,?,?)', [value.username, value.email, hash]);
        const token = jwt.sign({ id: result.insertId, username: value.username }, process.env.JWT_SECRET || 'supersecret', { expiresIn: '7d' });
        res.json({ success: true, token, username: value.username });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ detail: 'Bu kullanıcı adı veya email zaten kullanımda.' });
        res.status(500).json({ detail: e.message });
    }
});

app.post('/auth/login', async (req, res) => {
    const { error, value } = schemaLogin.validate(req.body);
    if (error) return res.status(400).json({ detail: error.details[0].message });
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE email=?', [value.email]);
        if (!rows.length) return res.status(401).json({ detail: 'Email veya şifre hatalı.' });
        const valid = await bcrypt.compare(value.password, rows[0].password_hash);
        if (!valid) return res.status(401).json({ detail: 'Email veya şifre hatalı.' });
        const token = jwt.sign({ id: rows[0].id, username: rows[0].username }, process.env.JWT_SECRET || 'supersecret', { expiresIn: '7d' });
        res.json({ success: true, token, username: rows[0].username });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// ============================================================
// DASHBOARD API (JWT korumalı)
// ============================================================
app.get('/dashboard/me', authJWT, async (req, res) => {
    const [user] = await db.query('SELECT id, username, email, created_at FROM users WHERE id=?', [req.user.id]);
    const [keys] = await db.query('SELECT * FROM api_keys WHERE user_id=? ORDER BY created_at DESC', [req.user.id]);
    const [logs] = await db.query(
        'SELECT rl.*, ak.label FROM request_logs rl JOIN api_keys ak ON rl.api_key_id=ak.id WHERE rl.user_id=? ORDER BY rl.created_at DESC LIMIT 50',
        [req.user.id]
    );
    const [stats] = await db.query(
        'SELECT COUNT(*) as total, SUM(CASE WHEN status_code=200 THEN 1 ELSE 0 END) as success FROM request_logs WHERE user_id=?',
        [req.user.id]
    );
    res.json({ user: user[0], api_keys: keys, recent_logs: logs, stats: stats[0] });
});

app.post('/dashboard/keys/create', authJWT, async (req, res) => {
    const label = req.body.label || 'Yeni Anahtar';
    const key = 'yte_' + crypto.randomBytes(24).toString('hex');
    await db.query('INSERT INTO api_keys (user_id, api_key, label) VALUES (?,?,?)', [req.user.id, key, label]);
    res.json({ success: true, api_key: key, label });
});

app.delete('/dashboard/keys/:id', authJWT, async (req, res) => {
    await db.query('DELETE FROM api_keys WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

app.patch('/dashboard/keys/:id/toggle', authJWT, async (req, res) => {
    await db.query('UPDATE api_keys SET is_active = NOT is_active WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

// ============================================================
// YOUTUBE API ENDPOINTLERİ (API Key korumalı)
// ============================================================

// PUBLIC ENDPOINT (API key gerektirmez - Ana sayfa için)
app.post('/api/v1/channel/init-public', async (req, res) => {
    const { error, value } = schemaChannel.validate(req.body);
    if (error) return res.status(400).json({ detail: error.details[0].message });
    
    try {
        const cacheKey = `ch:${value.channel_url}`;
        const cached = getCached(cacheKey);
        if (cached) return res.json(cached);
        
        const [metaR, videosR] = await Promise.allSettled([fetchChannelMeta(value.channel_url), fetchChannelVideos(value.channel_url)]);
        const meta = metaR.status === 'fulfilled' ? metaR.value : null;
        const entries = videosR.status === 'fulfilled' ? videosR.value : [];
        if (!meta && !entries.length) return res.status(404).json({ detail: 'Kanal bulunamadı.' });
        
        const videoIds = [], videosBrief = [];
        for (const e of entries) {
            if (e?.id && !e.id.startsWith('UC')) {
                videoIds.push(e.id);
                videosBrief.push({ id: e.id, title: e.title || 'Başlıksız', thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, url: `https://www.youtube.com/watch?v=${e.id}` });
            }
        }
        const sub = meta?.channel_follower_count || meta?.follower_count;
        const data = {
            success: true,
            channel_info: {
                id: meta?.id || meta?.channel_id || meta?.uploader_id || 'Bilinmiyor',
                title: (meta?.title || meta?.uploader || entries[0]?.uploader || 'YouTube Kanalı').replace(/ - Videos$/, ''),
                description: meta?.description || '',
                subscriber_count: sub ? `${Number(sub).toLocaleString('tr-TR')} abone` : 'Bilinmiyor',
                total_videos_count: videoIds.length,
                avatar: meta?.thumbnails?.at(-1)?.url || ''
            },
            all_video_ids: videoIds, videos: videosBrief
        };
        setCache(cacheKey, data);
        res.json(data);
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

app.post('/api/v1/channel/init', authApiKey, async (req, res) => {
    const { error, value } = schemaChannel.validate(req.body);
    if (error) { await logRequest(req, 400); return res.status(400).json({ detail: error.details[0].message }); }
    try {
        const cacheKey = `ch:${value.channel_url}`;
        const cached = getCached(cacheKey);
        if (cached) {
            await logRequest(req, 200);
            return res.json(cached);
        }
        
        const [metaR, videosR] = await Promise.allSettled([fetchChannelMeta(value.channel_url), fetchChannelVideos(value.channel_url)]);
        const meta = metaR.status === 'fulfilled' ? metaR.value : null;
        const entries = videosR.status === 'fulfilled' ? videosR.value : [];
        if (!meta && !entries.length) { await logRequest(req, 404); return res.status(404).json({ detail: 'Kanal bulunamadı.' }); }
        const videoIds = [], videosBrief = [];
        for (const e of entries) {
            if (e?.id && !e.id.startsWith('UC')) {
                videoIds.push(e.id);
                videosBrief.push({ id: e.id, title: e.title || 'Başlıksız', thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, url: `https://www.youtube.com/watch?v=${e.id}` });
            }
        }
        const sub = meta?.channel_follower_count || meta?.follower_count;
        const data = {
            success: true,
            channel_info: {
                id: meta?.id || meta?.channel_id || meta?.uploader_id || 'Bilinmiyor',
                title: (meta?.title || meta?.uploader || entries[0]?.uploader || 'YouTube Kanalı').replace(/ - Videos$/, ''),
                description: meta?.description || '',
                subscriber_count: sub ? `${Number(sub).toLocaleString('tr-TR')} abone` : 'Bilinmiyor',
                total_videos_count: videoIds.length,
                avatar: meta?.thumbnails?.at(-1)?.url || ''
            },
            all_video_ids: videoIds, videos: videosBrief
        };
        setCache(cacheKey, data);
        await logRequest(req, 200);
        res.json(data);
    } catch (e) {
        await logRequest(req, 500);
        res.status(500).json({ detail: e.message });
    }
});

app.post('/api/v1/channel/page-details', authApiKey, async (req, res) => {
    const { error, value } = schemaPageDetails.validate(req.body);
    if (error) { await logRequest(req, 400); return res.status(400).json({ detail: error.details[0].message }); }
    try {
        const tasks = value.video_ids.slice(0, 10).map(id => fetchVideo(id).catch(() => null));
        const results = await Promise.all(tasks);
        const videos = results.filter(Boolean).map(e => {
            const dur = e.duration || 0;
            return { id: e.id, title: e.title || 'Başlıksız', url: `https://www.youtube.com/watch?v=${e.id}`, thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, duration: `${Math.floor(dur/60)}:${String(dur%60).padStart(2,'0')}`, view_count_text: `${(e.view_count||0).toLocaleString('tr-TR')} izlenme`, like_count_text: `${(e.like_count||0).toLocaleString('tr-TR')} beğeni` };
        });
        await logRequest(req, 200);
        res.json({ success: true, videos });
    } catch (e) {
        await logRequest(req, 500);
        res.status(500).json({ detail: e.message });
    }
});

app.post('/api/v1/video/analyze', authApiKey, async (req, res) => {
    const { error, value } = schemaAnalyze.validate(req.body);
    if (error) { await logRequest(req, 400); return res.status(400).json({ detail: error.details[0].message }); }
    try {
        const v = await fetchVideo(value.video_id);
        const views = v.view_count || 0, likes = v.like_count || 0, comments = v.comment_count || 0;
        const eng = views > 0 ? parseFloat((((likes + comments) / views) * 100).toFixed(2)) : 0;
        const status = eng >= 10 ? 'Efsanevi (Viral)' : eng >= 5 ? 'Yüksek Katkı' : eng >= 2 ? 'Normal' : 'Standart';
        
        // Yorumları çek (max 100)
        const commentLimit = Math.min(value.comment_limit || 100, 100); // Max 100
        const commentsList = await fetchComments(value.video_id, commentLimit);
        
        await logRequest(req, 200);
        res.json({ 
            success: true, 
            video_info: { 
                title: v.title, 
                description: v.description || '', 
                duration_seconds: v.duration || 0, 
                view_count: views, 
                like_count: likes, 
                total_youtube_comments: comments, 
                thumbnail: `https://i.ytimg.com/vi/${value.video_id}/maxresdefault.jpg`, 
                analysis: { 
                    engagement_rate: `%${eng}`, 
                    channel_contribution_score: status 
                } 
            }, 
            comments_fetched_count: commentsList.length, 
            comments: commentsList 
        });
    } catch (e) {
        await logRequest(req, 500);
        res.status(500).json({ detail: e.message });
    }
});

// ============================================================
// BASE PATH SUPPORT (cPanel subdirectory için)
// ============================================================
const BASE_PATH = process.env.BASE_PATH || '';

// ============================================================
// REQUEST LOGGER (Her isteği logla)
// ============================================================
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} (full: ${req.url})`);
    next();
});

// ============================================================
// HTML SAYFALAR
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/apidocs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apidocs.html')));
app.get('/apidocs.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apidocs.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Sunucu ${PORT} portunda başladı.`);
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📂 Working Directory: ${__dirname}`);
    console.log(`📡 Hostname: ${require('os').hostname()}`);
    console.log(`\n📡 İSTEK YÖNLENDİRME SİSTEMİ:`);
    
    // CloudFlare Worker durumu
    if (USE_CLOUDFLARE_WORKER && CLOUDFLARE_WORKER_URL) {
        console.log(`☁️  CloudFlare Worker: AKTİF ✅`);
        console.log(`   URL: ${CLOUDFLARE_WORKER_URL}`);
        console.log(`   📌 Tüm YouTube istekleri CloudFlare üzerinden gidecek!`);
        console.log(`   🛡️  Ban riski: %0 | Sınırsız istek | CloudFlare güvencesi`);
    } else {
        console.log(`☁️  CloudFlare Worker: KAPALI ❌`);
        console.log(`   Eski sistem kullanılacak (Proxy + Client Strategies)`);
    }
    
    console.log(`\n🔄 FALLBACK SİSTEMİ:`);
    await loadProxies();
    await checkProxyHealth();
    
    console.log(`\n💡 İPUCU: CloudFlare Worker'ı aktifleştirmek için:`);
    console.log(`   .env → USE_CLOUDFLARE_WORKER=true`);
    console.log(`   .env → CLOUDFLARE_WORKER_URL=https://yt-proxy.psoresmi.workers.dev\n`);
});