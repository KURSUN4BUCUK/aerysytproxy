const net = require('net');
const axios = require('axios');

const PORT = 8989;
const HOST = '127.0.0.1';
let proxyPool = [];

// Güvenilir ve hızlı güncellenen tek bir kaynak kullanıyoruz
async function fetchProxies() {
    console.log("[!] Hızlı proxy listesi hafızaya alınıyor...");
    try {
        // Sadece anlık aktif olan HTTP proxyleri veren taze bir API
        const res = await axios.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=1000&country=all&ssl=all&anonymity=all');
        const lines = res.data.split('\r\n');
        let tempPool = [];
        for (let line of lines) {
            if (line.trim() && line.includes(':')) tempPool.push(line.trim());
        }
        if(tempPool.length > 0) {
            proxyPool = tempPool;
            console.log(`[+] Havuz hazır! ${proxyPool.length} adet filtrelenmiş IP yüklendi.`);
        }
    } catch (e) {
        console.log("[-] Liste çekilemedi, yerel bağlantıya dönülüyor.");
    }
}

// Havuzdan rastgele proxy seçen fonksiyon
function getRandomProxy() {
    if (proxyPool.length === 0) return null;
    return proxyPool[Math.floor(Math.random() * proxyPool.length)];
}

const server = net.createServer((clientSocket) => {
    clientSocket.once('data', (data) => {
        const dataStr = data.toString();
        const isTLS = dataStr.startsWith('CONNECT');

        let remoteHost, remotePort;
        if (isTLS) {
            const match = dataStr.match(/^CONNECT\s+([^:]+):(\d+)/);
            if (match) { remoteHost = match[1]; remotePort = parseInt(match[2], 10); }
        }

        // Hata durumunda başka proxy ile yeniden deneme fonksiyonu (Max 5 deneme)
        let attempts = 0;
        function tryConnect() {
            attempts++;
            const proxy = getRandomProxy();
            
            if (!proxy || attempts > 5) {
                // Eğer 5 denemede de canlı proxy bulamazsa kendi internetinden çıkarır (Sistem kilitlenmez)
                return connectDirectly();
            }

            const [pHost, pPort] = proxy.split(':');

            // Agresif 1.5 saniye timeout: Yavaş proxy'yi bekleme, anında diğerine geç!
            const remoteSocket = new net.Socket();
            remoteSocket.setTimeout(1500); 

            remoteSocket.connect(parseInt(pPort), pHost, () => {
                if (isTLS) {
                    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                } else {
                    remoteSocket.write(data);
                }
                clientSocket.pipe(remoteSocket);
                remoteSocket.pipe(clientSocket);
            });

            remoteSocket.on('error', () => {
                remoteSocket.destroy();
                tryConnect(); // Patladıysa saliseler içinde başka proxy dene!
            });

            remoteSocket.on('timeout', () => {
                remoteSocket.destroy();
                tryConnect(); // Yavaşsa anında diğer proxy'ye atla!
            });
        }

        function connectDirectly() {
            if(!remoteHost) return clientSocket.end();
            const directSocket = net.connect(remotePort, remoteHost, () => {
                if (isTLS) clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                clientSocket.pipe(directSocket);
                directSocket.pipe(clientSocket);
            });
            directSocket.on('error', () => clientSocket.end());
        }

        tryConnect();
    });
});

fetchProxies().then(() => {
    server.listen(PORT, HOST, () => {
        console.log(`[+] Akıllı Proxy Rotator ${HOST}:${PORT} üzerinde aktif!`);
    });
});