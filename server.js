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
    const response = await axios.get(CLOUDFLARE_WORKER_URL, {
        params: { url: targetUrl },
        timeout: 30000,
        responseType: 'text'
    });

    return response.data;
}

const schemaChannel = Joi.object({ channel_url: Joi.string().uri().required() });
const schemaAnalyze = Joi.object({ video_id: Joi.string().required(), comment_limit: Joi.number().integer().min(1).default(100) });

// ============================================================
// 1. ENDPOINT: KANAL BİLGİLERİ VE VİDEOLARI
// ============================================================
app.post('/api/v1/channel/init-public', async (req, res) => {
    const { error, value } = schemaChannel.validate(req.body);
    if (error) {
        return res.status(400).json({
            detail: error.details[0].message
        });
    }

    try {
        const cleanUrl = value.channel_url.replace(/\/$/, '');
        
        // Kanal ana sayfasını çek
        let html = await fetchFromWorker(cleanUrl);

        // Kanal başlığı
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const channelTitle = titleMatch ? titleMatch[1].replace(' - YouTube', '').trim() : 'YouTube Kanalı';

        // Kanal açıklaması - daha kapsamlı regex
        let channelDescription = 'Açıklama bulunamadı.';
        const descMatches = [
            html.match(/"description":\{"simpleText":"([^"]+)"\}/),
            html.match(/"description":"([^"]+)"/),
            html.match(/<meta name="description" content="([^"]+)"/)
        ];
        for (const match of descMatches) {
            if (match && match[1]) {
                channelDescription = match[1].replace(/\\n/g, ' ').replace(/\\/g, '');
                break;
            }
        }

        // Avatar resmi
        let avatarUrl = 'https://www.youtube.com/s/desktop/2df1f206/img/avatar_placeholder_dark.png';
        const avatarMatches = [
            html.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/),
            html.match(/"channelBannerHeaderRenderer":\{"image":\{"thumbnails":\[\{"url":"([^"]+)"/),
            html.match(/"width":88,"height":88\},"url":"([^"]+)"/)
        ];
        for (const match of avatarMatches) {
            if (match && match[1]) {
                avatarUrl = match[1].replace(/\\u0026/g, '&').replace(/\\/g, '');
                break;
            }
        }

        // Abone sayısı - çok daha kapsamlı regex setleri
        let subscriberCount = 'Gizli veya Bilinmiyor';
        const subMatches = [
            html.match(/"subscriberCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"/),
            html.match(/"subscriberCountText":\{"simpleText":"([^"]+)"/),
            html.match(/"subscriberCountText":\{"runs":\[\{"text":"([^"]+)"/),
            html.match(/(\d+[\.,]?\d*[KMB]?) abone/i),
            html.match(/(\d+[\.,]?\d*[KMB]?) subscriber/i)
        ];
        for (const match of subMatches) {
            if (match && match[1]) {
                subscriberCount = match[1].trim();
                break;
            }
        }

        // Toplam video sayısı
        let totalVideosCount = 0;
        const videoCountMatches = [
            html.match(/"videosCountText":\{"runs":\[\{"text":"([^"]+)"\}/),
            html.match(/(\d+[\.,]?\d*) video/i)
        ];
        for (const match of videoCountMatches) {
            if (match && match[1]) {
                const numStr = match[1].replace(/[^\d]/g, '');
                totalVideosCount = parseInt(numStr) || 0;
                break;
            }
        }

        // Videoları çek - TÜM VİDEOLARI
        const videoRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
        const videoDetailsMap = new Map();
        let match;

        // Video ID'lerini topla
        while ((match = videoRegex.exec(html)) !== null) {
            const id = match[1];
            if (!videoDetailsMap.has(id)) {
                videoDetailsMap.set(id, { id });
            }
        }

        console.log(`✅ ${videoDetailsMap.size} benzersiz video ID bulundu`);

        // Video başlıklarını ve thumbnailleri çıkar
        const titleRegex = /"videoId":"([a-zA-Z0-9_-]{11})"[^}]*"title":\{"runs":\[\{"text":"([^"]+)"\}\]/g;
        const titleSimpleRegex = /"videoId":"([a-zA-Z0-9_-]{11})"[^}]*"title":\{"simpleText":"([^"]+)"\}/g;
        
        let videoTitleMatch;
        while ((videoTitleMatch = titleRegex.exec(html)) !== null) {
            const [, videoId, title] = videoTitleMatch;
            if (videoDetailsMap.has(videoId)) {
                const video = videoDetailsMap.get(videoId);
                video.title = title.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
        }

        while ((videoTitleMatch = titleSimpleRegex.exec(html)) !== null) {
            const [, videoId, title] = videoTitleMatch;
            if (videoDetailsMap.has(videoId) && !videoDetailsMap.get(videoId).title) {
                const video = videoDetailsMap.get(videoId);
                video.title = title.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
        }

        // Video listesini oluştur
        const videos = Array.from(videoDetailsMap.values()).map((video, index) => ({
            id: video.id,
            title: video.title || `Video ${index + 1}`,
            thumbnail: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${video.id}`
        }));

        // Eğer toplam video sayısı bulunamadıysa, çekilen video sayısını kullan
        if (totalVideosCount === 0) {
            totalVideosCount = videos.length;
        }

        console.log(`📊 Kanal: ${channelTitle}`);
        console.log(`👥 Aboneler: ${subscriberCount}`);
        console.log(`🎬 Toplam Video: ${totalVideosCount}`);
        console.log(`📹 Çekilen Video: ${videos.length}`);

        res.json({
            success: true,
            channel_info: {
                id: "youtube-channel",
                title: channelTitle,
                description: channelDescription,
                subscriber_count: subscriberCount,
                total_videos_count: totalVideosCount,
                fetched_videos_count: videos.length,
                avatar: avatarUrl
            },
            videos
        });

    } catch (e) {
        console.error('❌ Hata:', e);
        res.status(500).json({
            detail: e.message
        });
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