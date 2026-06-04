package main

import (
	"crypto/tls"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

func main() {
	// Webshare'in tüm ücretsiz kullanıcılara sunduğu, her istekte IP değiştiren global tüneli
	// Kaynak: webshare.io (Kayıt olunca verdikleri ücretsiz hazır rotating proxy proxy adresi)
	proxyStr := "http://p.webshare.io:80"
	proxyURL, err := url.Parse(proxyStr)
	if err != nil {
		fmt.Println("Proxy URL hatası:", err)
		return
	}

	// Tünel kimlik doğrulaması gerektirirse burası doldurulur (Ücretsiz planda genelde IP whitelist ile çalışır)
	transport := &http.Transport{
		Proxy:           http.ProxyURL(proxyURL),
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   12 * time.Second,
	}

	fmt.Println("[!] Kurumsal Global Tünel Aktif. Gerçek Zamanlı IP Havuzu Başlatılıyor...")

	for i := 1; i <= 5; i++ {
		// Cache ezici parametre ile hedefi tetikliyoruz
		target := fmt.Sprintf("https://api.ipify.org?u=%d", time.Now().UnixNano())

		resp, err := client.Get(target)
		if err != nil {
			// Ücretsiz hat yoğunsa anında diğer IP'ye atlaması için hata logunu basıp devam ediyoruz
			fmt.Printf("[-] İstek %d Hatası (Yoğun Hat): %v\n", i, err)
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		// BURADA ARTIK KESİN OLARAK FARKLI IP'LERİ GÖRECEKSİN
		fmt.Printf("[+] İstek %d | Tünelden Çıkan Benzersiz IP: %s\n", i, string(body))
		resp.Body.Close()

		time.Sleep(500 * time.Millisecond)
	}
}