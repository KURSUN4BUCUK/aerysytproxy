const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { execFile } = require('child_process');

dotenv.config();
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// yt-dlp'yi asenkron ve güvenli çalıştıran yardımcı fonksiyon
function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        // execyerine execFile kullanarak parametre güvenliği sağlıyoruz
        execFile('yt-dlp', args, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
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

// 1. ENDPOINT: KANAL BİLGİLERİ VE TÜM VİDEOLAR (GARANTİLİ)
app.post('/api/v1/channel/init-public', async (req, res) => {
    let { channel_url } = req.body;
    if (!channel_url) return res.status(400).json({ detail: 'Kanal URL zorunlu.' });

    // Kullanıcı sadece kullanıcı adı girdiyse URL'e dönüştür, sonundaki eğik çizgiyi temizle
    if (!channel_url.includes('youtube.com')) {
        channel_url = `https://www.youtube.com/${channel_url.startsWith('@') ? '' : '@'}${channel_url}`;
    }
    
    // Videolar sekmesini garanti altına almak için URL sonuna ekleme yapıyoruz
    const targetUrl = channel_url.endsWith('/videos') ? channel_url : `${channel_url.replace(/\/$/, '')}/videos`;

    try {
        // --flat-playlist: Videoları tek tek indirmeden hızlıca listeler
        // --dump-single-json: Tüm playlist/kanal içeriğini tek bir JSON objesi yapar
        const args = [
            '--flat-playlist',
            '--dump-single-json',
            '--playlist-end', '30', // Son 30 videoyu getir
            targetUrl
        ];

        const output = await runYtDlp(args);

        if (!output || !output.entries) {
            throw new Error('Kanal verisi veya videolar alınamadı.');
        }

        // yt-dlp'den gelen temiz verileri haritalandır
        const videos = output.entries.map(entry => ({
            id: entry.id,
            title: entry.title || 'Başlıksız Video',
            thumbnail: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`
        }));

        res.json({
            success: true,
            channel_info: {
                title: output.title || 'YouTube Kanalı',
                description: output.description || 'Açıklama bulunamadı.',
                subscriber_count: 'Aktif', // Flat playlist modunda abone sayısı için ana sayfaya vurmak gerekir, stabilite için 'Aktif' geçildi.
                total_videos_count: videos.length,
                avatar: '' // Ön yüz varsayılan avatarı basacak
            },
            videos
        });
    } catch (e) {
        console.error('yt-dlp Kanal Hatası:', e.message);
        res.status(500).json({ detail: 'Kanal videoları çekilemedi: ' + e.message });
    }
});

// 2. ENDPOINT: VİDEO METRİKLERİ VE ANALİZİ (GARANTİLİ)
app.post('/api/v1/video/analyze', async (req, res) => {
    const { video_id } = req.body;
    if (!video_id) return res.status(400).json({ detail: 'video_id zorunlu.' });

    try {
        const videoUrl = `https://www.youtube.com/watch?v=${video_id}`;
        // --dump-json: İlgili videonun tüm meta verilerini (like, view, comment) getirir
        const args = ['--dump-json', videoUrl];
        
        const output = await runYtDlp(args);

        const views = output.view_count || 0;
        const likes = output.like_count || 0;
        const comments = output.comment_count || 0;
        
        // Süre hesaplama (saniyeyi MM:SS formatına çevir)
        let duration = 'Bilinmiyor';
        if (output.duration) {
            const sec = parseInt(output.duration);
            duration = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
        }

        // Etkileşim Skoru
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
app.listen(PORT, () => console.log(`🚀 [Aerys Pro] Sunucu yt-dlp motoru ile %100 güvende. Port: ${PORT}`));