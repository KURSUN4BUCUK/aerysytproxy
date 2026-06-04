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
        let html = await fetchFromWorker(cleanUrl);
        
        // ytInitialData JSON'unu çıkar
        let ytInitialData = null;
        const scriptMatch = html.match(/var ytInitialData = (\{.+?\});/);
        if (scriptMatch) {
            try {
                ytInitialData = JSON.parse(scriptMatch[1]);
            } catch (e) {
                console.log('⚠️ ytInitialData parse edilemedi, regex ile devam ediliyor');
            }
        }

        // Kanal başlığı
        let channelTitle = 'YouTube Kanalı';
        if (ytInitialData) {
            try {
                const metadata = ytInitialData.metadata?.channelMetadataRenderer;
                if (metadata?.title) channelTitle = metadata.title;
            } catch (e) {}
        }
        if (channelTitle === 'YouTube Kanalı') {
            const titleMatch = html.match(/<title>(.*?)<\/title>/i);
            if (titleMatch) channelTitle = titleMatch[1].replace(' - YouTube', '').trim();
        }

        // Kanal açıklaması
        let channelDescription = 'Açıklama bulunamadı.';
        if (ytInitialData) {
            try {
                const metadata = ytInitialData.metadata?.channelMetadataRenderer;
                if (metadata?.description) {
                    channelDescription = metadata.description;
                }
            } catch (e) {}
        }
        if (channelDescription === 'Açıklama bulunamadı.') {
            const metaDesc = html.match(/<meta name="description" content="([^"]+)"/);
            if (metaDesc) channelDescription = metaDesc[1];
        }

        // Avatar
        let avatarUrl = 'https://yt3.ggpht.com/a/default-user';
        if (ytInitialData) {
            try {
                const metadata = ytInitialData.metadata?.channelMetadataRenderer;
                if (metadata?.avatar?.thumbnails?.[0]?.url) {
                    avatarUrl = metadata.avatar.thumbnails[0].url;
                }
            } catch (e) {}
        }

        // Abone sayısı - Daha agresif arama
        let subscriberCount = 'Gizli';
        
        // ytInitialData'dan abone sayısı
        if (ytInitialData) {
            try {
                const header = ytInitialData.header?.c4TabbedHeaderRenderer || ytInitialData.header?.pageHeaderRenderer;
                
                if (header?.subscriberCountText) {
                    const subText = header.subscriberCountText;
                    if (subText.simpleText) {
                        subscriberCount = subText.simpleText;
                    } else if (subText.runs && subText.runs[0]?.text) {
                        subscriberCount = subText.runs[0].text;
                    }
                }
            } catch (e) {
                console.log('⚠️ ytInitialData\'dan abone çekilemedi:', e.message);
            }
        }

        // Regex fallback
        if (subscriberCount === 'Gizli') {
            const patterns = [
                /"subscriberCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+\s+abone[^"]*)"/i,
                /"subscriberCountText":\{"simpleText":"([^"]+)"/,
                /"label":"([0-9.,KMB]+\s*abone[^"]*)"/i,
                /([0-9.,]+[KMB]?\s+abone)/i,
                /"text":"([0-9.,]+[KMB]?\s*abone[^"]*)"/i
            ];

            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (match && match[1]) {
                    subscriberCount = match[1].trim().replace('abone', 'abone');
                    break;
                }
            }
        }

        console.log(`👥 Abone sayısı bulundu: ${subscriberCount}`);

        // Toplam video sayısı
        let totalVideosCount = 0;
        if (ytInitialData) {
            try {
                const header = ytInitialData.header?.c4TabbedHeaderRenderer;
                if (header?.videosCountText?.runs?.[0]?.text) {
                    const countText = header.videosCountText.runs[0].text.replace(/\D/g, '');
                    totalVideosCount = parseInt(countText) || 0;
                }
            } catch (e) {}
        }

        // Videoları çek
        const videoDetailsMap = new Map();
        
        if (ytInitialData) {
            try {
                const tabs = ytInitialData.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
                
                for (const tab of tabs) {
                    const tabRenderer = tab.tabRenderer;
                    if (!tabRenderer?.content) continue;

                    const richGrid = tabRenderer.content.richGridRenderer?.contents || [];
                    const sectionList = tabRenderer.content.sectionListRenderer?.contents || [];

                    // richGridRenderer'dan videolar
                    for (const item of richGrid) {
                        const videoRenderer = item.richItemRenderer?.content?.videoRenderer;
                        if (videoRenderer?.videoId) {
                            const vid = videoRenderer.videoId;
                            const title = videoRenderer.title?.runs?.[0]?.text || 
                                         videoRenderer.title?.simpleText || 
                                         'Video';
                            
                            videoDetailsMap.set(vid, {
                                id: vid,
                                title: title
                            });
                        }
                    }

                    // sectionListRenderer'dan videolar
                    for (const section of sectionList) {
                        const items = section.itemSectionRenderer?.contents || [];
                        for (const item of items) {
                            const gridRenderer = item.gridRenderer?.items || [];
                            for (const gridItem of gridRenderer) {
                                const videoRenderer = gridItem.gridVideoRenderer;
                                if (videoRenderer?.videoId) {
                                    const vid = videoRenderer.videoId;
                                    const title = videoRenderer.title?.runs?.[0]?.text || 
                                                 videoRenderer.title?.simpleText || 
                                                 'Video';
                                    
                                    videoDetailsMap.set(vid, {
                                        id: vid,
                                        title: title
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.log('⚠️ ytInitialData\'dan video çekilemedi:', e.message);
            }
        }

        // Regex fallback ile video çek
        if (videoDetailsMap.size === 0) {
            console.log('📝 Regex ile video çekiliyor...');
            const videoPattern = /"videoId":"([a-zA-Z0-9_-]{11})"[^}]{0,500}?"title":\{(?:"runs":\[\{"text":"([^"]+)"|"simpleText":"([^"]+)")/g;
            let match;
            while ((match = videoPattern.exec(html)) !== null) {
                const videoId = match[1];
                const title = match[2] || match[3] || 'Video';
                if (!videoDetailsMap.has(videoId)) {
                    videoDetailsMap.set(videoId, { id: videoId, title: title });
                }
            }
        }

        const videos = Array.from(videoDetailsMap.values()).map(v => ({
            id: v.id,
            title: v.title,
            thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${v.id}`
        }));

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
// 3. ENDPOINT: VİDEO ANALİZİ VE YORUMLAR (Gerçek Verilerle)
// ============================================================
app.post('/api/v1/video/analyze', async (req, res) => {
    const { error, value } = schemaAnalyze.validate(req.body);
    if (error) return res.status(400).json({ detail: error.details[0].message });
    
    try {
        console.log(`🎬 Video analiz ediliyor: ${value.video_id}`);
        
        const videoUrl = `https://www.youtube.com/watch?v=${value.video_id}`;
        const html = await fetchFromWorker(videoUrl);
        
        // ytInitialData çıkar
        let ytData = null;
        const scriptMatch = html.match(/var ytInitialData = (\{.+?\});/);
        if (scriptMatch) {
            try {
                ytData = JSON.parse(scriptMatch[1]);
            } catch (e) {
                console.log('⚠️ ytInitialData parse edilemedi');
            }
        }

        let title = 'Video Başlığı';
        let description = '';
        let views = 0;
        let likes = 0;
        let comments = 0;
        let duration = '';
        let publishDate = '';

        // ytInitialData'dan bilgileri çek
        if (ytData) {
            try {
                const videoDetails = ytData.videoDetails;
                const videoPrimaryInfo = ytData.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[0]?.videoPrimaryInfoRenderer;
                const videoSecondaryInfo = ytData.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[1]?.videoSecondaryInfoRenderer;

                // Başlık
                if (videoDetails?.title) {
                    title = videoDetails.title;
                }

                // Açıklama
                if (videoDetails?.shortDescription) {
                    description = videoDetails.shortDescription;
                }

                // İzlenme sayısı
                if (videoDetails?.viewCount) {
                    views = parseInt(videoDetails.viewCount) || 0;
                }

                // Süre
                if (videoDetails?.lengthSeconds) {
                    const sec = parseInt(videoDetails.lengthSeconds);
                    const mins = Math.floor(sec / 60);
                    const secs = sec % 60;
                    duration = `${mins}:${String(secs).padStart(2, '0')}`;
                }

                // Beğeni sayısı
                if (videoPrimaryInfo?.videoActions?.menuRenderer?.topLevelButtons) {
                    const buttons = videoPrimaryInfo.videoActions.menuRenderer.topLevelButtons;
                    for (const btn of buttons) {
                        const toggleButton = btn.segmentedLikeDislikeButtonRenderer?.likeButton?.toggleButtonRenderer;
                        if (toggleButton?.defaultText?.accessibility?.accessibilityData?.label) {
                            const label = toggleButton.defaultText.accessibility.accessibilityData.label;
                            const likeMatch = label.match(/([0-9.,]+)/);
                            if (likeMatch) {
                                likes = parseInt(likeMatch[1].replace(/[.,]/g, '')) || 0;
                            }
                        }
                    }
                }

                // Yorum sayısı
                if (ytData.contents?.twoColumnWatchNextResults?.results?.results?.contents) {
                    const contents = ytData.contents.twoColumnWatchNextResults.results.results.contents;
                    for (const item of contents) {
                        const commentRenderer = item.itemSectionRenderer?.contents?.[0]?.commentsEntryPointHeaderRenderer;
                        if (commentRenderer?.commentCount?.simpleText) {
                            const commentText = commentRenderer.commentCount.simpleText;
                            const commentMatch = commentText.match(/([0-9.,]+)/);
                            if (commentMatch) {
                                comments = parseInt(commentMatch[1].replace(/[.,]/g, '')) || 0;
                            }
                        }
                    }
                }

                // Yayın tarihi
                if (videoSecondaryInfo?.dateText?.simpleText) {
                    publishDate = videoSecondaryInfo.dateText.simpleText;
                }

            } catch (e) {
                console.log('⚠️ Video detayları parse hatası:', e.message);
            }
        }

        // Regex fallback
        if (views === 0) {
            const viewMatch = html.match(/"viewCount":"(\d+)"/);
            if (viewMatch) views = parseInt(viewMatch[1]) || 0;
        }

        if (likes === 0) {
            const likePatterns = [
                /"label":"([0-9.,]+)[^"]*beğeni"/i,
                /"accessibilityData":\{"label":"([0-9.,]+)[^"]*like"/i
            ];
            for (const pattern of likePatterns) {
                const match = html.match(pattern);
                if (match) {
                    likes = parseInt(match[1].replace(/[.,]/g, '')) || 0;
                    break;
                }
            }
        }

        if (title === 'Video Başlığı') {
            const titleMatch = html.match(/<title>(.*?)<\/title>/);
            if (titleMatch) title = titleMatch[1].replace(' - YouTube', '').trim();
        }

        // Etkileşim hesapla
        const eng = views > 0 ? parseFloat((((likes + comments) / views) * 100).toFixed(2)) : 0;
        const status = eng >= 7 ? 'Efsanevi (Viral)' : eng >= 4 ? 'Yüksek Etkileşim' : eng >= 2 ? 'Normal' : 'Düşük';

        console.log(`✅ ${title}`);
        console.log(`👁️ İzlenme: ${views.toLocaleString('tr-TR')}`);
        console.log(`👍 Beğeni: ${likes.toLocaleString('tr-TR')}`);
        console.log(`💬 Yorum: ${comments.toLocaleString('tr-TR')}`);
        console.log(`📊 Etkileşim: %${eng}`);

        res.json({ 
            success: true, 
            video_info: { 
                id: value.video_id,
                title: title, 
                description: description.substring(0, 300) || 'Açıklama yok', 
                view_count: views.toLocaleString('tr-TR'), 
                like_count: likes.toLocaleString('tr-TR'), 
                total_comments: comments.toLocaleString('tr-TR'),
                duration: duration || 'Bilinmiyor',
                publish_date: publishDate || 'Bilinmiyor',
                thumbnail: `https://i.ytimg.com/vi/${value.video_id}/maxresdefault.jpg`, 
                analysis: { 
                    engagement_rate: `%${eng}`, 
                    score: status 
                } 
            }
        });
    } catch (e) {
        console.error('❌ Video analiz hatası:', e);
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