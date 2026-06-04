const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

dotenv.config();
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Render.com Linux ortamı ve lokal ortam binary ayrıştırma köprüsü
const YT_DLP_PATH = fs.existsSync(path.join(process.cwd(), 'bin', 'yt-dlp')) 
    ? path.join(process.cwd(), 'bin', 'yt-dlp') 
    : 'yt-dlp';

function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        execFile(YT_DLP_PATH, args, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(stderr || error.message));
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(new Error('JSON parse hatası: ' + e.message));
            }
        });
    });
}

// 1. ENDPOINT: KANAL BİLGİLERİ VE TÜM VİDEOLAR (PARALEL SİSTEM)
app.post('/api/v1/channel/init-public', async (req, res) => {
    let { channel_url } = req.body;
    if (!channel_url) return res.status(400).json({ detail: 'Kanal URL zorunlu.' });

    if (!channel_url.includes('youtube.com')) {
        channel_url = `https://www.youtube.com/${channel_url.startsWith('@') ? '' : '@'}${channel_url}`;
    }
    
    const baseChannelUrl = channel_url.replace(/\/videos$/, '').replace(/\/$/, '');
    const videosTabUrl = `${baseChannelUrl}/videos`;

    try {
        const metaArgs = ['--dump-single-json', '--playlist-end', '0', baseChannelUrl];
        const videoArgs = ['--flat-playlist', '--dump-single-json', videosTabUrl];

        // Paralel işleme katmanı
        const [metaOutput, videoOutput] = await Promise.all([
            runYtDlp(metaArgs).catch(err => {
                console.warn('Meta verisi alınırken hata oluştu, fallback kullanılacak:', err.message);
                return null;
            }),
            runYtDlp(videoArgs)
        ]);

        if (!videoOutput || !videoOutput.entries) {
            throw new Error('Kanalın videoları YouTube katmanından çekilemedi.');
        }

        // Sınırsız Video Listeleme
        const videos = videoOutput.entries.map(entry => ({
            id: entry.id,
            title: entry.title || 'Başlıksız Video',
            thumbnail: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`
        }));

        // Abone Sayısı Ayrıştırma
        const activeMeta = metaOutput || videoOutput;
        let subscriberCount = 'Gizli/Yok';
        if (activeMeta.channel_follower_count) {
            subscriberCount = activeMeta.channel_follower_count.toLocaleString('tr-TR');
        } else if (activeMeta.subscriber_count) {
            subscriberCount = activeMeta.subscriber_count.toLocaleString('tr-TR');
        }

        // Yüksek Çözünürlüklü Avatar Çözümleme
        let avatarUrl = 'https://www.youtube.com/s/desktop/2df1f206/img/avatar_placeholder_dark.png';
        if (activeMeta.thumbnails && activeMeta.thumbnails.length > 0) {
            const avatarThumb = activeMeta.thumbnails.find(t => t.id === 'avatar') || activeMeta.thumbnails[activeMeta.thumbnails.length - 1];
            if (avatarThumb && avatarThumb.url) avatarUrl = avatarThumb.url;
        }

        res.json({
            success: true,
            channel_info: {
                title: activeMeta.title || videoOutput.title || 'YouTube Kanalı',
                description: activeMeta.description || 'Açıklama bulunamadı.',
                subscriber_count: subscriberCount,
                total_videos_count: videos.length,
                avatar: avatarUrl
            },
            videos
        });
    } catch (e) {
        console.error('Kritik Kanal Hatası:', e.message);
        res.status(500).json({ detail: 'Sistem hatası: ' + e.message });
    }
});

// 2. ENDPOINT: VİDEO METRİKLERİ VE ANALİZİ
app.post('/api/v1/video/analyze', async (req, res) => {
    const { video_id } = req.body;
    if (!video_id) return res.status(400).json({ detail: 'video_id zorunlu.' });

    try {
        const videoUrl = `https://www.youtube.com/watch?v=${video_id}`;
        const args = ['--dump-json', videoUrl];
        
        const output = await runYtDlp(args);

        const views = output.view_count || 0;
        const likes = output.like_count || 0;
        const comments = output.comment_count || 0;
        
        let duration = 'Bilinmiyor';
        if (output.duration) {
            const sec = parseInt(output.duration);
            duration = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
        }

        const eng = views > 0 ? parseFloat((((likes + comments) / views) * 100).toFixed(2)) : 0;
        const score = eng >= 6 ? 'Efsanevi' : eng >= 3 ? 'Yüksek' : eng >= 1 ? 'Normal' : 'Düşük';

        res.json({
            success: true,
            video_info: {
                title: output.title || 'Video Başlığı',
                description: (output.description || 'Açıklama yok.').substring(0, 150) + '...',
                view_count: views.toLocaleString('tr-TR'),
                like_count: likes > 0 ? likes.toLocaleString('tr-TR') : 'Gizli/Yok',
                total_comments: comments > 0 ? comments.toLocaleString('tr-TR') : 'Gizli/Yok',
                duration,
                thumbnail: output.thumbnail || `https://i.ytimg.com/vi/${video_id}/mqdefault.jpg`,
                analysis: { engagement_rate: `%${eng}`, score }
            }
        });
    } catch (e) {
        console.error('yt-dlp Video Hatası:', e.message);
        res.status(500).json({ detail: 'Video verileri çekilemedi: ' + e.message });
    }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 [Aerys Engine v2 - Production Ready] Port: ${PORT}`));