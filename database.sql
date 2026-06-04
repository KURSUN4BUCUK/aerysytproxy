-- ============================================================
-- AERYS - YouTube API Proxy System
-- Database Schema v1.0
-- ============================================================
-- Bu dosyayı cPanel → phpMyAdmin'den import edebilirsiniz
-- ============================================================

-- Database oluştur (eğer yoksa)
CREATE DATABASE IF NOT EXISTS aeryssi3_ytproxy CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE aeryssi3_ytproxy;

-- ============================================================
-- TABLO 1: users (Kullanıcılar)
-- ============================================================
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT(11) UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(50) NOT NULL UNIQUE,
  `email` VARCHAR(100) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_email` (`email`),
  INDEX `idx_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- TABLO 2: api_keys (API Anahtarları)
-- ============================================================
CREATE TABLE IF NOT EXISTS `api_keys` (
  `id` INT(11) UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT(11) UNSIGNED NOT NULL,
  `api_key` VARCHAR(100) NOT NULL UNIQUE,
  `label` VARCHAR(100) DEFAULT 'Yeni Anahtar',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `request_count` INT(11) UNSIGNED NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_api_key` (`api_key`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_is_active` (`is_active`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- TABLO 3: request_logs (API İstek Logları)
-- ============================================================
CREATE TABLE IF NOT EXISTS `request_logs` (
  `id` INT(11) UNSIGNED NOT NULL AUTO_INCREMENT,
  `api_key_id` INT(11) UNSIGNED NOT NULL,
  `user_id` INT(11) UNSIGNED NOT NULL,
  `endpoint` VARCHAR(255) NOT NULL,
  `method` VARCHAR(10) NOT NULL DEFAULT 'GET',
  `status_code` INT(3) NOT NULL,
  `ip_address` VARCHAR(45) DEFAULT NULL,
  `response_ms` INT(11) UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_api_key_id` (`api_key_id`),
  INDEX `idx_user_id` (`user_id`),
  INDEX `idx_created_at` (`created_at`),
  INDEX `idx_status_code` (`status_code`),
  FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- ÖRNEK VERİ (İsteğe bağlı - test için)
-- ============================================================

-- Test kullanıcısı (şifre: test123)
-- Not: Gerçek uygulamada bu satırı SİLİN!
INSERT INTO `users` (`username`, `email`, `password_hash`) VALUES 
('test_user', 'test@aerys.site', '$2a$10$rQ3P7w8X9Y5Z1A2B3C4D5e6F7g8H9I0J1K2L3M4N5O6P7Q8R9S0T1');

-- Test API key (yukarıdaki test kullanıcısı için)
-- Not: Gerçek uygulamada bu satırı SİLİN!
INSERT INTO `api_keys` (`user_id`, `api_key`, `label`, `is_active`) VALUES 
(1, 'yte_test_key_1234567890abcdef', 'Test Anahtarı', 1);

-- ============================================================
-- PERFORMANS OPTİMİZASYONLARI
-- ============================================================

-- request_logs tablosu çok büyüyebilir, eski logları temizlemek için:
-- (Opsiyonel: Cron job veya Event Scheduler ile otomatikleştirilebilir)

-- 30 günden eski logları sil (manuel çalıştırılır)
-- DELETE FROM request_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY);

-- Event Scheduler ile otomatik temizlik (MySQL 5.1+)

-- ============================================================
-- TABLO DURUM KONTROLÜ
-- ============================================================

-- Tabloların oluşturulduğunu kontrol et
SHOW TABLES;

-- Her tablodaki kayıt sayısını göster
SELECT 'users' AS table_name, COUNT(*) AS row_count FROM users
UNION ALL
SELECT 'api_keys', COUNT(*) FROM api_keys
UNION ALL
SELECT 'request_logs', COUNT(*) FROM request_logs;

-- ============================================================
-- NOTLAR
-- ============================================================

-- 1. Bu dosyayı phpMyAdmin'den import etmek için:
--    - cPanel → phpMyAdmin
--    - Sol menüden aeryssi3_ytproxy database'ini seç
--    - Üst menüden "Import" sekmesine tıkla
--    - "Choose File" → database.sql dosyasını seç
--    - "Go" butonuna tıkla

-- 2. .env dosyasındaki database bilgileri:
--    DB_HOST=localhost
--    DB_USER=aeryssi3_ytproxy (cPanel'den oluşturduğun kullanıcı adı)
--    DB_PASS=güçlü_şifre_buraya
--    DB_NAME=aeryssi3_ytproxy

-- 3. cPanel'de MySQL User oluşturma:
--    - cPanel → MySQL Databases
--    - "Add New User" bölümünden kullanıcı oluştur
--    - "Add User to Database" ile kullanıcıyı database'e ekle
--    - ALL PRIVILEGES seç

-- 4. Güvenlik:
--    - Test kullanıcısını ve test API key'i SİL (production'da)
--    - .env dosyasındaki JWT_SECRET ve SESSION_SECRET'i değiştir
--    - Güçlü database şifreleri kullan

-- 5. Backup:
--    - cPanel'de otomatik backup aktif olmalı
--    - Veya phpMyAdmin → Export ile manuel backup al

-- ============================================================
-- SON
-- ============================================================
