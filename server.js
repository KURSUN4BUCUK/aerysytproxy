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

// Render üzerinde Environment Variable olarak girilecek URL, girilmezse bu fallback'i kullanır
const CLOUDFLARE_WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || 'https://yt-proxy.psoresmi.workers.dev';

async function fetchFromWorker(targetUrl) {
    try {
        const response = await axios.get(CLOUDFLARE_WORKER_URL, {
            params: { url: targetUrl },
            timeout: 30000
        });
        return response.data;
    } catch (error) {
        console.error(`❌ [PROXY ERROR]:`, error.message);
        throw new Error(`CloudFlare Worker üzerinden veri çekilemedi: ${error.message}`);
    }
}

const schemaChannel = Joi.object({ channel_url: Joi.string().uri().required() });
const schemaAnalyze = Joi.object({ video_id: Joi.string().required(), comment_limit: Joi.number().integer().min(1).default(100) });

// 1. ENDPOINT: Kanal Sorgulama
app.post('/api/v1/channel/init-public', async (req, res) => {
    const { error, value } = schemaChannel.validate(req.body);
    if (error) return res.status(400).json({ detail: error.details[0].message });
    
    try {
        const target = value.channel_url.replace(/\/(videos|shorts|streams)\/?$/, '').replace(/\/$/, '');
        const data = await fetchFromWorker(target);
        
        if (data && (data.id || data.title)) {
            const sub = data.channel_follower_count || data.follower_count;
            return res.json({
                success: true,
                channel_info: {
                    id: data.id || 'Bilinmiyor',
                    title: data.title || 'YouTube Kanalı',
                    description: data.description || '',
                    subscriber_count: sub ? `${Number(sub).toLocaleString('tr-TR')} abone` : 'Bilinmiyor',
                    total_videos_count: data.entries ? data.entries.length : 0,
                    avatar: data.thumbnails?.at(-1)?.url || ''
                },
                all_video_ids: data.entries ? data.entries.map(e => e.id) : [],
                videos: data.entries ? data.entries.slice(0, 10).map(e => ({
                    id: e.id,
                    title: e.title,
                    thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
                    url: `https://www.youtube.com/watch?v=${e.id}`
                })) : []
            });
        }
        
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// 2. ENDPOINT: Video Detay Çekme
app.post('/api/v1/video/details', async (req, res) => {
    const { video_id } = req.body;
    if (!video_id) return res.status(400).json({ detail: "video_id gerekli." });
    
    try {
        const targetUrl = `https://www.youtube.com/watch?v=${video_id}`;
        const data = await fetchFromWorker(targetUrl);
        
        res.json({
            success: true,
            video: {
                id: video_id,
                title: data.title || 'Mevcut Video',
                url: targetUrl,
                thumbnail: `https://i.ytimg.com/vi/${video_id}/hqdefault.jpg`,
                duration: data.duration ? `${Math.floor(data.duration/60)}:${String(data.duration%60).padStart(2,'0')}` : 'Bilinmiyor',
                view_count: data.view_count || 0,
                like_count: data.like_count || 0
            }
        });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// 3. ENDPOINT: Yorumlu Video Analizi
app.post('/api/v1/video/analyze', async (req, res) => {
    const { error, value } = schemaAnalyze.validate(req.body);
    if (error) return res.status(400).json({ detail: error.details[0].message });
    
    try {
        const targetUrl = `https://www.youtube.com/watch?v=${value.video_id}`;
        const data = await fetchFromWorker(targetUrl);
        
        const views = data.view_count || 0;
        const likes = data.like_count || 0;
        const comments = data.comment_count || 0;
        const eng = views > 0 ? parseFloat((((likes + comments) / views) * 100).toFixed(2)) : 0;
        
        res.json({ 
            success: true, 
            video_info: { 
                title: data.title || 'Video Başlığı', 
                description: data.description || '', 
                view_count: views, 
                like_count: likes, 
                total_youtube_comments: comments, 
                thumbnail: `https://i.ytimg.com/vi/${value.video_id}/maxresdefault.jpg`, 
                analysis: { 
                    engagement_rate: `%${eng}`, 
                    channel_contribution_score: eng >= 5 ? 'Yüksek' : 'Normal'
                } 
            }, 
            comments: []
        });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// Frontend'in (index.html vb.) Render üzerinde doğrudan çalışabilmesi için Catch-All kuralı
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));