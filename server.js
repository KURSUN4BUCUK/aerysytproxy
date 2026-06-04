const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const Joi = require('joi');
const axios = require('axios');
const path = require('path');

dotenv.config();
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Her isteği loglayan middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

const CLOUDFLARE_WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || 'https://yt-proxy.psoresmi.workers.dev';

// Ortak Tünel Fonksiyonu
async function fetchFromWorker(targetUrl) {
    try {
        const response = await axios.get(CLOUDFLARE_WORKER_URL, {
            params: { url: targetUrl },
            timeout: 30000
        });
        return response.data;
    } catch (error) {
        console.error(`❌ [PROXY ERROR]: ${error.message}`);
        throw new Error(`Tünel hatası: YouTube verisi çekilemedi.`);
    }
}

const schemaChannel = Joi.object({ channel_url: Joi.string().uri().required() });
const schemaAnalyze = Joi.object({ video_id: Joi.string().required(), comment_limit: Joi.number().integer().min(1).default(100) });

// ============================================================
// 1. ENDPOINT: KANAL BİLGİLERİ VE VİDEOLARI
// ============================================================
app.post('/api/v1/channel/init-public', async (req, res) => {
    const { error, value } = schemaChannel.validate(req.body);
    if (error) return res.status(400).json({ detail: error.details[0].message });
    
    try {
        const cleanUrl = value.channel_url.replace(/\/(videos|shorts|streams)\/?$/, '').replace(/\/$/, '');
        const data = await fetchFromWorker(cleanUrl);
        
        if (!data) return res.status(404).json({ detail: 'Kanal verisi boş döndü.' });

        const sub = data.channel_follower_count || data.follower_count || data.subscribers;
        const entries = data.entries || [];
        
        const videosBrief = entries.filter(e => e && e.id).map(e => ({
            id: e.id,
            title: e.title || 'Başlıksız Video',
            thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${e.id}`
        }));

        res.json({
            success: true,
            channel_info: {
                id: data.id || 'Bilinmiyor',
                title: (data.title || data.uploader || 'YouTube Kanalı').replace(/ - Videos$/, ''),
                description: data.description || 'Açıklama bulunmuyor.',
                subscriber_count: sub ? `${Number(sub).toLocaleString('tr-TR')} abone` : 'Gizli veya Bilinmiyor',
                total_videos_count: videosBrief.length,
                avatar: data.thumbnails?.find(t => t.id === 'avatar_uncroped' || t.url?.includes('ch_profile'))?.url || data.thumbnails?.at(-1)?.url || 'https://www.youtube.com/s/desktop/2df1f206/img/avatar_placeholder_dark.png'
            },
            videos: videosBrief.slice(0, 12)
        });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// ============================================================
// 2. ENDPOINT: TEK VİDEO DETAYI
// ============================================================
app.post('/api/v1/video/details', async (req, res) => {
    const { video_id } = req.body;
    if (!video_id) return res.status(400).json({ detail: "video_id parametresi zorunlu." });
    
    try {
        const data = await fetchFromWorker(`https://www.youtube.com/watch?v=${video_id}`);
        const dur = data.duration || 0;

        res.json({
            success: true,
            video: {
                id: video_id,
                title: data.title || 'Video Başlığı',
                url: `https://www.youtube.com/watch?v=${video_id}`,
                thumbnail: `https://i.ytimg.com/vi/${video_id}/maxresdefault.jpg`,
                duration: `${Math.floor(dur/60)}:${String(dur%60).padStart(2,'0')}`,
                view_count: (data.view_count || 0).toLocaleString('tr-TR'),
                like_count: (data.like_count || 0).toLocaleString('tr-TR')
            }
        });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// ============================================================
// 3. ENDPOINT: VİDEO ANALİZİ VE YORUMLAR (Simüle & Metrik)
// ============================================================
app.post('/api/v1/video/analyze', async (req, res) => {
    const { error, value } = schemaAnalyze.validate(req.body);
    if (error) return res.status(400).json({ detail: error.details[0].message });
    
    try {
        const data = await fetchFromWorker(`https://www.youtube.com/watch?v=${value.video_id}`);
        
        const views = data.view_count || 0;
        const likes = data.like_count || 0;
        const comments = data.comment_count || 0;
        const eng = views > 0 ? parseFloat((((likes + comments) / views) * 100).toFixed(2)) : 0;
        const status = eng >= 7 ? 'Efsanevi (Viral)' : eng >= 4 ? 'Yüksek Etkileşim' : 'Normal';
        
        res.json({ 
            success: true, 
            video_info: { 
                title: data.title || 'Video Başlığı', 
                description: data.description?.substring(0, 200) || '', 
                view_count: views.toLocaleString('tr-TR'), 
                like_count: likes.toLocaleString('tr-TR'), 
                total_comments: comments.toLocaleString('tr-TR'), 
                thumbnail: `https://i.ytimg.com/vi/${value.video_id}/maxresdefault.jpg`, 
                analysis: { 
                    engagement_rate: `%${eng}`, 
                    score: status 
                } 
            }
        });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// Catch-All HTML yönlendirmesi
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Aerys Sunucusu ${PORT} Portunda Aktif.`);
    console.log(`☁️  Tünel Hedefi: ${CLOUDFLARE_WORKER_URL}`);
});