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
        console.log(`🔍 Kanal çekiliyor: ${cleanUrl}`);
        
        // Kanal ana sayfasını çek
        const html = await fetchFromWorker(cleanUrl);
        
        // Kanal başlığı - <title> tag'inden
        let channelTitle = 'YouTube Kanalı';
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch) {
            channelTitle = titleMatch[1].replace(' - YouTube', '').trim();
        }
        console.log(`📺 Başlık: ${channelTitle}`);

        // Kanal açıklaması - meta description
        let channelDescription = '';
        const descMatch = html.match(/<meta name="description" content="([^"]+)"/i);
        if (descMatch) {
            channelDescription = descMatch[1];
        }

        // Avatar - og:image veya diğer meta taglerden
        let avatarUrl = 'https://yt3.ggpht.com/a/default-user';
        const avatarPatterns = [
            /<link rel="image_src" href="([^"]+)"/,
            /<meta property="og:image" content="([^"]+)"/,
            /"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/
        ];
        for (const pattern of avatarPatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                avatarUrl = match[1].replace(/=s\d+-c/, '=s176-c');
                break;
            }
        }

        // Abone sayısı - Çok agresif regex
        let subscriberCount = 'Gizli';
        const subPatterns = [
            /"subscriberCountText":\{"simpleText":"([^"]+)"/,
            /"label":"([^"]*\d+[^"]*abone[^"]*)"/i,
            /"simpleText":"([^"]*\d+[^"]*abone[^"]*)"/i,
            /"text":"([^"]*\d+[.,\s]*[KMB]?[^"]*abone[^"]*)"/i,
            /(\d+[.,]?\d*\s*[KMB]?\s+abone)/i,
            /"accessibilityData":\{"label":"([^"]+abone[^"]*)"/i
        ];

        for (const pattern of subPatterns) {
            const match = html.match(pattern);
            if (match && match[1] && match[1].match(/\d/)) {
                subscriberCount = match[1].trim();
                // Temizle
                subscriberCount = subscriberCount.replace(/\s+/g, ' ');
                console.log(`👥 Abone bulundu: ${subscriberCount}`);
                break;
            }
        }

        // Toplam video sayısı
        let totalVideosCount = 0;
        const videoCountPatterns = [
            /"videosCountText":\{"runs":\[\{"text":"([0-9.,]+)"/,
            /"text":"([0-9.,]+)\s*video"/i
        ];
        for (const pattern of videoCountPatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                totalVideosCount = parseInt(match[1].replace(/[^0-9]/g, '')) || 0;
                break;
            }
        }

        // Videoları çek - Basit ve etkili
        const videoMap = new Map();
        
        // Önce tüm video ID'lerini topla
        const idRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
        let idMatch;
        while ((idMatch = idRegex.exec(html)) !== null) {
            const vid = idMatch[1];
            if (!videoMap.has(vid)) {
                videoMap.set(vid, { id: vid, title: null });
            }
        }

        console.log(`🎬 ${videoMap.size} video ID bulundu`);

        // Şimdi başlıkları eşleştir - daha basit regex
        const titlePatterns = [
            /"videoId":"([a-zA-Z0-9_-]{11})"[^}]*?"title":\{"runs":\[\{"text":"([^"]+)"/g,
            /"videoId":"([a-zA-Z0-9_-]{11})"[^}]*?"title":\{"simpleText":"([^"]+)"/g,
            /"text":"([^"]+)"[^}]*?"videoId":"([a-zA-Z0-9_-]{11})"/g
        ];

        for (const pattern of titlePatterns) {
            let titleMatch;
            while ((titleMatch = pattern.exec(html)) !== null) {
                const vid = titleMatch[1] || titleMatch[2];
                const title = titleMatch[2] || titleMatch[1];
                
                if (vid && title && vid.length === 11 && videoMap.has(vid)) {
                    videoMap.get(vid).title = title.replace(/\\"/g, '"').replace(/\\\\/g, '');
                }
            }
        }

        // Video listesi oluştur
        const videos = [];
        let index = 0;
        for (const [id, data] of videoMap) {
            videos.push({
                id: id,
                title: data.title || `Video ${index + 1}`,
                thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                url: `https://www.youtube.com/watch?v=${id}`
            });
            index++;
        }

        if (totalVideosCount === 0) totalVideosCount = videos.length;

        console.log(`✅ Kanal: ${channelTitle}`);
        console.log(`👥 Aboneler: ${subscriberCount}`);
        console.log(`🎬 Toplam: ${totalVideosCount} video`);
        console.log(`📹 Çekilen: ${videos.length} video`);

        res.json({
            success: true,
            channel_info: {
                id: "youtube-channel",
                title: channelTitle,
                description: channelDescription || 'Açıklama bulunamadı',
                subscriber_count: subscriberCount,
                total_videos_count: totalVideosCount,
                fetched_videos_count: videos.length,
                avatar: avatarUrl
            },
            videos
        });

    } catch (e) {
        console.error('❌ Kanal Hatası:', e.message);
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
// 3. ENDPOINT: VİDEO ANALİZİ VE YORUMLAR (Basit & Güvenilir)
// ============================================================
app.post('/api/v1/video/analyze', async (req, res) => {
    const { error, value } = schemaAnalyze.validate(req.body);
    if (error) return res.status(400).json({ detail: error.details[0].message });
    
    try {
        console.log(`🎬 Video analiz ediliyor: ${value.video_id}`);
        
        const videoUrl = `https://www.youtube.com/watch?v=${value.video_id}`;
        const html = await fetchFromWorker(videoUrl);

        // Başlık - <title> tag'inden
        let title = 'Video';
        const titleMatch = html.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
            title = titleMatch[1].replace(' - YouTube', '').trim();
        }

        // Açıklama - meta description
        let description = '';
        const descMatch = html.match(/<meta name="description" content="([^"]+)"/);
        if (descMatch) {
            description = descMatch[1];
        }

        // İzlenme sayısı
        let views = 0;
        const viewPatterns = [
            /"viewCount":"(\d+)"/,
            /"view_count":"(\d+)"/,
            /"viewCount":\{"simpleText":"([0-9.,]+)/,
            /([0-9.,]+)\s+görüntülenme/i,
            /([0-9.,]+)\s+views?/i
        ];
        for (const pattern of viewPatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                views = parseInt(match[1].replace(/[^0-9]/g, '')) || 0;
                if (views > 0) break;
            }
        }

        // Beğeni sayısı
        let likes = 0;
        const likePatterns = [
            /"accessibilityData":\{"label":"([0-9.,]+)[^"]*beğen[^"]*"/i,
            /"label":"([0-9.,]+)[^"]*like/i,
            /"defaultText":\{"accessibility":\{"accessibilityData":\{"label":"([0-9.,]+)/,
            /"text":"([0-9.,]+)"[^}]*?"label":"beğen/i
        ];
        for (const pattern of likePatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                likes = parseInt(match[1].replace(/[^0-9]/g, '')) || 0;
                if (likes > 0) break;
            }
        }

        // Yorum sayısı
        let comments = 0;
        const commentPatterns = [
            /"commentsEntryPointHeaderRenderer":\{[^}]*"commentCount":\{"simpleText":"([0-9.,]+)"/,
            /"commentCount":\{"simpleText":"([0-9.,]+)"/,
            /([0-9.,]+)\s+yorum/i,
            /([0-9.,]+)\s+comment/i
        ];
        for (const pattern of commentPatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                comments = parseInt(match[1].replace(/[^0-9]/g, '')) || 0;
                if (comments > 0) break;
            }
        }

        // Video süresi
        let duration = 'Bilinmiyor';
        const durationPatterns = [
            /"lengthSeconds":"(\d+)"/,
            /"approxDurationMs":"(\d+)"/
        ];
        for (const pattern of durationPatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                let seconds = parseInt(match[1]);
                if (pattern.toString().includes('approxDurationMs')) {
                    seconds = Math.floor(seconds / 1000);
                }
                const mins = Math.floor(seconds / 60);
                const secs = seconds % 60;
                duration = `${mins}:${String(secs).padStart(2, '0')}`;
                break;
            }
        }

        // Yayın tarihi
        let publishDate = '';
        const dateMatch = html.match(/"publishDate":"([^"]+)"/);
        if (dateMatch) {
            publishDate = dateMatch[1];
        }

        // Etkileşim hesapla
        const eng = views > 0 ? parseFloat((((likes + comments) / views) * 100).toFixed(2)) : 0;
        const status = eng >= 7 ? 'Efsanevi (Viral)' : eng >= 4 ? 'Yüksek Etkileşim' : eng >= 2 ? 'Normal' : 'Düşük';

        console.log(`✅ Başlık: ${title}`);
        console.log(`👁️  İzlenme: ${views.toLocaleString('tr-TR')}`);
        console.log(`👍 Beğeni: ${likes.toLocaleString('tr-TR')}`);
        console.log(`💬 Yorum: ${comments.toLocaleString('tr-TR')}`);
        console.log(`⏱️  Süre: ${duration}`);
        console.log(`📊 Etkileşim: %${eng} - ${status}`);

        res.json({ 
            success: true, 
            video_info: { 
                id: value.video_id,
                title: title, 
                description: description.substring(0, 300) || 'Açıklama yok', 
                view_count: views.toLocaleString('tr-TR'), 
                like_count: likes.toLocaleString('tr-TR'), 
                total_comments: comments.toLocaleString('tr-TR'),
                duration: duration,
                publish_date: publishDate || 'Bilinmiyor',
                thumbnail: `https://i.ytimg.com/vi/${value.video_id}/maxresdefault.jpg`, 
                analysis: { 
                    engagement_rate: `%${eng}`, 
                    score: status 
                } 
            }
        });
    } catch (e) {
        console.error('❌ Video Hatası:', e.message);
        res.status(500).json({ detail: e.message });
    }
});

// ============================================================
// TEST ENDPOINT: HTML içeriğinin ilk 5000 karakterini göster
// ============================================================
app.post('/api/v1/debug/fetch', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'url parametresi gerekli' });
        
        console.log(`🔍 Debug fetch: ${url}`);
        const html = await fetchFromWorker(url);
        
        res.json({
            success: true,
            url: url,
            htmlLength: html.length,
            preview: html.substring(0, 5000),
            hasYtInitialData: html.includes('ytInitialData'),
            hasVideoId: html.includes('videoId'),
            hasSubscriberCount: html.includes('subscriberCount')
        });
    } catch (e) {
        console.error('❌ Debug fetch hatası:', e);
        res.status(500).json({ error: e.message });
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