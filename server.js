const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const path = require('path');

dotenv.config();
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLOUDFLARE_WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || 'https://yt-proxy.psoresmi.workers.dev';

async function fetchFromWorker(targetUrl) {
    try {
        const response = await axios.get(CLOUDFLARE_WORKER_URL, {
            params: { url: targetUrl },
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    } catch (error) {
        throw new Error(error.response?.status === 429 ? 'Rate limit hit' : error.message);
    }
}

// HTML içinden ytInitialData JSON'ını güvenlice koparan fonksiyon
function extractYtData(html) {
    try {
        const match = html.match(/var ytInitialData\s*=\s*({.+?});\s*<\/script>/) || 
                      html.match(/window\["ytInitialData"\]\s*=\s*({.+?});/);
        return match ? JSON.parse(match[1]) : null;
    } catch {
        return null;
    }
}

// 1. ENDPOINT: KANAL BİLGİLERİ VE VİDEOLARI
app.post('/api/v1/channel/init-public', async (req, res) => {
    const { channel_url } = req.body;
    if (!channel_url) return res.status(400).json({ detail: 'Kanal URL zorunlu.' });

    try {
        const html = await fetchFromWorker(channel_url.replace(/\/$/, ''));
        const ytData = extractYtData(html);

        if (!ytData) throw new Error('YouTube veri yapısı ayrıştırılamadı.');

        // Kanal üst bilgileri (Header)
        const header = ytData.header?.c4TabbedHeaderRenderer || ytData.header?.pageHeaderRenderer;
        
        const channelTitle = ytData.metadata?.channelMetadataRenderer?.title || 
                             header?.title || 'YouTube Kanalı';
                             
        const channelDescription = ytData.metadata?.channelMetadataRenderer?.description || 'Açıklama bulunamadı.';
        
        const avatarUrl = ytData.metadata?.channelMetadataRenderer?.avatar?.thumbnails?.[0]?.url || 
                          header?.avatar?.thumbnails?.[0]?.url || '';

        // KESİN ÇÖZÜM: Abone Sayısı Ayıklama (Farklı YouTube şablonlarına uyumlu)
        let subscriberCount = 'Gizli';
        if (header?.subscriberCountText?.simpleText) {
            subscriberCount = header.subscriberCountText.simpleText;
        } else if (header?.content?.pageHeaderViewModel?.metadata?.contentMetadataViewModel?.metadataRows) {
            const rows = header.content.pageHeaderViewModel.metadata.contentMetadataViewModel.metadataRows;
            for (const row of rows) {
                const text = row.metadataParts?.[0]?.text?.content;
                if (text && (text.includes('abone') || text.includes('subscriber'))) {
                    subscriberCount = text;
                    break;
                }
            }
        }

        // Videoları JSON Ağacından Toplama (Kırılma ihtimali yok, başlıklar tam gelir)
        const videos = [];
        const tabs = ytData.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
        const homeOrVideosTab = tabs.find(t => t.tabRenderer?.selected) || tabs[0];
        const contents = homeOrVideosTab?.tabRenderer?.content?.richGridRenderer?.contents || 
                         homeOrVideosTab?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.gridRenderer?.items || [];

        contents.forEach(item => {
            const video = item.richItemRenderer?.content?.videoRenderer || item.videoRenderer;
            if (video && video.videoId) {
                videos.push({
                    id: video.videoId,
                    title: video.title?.runs?.[0]?.text || video.title?.simpleText || 'Başlıksız Video',
                    thumbnail: `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`
                });
            }
        });

        // Fallback: JSON derinliğinden çıkmazsa eski usul regex destekli toplayıcı (Ama başlıkları kurtararak)
        if (videos.length === 0) {
            const idMatches = [...html.matchAll(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g)];
            const uniqueIds = [...new Set(idMatches.map(m => m[1]))];
            uniqueIds.slice(0, 20).forEach((id, idx) => {
                videos.push({ id, title: `Video (${id})`, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
            });
        }

        res.json({
            success: true,
            channel_info: {
                title: channelTitle,
                description: channelDescription,
                subscriber_count: subscriberCount.replace('·', '').trim(),
                total_videos_count: videos.length,
                avatar: avatarUrl
            },
            videos
        });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// 2. ENDPOINT: VİDEO ANALİZİ
app.post('/api/v1/video/analyze', async (req, res) => {
    const { video_id } = req.body;
    if (!video_id) return res.status(400).json({ detail: 'video_id zorunlu.' });

    try {
        const html = await fetchFromWorker(`https://www.youtube.com/watch?v=${video_id}`);
        
        let title = 'Video Başlığı';
        const tMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
        if (tMatch) title = tMatch[1].replace(' - YouTube', '').trim();

        let description = 'Açıklama yok.';
        const dMatch = html.match(/<meta name="description" content="([^"]+)"/i);
        if (dMatch) description = dMatch[1];

        // İzlenme Sayısı
        let views = 0;
        const viewMatch = html.match(/"viewCount"\s*:\s*"(\d+)"/i) || html.match(/<meta itemprop="interactionCount" content="(\d+)"/i);
        if (viewMatch) views = parseInt(viewMatch[1]) || 0;

        // Beğeni Sayısı
        let likes = 0;
        const likeMatch = html.match(/"label"\s*:\s*"([0-9.,\s]*)\s*(beğeni|like)/i);
        if (likeMatch) {
            likes = parseInt(likeMatch[1].replace(/[^0-9]/g, '')) || 0;
        } else {
            const cleanHtml = html.replace(/&quot;/g, '"').replace(/\\/g, '');
            const countMatch = cleanHtml.match(/"likeCountViewModel"\s*:\s*\{\s*"likeCountText"\s*:\s*\{\s*"content"\s*:\s*"([0-9.,KMB\s]+)"/i);
            if (countMatch) likes = countMatch[1];
        }

        // Yorum Sayısı
        let comments = 0;
        const commentMatch = html.match(/"commentCount"\s*:\s*\{\s*"simpleText"\s*:\s*"([0-9.,]+)"\}/i) || 
                             html.match(/"text"\s*:\s*\{\s*"content"\s*:\s*"([0-9.,]+)\s*Yorum"/i);
        if (commentMatch) comments = parseInt(commentMatch[1].replace(/[^0-9]/g, '')) || 0;

        // Süre
        let duration = 'Bilinmiyor';
        const lenMatch = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/i);
        if (lenMatch) {
            const sec = parseInt(lenMatch[1]);
            duration = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
        }

        // Metrik Hesaplama
        const parsedLikes = typeof likes === 'string' ? parseInt(likes.replace(/[^0-9]/g, '')) || 0 : likes;
        const eng = views > 0 ? parseFloat((((parsedLikes + comments) / views) * 100).toFixed(2)) : 0;
        const score = eng >= 6 ? 'Efsanevi' : eng >= 3 ? 'Yüksek' : eng >= 1 ? 'Normal' : 'Düşük';

        res.json({
            success: true,
            video_info: {
                title,
                description: description.substring(0, 150) + '...',
                view_count: views.toLocaleString('tr-TR'),
                like_count: parsedLikes > 0 ? parsedLikes.toLocaleString('tr-TR') : (likes || 'Gizli/Yok'),
                total_comments: comments > 0 ? comments.toLocaleString('tr-TR') : 'Gizli/Yok',
                duration,
                thumbnail: `https://i.ytimg.com/vi/${video_id}/mqdefault.jpg`,
                analysis: { engagement_rate: `%${eng}`, score }
            }
        });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Sunucu ${PORT} portunda aktif.`));