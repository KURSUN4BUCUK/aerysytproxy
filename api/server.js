const express = require('express');
const YTDlpWrap = require('yt-dlp-wrap').default;
const path = require('path');
const fs = require('fs');

const app = express(); // Webpack hatası düzeltildi kanka, temizlendi
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const isWindows = process.platform === 'win32';
const binaryPath = path.join(__dirname, 'bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp');

app.get('/api/scrape', async (req, res) => {
    try {
        let { channel } = req.query;
        if (!channel) return res.status(400).json({ error: 'Kanal linki gerekli.' });

        // 1. ADIM: Girdiyi decode et ve proxy varsa temizle
        let decodedChannel = decodeURIComponent(channel.trim());
        if (decodedChannel.includes('yt-proxy.psoresmi.workers.dev')) {
            const urlParams = new URLSearchParams(decodedChannel.split('?')[1]);
            if (urlParams.has('url')) decodedChannel = urlParams.get('url');
        }

        // 2. ADIM: Sadece handle kısmını cımbızla çekiyoruz
        let handle = '';
        const handleMatch = decodedChannel.match(/(@[\w\.\-]+)/);
        if (handleMatch) {
            handle = handleMatch[1];
        } else {
            handle = '@' + decodedChannel.replace(/[^a-zA-Z0-9\.\-_]/g, '');
        }

        // Doğrudan kanalın /videos sekmesine vuruyoruz (Ultra hızlı mod)
        const targetYoutubeUrl = `https://www.youtube.com/${handle}/videos`;
        console.log(`[Fast Engine Launching]: ${targetYoutubeUrl}`);

        if (!fs.existsSync(binaryPath)) {
            return res.status(500).json({ error: 'yt-dlp binary bulunamadı.' });
        }
        
        const ytDlpWrap = new YTDlpWrap(binaryPath);

        // En hızlı veri okuma parametreleri ayarlandı
        let stdout = await ytDlpWrap.execPromise([
            targetYoutubeUrl,
            '--dump-single-json',
            '--playlist-end', '50',
            '--no-warnings',
            '--no-check-certificates',
            '--flat-playlist',
            '--extractor-args', 'youtube:player_client=web'
        ]);

        const ytData = JSON.parse(stdout);

        // 3. ADIM: Üst Düzey Meta Veri Ayıklama
        const channelName = ytData.title || ytData.uploader || handle;
        const description = ytData.description || 'Açıklama Belirtilmemiş.';
        
        let subscriberCount = 'Gizli';
        const followers = ytData.channel_follower_count || ytData.entries?.[0]?.channel_follower_count;
        if (followers) {
            if (followers >= 1000000) {
                subscriberCount = `${(followers / 1000000).toFixed(1)} Mn abone`;
            } else if (followers >= 1000) {
                subscriberCount = `${(followers / 1000).toFixed(1)} B abone`;
            } else {
                subscriberCount = `${followers} abone`;
            }
        }

        // 4. ADIM: Videoları eksiksiz array'e map'leme
        const videos = [];
        if (ytData.entries) {
            ytData.entries.forEach(entry => {
                if (entry) {
                    const videoId = entry.id || entry.url;
                    const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
                    
                    const views = entry.view_count 
                        ? `${entry.view_count.toLocaleString('tr-TR')} izlenme` 
                        : '0 izlenme';

                    let dateStr = 'Yeni';
                    if (entry.upload_date) {
                        const y = entry.upload_date.slice(0, 4);
                        const m = entry.upload_date.slice(4, 6);
                        const d = entry.upload_date.slice(6, 8);
                        dateStr = `${d}.${m}.${y}`;
                    }

                    videos.push({
                        videoId,
                        title: entry.title || 'Başlıksız Video',
                        thumbnail,
                        viewCount: views,
                        publishedTime: dateStr,
                        url: `https://www.youtube.com/watch?v=${videoId}`
                    });
                }
            });
        }

        return res.json({
            channelName,
            description,
            subscriberCount,
            estimatedLoadedVideoCount: videos.length,
            videos
        });

    } catch (error) {
        console.error("Scrape Engine Critical Error:", error);
        return res.status(500).json({ error: 'Mühendislik Hatası: ' + error.message });
    }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
